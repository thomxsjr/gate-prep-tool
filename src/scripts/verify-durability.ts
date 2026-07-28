/**
 * Durability proof.
 *
 *   write real rows → back up → DELETE the database → restore → compare
 *
 * Runs against an isolated temp database so it never touches the live
 * gate.db. Exits non-zero on any mismatch. Nothing else in M0 matters if this
 * does not pass.
 */

import { mkdtempSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Redirect every path BEFORE importing anything that reads them at module load.
const sandbox = mkdtempSync(resolve(tmpdir(), 'gate-durability-'));
process.env.GATE_DB = resolve(sandbox, 'gate.db');
process.env.GATE_DATA_DIR = resolve(sandbox, 'data');

const { openDb, closeDb, DB_PATH, JOURNAL_DIR } = await import('../db/index.ts');
const { migrate } = await import('../db/migrate.ts');
const { seed } = await import('../db/seed.ts');
const { backup } = await import('../scripts/backup.ts');
const { restore, countRows } = await import('../scripts/restore.ts');
const { buildExport, contentHash } = await import('../scripts/export.ts');

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

console.log(`durability: sandbox ${sandbox}\n`);

// --- 1. build ---------------------------------------------------------------
console.log('1. build');
let db = openDb();
migrate(db, true);
seed(db, undefined, true);
check('migrations applied', true, `schema v${schemaVersion(db)}`);
check('seed loaded', countRows(db) > 0, `${countRows(db)} rows`);

// --- 2. write representative data ------------------------------------------
console.log('\n2. write');
const now = new Date().toISOString();

const sourceId = Number(
  db
    .prepare(
      `INSERT INTO sources (kind, exam, year, paper, label, created_at)
       VALUES ('pyq', 'GATE DA', 2026, 'Forenoon', 'GATE DA 2026', ?)`,
    )
    .run(now).lastInsertRowid,
);

const subjectId = (db.prepare("SELECT id FROM subjects WHERE code = 'ALGO'").get() as { id: number }).id;
const msqClassId = (db.prepare("SELECT id FROM error_classes WHERE code = 'MSQ_STOP'").get() as { id: number }).id;
const boundaryClassId = (db.prepare("SELECT id FROM error_classes WHERE code = 'BOUNDARY'").get() as { id: number }).id;

const insertQuestion = db.prepare(`
  INSERT INTO questions (source_id, source_q_no, marks, qtype, subject_id,
                         paraphrase, correct_answer, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const q1 = Number(insertQuestion.run(sourceId, 'Q41', 2, 'MSQ', subjectId,
  'My paraphrase: which statements about the traversal hold?', 'A,C', now, now).lastInsertRowid);
const q2 = Number(insertQuestion.run(sourceId, 'Q17', 1, 'MCQ', subjectId,
  'My paraphrase: comparison count for binary search on a sorted array.', 'B', now, now).lastInsertRowid);

const insertOption = db.prepare(
  'INSERT INTO question_options (question_id, label, is_correct, sort_order) VALUES (?, ?, ?, ?)',
);
for (const [i, [label, correct]] of ([['A', 1], ['B', 0], ['C', 1], ['D', 0]] as const).entries()) {
  insertOption.run(q1, label, correct, i);
}

const mockId = Number(
  db
    .prepare(
      `INSERT INTO mocks (date, started_at, started_at_0930, environment, duration_minutes, created_at)
       VALUES (?, ?, 1, 'home', 180, ?)`,
    )
    .run('2026-07-28', '2026-07-28T09:31:00', now).lastInsertRowid,
);

const insertAttempt = db.prepare(`
  INSERT INTO attempts (question_id, mock_id, context, attempted_at, my_answer, outcome,
                        marks_available, marks_obtained, marks_lost, time_seconds, confidence,
                        error_class_id, what_i_thought, broke_at_step, prevention_rule,
                        attempt_no, is_first_attempt, captured_at, triaged_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const a1 = Number(insertAttempt.run(q1, mockId, 'mock', now, 'A,C,D', 'wrong',
  2, 0, 2, 210, 80, msqClassId,
  'Saw A and C were right and stopped checking.',
  'Committed after option C without evaluating D.',
  'Read every option to the end before submitting an MSQ. No exceptions.',
  1, 1, now, now, now, now).lastInsertRowid);
insertAttempt.run(q2, mockId, 'mock', now, 'C', 'wrong',
  1, -1 / 3, 4 / 3, 95, 65, boundaryClassId,
  'Used log2(n) without the +1.',
  'Dropped the floor(...)+1 term in the comparison count.',
  'Write the recurrence out before quoting a closed form.',
  1, 1, now, now, now, now);

const optionIds = db.prepare('SELECT id, is_correct FROM question_options WHERE question_id = ?').all(q1) as
  { id: number; is_correct: number }[];
const insertAttemptOption = db.prepare(`
  INSERT INTO attempt_options (attempt_id, question_option_id, my_verdict, justification,
                               is_verdict_correct, seconds)
  VALUES (?, ?, ?, ?, ?, ?)
`);
for (const [i, o] of optionIds.entries()) {
  const myVerdict = i === 3 ? 1 : o.is_correct; // got D wrong: the near-miss
  insertAttemptOption.run(a1, o.id, myVerdict, 'Checked against the traversal order.',
    myVerdict === o.is_correct ? 1 : 0, 45);
}

db.prepare(`
  INSERT INTO cards (type, front, back, subject_id, origin_attempt_id, due_date,
                     interval_days, ease, reps, lapses, created_at, updated_at)
  VALUES ('procedure', ?, ?, ?, ?, ?, 1, 2.5, 1, 0, ?, ?)
`).run('Recite the MSQ submission procedure.',
  '1. Verdict every option. 2. Justify each. 3. Only then submit.',
  subjectId, a1, '2026-07-29', now, now);

db.prepare(`
  INSERT INTO sessions (date, block, subject_id, planned_minutes, actual_minutes, note, created_at)
  VALUES (?, 'deep_work', ?, 150, 145, ?, ?)
`).run('2026-07-28', subjectId, 'PYQ saturation, algorithms.', now);

const rungId = (db.prepare('SELECT id FROM rungs WHERE ordinal = 1').get() as { id: number }).id;
db.prepare(`
  INSERT INTO rung_items (rung_id, label, kind, status, question_id, created_at)
  VALUES (?, ?, 'question', 'open', ?, ?)
`).run(rungId, 'GATE DA 2026 Q41 — stopped at option C', q1, now);

const written = countRows(db);
check('representative rows written', written > 0, `${written} rows across the schema`);

// --- 3. export + backup -----------------------------------------------------
console.log('\n3. back up');
const before = buildExport(db);
const hashBefore = contentHash(before);
const b = backup(db, new Date(), DB_PATH);
check('backup produced .db + .json', existsSync(b.dbPath) && existsSync(b.jsonPath));
check('canonical export written', existsSync(b.canonicalPath), b.canonicalPath.replace(sandbox, '.'));
check('backup hash matches live db', b.hash === hashBefore, b.hash.slice(0, 16));

const journalFiles = existsSync(JOURNAL_DIR) ? readdirSync(JOURNAL_DIR) : [];
const journalLines = journalFiles.reduce(
  (n, f) => n + readFileSync(resolve(JOURNAL_DIR, f), 'utf8').trim().split('\n').filter(Boolean).length,
  0,
);
check('write journal populated', journalLines > 0, `${journalLines} lines in ${journalFiles.length} file(s)`);

// --- 4. destroy -------------------------------------------------------------
console.log('\n4. destroy');
closeDb();
db.close();
for (const suffix of ['', '-wal', '-shm']) {
  const p = `${DB_PATH}${suffix}`;
  if (existsSync(p)) rmSync(p);
}
check('database deleted', !existsSync(DB_PATH), DB_PATH.replace(sandbox, '.'));

// --- 5. restore -------------------------------------------------------------
console.log('\n5. restore');
db = openDb();
const r = restore(b.canonicalPath, db, { quiet: true });
check('restore completed', r.rows > 0, `${r.rows} rows across ${r.tables} tables`);

const fk = db.pragma('foreign_key_check') as unknown[];
check('foreign keys intact', fk.length === 0, `${fk.length} violation(s)`);

// --- 6. compare -------------------------------------------------------------
console.log('\n6. compare');
const after = buildExport(db);
const hashAfter = contentHash(after);
check('row count identical', countRows(db) === written, `${countRows(db)} vs ${written}`);
check('content hash identical', hashAfter === hashBefore,
  hashAfter === hashBefore ? hashAfter.slice(0, 16) : `${hashBefore.slice(0, 12)} != ${hashAfter.slice(0, 12)}`);

// Spot-check the row that matters most: a triaged error-log entry.
const roundTripped = db
  .prepare('SELECT prevention_rule, marks_lost FROM attempts WHERE question_id = ?')
  .get(q1) as { prevention_rule: string; marks_lost: number } | undefined;
check('error-log content survived verbatim',
  roundTripped?.prevention_rule === 'Read every option to the end before submitting an MSQ. No exceptions.',
  roundTripped ? `marks_lost ${roundTripped.marks_lost}` : 'row missing');

// --- report -----------------------------------------------------------------
db.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\ndurability: ${checks.length - failed.length}/${checks.length} checks passed`);

if (failed.length > 0) {
  console.error(`durability: FAILED — ${failed.map((f) => f.name).join(', ')}`);
  console.error(`durability: sandbox kept for inspection at ${sandbox}`);
  process.exit(1);
}

rmSync(sandbox, { recursive: true, force: true });
console.log('durability: PASSED — write, back up, delete, restore, verify');

function schemaVersion(d: import('better-sqlite3').Database): number {
  const r = d.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return r.v ?? 0;
}
