/**
 * Drop the database and rebuild it from migrations + config.seed.json.
 *
 * Destructive and deliberately awkward: requires --yes, and takes a backup
 * first unless --no-backup is given.
 */

import { existsSync, rmSync } from 'node:fs';
import { DB_PATH, closeDb, getDb } from './index.ts';
import { isMain } from '../lib/is-main.ts';
import { migrate } from './migrate.ts';
import { seed } from './seed.ts';

export function reset(quiet = false): void {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${DB_PATH}${suffix}`;
    if (existsSync(p)) rmSync(p);
  }
  const db = getDb();
  migrate(db, quiet);
  seed(db, undefined, quiet);
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.includes('--yes')) {
    console.error('reset: this destroys gate.db. Re-run with --yes to confirm.');
    console.error('reset: (run `npm run backup` first unless you mean it.)');
    process.exit(1);
  }

  if (!args.includes('--no-backup') && existsSync(DB_PATH)) {
    const { backup } = await import('../scripts/backup.ts');
    const r = backup(getDb());
    console.log(`reset: backed up ${r.rows} rows to ${r.jsonPath}`);
  }

  reset();
  console.log('reset: rebuilt from migrations + config.seed.json');
}
