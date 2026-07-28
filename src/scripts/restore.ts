/**
 * Restore from a JSON export.
 *
 * JSON, not the .db copy, is the primary restore path: it is the artifact
 * that survives a SQLite upgrade, and restoring through it proves the export
 * is actually complete rather than merely present.
 *
 * Destructive. Refuses to run against a non-empty database unless --force is
 * given, because the one thing worse than losing the error log is
 * overwriting it with an older copy.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { BACKUP_DIR, EXPORT_DIR, TABLES, type DB, ensureDirs, getDb } from '../db/index.ts';
import { append } from '../db/journal.ts';
import { isMain } from '../lib/is-main.ts';
import { migrate } from '../db/migrate.ts';
import type { ExportBundle } from './export.ts';

export const DEFAULT_EXPORT = resolve(EXPORT_DIR, 'gate-export.json');

export function readBundle(path: string): ExportBundle {
  const bundle = JSON.parse(readFileSync(path, 'utf8')) as ExportBundle;
  if (bundle.format !== 'gate-prep-tool/export') {
    throw new Error(`${path} is not a gate-prep-tool export (format=${bundle.format})`);
  }
  return bundle;
}

export function countRows(db: DB): number {
  let n = 0;
  for (const t of TABLES) {
    const r = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number };
    n += r.c;
  }
  return n;
}

export interface RestoreOptions {
  force?: boolean;
  quiet?: boolean;
}

export function restore(
  path: string = DEFAULT_EXPORT,
  db: DB = getDb(),
  opts: RestoreOptions = {},
): { rows: number; tables: number } {
  ensureDirs();
  if (!existsSync(path)) {
    throw new Error(`no export at ${path}. Run \`npm run backup\` first.`);
  }

  // The target may be a brand-new file; bring the schema up before loading.
  migrate(db, true);

  const existing = countRows(db);
  if (existing > 0 && !opts.force) {
    throw new Error(
      `refusing to restore over a database holding ${existing} rows. ` +
        `Back it up, then re-run with --force.`,
    );
  }

  const bundle = readBundle(path);
  let rows = 0;
  let tables = 0;

  const run = db.transaction(() => {
    db.pragma('foreign_keys = OFF');

    // Reverse order for deletes so children go before parents.
    for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();

    for (const t of TABLES) {
      const data = bundle.tables[t] ?? [];
      if (data.length === 0) continue;
      tables += 1;

      const cols = Object.keys(data[0]!);
      const stmt = db.prepare(
        `INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(', ')}) ` +
          `VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
      );
      for (const row of data) {
        stmt.run(row);
        rows += 1;
      }
    }

    db.pragma('foreign_keys = ON');
    const fk = db.pragma('foreign_key_check') as unknown[];
    if (fk.length > 0) {
      throw new Error(`restore produced ${fk.length} foreign-key violation(s); rolled back`);
    }
  });

  run();
  append({ op: 'restore', table: '_restore', id: path, note: `${rows} rows` });

  if (!opts.quiet) console.log(`restore: ${rows} rows across ${tables} tables from ${path}`);
  return { rows, tables };
}

/** Most recent JSON backup, for `--latest`. */
export function latestBackup(): string | null {
  if (!existsSync(BACKUP_DIR)) return null;
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('gate-') && f.endsWith('.json'))
    .sort();
  const last = files.at(-1);
  return last ? resolve(BACKUP_DIR, last) : null;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const useLatest = args.includes('--latest');
  const explicit = args.find((a) => !a.startsWith('--'));

  let path = explicit ?? DEFAULT_EXPORT;
  if (useLatest) {
    const l = latestBackup();
    if (!l) {
      console.error('restore: no backups found in data/backups/');
      process.exit(1);
    }
    path = l;
  }

  try {
    restore(path, getDb(), { force });
  } catch (err) {
    console.error(`restore: ${(err as Error).message}`);
    process.exit(1);
  }
}
