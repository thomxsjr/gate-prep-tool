/**
 * Migration runner. Forward-only, one transaction per migration, recorded in
 * `schema_migrations`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type DB, ensureDirs, getDb } from './index.ts';
import { append } from './journal.ts';
import { isMain } from '../lib/is-main.ts';

const MIGRATIONS_DIR = resolve(import.meta.dirname, 'migrations');

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      const m = /^(\d+)_(.+)\.sql$/.exec(f);
      if (!m) throw new Error(`migration filename not in NNN_name.sql form: ${f}`);
      return {
        version: Number(m[1]),
        name: m[2]!,
        sql: readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8'),
      };
    })
    .sort((a, b) => a.version - b.version);
}

function ensureMigrationsTable(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function appliedVersions(db: DB): Set<number> {
  ensureMigrationsTable(db);
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as {
    version: number;
  }[];
  return new Set(rows.map((r) => r.version));
}

/** `upTo` applies migrations only through that version — used by tests to
 *  reproduce an older schema and step it forward. */
export function migrate(db: DB = getDb(), quiet = false, upTo?: number): number {
  ensureDirs();
  ensureMigrationsTable(db);
  const done = appliedVersions(db);
  const pending = loadMigrations().filter(
    (m) => !done.has(m.version) && (upTo === undefined || m.version <= upTo),
  );

  if (pending.length === 0) {
    if (!quiet) console.log('migrate: up to date');
    return 0;
  }

  // Foreign keys OFF for the duration, as SQLite's own table-rebuild procedure
  // requires, and it must be set OUTSIDE the transaction — the pragma is a
  // no-op inside one. This is not cosmetic: a rebuild that drops a parent
  // table with enforcement ON fires ON DELETE CASCADE and silently destroys
  // every child row. Integrity is re-checked below instead of assumed.
  const fkWasOn = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
  db.pragma('foreign_keys = OFF');

  try {
    for (const m of pending) {
      const run = db.transaction(() => {
        db.exec(m.sql);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        ).run(m.version, m.name, new Date().toISOString());
      });
      run();
      append({ op: 'migrate', table: 'schema_migrations', id: m.version, note: m.name });
      if (!quiet) console.log(`migrate: applied ${String(m.version).padStart(3, '0')}_${m.name}`);
    }
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }

  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `migration left ${violations.length} foreign-key violation(s): ` +
        JSON.stringify(violations.slice(0, 5)),
    );
  }

  return pending.length;
}

if (isMain(import.meta.url)) {
  migrate();
}
