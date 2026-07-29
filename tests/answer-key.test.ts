import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';
import { importSheet, type SheetQuestion } from '../src/scripts/import-response-sheet.ts';
import { applyKey, isCorrect, solveJoin, type KeyBundle, type KeyEntry } from '../src/scripts/apply-answer-key.ts';
import { REPO_ROOT } from '../src/db/index.ts';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'gate-key-'));
  db = new Database(resolve(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  migrate(db, true);
  seed(db, undefined, true);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const REAL_SHEET = resolve(REPO_ROOT, 'data/import/gate-da-2026-response.json');
const REAL_KEY = resolve(REPO_ROOT, 'data/import/gate-da-2026-key.json');

function loadReal(): { sheet: SheetQuestion[]; key: KeyBundle } {
  return {
    sheet: JSON.parse(readFileSync(REAL_SHEET, 'utf8')).questions as SheetQuestion[],
    key: JSON.parse(readFileSync(REAL_KEY, 'utf8')) as KeyBundle,
  };
}

describe('the published key', () => {
  it('has 65 contiguous entries totalling 100 marks', () => {
    const { key } = loadReal();
    expect(key.entries).toHaveLength(65);
    expect(key.entries.map((e) => e.paper_q_no)).toEqual(
      Array.from({ length: 65 }, (_, i) => i + 1),
    );
    expect(key.entries.reduce((a, e) => a + e.marks, 0)).toBe(100);
    expect(key.entries.filter((e) => e.section === 'GA').reduce((a, e) => a + e.marks, 0)).toBe(15);
  });

  it('turns every NAT range into a midpoint and tolerance', () => {
    const { key } = loadReal();
    for (const e of key.entries.filter((x) => x.qtype === 'NAT')) {
      expect(Number.isFinite(Number(e.answer))).toBe(true);
      expect(e.tolerance).not.toBeNull();
      expect(e.tolerance!).toBeGreaterThanOrEqual(0);
    }
  });

  it('is a single session', () => {
    const { key } = loadReal();
    expect(new Set(key.entries.map((e) => e.session)).size).toBe(1);
  });
});

describe('joining sheet to key', () => {
  it('validates on all 65 questions via question ID', () => {
    const { sheet, key } = loadReal();
    importSheet(sheet, { label: 'GATE DA 2026', exam: 'GATE DA', year: 2026 }, db);

    const questions = db
      .prepare('SELECT id, source_q_no, qtype, marks, section, external_ref FROM questions')
      .all() as never[];
    const join = solveJoin(questions, key.entries)!;

    expect(join.agreement).toBe(65);
    expect(join.offset).toBe(22848210010);
  });

  it('finds the four GA questions whose derived marks were wrong', () => {
    const { sheet, key } = loadReal();
    importSheet(sheet, { label: 'GATE DA 2026', exam: 'GATE DA', year: 2026 }, db);

    const questions = db
      .prepare('SELECT id, source_q_no, qtype, marks, section, external_ref FROM questions')
      .all() as never[];
    const join = solveJoin(questions, key.entries)!;

    // Position-derived marks were wrong on exactly four GA questions, and the
    // two errors in each direction cancelled — so the "total = 100" check
    // passed while the per-question data was wrong.
    expect(join.marksCorrections).toHaveLength(4);
    expect(join.marksCorrections.every((c) => c.question.startsWith('GA-'))).toBe(true);
    const net = join.marksCorrections.reduce((a, c) => a + (c.to - c.from), 0);
    expect(net).toBe(0);
  });

  it('refuses a partial mapping rather than writing it', () => {
    const { sheet, key } = loadReal();
    importSheet(sheet, { label: 'GATE DA 2026', exam: 'GATE DA', year: 2026 }, db);

    const corrupted: KeyBundle = {
      ...key,
      entries: key.entries.map((e, i) =>
        i < 5 ? { ...e, qtype: e.qtype === 'MCQ' ? 'NAT' : 'MCQ' } : e,
      ) as KeyEntry[],
    };

    expect(() => applyKey(corrupted, { sourceLabel: 'GATE DA 2026' }, db)).toThrow(/partial mapping/);
  });
});

describe('applying the real key', () => {
  beforeEach(() => {
    const { sheet } = loadReal();
    importSheet(sheet, { label: 'GATE DA 2026', exam: 'GATE DA', year: 2026 }, db);
  });

  it('detects that option labels are unusable', () => {
    const { key } = loadReal();
    const r = applyKey(key, { sourceLabel: 'GATE DA 2026' }, db);
    expect(r.labelsUnusable).toBe(true);
  });

  it('scores NAT definitively and leaves MCQ/MSQ for a human', () => {
    const { key } = loadReal();
    const r = applyKey(key, { sourceLabel: 'GATE DA 2026' }, db);

    expect(r.natScored).toBe(18);
    expect(r.natCorrect).toBe(11);
    expect(r.natMarks).toBe(17);
    expect(r.leftForHuman).toBe(42);
  });

  it('leaves no MCQ or MSQ outcome invented', () => {
    const { key } = loadReal();
    applyKey(key, { sourceLabel: 'GATE DA 2026' }, db);

    const undetermined = db
      .prepare(
        `SELECT COUNT(*) AS c FROM attempts a JOIN questions q ON q.id = a.question_id
          WHERE q.qtype IN ('MCQ','MSQ') AND a.my_answer IS NOT NULL AND a.outcome IS NULL`,
      )
      .get() as { c: number };
    expect(undetermined.c).toBe(42);
  });

  it('marks NAT as comparable and MCQ/MSQ as not', () => {
    const { key } = loadReal();
    applyKey(key, { sourceLabel: 'GATE DA 2026' }, db);

    const rows = db
      .prepare('SELECT qtype, option_labels_comparable AS c, COUNT(*) AS n FROM questions GROUP BY qtype, c')
      .all() as { qtype: string; c: number; n: number }[];

    expect(rows.find((r) => r.qtype === 'NAT')!.c).toBe(1);
    expect(rows.find((r) => r.qtype === 'MCQ')!.c).toBe(0);
    expect(rows.find((r) => r.qtype === 'MSQ')!.c).toBe(0);
  });

  it('records how each outcome was established', () => {
    const { key } = loadReal();
    applyKey(key, { sourceLabel: 'GATE DA 2026' }, db);

    const sources = db
      .prepare("SELECT outcome_source AS s, COUNT(*) AS n FROM attempts GROUP BY s")
      .all() as { s: string | null; n: number }[];

    expect(sources.find((x) => x.s === 'answer_key')!.n).toBe(18);
    expect(sources.find((x) => x.s === 'response_sheet')!.n).toBe(5);
    expect(sources.find((x) => x.s === null)!.n).toBe(42);
  });

  it('corrects the five non-attempts to their true marks, still totalling 8', () => {
    const { key } = loadReal();
    applyKey(key, { sourceLabel: 'GATE DA 2026' }, db);

    const blanks = db
      .prepare("SELECT q.marks FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.outcome = 'skipped'")
      .all() as { marks: number }[];

    expect(blanks).toHaveLength(5);
    expect(blanks.reduce((a, b) => a + b.marks, 0)).toBe(8);
  });

  it('is idempotent', () => {
    const { key } = loadReal();
    const first = applyKey(key, { sourceLabel: 'GATE DA 2026' }, db);
    const second = applyKey(key, { sourceLabel: 'GATE DA 2026' }, db);
    expect(second.natCorrect).toBe(first.natCorrect);
    expect(second.leftForHuman).toBe(first.leftForHuman);
  });

  it('refuses an unknown source', () => {
    const { key } = loadReal();
    expect(() => applyKey(key, { sourceLabel: 'nope' }, db)).toThrow(/no source/);
  });
});

describe('isCorrect', () => {
  const nat: KeyEntry = {
    paper_q_no: 29, session: 8, qtype: 'NAT', section: 'SUBJECT', marks: 1,
    key_raw: '8.90 to 9.10', answer: '9', tolerance: 0.1,
  };

  it('accepts a NAT value inside the published range', () => {
    expect(isCorrect(nat, '8.90')).toBe(true);
    expect(isCorrect(nat, '9.10')).toBe(true);
    expect(isCorrect(nat, '9.11')).toBe(false);
    expect(isCorrect(nat, '8.89')).toBe(false);
  });

  it('rejects a non-numeric NAT answer', () => {
    expect(isCorrect(nat, 'abc')).toBe(false);
  });

  const msq: KeyEntry = {
    paper_q_no: 24, session: 8, qtype: 'MSQ', section: 'SUBJECT', marks: 1,
    key_raw: 'A;B;C', answer: 'A,B,C', tolerance: null,
  };

  it('requires an exact MSQ set, in any order', () => {
    expect(isCorrect(msq, 'C,B,A')).toBe(true);
    expect(isCorrect(msq, 'A,B')).toBe(false);
    expect(isCorrect(msq, 'A,B,C,D')).toBe(false);
  });

  const mcq: KeyEntry = {
    paper_q_no: 1, session: 8, qtype: 'MCQ', section: 'GA', marks: 1,
    key_raw: 'B', answer: 'B', tolerance: null,
  };

  it('matches a single MCQ letter, case-insensitively', () => {
    expect(isCorrect(mcq, 'b')).toBe(true);
    expect(isCorrect(mcq, 'A')).toBe(false);
    expect(isCorrect(mcq, 'A,B')).toBe(false);
  });
});

describe('NAT tolerances match the published ranges exactly', () => {
  it('accepts both endpoints of every published range', () => {
    const { key } = loadReal();
    const RANGE = /^\s*(-?[\d.]+)\s+to\s+(-?[\d.]+)\s*$/;

    for (const e of key.entries.filter((x) => x.qtype === 'NAT')) {
      const m = RANGE.exec(e.key_raw.replace(/\s+/g, ' '));
      expect(m, `unparsed range: ${e.key_raw}`).not.toBeNull();

      const lo = Number(m![1]);
      const hi = Number(m![2]);
      // An answer sitting exactly on a published boundary must be accepted;
      // float noise in the midpoint would silently narrow the range.
      expect(isCorrect(e, String(lo)), `lo of ${e.key_raw}`).toBe(true);
      expect(isCorrect(e, String(hi)), `hi of ${e.key_raw}`).toBe(true);
    }
  });

  it('carries no float noise in the stored tolerances', () => {
    const { key } = loadReal();
    for (const e of key.entries.filter((x) => x.qtype === 'NAT')) {
      expect(Number(e.tolerance!.toFixed(6))).toBe(e.tolerance);
    }
  });
});
