/**
 * Importer for a TCS-iON / digialm candidate response sheet.
 *
 *   npm run import:response-sheet -- <file.html> [--label "GATE DA 2026"] [--dry-run]
 *
 * WHAT IT TAKES: question number, section, type, marks, the answer given, the
 * option chosen, the status. That is the user's own record of their sitting.
 *
 * WHAT IT DELIBERATELY DROPS: the question text and the option text. Those are
 * third-party content and the spec's non-goals forbid storing them. The
 * `paraphrase` column stays empty for the user to fill in their own words.
 *
 * Save the page from the browser (Cmd+S, "Web Page, HTML only") and pass the
 * local file — nothing here touches the network.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'node-html-parser';
import { type DB, getDb } from '../db/index.ts';
import { appendMany, type JournalEntry } from '../db/journal.ts';
import { isMain } from '../lib/is-main.ts';

export interface ParsedQuestion {
  questionNumber: number;
  /** 'MCQ' | 'MSQ' | 'NAT', inferred from the option/answer shape. */
  qtype: 'MCQ' | 'MSQ' | 'NAT';
  section: string | null;
  /** Option label(s) chosen, or the typed value for NAT. */
  given: string | null;
  status: string | null;
  optionCount: number;
}

/**
 * Response sheets vary by year and by host. This reads the common TCS-iON
 * layout: a `.question-pnl` block per question, with `.menu-tbl` rows holding
 * the metadata. Anything it cannot read is reported rather than guessed at.
 */
export function parseResponseSheet(html: string): {
  questions: ParsedQuestion[];
  warnings: string[];
} {
  const root = parse(html);
  const warnings: string[] = [];
  const questions: ParsedQuestion[] = [];

  const panels = root.querySelectorAll('.question-pnl');
  if (panels.length === 0) {
    warnings.push(
      'no .question-pnl blocks found — this may be a layout the parser has not seen. ' +
        'Run with --dump to inspect the structure.',
    );
  }

  for (const panel of panels) {
    const fields = new Map<string, string>();
    for (const row of panel.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const key = cells[0]!.text.replace(/\s+/g, ' ').trim().replace(/:$/, '');
        const val = cells[1]!.text.replace(/\s+/g, ' ').trim();
        if (key) fields.set(key, val);
      }
    }

    const qidRaw = fields.get('Question Number') ?? fields.get('Question No') ?? '';
    const questionNumber = Number(qidRaw.replace(/\D+/g, ''));
    if (!Number.isFinite(questionNumber) || questionNumber === 0) continue;

    const typeRaw = (fields.get('Question Type') ?? '').toUpperCase();
    const chosen =
      fields.get('Chosen Option') ??
      fields.get('Chosen Options') ??
      fields.get('Given Answer') ??
      null;

    const optionCount = panel.querySelectorAll('[class*="option"]').length;

    let qtype: ParsedQuestion['qtype'];
    if (typeRaw.includes('SA') || typeRaw.includes('NAT')) qtype = 'NAT';
    else if (typeRaw.includes('MSQ') || (chosen ?? '').includes(',')) qtype = 'MSQ';
    else qtype = 'MCQ';

    questions.push({
      questionNumber,
      qtype,
      section: fields.get('Section') ?? fields.get('Section Name') ?? null,
      given: chosen && chosen !== '--' ? chosen : null,
      status: fields.get('Status') ?? null,
      optionCount,
    });
  }

  if (questions.length > 0 && questions.length !== 65) {
    warnings.push(
      `parsed ${questions.length} questions; a GATE paper has 65. Check for a ` +
        `section the parser missed before importing.`,
    );
  }

  return { questions, warnings };
}

export interface ImportOptions {
  label: string;
  year: number;
  exam: string;
  dryRun?: boolean;
}

export function importQuestions(
  parsed: readonly ParsedQuestion[],
  opts: ImportOptions,
  db: DB = getDb(),
): { source: number | null; inserted: number } {
  if (opts.dryRun) return { source: null, inserted: 0 };

  const now = new Date().toISOString();
  const journal: Omit<JournalEntry, 'ts'>[] = [];
  let inserted = 0;
  let sourceId = 0;

  const run = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM sources WHERE label = ?').get(opts.label) as
      | { id: number }
      | undefined;

    sourceId =
      existing?.id ??
      Number(
        db
          .prepare(
            `INSERT INTO sources (kind, exam, year, paper, label, created_at)
             VALUES ('pyq', ?, ?, NULL, ?, ?)`,
          )
          .run(opts.exam, opts.year, opts.label, now).lastInsertRowid,
      );

    const insertQ = db.prepare(`
      INSERT INTO questions (source_id, source_q_no, marks, qtype, paraphrase, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', ?, ?)
      ON CONFLICT (source_id, source_q_no) DO NOTHING
    `);
    const insertOpt = db.prepare(`
      INSERT INTO question_options (question_id, label, is_correct, sort_order)
      VALUES (?, ?, 0, ?) ON CONFLICT (question_id, label) DO NOTHING
    `);

    for (const q of parsed) {
      // Marks are not on the response sheet. GATE numbers 1-mark questions
      // first within each section, but the split varies — left null-safe at 1
      // and corrected during triage rather than guessed at here.
      const info = insertQ.run(sourceId, `Q${q.questionNumber}`, 1, q.qtype, now, now);
      if (info.changes === 0) continue;
      inserted += 1;

      const qid = Number(info.lastInsertRowid);
      const n = q.optionCount > 0 && q.qtype !== 'NAT' ? Math.min(q.optionCount, 6) : 0;
      for (let i = 0; i < n; i += 1) {
        insertOpt.run(qid, String.fromCharCode(65 + i), i);
      }
      journal.push({ op: 'insert', table: 'questions', id: qid, data: { q: q.questionNumber } });
    }
  });

  run();
  appendMany(journal);
  return { source: sourceId, inserted };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const labelIdx = args.indexOf('--label');
  const label = labelIdx >= 0 ? (args[labelIdx + 1] ?? 'GATE DA 2026') : 'GATE DA 2026';

  if (!file || !existsSync(file)) {
    console.error('usage: npm run import:response-sheet -- <file.html> [--label "GATE DA 2026"] [--dry-run]');
    console.error('');
    console.error('Save the response sheet from your browser first (Web Page, HTML only).');
    console.error('This script never touches the network.');
    process.exit(1);
  }

  const { questions, warnings } = parseResponseSheet(readFileSync(file, 'utf8'));
  for (const w of warnings) console.warn(`import: WARNING ${w}`);

  const byType = questions.reduce<Record<string, number>>((a, q) => {
    a[q.qtype] = (a[q.qtype] ?? 0) + 1;
    return a;
  }, {});
  console.log(`import: parsed ${questions.length} questions ${JSON.stringify(byType)}`);
  const answered = questions.filter((q) => q.given !== null).length;
  console.log(`import: ${answered} answered, ${questions.length - answered} left blank`);

  if (dryRun) {
    console.log('import: dry run, nothing written');
  } else {
    const r = importQuestions(questions, { label, year: 2026, exam: 'GATE DA' });
    console.log(`import: inserted ${r.inserted} questions under source ${r.source}`);
    console.log('import: question text was NOT stored. Add your own paraphrase during triage.');
  }
}
