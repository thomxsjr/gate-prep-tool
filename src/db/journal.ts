/**
 * Append-only write journal.
 *
 * Every mutation appends one JSON line to `data/journal/YYYY-MM.jsonl` before
 * the caller sees success. The journal — not the .db — is the committed
 * asset: it is human-readable, diffable, survives a corrupt SQLite file, and
 * can rebuild the database from nothing.
 *
 * Written with an fsync so a crash cannot leave a torn line. The cost is
 * microseconds on a local disk and the whole point of the project is that six
 * months of error logs never go missing.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { JOURNAL_DIR } from './index.ts';

export type JournalOp = 'insert' | 'update' | 'delete' | 'migrate' | 'seed' | 'restore';

export interface JournalEntry {
  ts: string;
  op: JournalOp;
  table: string;
  id?: number | string | null;
  data?: unknown;
  note?: string;
}

export function journalPath(at: Date = new Date()): string {
  const month = at.toISOString().slice(0, 7);
  return resolve(JOURNAL_DIR, `${month}.jsonl`);
}

export function append(entry: Omit<JournalEntry, 'ts'>, at: Date = new Date()): void {
  mkdirSync(JOURNAL_DIR, { recursive: true });
  const line = JSON.stringify({ ts: at.toISOString(), ...entry }) + '\n';

  const fd = openSync(journalPath(at), 'a');
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function appendMany(
  entries: ReadonlyArray<Omit<JournalEntry, 'ts'>>,
  at: Date = new Date(),
): void {
  if (entries.length === 0) return;
  mkdirSync(JOURNAL_DIR, { recursive: true });
  const ts = at.toISOString();
  const payload = entries.map((e) => JSON.stringify({ ts, ...e })).join('\n') + '\n';

  const fd = openSync(journalPath(at), 'a');
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function journalExists(at: Date = new Date()): boolean {
  return existsSync(journalPath(at));
}
