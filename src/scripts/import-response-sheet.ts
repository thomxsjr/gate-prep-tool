/**
 * Import a candidate response sheet.
 *
 *   npm run import:response-sheet -- data/import/gate-da-2026-response.json
 *   npm run import:response-sheet -- sheet.html --label "GATE DA 2026"
 *   ... --dry-run
 *
 * Accepts either the HTML sheet saved from the browser (the durable path) or
 * the JSON bundle produced by tools/extract-response-sheet-pdf.py.
 *
 * WHAT IT STORES: question number, section, type, marks, the option chosen or
 * value typed, and the exam's own question ID.
 *
 * WHAT IT DROPS: the question text and the option text. Third-party content is
 * never persisted; `paraphrase` stays empty for the user's own words.
 *
 * OUTCOMES ARE NOT INVENTED. A response sheet publishes no answer key, so an
 * answered question is imported with a NULL outcome meaning "not yet
 * determined". Only a blank is definitively known, and it lands as 'skipped'.
 * Every row arrives untriaged, which is what puts the whole paper into the
 * triage queue where the diagnosis belongs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'node-html-parser';
import { type DB, getDb } from '../db/index.ts';
import { appendMany, type JournalEntry } from '../db/journal.ts';
import { isMain } from '../lib/is-main.ts';

export type QType = 'MCQ' | 'MSQ' | 'NAT';

export interface SheetQuestion {
  number: number;
  section: 'GA' | 'SUBJECT';
  qtype: QType;
  marks: 1 | 2;
  status: string | null;
  /** Option label(s) chosen, or the typed NAT value. Null when left blank. */
  given: string | null;
  external_ref: string | null;
}

export interface SheetBundle {
  format: 'gate-prep-tool/response-sheet';
  version: 1;
  label: string;
  exam: string;
  year: number;
  paper?: string;
  source_meta?: Record<string, string>;
  questions: SheetQuestion[];
}

// --------------------------------------------------------------------------
// HTML path
// --------------------------------------------------------------------------

export function parseResponseSheetHtml(html: string): {
  questions: SheetQuestion[];
  warnings: string[];
} {
  const root = parse(html);
  const warnings: string[] = [];
  const raw: Omit<SheetQuestion, 'section' | 'marks'>[] = [];

  const panels = root.querySelectorAll('.question-pnl');
  if (panels.length === 0) {
    warnings.push('no .question-pnl blocks found — unrecognised layout');
  }

  for (const panel of panels) {
    const fields = new Map<string, string>();
    for (const row of panel.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const k = cells[0]!.text.replace(/\s+/g, ' ').trim().replace(/:$/, '');
        if (k) fields.set(k, cells[1]!.text.replace(/\s+/g, ' ').trim());
      }
    }

    const number = Number((fields.get('Question Number') ?? '').replace(/\D+/g, ''));
    if (!Number.isFinite(number) || number === 0) continue;

    const typeRaw = (fields.get('Question Type') ?? '').toUpperCase().replace(/\s+/g, '');
    const chosen =
      fields.get('Chosen Option') ?? fields.get('Chosen Options') ?? fields.get('Given Answer') ?? '';

    raw.push({
      number,
      qtype: typeRaw.includes('NAT') || typeRaw === 'NA' || typeRaw.includes('SA')
        ? 'NAT'
        : typeRaw.includes('MSQ')
          ? 'MSQ'
          : 'MCQ',
      status: fields.get('Status') ?? null,
      given: chosen && chosen !== '--' ? chosen : null,
      external_ref: fields.get('Question ID') ?? null,
    });
  }

  return { questions: assignSectionAndMarks(raw, warnings), warnings };
}

/**
 * Question numbers restart at 1 in the subject section, which is the only
 * reliable section boundary in these sheets. Marks come from the published
 * GATE DA structure: 1-mark questions precede 2-mark ones within a section.
 */
export function assignSectionAndMarks(
  raw: ReadonlyArray<Omit<SheetQuestion, 'section' | 'marks'>>,
  warnings: string[] = [],
): SheetQuestion[] {
  let section: 'GA' | 'SUBJECT' = 'GA';
  let prev = 0;

  const out = raw.map((q) => {
    if (q.number === 1 && prev !== 0) section = 'SUBJECT';
    prev = q.number;
    const marks: 1 | 2 =
      section === 'GA' ? (q.number <= 5 ? 1 : 2) : q.number <= 25 ? 1 : 2;
    return { ...q, section, marks };
  });

  const total = out.reduce((a, q) => a + q.marks, 0);
  if (out.length > 0 && total !== 100) {
    warnings.push(`derived marks total ${total}, expected 100 — do not trust the marks column`);
  }
  return out;
}

// --------------------------------------------------------------------------
// Import
// --------------------------------------------------------------------------

export interface ImportOptions {
  label: string;
  exam: string;
  year: number;
  paper?: string | null;
  /** Rung ordinal that non-attempts are filed against. */
  nonAttemptRung?: number;
  dryRun?: boolean;
}

export interface ImportResult {
  sourceId: number;
  questions: number;
  attempts: number;
  skipped: number;
  rungItems: number;
}

export function importSheet(
  questions: readonly SheetQuestion[],
  opts: ImportOptions,
  db: DB = getDb(),
): ImportResult {
  const now = new Date().toISOString();
  // The sitting itself, not the moment of import.
  const satAt = `${opts.year}-02-15T14:30:00`;
  const journal: Omit<JournalEntry, 'ts'>[] = [];
  const result: ImportResult = {
    sourceId: 0,
    questions: 0,
    attempts: 0,
    skipped: 0,
    rungItems: 0,
  };

  const run = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM sources WHERE label = ?').get(opts.label) as
      | { id: number }
      | undefined;

    result.sourceId =
      existing?.id ??
      Number(
        db
          .prepare(
            `INSERT INTO sources (kind, exam, year, paper, label, created_at)
             VALUES ('pyq', ?, ?, ?, ?, ?)`,
          )
          .run(opts.exam, opts.year, opts.paper ?? null, opts.label, now).lastInsertRowid,
      );

    const gaSubject = db.prepare("SELECT id FROM subjects WHERE code = 'GA'").get() as
      | { id: number }
      | undefined;

    const insertQ = db.prepare(`
      INSERT INTO questions (source_id, source_q_no, marks, qtype, section, subject_id,
                             external_ref, paraphrase, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)
      ON CONFLICT (source_id, source_q_no) DO NOTHING
    `);
    const insertOpt = db.prepare(`
      INSERT INTO question_options (question_id, label, is_correct, sort_order)
      VALUES (?, ?, 0, ?) ON CONFLICT (question_id, label) DO NOTHING
    `);
    const insertAttempt = db.prepare(`
      INSERT INTO attempts (question_id, context, attempted_at, my_answer, outcome,
                            marks_available, marks_obtained, marks_lost,
                            attempt_no, is_first_attempt, captured_at, triaged_at,
                            created_at, updated_at)
      VALUES (?, 'pyq', ?, ?, ?, ?, ?, ?, 1, 1, ?, NULL, ?, ?)
    `);

    const rung = db
      .prepare('SELECT id FROM rungs WHERE ordinal = ?')
      .get(opts.nonAttemptRung ?? 4) as { id: number } | undefined;
    const insertRungItem = db.prepare(`
      INSERT INTO rung_items (rung_id, label, kind, status, question_id, notes, created_at)
      VALUES (?, ?, 'question', 'open', ?, ?, ?)
    `);

    for (const q of questions) {
      const qNo = `${q.section}-Q${q.number}`;
      const info = insertQ.run(
        result.sourceId,
        qNo,
        q.marks,
        q.qtype,
        q.section,
        q.section === 'GA' ? (gaSubject?.id ?? null) : null,
        q.external_ref,
        now,
        now,
      );
      if (info.changes === 0) continue;

      const qid = Number(info.lastInsertRowid);
      result.questions += 1;

      // Option labels only — never option text. Correctness is unknown until
      // an official key is loaded, so every option starts is_correct = 0.
      if (q.qtype !== 'NAT') {
        for (let i = 0; i < 4; i += 1) insertOpt.run(qid, String.fromCharCode(65 + i), i);
      }

      const blank = q.given === null;
      insertAttempt.run(
        qid,
        satAt,
        q.given,
        // Only a blank is definitively known. An answered question stays NULL
        // until the key says otherwise.
        blank ? 'skipped' : null,
        q.marks,
        blank ? 0 : null,
        blank ? q.marks : null,
        now,
        now,
        now,
      );
      result.attempts += 1;

      if (blank) {
        result.skipped += 1;
        if (rung) {
          insertRungItem.run(
            rung.id,
            `${opts.label} ${qNo} — ${q.marks}-mark ${q.qtype}, left blank`,
            qid,
            'Imported from the response sheet. Decide: solvable at the time (non-attempt) or a genuine concept gap.',
            now,
          );
          result.rungItems += 1;
        }
      }

      journal.push({ op: 'insert', table: 'questions', id: qid, data: { qNo, marks: q.marks } });
    }
  });

  if (opts.dryRun) return result;
  run();
  appendMany(journal);
  return result;
}

// --------------------------------------------------------------------------

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const labelIdx = args.indexOf('--label');
  const labelArg = labelIdx >= 0 ? args[labelIdx + 1] : undefined;

  if (!file || !existsSync(file)) {
    console.error('usage: npm run import:response-sheet -- <file.json|file.html> [--label "..."] [--dry-run]');
    console.error('');
    console.error('  .html  response sheet saved from the browser (Web Page, HTML only)');
    console.error('  .json  bundle from tools/extract-response-sheet-pdf.py');
    console.error('');
    console.error('Nothing here touches the network.');
    process.exit(1);
  }

  let questions: SheetQuestion[];
  let opts: ImportOptions;

  if (file.endsWith('.json')) {
    const bundle = JSON.parse(readFileSync(file, 'utf8')) as SheetBundle;
    if (bundle.format !== 'gate-prep-tool/response-sheet') {
      console.error(`import: ${file} is not a response-sheet bundle`);
      process.exit(1);
    }
    questions = bundle.questions;
    opts = {
      label: labelArg ?? bundle.label,
      exam: bundle.exam,
      year: bundle.year,
      paper: bundle.paper ?? bundle.source_meta?.['test_time'] ?? null,
      dryRun,
    };
    if (bundle.source_meta) {
      console.log(`import: sitting ${JSON.stringify(bundle.source_meta)}`);
    }
  } else {
    const { questions: qs, warnings } = parseResponseSheetHtml(readFileSync(file, 'utf8'));
    for (const w of warnings) console.warn(`import: WARNING ${w}`);
    questions = qs;
    opts = { label: labelArg ?? 'GATE DA 2026', exam: 'GATE DA', year: 2026, dryRun };
  }

  const byType = questions.reduce<Record<string, number>>((a, q) => {
    a[q.qtype] = (a[q.qtype] ?? 0) + 1;
    return a;
  }, {});
  const blanks = questions.filter((q) => q.given === null);

  console.log(`import: ${questions.length} questions ${JSON.stringify(byType)}`);
  console.log(`import: ${questions.length - blanks.length} answered, ${blanks.length} blank ` +
    `(${blanks.reduce((a, q) => a + q.marks, 0)} marks)`);

  const r = importSheet(questions, opts);

  if (dryRun) {
    console.log('import: dry run, nothing written');
  } else {
    console.log(`import: ${r.questions} questions, ${r.attempts} attempts, ${r.rungItems} rung items`);
    console.log(`import: outcomes left NULL for answered questions — no answer key in a response sheet.`);
    console.log(`import: question text NOT stored. Add your own paraphrase during triage.`);
  }
}
