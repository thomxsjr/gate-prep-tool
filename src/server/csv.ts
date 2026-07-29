/**
 * CSV import for the error log.
 *
 * Bring your own data. Header names are matched case- and space-insensitively.
 *
 * Required : source, qtype, marks, outcome
 * Optional : q_no, subject, context, my_answer, correct_answer, time_seconds,
 *            confidence, error_class, what_i_thought, broke_at_step,
 *            prevention_rule, paraphrase, attempted_at, concept
 *
 * A row carrying a full diagnosis (error class + both structured fields) is
 * imported already triaged. Anything less lands in the triage queue rather
 * than being silently accepted as diagnosed — the same rule the UI enforces.
 */

import { type DB, getDb } from '../db/index.ts';
import * as repo from './repo.ts';
import type { CaptureInput, Context, Outcome, QType } from '../shared/types.ts';

export function parseCsv(text: string): Record<string, string>[] {
  const rows = splitRows(text);
  if (rows.length === 0) return [];

  const header = rows[0]!.map(norm);
  return rows.slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** RFC4180-ish: quoted fields, doubled quotes, embedded newlines and commas. */
function splitRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/[\s-]+/g, '_');

export interface ImportReport {
  imported: number;
  triaged: number;
  queued: number;
  skipped: number;
  errors: { row: number; message: string }[];
}

export function importErrorCsv(text: string, db: DB = getDb()): ImportReport {
  const rows = parseCsv(text);
  const report: ImportReport = { imported: 0, triaged: 0, queued: 0, skipped: 0, errors: [] };

  const classes = repo.errorClasses(db);
  const byCode = new Map(classes.map((c) => [c.code.toLowerCase(), c.id]));
  const byName = new Map(classes.map((c) => [c.name.toLowerCase(), c.id]));
  const subjects = repo.subjects(db);
  const subjByCode = new Map(subjects.map((s) => [s.code.toLowerCase(), s.id]));
  const subjByName = new Map(subjects.map((s) => [s.name.toLowerCase(), s.id]));

  rows.forEach((r, i) => {
    const line = i + 2;
    try {
      const source = r['source'] ?? r['source_label'] ?? '';
      if (!source) throw new Error('source is required');

      const qtype = (r['qtype'] ?? r['type'] ?? '').toUpperCase() as QType;
      if (!['MCQ', 'MSQ', 'NAT'].includes(qtype)) throw new Error(`qtype must be MCQ, MSQ or NAT`);

      const marks = Number(r['marks']);
      if (marks !== 1 && marks !== 2) throw new Error('marks must be 1 or 2');

      const outcome = (r['outcome'] ?? '').toLowerCase().replace(/[\s-]+/g, '_') as Outcome;
      if (!['correct', 'wrong', 'skipped', 'correct_but_guessed'].includes(outcome)) {
        throw new Error('outcome must be correct, wrong, skipped or correct_but_guessed');
      }

      const ctxRaw = (r['context'] ?? 'pyq').toLowerCase();
      const context = (['practice', 'mock', 'sectional', 'pyq', 'drill', 'review'].includes(ctxRaw)
        ? ctxRaw
        : 'pyq') as Context;

      const subjectKey = (r['subject'] ?? '').toLowerCase();
      const subjectId = subjByCode.get(subjectKey) ?? subjByName.get(subjectKey) ?? null;

      const classKey = (r['error_class'] ?? '').toLowerCase();
      const errorClassId = byCode.get(classKey) ?? byName.get(classKey) ?? null;

      const input: CaptureInput = {
        sourceLabel: source,
        sourceQNo: r['q_no'] || r['question'] || null,
        qtype,
        marks: marks as 1 | 2,
        subjectId,
        context,
        outcome,
        myAnswer: r['my_answer'] || null,
        correctAnswer: r['correct_answer'] || null,
        timeSeconds: r['time_seconds'] ? Number(r['time_seconds']) : null,
        confidence: r['confidence'] ? Number(r['confidence']) : null,
        errorClassId,
        paraphrase: r['paraphrase'] ?? '',
        attemptedAt: r['attempted_at'] || undefined,
      };

      const attempt = repo.capture(input, db);
      report.imported += 1;

      const whatIThought = r['what_i_thought'] ?? '';
      const broke = r['broke_at_step'] ?? r['correct_reasoning'] ?? '';
      const prevention = r['prevention_rule'] ?? '';

      const limits = repo.triageLimits(db);
      const canTriage =
        errorClassId !== null &&
        broke.trim().length >= limits.minBrokeAtStep &&
        prevention.trim().length >= limits.minPreventionRule &&
        whatIThought.trim().length >= limits.minWhatIThought;

      if (canTriage) {
        repo.triage(
          attempt.id,
          {
            errorClassId: errorClassId!,
            whatIThought,
            brokeAtStep: broke,
            preventionRule: prevention,
            subjectId,
            conceptName: r['concept'] || null,
          },
          db,
        );
        report.triaged += 1;
      } else {
        report.queued += 1;
      }
    } catch (err) {
      report.skipped += 1;
      report.errors.push({ row: line, message: (err as Error).message });
    }
  });

  return report;
}

export const CSV_TEMPLATE = [
  'source,q_no,qtype,marks,subject,context,outcome,my_answer,correct_answer,time_seconds,confidence,error_class,what_i_thought,broke_at_step,prevention_rule,paraphrase,concept',
  'GATE DA 2025,Q41,MSQ,2,ALGO,pyq,wrong,"A,C","A,C,D",210,80,MSQ_STOP,Saw A and C were right and stopped,Committed after option C without evaluating D,Read every option to the end before submitting an MSQ,Which statements about the traversal hold?,MSQ discipline',
].join('\n');
