/**
 * Data access. Every write also appends to the journal.
 *
 * Aggregations that the spec requires to be correct are computed by the pure
 * functions in src/domain/ — this layer only fetches rows and hands them over.
 */

import { type DB, getDb } from '../db/index.ts';
import { append } from '../db/journal.ts';
import type {
  AttemptRow,
  CaptureInput,
  Context,
  ErrorClass,
  MsqQuestion,
  MsqVerdictInput,
  RungRow,
  Subject,
  TriageInput,
} from '../shared/types.ts';
import type { ShareAttempt } from '../domain/procedural.ts';
import { score } from '../domain/scoring.ts';
import { thirdsToMarks } from '../domain/marking.ts';
import { newCard, review as sm2Review, type CardState } from '../domain/scheduler.ts';

const now = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getConfig<T = unknown>(key: string, db: DB = getDb()): T | null {
  const row = db.prepare('SELECT value_json FROM config WHERE key = ?').get(key) as
    | { value_json: string }
    | undefined;
  return row ? (JSON.parse(row.value_json) as T) : null;
}

export function allConfig(db: DB = getDb()): Record<string, { value: unknown; verified: boolean }> {
  const rows = db
    .prepare('SELECT key, value_json, verified_against_brochure FROM config')
    .all() as { key: string; value_json: string; verified_against_brochure: number }[];
  return Object.fromEntries(
    rows.map((r) => [
      r.key,
      { value: JSON.parse(r.value_json), verified: r.verified_against_brochure === 1 },
    ]),
  );
}

export function setConfig(key: string, value: unknown, db: DB = getDb()): void {
  db.prepare(
    `INSERT INTO config (key, value_json, grp, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), key, now());
  append({ op: 'update', table: 'config', id: key, data: value });
}

export function markVerified(key: string, verified: boolean, db: DB = getDb()): void {
  db.prepare('UPDATE config SET verified_against_brochure = ?, updated_at = ? WHERE key = ?').run(
    verified ? 1 : 0,
    now(),
    key,
  );
  append({ op: 'update', table: 'config', id: key, note: `verified=${verified}` });
}

export function unverifiedGroups(db: DB = getDb()): string[] {
  return (
    db
      .prepare('SELECT key FROM config WHERE verified_against_brochure = 0 ORDER BY key')
      .all() as { key: string }[]
  ).map((r) => r.key);
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

export function errorClasses(db: DB = getDb()): ErrorClass[] {
  return (
    db
      .prepare('SELECT * FROM error_classes WHERE active = 1 ORDER BY sort_order')
      .all() as (Omit<ErrorClass, 'is_procedural'> & { is_procedural: number })[]
  ).map((r) => ({ ...r, is_procedural: r.is_procedural === 1 }));
}

export function subjects(db: DB = getDb()): Subject[] {
  return db.prepare('SELECT * FROM subjects ORDER BY sort_order').all() as Subject[];
}

export function rungs(db: DB = getDb()): RungRow[] {
  return (
    db.prepare('SELECT * FROM rungs ORDER BY ordinal').all() as (Omit<
      RungRow,
      'is_procedural'
    > & { is_procedural: number })[]
  ).map((r) => ({ ...r, is_procedural: r.is_procedural === 1 }));
}

export function rungItemsClosed(db: DB = getDb()): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT r.ordinal, SUM(CASE WHEN ri.status = 'closed' THEN 1 ELSE 0 END) AS closed
         FROM rungs r LEFT JOIN rung_items ri ON ri.rung_id = r.id GROUP BY r.ordinal`,
    )
    .all() as { ordinal: number; closed: number | null }[];
  return new Map(rows.map((r) => [r.ordinal, r.closed ?? 0]));
}

export function sources(db: DB = getDb()): { id: number; label: string; kind: string; year: number | null }[] {
  return db
    .prepare('SELECT id, label, kind, year FROM sources ORDER BY year DESC, label')
    .all() as never;
}

// ---------------------------------------------------------------------------
// Attempts — the spine
// ---------------------------------------------------------------------------

const ATTEMPT_SELECT = `
  SELECT a.id, a.question_id, s.label AS source_label, q.source_q_no, q.paper_q_no,
         q.qtype, q.marks, q.subject_id, sub.name AS subject_name, q.paraphrase,
         q.correct_answer, q.option_labels_comparable,
         a.context, a.attempted_at, a.my_answer, a.outcome, a.outcome_source,
         a.marks_lost, a.time_seconds, a.confidence, a.error_class_id,
         ec.code AS error_code, ec.name AS error_name, ec.is_procedural,
         a.what_i_thought, a.broke_at_step, a.prevention_rule,
         a.attempt_no, a.is_first_attempt, a.captured_at, a.triaged_at
    FROM attempts a
    JOIN questions q ON q.id = a.question_id
    JOIN sources s ON s.id = q.source_id
    LEFT JOIN subjects sub ON sub.id = q.subject_id
    LEFT JOIN error_classes ec ON ec.id = a.error_class_id
`;

function hydrate(r: Record<string, unknown>): AttemptRow {
  return {
    ...r,
    is_procedural: r['is_procedural'] === null || r['is_procedural'] === undefined
      ? null
      : r['is_procedural'] === 1,
    is_first_attempt: r['is_first_attempt'] === 1,
    option_labels_comparable: r['option_labels_comparable'] === 1,
  } as AttemptRow;
}

export interface AttemptFilter {
  errorClassId?: number;
  subjectId?: number;
  rungOrdinal?: number;
  context?: Context;
  triaged?: boolean;
  sourceId?: number;
  qtype?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export function listAttempts(f: AttemptFilter = {}, db: DB = getDb()): AttemptRow[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (f.errorClassId !== undefined) { where.push('a.error_class_id = ?'); params.push(f.errorClassId); }
  if (f.subjectId !== undefined) { where.push('q.subject_id = ?'); params.push(f.subjectId); }
  if (f.context !== undefined) { where.push('a.context = ?'); params.push(f.context); }
  if (f.sourceId !== undefined) { where.push('q.source_id = ?'); params.push(f.sourceId); }
  if (f.qtype !== undefined) { where.push('q.qtype = ?'); params.push(f.qtype); }
  if (f.since !== undefined) { where.push('a.attempted_at >= ?'); params.push(f.since); }
  if (f.triaged === true) where.push('a.triaged_at IS NOT NULL');
  if (f.triaged === false) where.push('a.triaged_at IS NULL');
  if (f.rungOrdinal !== undefined) {
    where.push('q.rung_id = (SELECT id FROM rungs WHERE ordinal = ?)');
    params.push(f.rungOrdinal);
  }

  const sql =
    ATTEMPT_SELECT +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY a.attempted_at DESC, a.id DESC' +
    ` LIMIT ${Math.min(f.limit ?? 200, 1000)} OFFSET ${f.offset ?? 0}`;

  return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map(hydrate);
}

export function getAttempt(id: number, db: DB = getDb()): AttemptRow | null {
  const r = db.prepare(`${ATTEMPT_SELECT} WHERE a.id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? hydrate(r) : null;
}

/** Rows for the procedural-share and leak computations. */
export function shareAttempts(db: DB = getDb()): ShareAttempt[] {
  const rows = db
    .prepare(
      `SELECT a.attempted_at, a.context, a.marks_lost, a.error_class_id, a.triaged_at,
              ec.is_procedural
         FROM attempts a LEFT JOIN error_classes ec ON ec.id = a.error_class_id`,
    )
    .all() as {
    attempted_at: string;
    context: string;
    marks_lost: number | null;
    error_class_id: number | null;
    triaged_at: string | null;
    is_procedural: number | null;
  }[];

  return rows.map((r) => ({
    attemptedAt: r.attempted_at,
    context: r.context,
    marksLost: r.marks_lost ?? 0,
    isProcedural: r.is_procedural === null ? null : r.is_procedural === 1,
    errorClassId: r.error_class_id,
    triagedAt: r.triaged_at,
  }));
}

function ensureSource(label: string, db: DB): number {
  const existing = db.prepare('SELECT id FROM sources WHERE label = ?').get(label) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const kind = /mock/i.test(label) ? 'mock' : /section/i.test(label) ? 'sectional' : 'pyq';
  return Number(
    db
      .prepare('INSERT INTO sources (kind, label, created_at) VALUES (?, ?, ?)')
      .run(kind, label, now()).lastInsertRowid,
  );
}

/** Stage 1 capture. Fast path — no diagnosis required. */
export function capture(input: CaptureInput, db: DB = getDb()): AttemptRow {
  const ts = now();
  const attemptedAt = input.attemptedAt ?? ts;

  const run = db.transaction(() => {
    const sourceId = ensureSource(input.sourceLabel, db);
    const qNo = input.sourceQNo?.trim() || null;

    let questionId: number | null = null;
    if (qNo) {
      const found = db
        .prepare('SELECT id FROM questions WHERE source_id = ? AND source_q_no = ?')
        .get(sourceId, qNo) as { id: number } | undefined;
      questionId = found?.id ?? null;
    }

    if (questionId === null) {
      questionId = Number(
        db
          .prepare(
            `INSERT INTO questions (source_id, source_q_no, marks, qtype, subject_id,
                                    paraphrase, correct_answer, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sourceId,
            qNo,
            input.marks,
            input.qtype,
            input.subjectId ?? null,
            input.paraphrase ?? '',
            input.correctAnswer ?? null,
            ts,
            ts,
          ).lastInsertRowid,
      );
    } else if (input.paraphrase || input.correctAnswer) {
      db.prepare(
        `UPDATE questions SET paraphrase = COALESCE(NULLIF(?, ''), paraphrase),
                              correct_answer = COALESCE(?, correct_answer), updated_at = ?
          WHERE id = ?`,
      ).run(input.paraphrase ?? '', input.correctAnswer ?? null, ts, questionId);
    }

    const prev = db
      .prepare('SELECT COALESCE(MAX(attempt_no), 0) AS n FROM attempts WHERE question_id = ?')
      .get(questionId) as { n: number };
    const attemptNo = prev.n + 1;

    const s = score({
      qtype: input.qtype,
      marks: input.marks,
      isCorrect: input.outcome === 'correct' || input.outcome === 'correct_but_guessed',
      attempted: input.outcome !== 'skipped',
      guessed: input.outcome === 'correct_but_guessed',
    });

    const id = Number(
      db
        .prepare(
          `INSERT INTO attempts (question_id, context, attempted_at, my_answer, outcome,
                                 marks_available, marks_obtained, marks_lost, time_seconds,
                                 confidence, error_class_id, attempt_no, is_first_attempt,
                                 captured_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          questionId,
          input.context,
          attemptedAt,
          input.myAnswer ?? null,
          input.outcome,
          input.marks,
          thirdsToMarks(s.obtainedThirds),
          thirdsToMarks(s.lostThirds),
          input.timeSeconds ?? null,
          input.confidence ?? null,
          input.errorClassId ?? null,
          attemptNo,
          attemptNo === 1 ? 1 : 0,
          ts,
          ts,
          ts,
        ).lastInsertRowid,
    );
    return id;
  });

  const id = run();
  append({ op: 'insert', table: 'attempts', id, data: input });
  return getAttempt(id, db)!;
}

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface TriageLimits {
  minBrokeAtStep: number;
  minPreventionRule: number;
  minWhatIThought: number;
}

export function triageLimits(db: DB = getDb()): TriageLimits {
  const cfg = getConfig<Record<string, number>>('logging', db) ?? {};
  return {
    minBrokeAtStep: cfg['min_broke_at_step_chars'] ?? 25,
    minPreventionRule: cfg['min_prevention_rule_chars'] ?? 25,
    minWhatIThought: cfg['min_what_i_thought_chars'] ?? 10,
  };
}

/**
 * Stage 2 diagnosis.
 *
 * The structured fields are the friction. A character floor alone measures
 * typing; requiring the step that broke AND the rule that prevents it forces
 * the diagnosis to be specific enough to act on — and the prevention rule is
 * what becomes the flashcard.
 */
export function triage(id: number, input: TriageInput, db: DB = getDb()): AttemptRow {
  const limits = triageLimits(db);
  const attempt = getAttempt(id, db);
  if (!attempt) throw new ValidationError('no such attempt', 'id');

  if (!input.errorClassId) {
    throw new ValidationError('an error class is required', 'errorClassId');
  }
  if ((input.brokeAtStep ?? '').trim().length < limits.minBrokeAtStep) {
    throw new ValidationError(
      `name the step that broke, in at least ${limits.minBrokeAtStep} characters`,
      'brokeAtStep',
    );
  }
  if ((input.preventionRule ?? '').trim().length < limits.minPreventionRule) {
    throw new ValidationError(
      `write the rule that prevents this, in at least ${limits.minPreventionRule} characters`,
      'preventionRule',
    );
  }
  if ((input.whatIThought ?? '').trim().length < limits.minWhatIThought) {
    throw new ValidationError('say what you were thinking at the time', 'whatIThought');
  }

  const ts = now();
  const run = db.transaction(() => {
    let conceptId: number | null = null;
    if (input.conceptName?.trim()) {
      const name = input.conceptName.trim();
      const found = db.prepare('SELECT id FROM concepts WHERE name = ?').get(name) as
        | { id: number }
        | undefined;
      conceptId =
        found?.id ??
        Number(
          db
            .prepare('INSERT INTO concepts (name, subject_id, created_at) VALUES (?, ?, ?)')
            .run(name, input.subjectId ?? null, ts).lastInsertRowid,
        );
    }

    const outcome = input.outcome ?? attempt.outcome;
    if (!outcome) throw new ValidationError('an outcome is required to triage', 'outcome');

    const s = score({
      qtype: attempt.qtype,
      marks: attempt.marks as 1 | 2,
      isCorrect: outcome === 'correct' || outcome === 'correct_but_guessed',
      attempted: outcome !== 'skipped',
      guessed: outcome === 'correct_but_guessed',
    });

    db.prepare(
      `UPDATE attempts
          SET error_class_id = ?, outcome = ?, outcome_source = COALESCE(outcome_source, 'manual'),
              marks_obtained = ?, marks_lost = ?,
              what_i_thought = ?, broke_at_step = ?, prevention_rule = ?,
              confidence = COALESCE(?, confidence), time_seconds = COALESCE(?, time_seconds),
              triaged_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      input.errorClassId,
      outcome,
      thirdsToMarks(s.obtainedThirds),
      thirdsToMarks(s.lostThirds),
      input.whatIThought.trim(),
      input.brokeAtStep.trim(),
      input.preventionRule.trim(),
      input.confidence ?? null,
      input.timeSeconds ?? null,
      ts,
      ts,
      id,
    );

    if (conceptId !== null || input.subjectId || input.paraphrase) {
      db.prepare(
        `UPDATE questions
            SET concept_id = COALESCE(?, concept_id),
                subject_id = COALESCE(?, subject_id),
                paraphrase = COALESCE(NULLIF(?, ''), paraphrase),
                updated_at = ?
          WHERE id = ?`,
      ).run(conceptId, input.subjectId ?? null, input.paraphrase ?? '', ts, attempt.question_id);
    }

    if (input.createCard) {
      createCardFromAttempt(id, conceptId, db);
    }
  });

  run();
  append({ op: 'update', table: 'attempts', id, data: { triaged: true, ...input } });
  return getAttempt(id, db)!;
}

export function triageQueue(db: DB = getDb()): AttemptRow[] {
  return (
    db
      .prepare(`${ATTEMPT_SELECT} WHERE a.triaged_at IS NULL ORDER BY a.captured_at ASC LIMIT 500`)
      .all() as Record<string, unknown>[]
  ).map(hydrate);
}

export function deleteAttempt(id: number, db: DB = getDb()): void {
  db.prepare('DELETE FROM attempts WHERE id = ?').run(id);
  append({ op: 'delete', table: 'attempts', id });
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export function createCardFromAttempt(
  attemptId: number,
  conceptId: number | null,
  db: DB = getDb(),
): number {
  const a = getAttempt(attemptId, db);
  if (!a) throw new ValidationError('no such attempt', 'attemptId');

  const type = a.error_code === 'BOUNDARY' ? 'boundary' : 'procedure';
  const front =
    a.paraphrase.trim() ||
    `${a.source_label ?? 'Question'} ${a.source_q_no ?? ''} — what is the rule?`.trim();

  const ts = now();
  const id = Number(
    db
      .prepare(
        `INSERT INTO cards (type, front, back, subject_id, concept_id, origin_attempt_id,
                            due_date, interval_days, ease, reps, lapses, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 2.5, 0, 0, ?, ?)`,
      )
      .run(
        type,
        front,
        a.prevention_rule || a.broke_at_step,
        a.subject_id,
        conceptId,
        attemptId,
        ts.slice(0, 10),
        ts,
        ts,
      ).lastInsertRowid,
  );
  append({ op: 'insert', table: 'cards', id, note: `from attempt ${attemptId}` });
  return id;
}

export interface CardRow {
  id: number;
  type: string;
  front: string;
  back: string;
  subject_id: number | null;
  subject_name: string | null;
  due_date: string;
  interval_days: number;
  ease: number;
  reps: number;
  lapses: number;
  suspended: number;
  origin_attempt_id: number | null;
}

export function dueCards(on: string, db: DB = getDb()): CardRow[] {
  return db
    .prepare(
      `SELECT c.*, s.name AS subject_name FROM cards c
         LEFT JOIN subjects s ON s.id = c.subject_id
        WHERE c.suspended = 0 AND c.due_date <= ?
        ORDER BY c.due_date ASC, c.id ASC`,
    )
    .all(on) as CardRow[];
}

export function allCards(db: DB = getDb()): CardRow[] {
  return db
    .prepare(
      `SELECT c.*, s.name AS subject_name FROM cards c
         LEFT JOIN subjects s ON s.id = c.subject_id ORDER BY c.due_date ASC`,
    )
    .all() as CardRow[];
}

export function reviewCard(id: number, grade: number, db: DB = getDb()): CardRow {
  const c = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
  if (!c) throw new ValidationError('no such card', 'id');

  const state: CardState = {
    intervalDays: c.interval_days,
    ease: c.ease,
    reps: c.reps,
    lapses: c.lapses,
  };
  const r = sm2Review(state, grade);
  const ts = now();

  db.transaction(() => {
    db.prepare(
      `UPDATE cards SET interval_days = ?, ease = ?, reps = ?, lapses = ?,
                        due_date = ?, last_reviewed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(r.intervalDays, r.ease, r.reps, r.lapses, r.dueDate, ts, ts, id);
    db.prepare(
      `INSERT INTO card_reviews (card_id, reviewed_at, grade, prev_interval, new_interval,
                                 prev_ease, new_ease) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, ts, grade, state.intervalDays, r.intervalDays, state.ease, r.ease);
  })();

  append({ op: 'update', table: 'cards', id, data: { grade, due: r.dueDate } });
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow;
}

export function createCard(
  input: { type: string; front: string; back: string; subjectId?: number | null },
  db: DB = getDb(),
): number {
  const ts = now();
  const s = newCard();
  const id = Number(
    db
      .prepare(
        `INSERT INTO cards (type, front, back, subject_id, due_date, interval_days, ease,
                            reps, lapses, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.type,
        input.front,
        input.back,
        input.subjectId ?? null,
        ts.slice(0, 10),
        s.intervalDays,
        s.ease,
        s.reps,
        s.lapses,
        ts,
        ts,
      ).lastInsertRowid,
  );
  append({ op: 'insert', table: 'cards', id });
  return id;
}

// ---------------------------------------------------------------------------
// MSQ trainer
// ---------------------------------------------------------------------------

export function msqQuestions(db: DB = getDb()): MsqQuestion[] {
  const qs = db
    .prepare(
      `SELECT q.id, s.label AS source_label, q.source_q_no, q.marks, q.paraphrase,
              sub.name AS subject_name
         FROM questions q
         JOIN sources s ON s.id = q.source_id
         LEFT JOIN subjects sub ON sub.id = q.subject_id
        WHERE q.qtype = 'MSQ'
        ORDER BY q.id`,
    )
    .all() as {
    id: number;
    source_label: string;
    source_q_no: string | null;
    marks: number;
    paraphrase: string;
    subject_name: string | null;
  }[];

  const optStmt = db.prepare(
    'SELECT id, label, paraphrase, is_correct FROM question_options WHERE question_id = ? ORDER BY sort_order',
  );

  return qs.map((q) => ({
    questionId: q.id,
    sourceLabel: q.source_label,
    sourceQNo: q.source_q_no,
    marks: q.marks,
    paraphrase: q.paraphrase,
    subjectName: q.subject_name,
    options: (optStmt.all(q.id) as { id: number; label: string; paraphrase: string; is_correct: number }[]).map(
      (o) => ({ ...o, is_correct: o.is_correct === 1 }),
    ),
    perOptionBudgetSeconds: 30,
  }));
}

export function recordMsqAttempt(input: MsqVerdictInput, db: DB = getDb()): { attemptId: number } {
  const ts = now();
  const q = db.prepare('SELECT id, marks, qtype FROM questions WHERE id = ?').get(input.questionId) as
    | { id: number; marks: number; qtype: string }
    | undefined;
  if (!q) throw new ValidationError('no such question', 'questionId');

  const options = db
    .prepare('SELECT id, is_correct FROM question_options WHERE question_id = ?')
    .all(q.id) as { id: number; is_correct: number }[];
  const correctById = new Map(options.map((o) => [o.id, o.is_correct === 1]));

  // Every option needs a verdict AND a justification; the UI disables submit,
  // and the API refuses too, so there is no bypass.
  if (input.verdicts.length !== options.length) {
    throw new ValidationError('every option needs a verdict', 'verdicts');
  }
  for (const v of input.verdicts) {
    if (v.justification.trim().length < 15) {
      throw new ValidationError('every option needs a justification of 15+ characters', 'justification');
    }
  }

  const allRight = input.verdicts.every((v) => v.myVerdict === correctById.get(v.optionId));
  const s = score({ qtype: 'MSQ', marks: q.marks as 1 | 2, isCorrect: allRight, attempted: true });

  const attemptId = db.transaction(() => {
    const prev = db
      .prepare('SELECT COALESCE(MAX(attempt_no), 0) AS n FROM attempts WHERE question_id = ?')
      .get(q.id) as { n: number };
    const attemptNo = prev.n + 1;

    const id = Number(
      db
        .prepare(
          `INSERT INTO attempts (question_id, context, attempted_at, outcome, marks_available,
                                 marks_obtained, marks_lost, time_seconds, attempt_no,
                                 is_first_attempt, captured_at, triaged_at, created_at, updated_at)
           VALUES (?, 'practice', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          q.id,
          ts,
          s.outcome,
          q.marks,
          thirdsToMarks(s.obtainedThirds),
          thirdsToMarks(s.lostThirds),
          input.totalSeconds,
          attemptNo,
          attemptNo === 1 ? 1 : 0,
          ts,
          ts,
          ts,
        ).lastInsertRowid,
    );

    const ins = db.prepare(
      `INSERT INTO attempt_options (attempt_id, question_option_id, my_verdict, justification,
                                    is_verdict_correct, seconds) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const v of input.verdicts) {
      ins.run(
        id,
        v.optionId,
        v.myVerdict ? 1 : 0,
        v.justification.trim(),
        v.myVerdict === correctById.get(v.optionId) ? 1 : 0,
        v.seconds,
      );
    }
    return id;
  })();

  append({ op: 'insert', table: 'attempt_options', id: attemptId, note: 'msq trainer' });
  return { attemptId };
}

export function msqPerOptionRows(
  db: DB = getDb(),
): { attemptId: number; attemptedAt: string; right: number; total: number }[] {
  return db
    .prepare(
      `SELECT a.id AS attemptId, a.attempted_at AS attemptedAt,
              SUM(ao.is_verdict_correct) AS right, COUNT(*) AS total
         FROM attempts a JOIN attempt_options ao ON ao.attempt_id = a.id
        GROUP BY a.id ORDER BY a.attempted_at`,
    )
    .all() as never;
}

// ---------------------------------------------------------------------------
// Drills
// ---------------------------------------------------------------------------

export function recordDrillRun(
  r: {
    templateKey: string;
    seed: number;
    params: Record<string, unknown>;
    expected: string;
    given: string | null;
    correct: boolean;
    seconds: number;
    boundaryClassId: number | null;
  },
  db: DB = getDb(),
): { drillRunId: number; attemptId: number | null } {
  const ts = now();
  let attemptId: number | null = null;

  const drillRunId = db.transaction(() => {
    // A wrong drill auto-creates an error-log entry tagged to the boundary
    // class. It lands with context 'drill', which the procedural-share
    // computation excludes by construction.
    if (!r.correct && r.boundaryClassId !== null) {
      const sourceId = ensureSource('Boundary drills', db);
      const qNo = `${r.templateKey}#${r.seed}`;
      const existing = db
        .prepare('SELECT id FROM questions WHERE source_id = ? AND source_q_no = ?')
        .get(sourceId, qNo) as { id: number } | undefined;
      const questionId =
        existing?.id ??
        Number(
          db
            .prepare(
              `INSERT INTO questions (source_id, source_q_no, marks, qtype, paraphrase,
                                      correct_answer, created_at, updated_at)
               VALUES (?, ?, 1, 'NAT', ?, ?, ?, ?)`,
            )
            .run(sourceId, qNo, `Boundary drill: ${r.templateKey}`, r.expected, ts, ts)
            .lastInsertRowid,
        );

      const prev = db
        .prepare('SELECT COALESCE(MAX(attempt_no), 0) AS n FROM attempts WHERE question_id = ?')
        .get(questionId) as { n: number };

      attemptId = Number(
        db
          .prepare(
            `INSERT INTO attempts (question_id, context, attempted_at, my_answer, outcome,
                                   marks_available, marks_obtained, marks_lost, time_seconds,
                                   error_class_id, attempt_no, is_first_attempt,
                                   captured_at, created_at, updated_at)
             VALUES (?, 'drill', ?, ?, 'wrong', 1, 0, 1, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            questionId,
            ts,
            r.given,
            r.seconds,
            r.boundaryClassId,
            prev.n + 1,
            prev.n === 0 ? 1 : 0,
            ts,
            ts,
            ts,
          ).lastInsertRowid,
      );
    }

    return Number(
      db
        .prepare(
          `INSERT INTO drill_runs (template_key, seed, params_json, expected, given, correct,
                                   seconds, attempt_id, run_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.templateKey,
          r.seed,
          JSON.stringify(r.params),
          r.expected,
          r.given,
          r.correct ? 1 : 0,
          r.seconds,
          attemptId,
          ts,
        ).lastInsertRowid,
    );
  })();

  append({ op: 'insert', table: 'drill_runs', id: drillRunId });
  return { drillRunId, attemptId };
}

export function drillStats(
  db: DB = getDb(),
): { templateKey: string; runs: number; correct: number; avgSeconds: number }[] {
  return db
    .prepare(
      `SELECT template_key AS templateKey, COUNT(*) AS runs,
              SUM(correct) AS correct, AVG(seconds) AS avgSeconds
         FROM drill_runs GROUP BY template_key ORDER BY runs DESC`,
    )
    .all() as never;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

export interface MockRow {
  id: number;
  date: string;
  started_at: string | null;
  started_at_0930: number;
  environment: string;
  duration_minutes: number | null;
  raw_score: number | null;
  attempted: number | null;
  correct: number | null;
  wrong: number | null;
  skipped: number | null;
  marks_lost_negative: number | null;
  triage_completed_at: string | null;
  notes: string;
}

export function listMocks(db: DB = getDb()): MockRow[] {
  return db.prepare('SELECT * FROM mocks ORDER BY date DESC, id DESC').all() as MockRow[];
}

export function getMock(id: number, db: DB = getDb()): MockRow | null {
  return (db.prepare('SELECT * FROM mocks WHERE id = ?').get(id) as MockRow) ?? null;
}

/** 09:15–09:45 is the discipline window; anything outside is recorded as false. */
export function startedAt0930(startedAt: string | null, db: DB = getDb()): boolean {
  if (!startedAt) return false;
  const t = getConfig<{ mock_start_window?: { earliest: string; latest: string } }>('targets', db);
  const w = t?.mock_start_window ?? { earliest: '09:15', latest: '09:45' };
  const hhmm = startedAt.length > 10 ? startedAt.slice(11, 16) : startedAt;
  return hhmm >= w.earliest && hhmm <= w.latest;
}

export function createMock(
  m: { date: string; startedAt: string | null; environment: 'home' | 'away'; notes?: string },
  db: DB = getDb(),
): number {
  const ts = now();
  const id = Number(
    db
      .prepare(
        `INSERT INTO mocks (date, started_at, started_at_0930, environment, duration_minutes,
                            notes, created_at)
         VALUES (?, ?, ?, ?, 180, ?, ?)`,
      )
      .run(
        m.date,
        m.startedAt,
        startedAt0930(m.startedAt, db) ? 1 : 0,
        m.environment,
        m.notes ?? '',
        ts,
      ).lastInsertRowid,
  );
  append({ op: 'insert', table: 'mocks', id, data: m });
  return id;
}

export function mockAttempts(mockId: number, db: DB = getDb()): AttemptRow[] {
  return (
    db.prepare(`${ATTEMPT_SELECT} WHERE a.mock_id = ? ORDER BY a.id`).all(mockId) as Record<
      string,
      unknown
    >[]
  ).map(hydrate);
}

/**
 * Recompute a mock's totals. The score is only revealed once every wrong,
 * skipped or guessed-correct question has an error class — the triage is the
 * price of the number.
 */
export function recomputeMock(mockId: number, db: DB = getDb()): MockRow {
  const rows = mockAttempts(mockId, db);
  const needsTriage = rows.filter(
    (r) =>
      (r.outcome === 'wrong' || r.outcome === 'skipped' || r.outcome === 'correct_but_guessed') &&
      r.triaged_at === null,
  );

  const raw = rows.reduce((a, r) => a + (r.marks - (r.marks_lost ?? 0)), 0);
  const attempted = rows.filter((r) => r.outcome !== 'skipped').length;
  const correct = rows.filter((r) => r.outcome === 'correct' || r.outcome === 'correct_but_guessed').length;
  const wrong = rows.filter((r) => r.outcome === 'wrong').length;
  const skipped = rows.filter((r) => r.outcome === 'skipped').length;
  const negatives = rows
    .filter((r) => r.outcome === 'wrong' && r.qtype === 'MCQ')
    .reduce((a, r) => a + r.marks / 3, 0);

  const ts = now();
  db.prepare(
    `UPDATE mocks SET raw_score = ?, attempted = ?, correct = ?, wrong = ?, skipped = ?,
                      marks_lost_negative = ?, triage_completed_at = ? WHERE id = ?`,
    // Stored unrounded. Rounding here would compound across a rolling
    // three-mock average; formatting belongs at the display boundary.
  ).run(
    raw,
    attempted,
    correct,
    wrong,
    skipped,
    negatives,
    needsTriage.length === 0 && rows.length > 0 ? ts : null,
    mockId,
  );

  append({ op: 'update', table: 'mocks', id: mockId, note: `raw ${raw.toFixed(2)}` });
  return getMock(mockId, db)!;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function logSession(
  s: { date: string; block: string; subjectId?: number | null; plannedMinutes: number; actualMinutes: number; note?: string },
  db: DB = getDb(),
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO sessions (date, block, subject_id, planned_minutes, actual_minutes, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.date, s.block, s.subjectId ?? null, s.plannedMinutes, s.actualMinutes, s.note ?? '', now())
      .lastInsertRowid,
  );
  append({ op: 'insert', table: 'sessions', id, data: s });
  return id;
}

export function hoursSince(fromDate: string, db: DB = getDb()): number {
  const r = db
    .prepare('SELECT COALESCE(SUM(actual_minutes), 0) AS m FROM sessions WHERE date >= ?')
    .get(fromDate) as { m: number };
  return r.m / 60;
}

export function listSessions(limit = 60, db: DB = getDb()): unknown[] {
  return db
    .prepare(
      `SELECT s.*, sub.name AS subject_name FROM sessions s
         LEFT JOIN subjects sub ON sub.id = s.subject_id
        ORDER BY s.date DESC, s.id DESC LIMIT ?`,
    )
    .all(limit);
}

// ---------------------------------------------------------------------------
// PYQ coverage
// ---------------------------------------------------------------------------

export function pyqGrid(db: DB = getDb()): {
  sources: { id: number; label: string; year: number | null }[];
  subjects: Subject[];
  cells: {
    sourceId: number;
    subjectId: number | null;
    total: number;
    triaged: number;
    correct: number;
    marksLost: number;
    lastTouched: string | null;
  }[];
} {
  const cells = db
    .prepare(
      `SELECT q.source_id AS sourceId, q.subject_id AS subjectId,
              COUNT(DISTINCT q.id) AS total,
              SUM(CASE WHEN a.triaged_at IS NOT NULL THEN 1 ELSE 0 END) AS triaged,
              SUM(CASE WHEN a.outcome IN ('correct','correct_but_guessed') THEN 1 ELSE 0 END) AS correct,
              COALESCE(SUM(a.marks_lost), 0) AS marksLost,
              MAX(a.attempted_at) AS lastTouched
         FROM questions q
         LEFT JOIN attempts a ON a.question_id = q.id
        GROUP BY q.source_id, q.subject_id`,
    )
    .all() as never;

  return {
    sources: db
      .prepare("SELECT id, label, year FROM sources WHERE kind IN ('pyq','sectional') ORDER BY year DESC, label")
      .all() as never,
    subjects: subjects(db),
    cells,
  };
}

/** First-attempt accuracy is the honest number; re-attempts are inflated by recall. */
export function attemptSplit(db: DB = getDb()): {
  first: { n: number; correct: number };
  repeat: { n: number; correct: number };
} {
  const rows = db
    .prepare(
      `SELECT is_first_attempt AS f, COUNT(*) AS n,
              SUM(CASE WHEN outcome IN ('correct','correct_but_guessed') THEN 1 ELSE 0 END) AS correct
         FROM attempts WHERE outcome IS NOT NULL AND context <> 'drill' GROUP BY is_first_attempt`,
    )
    .all() as { f: number; n: number; correct: number }[];

  const pick = (f: number) => rows.find((r) => r.f === f) ?? { n: 0, correct: 0 };
  return { first: pick(1), repeat: pick(0) };
}

/** Anything wrong or guessed-correct comes back. */
export function revisitQueue(db: DB = getDb()): AttemptRow[] {
  return (
    db
      .prepare(
        `${ATTEMPT_SELECT}
          WHERE a.outcome IN ('wrong','correct_but_guessed','skipped')
            AND a.attempt_no = (SELECT MAX(attempt_no) FROM attempts x WHERE x.question_id = a.question_id)
          ORDER BY a.attempted_at ASC LIMIT 200`,
      )
      .all() as Record<string, unknown>[]
  ).map(hydrate);
}

export function subjectAccuracy(
  since: string,
  db: DB = getDb(),
): { subject: string; attempts: number; accuracy: number; marksLost: number }[] {
  return db
    .prepare(
      `SELECT COALESCE(s.name, 'Unassigned') AS subject, COUNT(*) AS attempts,
              AVG(CASE WHEN a.outcome IN ('correct','correct_but_guessed') THEN 1.0 ELSE 0.0 END) AS accuracy,
              COALESCE(SUM(a.marks_lost), 0) AS marksLost
         FROM attempts a
         JOIN questions q ON q.id = a.question_id
         LEFT JOIN subjects s ON s.id = q.subject_id
        WHERE a.outcome IS NOT NULL AND a.context <> 'drill' AND a.attempted_at >= ?
        GROUP BY s.id ORDER BY marksLost DESC`,
    )
    .all(since) as never;
}

export function conceptCost(db: DB = getDb()): unknown[] {
  return db
    .prepare('SELECT * FROM v_concept_cost WHERE marks_lost > 0 ORDER BY marks_lost DESC')
    .all();
}

export function confidenceObservations(
  db: DB = getDb(),
): { confidence: number; wasCorrect: boolean }[] {
  return (
    db
      .prepare(
        `SELECT confidence, outcome FROM attempts
          WHERE confidence IS NOT NULL AND outcome IS NOT NULL
            AND outcome <> 'skipped' AND context <> 'drill'`,
      )
      .all() as { confidence: number; outcome: string }[]
  ).map((r) => ({
    confidence: r.confidence,
    wasCorrect: r.outcome === 'correct' || r.outcome === 'correct_but_guessed',
  }));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
