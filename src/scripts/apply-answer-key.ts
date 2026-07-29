/**
 * Apply an official answer key to an imported response sheet.
 *
 *   npm run apply:key -- data/import/gate-da-2026-key.json --source "GATE DA 2026"
 *   ... --dry-run
 *
 * THE JOIN IS ON QUESTION ID, NOT POSITION. GATE shuffles question order per
 * candidate, so the response sheet's Q-numbers and the key's Q-numbers are
 * different orderings of the same paper. The exam's own question IDs are
 * contiguous in master-paper order, which gives an offset; the offset is then
 * validated against question type and section for EVERY question before
 * anything is written. Nothing is written on a partial match.
 *
 * OPTION LABELS ARE CHECKED BEFORE USE. NAT questions have no options and act
 * as a control group. If the option-bearing types score at chance while NAT
 * does not, the recorded labels are noise and MCQ/MSQ outcomes are left for a
 * human. See src/domain/option-shuffle.ts.
 */

import { readFileSync } from 'node:fs';
import { type DB, getDb } from '../db/index.ts';
import { appendMany, type JournalEntry } from '../db/journal.ts';
import { isMain } from '../lib/is-main.ts';
import { isMsqCorrect, isNatCorrect, score } from '../domain/scoring.ts';
import { thirdsToMarks } from '../domain/marking.ts';
import { detectOptionShuffle, type ScoredSample } from '../domain/option-shuffle.ts';

export interface KeyEntry {
  paper_q_no: number;
  session: number;
  qtype: 'MCQ' | 'MSQ' | 'NAT';
  section: 'GA' | 'SUBJECT';
  marks: 1 | 2;
  key_raw: string;
  answer: string;
  tolerance: number | null;
}

export interface KeyBundle {
  format: 'gate-prep-tool/answer-key';
  version: 1;
  label: string;
  exam: string;
  year: number;
  session: number;
  entries: KeyEntry[];
}

interface QuestionRow {
  id: number;
  source_q_no: string;
  qtype: 'MCQ' | 'MSQ' | 'NAT';
  marks: number;
  section: string | null;
  external_ref: string | null;
}

export interface JoinResult {
  offset: number;
  matched: number;
  total: number;
  /** Agreement on type + section, the fields that come verbatim off the sheet. */
  agreement: number;
  marksCorrections: { question: string; from: number; to: number }[];
}

/**
 * Find the offset mapping external_ref to paper question number, and validate
 * it. Marks are excluded from validation — they are derived, and were in fact
 * wrong for four questions, so validating against them would reject the
 * correct offset.
 */
export function solveJoin(
  questions: readonly QuestionRow[],
  entries: readonly KeyEntry[],
): JoinResult | null {
  const byPaperNo = new Map(entries.map((e) => [e.paper_q_no, e]));
  const refs = questions
    .map((q) => Number(q.external_ref))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (refs.length !== questions.length) return null;

  // Candidate offsets: align the lowest id with the lowest paper number, and
  // try a small neighbourhood in case the sheet omits a question.
  const minRef = Math.min(...refs);
  const minPaper = Math.min(...entries.map((e) => e.paper_q_no));
  const candidates = [-2, -1, 0, 1, 2].map((d) => minRef - minPaper + d);

  let best: JoinResult | null = null;

  for (const offset of candidates) {
    let agreement = 0;
    const marksCorrections: JoinResult['marksCorrections'] = [];

    for (const q of questions) {
      const e = byPaperNo.get(Number(q.external_ref) - offset);
      if (!e) continue;
      if (e.qtype === q.qtype && e.section === q.section) {
        agreement += 1;
        if (e.marks !== q.marks) {
          marksCorrections.push({ question: q.source_q_no, from: q.marks, to: e.marks });
        }
      }
    }

    const r: JoinResult = {
      offset,
      matched: questions.length,
      total: questions.length,
      agreement,
      marksCorrections,
    };
    if (!best || r.agreement > best.agreement) best = r;
  }

  return best;
}

export interface ApplyOptions {
  sourceLabel: string;
  dryRun?: boolean;
  /** Override the automatic option-label check. */
  forceOptionLabels?: boolean;
}

export interface ApplyResult {
  join: JoinResult;
  labelsUnusable: boolean;
  reason: string;
  questionsUpdated: number;
  natScored: number;
  natCorrect: number;
  natMarks: number;
  leftForHuman: number;
  determinedMarks: number;
  determinableTotal: number;
}

export function applyKey(
  bundle: KeyBundle,
  opts: ApplyOptions,
  db: DB = getDb(),
): ApplyResult {
  const source = db.prepare('SELECT id FROM sources WHERE label = ?').get(opts.sourceLabel) as
    | { id: number }
    | undefined;
  if (!source) throw new Error(`no source labelled "${opts.sourceLabel}"`);

  const questions = db
    .prepare(
      'SELECT id, source_q_no, qtype, marks, section, external_ref FROM questions WHERE source_id = ?',
    )
    .all(source.id) as QuestionRow[];
  if (questions.length === 0) throw new Error(`source "${opts.sourceLabel}" has no questions`);

  const join = solveJoin(questions, bundle.entries);
  if (!join) throw new Error('questions are missing external_ref; cannot join on question ID');
  if (join.agreement !== questions.length) {
    throw new Error(
      `join validated on only ${join.agreement}/${questions.length} questions ` +
        `(type + section). Refusing to write a partial mapping.`,
    );
  }

  const byPaperNo = new Map(bundle.entries.map((e) => [e.paper_q_no, e]));

  // --- decide whether option labels mean anything ------------------------
  const samples: ScoredSample[] = [];
  for (const q of questions) {
    const e = byPaperNo.get(Number(q.external_ref) - join.offset)!;
    const attempt = db
      .prepare('SELECT my_answer FROM attempts WHERE question_id = ? AND attempt_no = 1')
      .get(q.id) as { my_answer: string | null } | undefined;
    const given = attempt?.my_answer;
    if (given == null || given === '') continue;

    samples.push({
      qtype: e.qtype,
      optionCount: 4,
      wasCorrect: isCorrect(e, given),
    });
  }

  const verdict = detectOptionShuffle(samples);
  const labelsUnusable = opts.forceOptionLabels ? false : verdict.labelsUnusable;

  // --- write --------------------------------------------------------------
  const now = new Date().toISOString();
  const journal: Omit<JournalEntry, 'ts'>[] = [];
  const result: ApplyResult = {
    join,
    labelsUnusable,
    reason: verdict.reason,
    questionsUpdated: 0,
    natScored: 0,
    natCorrect: 0,
    natMarks: 0,
    leftForHuman: 0,
    determinedMarks: 0,
    determinableTotal: 0,
  };

  const run = db.transaction(() => {
    const updQ = db.prepare(`
      UPDATE questions
         SET paper_q_no = ?, marks = ?, correct_answer = ?, answer_tolerance = ?,
             option_labels_comparable = ?, updated_at = ?
       WHERE id = ?
    `);
    const updA = db.prepare(`
      UPDATE attempts
         SET outcome = ?, marks_obtained = ?, marks_lost = ?, outcome_source = ?, updated_at = ?
       WHERE question_id = ? AND attempt_no = 1
    `);

    for (const q of questions) {
      const e = byPaperNo.get(Number(q.external_ref) - join.offset)!;
      const comparable = e.qtype === 'NAT' ? 1 : labelsUnusable ? 0 : 1;

      updQ.run(e.paper_q_no, e.marks, e.answer, e.tolerance, comparable, now, q.id);
      result.questionsUpdated += 1;

      const attempt = db
        .prepare('SELECT id, my_answer, outcome FROM attempts WHERE question_id = ? AND attempt_no = 1')
        .get(q.id) as { id: number; my_answer: string | null; outcome: string | null } | undefined;
      if (!attempt) continue;

      const given = attempt.my_answer;

      // A blank is already definitive; only correct its marks.
      if (given == null || given === '') {
        updA.run('skipped', 0, e.marks, 'response_sheet', now, q.id);
        result.determinedMarks += 0;
        result.determinableTotal += e.marks;
        continue;
      }

      if (comparable === 0) {
        // Cannot be decided from the key. Leave it for the triage queue.
        result.leftForHuman += 1;
        continue;
      }

      const ok = isCorrect(e, given);
      const s = score({ qtype: e.qtype, marks: e.marks, isCorrect: ok, attempted: true });
      updA.run(
        s.outcome,
        thirdsToMarks(s.obtainedThirds),
        thirdsToMarks(s.lostThirds),
        'answer_key',
        now,
        q.id,
      );

      if (e.qtype === 'NAT') {
        result.natScored += 1;
        if (ok) {
          result.natCorrect += 1;
          result.natMarks += e.marks;
        }
      }
      result.determinedMarks += thirdsToMarks(s.obtainedThirds);
      result.determinableTotal += e.marks;
      journal.push({ op: 'update', table: 'attempts', id: attempt.id, data: { outcome: s.outcome } });
    }
  });

  if (opts.dryRun) return result;
  run();
  appendMany(journal);
  return result;
}

export function isCorrect(e: KeyEntry, given: string): boolean {
  if (e.qtype === 'NAT') {
    const v = Number(given);
    return Number.isFinite(v) && isNatCorrect(v, Number(e.answer), e.tolerance ?? 0);
  }
  const sel = given.toUpperCase().split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const cor = e.answer.toUpperCase().split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (e.qtype === 'MSQ') return isMsqCorrect(sel, cor);
  return sel.length === 1 && cor.length === 1 && sel[0] === cor[0];
}

// --------------------------------------------------------------------------

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const srcIdx = args.indexOf('--source');
  const sourceLabel = srcIdx >= 0 ? (args[srcIdx + 1] ?? '') : '';

  if (!file || !sourceLabel) {
    console.error('usage: npm run apply:key -- <key.json> --source "GATE DA 2026" [--dry-run]');
    process.exit(1);
  }

  const bundle = JSON.parse(readFileSync(file, 'utf8')) as KeyBundle;
  if (bundle.format !== 'gate-prep-tool/answer-key') {
    console.error(`apply:key: ${file} is not an answer-key bundle`);
    process.exit(1);
  }

  const r = applyKey(bundle, { sourceLabel, dryRun });

  console.log(`apply:key: joined on question ID, offset ${r.join.offset}`);
  console.log(`apply:key: validated ${r.join.agreement}/${r.join.total} on type + section`);
  if (r.join.marksCorrections.length > 0) {
    console.log(`apply:key: corrected marks on ${r.join.marksCorrections.length} question(s):`);
    for (const c of r.join.marksCorrections) {
      console.log(`             ${c.question}  ${c.from} -> ${c.to}`);
    }
  }
  console.log('');
  console.log(`apply:key: option labels ${r.labelsUnusable ? 'UNUSABLE' : 'usable'}`);
  console.log(`apply:key: ${r.reason}`);
  console.log('');
  console.log(`apply:key: ${r.questionsUpdated} questions updated with the key`);
  console.log(`apply:key: NAT scored ${r.natCorrect}/${r.natScored} = ${r.natMarks.toFixed(2)} marks`);
  console.log(`apply:key: ${r.leftForHuman} MCQ/MSQ left for human triage`);
  console.log(
    `apply:key: determined ${r.determinedMarks.toFixed(2)} of ${r.determinableTotal.toFixed(2)} determinable marks`,
  );
  if (dryRun) console.log('apply:key: dry run, nothing written');
}
