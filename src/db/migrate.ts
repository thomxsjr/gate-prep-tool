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

export function migrate(db: DB = getDb(), quiet = false): number {
  ensureDirs();
  ensureMigrationsTable(db);
  const done = appliedVersions(db);
  const pending = loadMigrations().filter((m) => !done.has(m.version));

  if (pending.length === 0) {
    if (!quiet) console.log('migrate: up to date');
    return 0;
  }

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

  return pending.length;
}

if (isMain(import.meta.url)) {
  migrate();
}
