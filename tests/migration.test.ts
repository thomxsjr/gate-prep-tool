import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';
import { assignSectionAndMarks, importSheet, type SheetQuestion } from '../src/scripts/import-response-sheet.ts';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'gate-migration-'));
  db = new Database(resolve(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOW = '2026-07-28T00:00:00.000Z';

function seedOneAttemptWithOptions(): { attemptId: number; optionCount: number } {
  const sourceId = Number(
    db.prepare(
      `INSERT INTO sources (kind, exam, year, label, created_at)
       VALUES ('pyq', 'GATE DA', 2026, 'GATE DA 2026', ?)`,
    ).run(NOW).lastInsertRowid,
  );
  const qid = Number(
    db.prepare(
      `INSERT INTO questions (source_id, source_q_no, marks, qtype, paraphrase, created_at, updated_at)
       VALUES (?, 'Q41', 2, 'MSQ', '', ?, ?)`,
    ).run(sourceId, NOW, NOW).lastInsertRowid,
  );

  const optionIds: number[] = [];
  for (const [i, label] of ['A', 'B', 'C', 'D'].entries()) {
    optionIds.push(
      Number(
        db.prepare(
          'INSERT INTO question_options (question_id, label, is_correct, sort_order) VALUES (?, ?, ?, ?)',
        ).run(qid, label, i % 2, i).lastInsertRowid,
      ),
    );
  }

  const attemptId = Number(
    db.prepare(
      `INSERT INTO attempts (question_id, context, attempted_at, my_answer, outcome,
                             marks_available, marks_obtained, marks_lost,
                             captured_at, triaged_at, created_at, updated_at)
       VALUES (?, 'mock', ?, 'A,C,D', 'wrong', 2, 0, 2, ?, ?, ?, ?)`,
    ).run(qid, NOW, NOW, NOW, NOW, NOW).lastInsertRowid,
  );

  for (const oid of optionIds) {
    db.prepare(
      `INSERT INTO attempt_options (attempt_id, question_option_id, my_verdict,
                                    justification, is_verdict_correct, seconds)
       VALUES (?, ?, 1, 'checked', 0, 30)`,
    ).run(attemptId, oid);
  }

  return { attemptId, optionCount: optionIds.length };
}

describe('002 rebuilds attempts without destroying children', () => {
  it('preserves attempt_options across the table rebuild', () => {
    // The rebuild drops and recreates `attempts`. With foreign keys enforced,
    // DROP TABLE fires attempt_options' ON DELETE CASCADE and silently wipes
    // every per-option verdict — the single most expensive data in M3.
    migrate(db, true, 1);
    const { attemptId, optionCount } = seedOneAttemptWithOptions();

    const before = db
      .prepare('SELECT COUNT(*) AS c FROM attempt_options')
      .get() as { c: number };
    expect(before.c).toBe(optionCount);

    migrate(db, true);

    const after = db.prepare('SELECT COUNT(*) AS c FROM attempt_options').get() as { c: number };
    expect(after.c).toBe(optionCount);

    const linked = db
      .prepare('SELECT COUNT(*) AS c FROM attempt_options WHERE attempt_id = ?')
      .get(attemptId) as { c: number };
    expect(linked.c).toBe(optionCount);
  });

  it('preserves the attempt row itself, verbatim', () => {
    migrate(db, true, 1);
    seedOneAttemptWithOptions();
    migrate(db, true);

    const a = db.prepare('SELECT * FROM attempts').get() as Record<string, unknown>;
    expect(a['my_answer']).toBe('A,C,D');
    expect(a['outcome']).toBe('wrong');
    expect(a['marks_lost']).toBe(2);
  });

  it('leaves no foreign-key violations', () => {
    migrate(db, true, 1);
    seedOneAttemptWithOptions();
    migrate(db, true);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('restores foreign key enforcement afterwards', () => {
    migrate(db, true);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('002 allows an undetermined outcome', () => {
  beforeEach(() => {
    migrate(db, true);
    seed(db, undefined, true);
  });

  it('accepts a null outcome for an answered-but-unmarked question', () => {
    const sourceId = Number(
      db.prepare(
        `INSERT INTO sources (kind, exam, year, label, created_at)
         VALUES ('pyq', 'GATE DA', 2026, 'S', ?)`,
      ).run(NOW).lastInsertRowid,
    );
    const qid = Number(
      db.prepare(
        `INSERT INTO questions (source_id, source_q_no, marks, qtype, paraphrase, created_at, updated_at)
         VALUES (?, 'Q1', 1, 'MCQ', '', ?, ?)`,
      ).run(sourceId, NOW, NOW).lastInsertRowid,
    );

    expect(() =>
      db.prepare(
        `INSERT INTO attempts (question_id, context, attempted_at, my_answer, outcome,
                               marks_available, captured_at, created_at, updated_at)
         VALUES (?, 'pyq', ?, 'B', NULL, 1, ?, ?, ?)`,
      ).run(qid, NOW, NOW, NOW, NOW),
    ).not.toThrow();
  });

  it('refuses a triaged attempt with no outcome', () => {
    const sourceId = Number(
      db.prepare(
        `INSERT INTO sources (kind, exam, year, label, created_at)
         VALUES ('pyq', 'GATE DA', 2026, 'S', ?)`,
      ).run(NOW).lastInsertRowid,
    );
    const qid = Number(
      db.prepare(
        `INSERT INTO questions (source_id, source_q_no, marks, qtype, paraphrase, created_at, updated_at)
         VALUES (?, 'Q1', 1, 'MCQ', '', ?, ?)`,
      ).run(sourceId, NOW, NOW).lastInsertRowid,
    );

    expect(() =>
      db.prepare(
        `INSERT INTO attempts (question_id, context, attempted_at, outcome, marks_available,
                               captured_at, triaged_at, created_at, updated_at)
         VALUES (?, 'pyq', ?, NULL, 1, ?, ?, ?, ?)`,
      ).run(qid, NOW, NOW, NOW, NOW, NOW),
    ).toThrow();
  });
});

describe('response sheet marks derivation', () => {
  it('reconstructs the GATE DA 100-mark structure', () => {
    const raw = [
      ...Array.from({ length: 10 }, (_, i) => ({ number: i + 1, qtype: 'MCQ' as const, status: 'Answered', given: 'A', external_ref: null })),
      ...Array.from({ length: 55 }, (_, i) => ({ number: i + 1, qtype: 'MCQ' as const, status: 'Answered', given: 'A', external_ref: null })),
    ];
    const out = assignSectionAndMarks(raw);

    expect(out).toHaveLength(65);
    expect(out.filter((q) => q.section === 'GA')).toHaveLength(10);
    expect(out.filter((q) => q.section === 'SUBJECT')).toHaveLength(55);
    expect(out.reduce((a, q) => a + q.marks, 0)).toBe(100);
    expect(out.filter((q) => q.section === 'GA').reduce((a, q) => a + q.marks, 0)).toBe(15);
  });

  it('puts 1-mark questions before 2-mark ones in each section', () => {
    const raw = Array.from({ length: 10 }, (_, i) => ({
      number: i + 1, qtype: 'MCQ' as const, status: 'A', given: 'A', external_ref: null,
    }));
    const out = assignSectionAndMarks(raw);
    expect(out.slice(0, 5).every((q) => q.marks === 1)).toBe(true);
    expect(out.slice(5).every((q) => q.marks === 2)).toBe(true);
  });
});

describe('importing a response sheet', () => {
  beforeEach(() => {
    migrate(db, true);
    seed(db, undefined, true);
  });

  const questions: SheetQuestion[] = [
    { number: 1, section: 'GA', qtype: 'MCQ', marks: 1, status: 'NotAnswered', given: null, external_ref: '111' },
    { number: 2, section: 'GA', qtype: 'MSQ', marks: 1, status: 'Answered', given: 'A,C', external_ref: '112' },
    { number: 3, section: 'GA', qtype: 'NAT', marks: 1, status: 'Answered', given: '4', external_ref: '113' },
  ];

  it('records a blank as skipped and an answered question as undetermined', () => {
    importSheet(questions, { label: 'T', exam: 'GATE DA', year: 2026 }, db);

    const rows = db
      .prepare('SELECT q.source_q_no, a.outcome, a.my_answer, a.marks_lost FROM attempts a JOIN questions q ON q.id = a.question_id ORDER BY q.source_q_no')
      .all() as { source_q_no: string; outcome: string | null; my_answer: string | null; marks_lost: number | null }[];

    expect(rows[0]!.outcome).toBe('skipped');
    expect(rows[0]!.marks_lost).toBe(1);
    // No answer key exists, so correctness is genuinely unknown.
    expect(rows[1]!.outcome).toBeNull();
    expect(rows[1]!.my_answer).toBe('A,C');
    expect(rows[2]!.outcome).toBeNull();
  });

  it('leaves every imported row in the triage queue', () => {
    importSheet(questions, { label: 'T', exam: 'GATE DA', year: 2026 }, db);
    const q = db.prepare('SELECT COUNT(*) AS c FROM v_triage_queue').get() as { c: number };
    expect(q.c).toBe(3);
  });

  it('stores no question or option text', () => {
    importSheet(questions, { label: 'T', exam: 'GATE DA', year: 2026 }, db);

    const paraphrases = db.prepare('SELECT paraphrase FROM questions').all() as { paraphrase: string }[];
    expect(paraphrases.every((p) => p.paraphrase === '')).toBe(true);

    const opts = db.prepare('SELECT paraphrase FROM question_options').all() as { paraphrase: string }[];
    expect(opts.every((o) => o.paraphrase === '')).toBe(true);
  });

  it('files non-attempts against the non-attempt rung', () => {
    importSheet(questions, { label: 'T', exam: 'GATE DA', year: 2026 }, db);

    const items = db
      .prepare('SELECT ri.label, r.ordinal FROM rung_items ri JOIN rungs r ON r.id = ri.rung_id')
      .all() as { label: string; ordinal: number }[];

    expect(items).toHaveLength(1);
    expect(items[0]!.ordinal).toBe(4);
    expect(items[0]!.label).toContain('GA-Q1');
  });

  it('does not create NAT options', () => {
    importSheet(questions, { label: 'T', exam: 'GATE DA', year: 2026 }, db);
    const nat = db
      .prepare("SELECT COUNT(*) AS c FROM question_options o JOIN questions q ON q.id = o.question_id WHERE q.qtype = 'NAT'")
      .get() as { c: number };
    expect(nat.c).toBe(0);
  });

  it('is idempotent', () => {
    importSheet(questions, { label: 'T', exam: 'GATE DA', year: 2026 }, db);
    const second = importSheet(questions, { label: 'T', exam: 'GATE DA', year: 2026 }, db);
    expect(second.questions).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM questions').get() as { c: number }).c).toBe(3);
  });
});
