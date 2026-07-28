/**
 * Backup: a timestamped binary copy plus a full JSON export.
 *
 * The .db copy is fast to restore; the JSON export is what survives a
 * SQLite version change, a corrupt page, or a laptop that no longer exists.
 * Both are produced every time because they fail in different ways.
 */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BACKUP_DIR, DB_PATH, EXPORT_DIR, type DB, ensureDirs, getDb } from '../db/index.ts';
import { append } from '../db/journal.ts';
import { isMain } from '../lib/is-main.ts';
import { buildExport, contentHash, serialise } from './export.ts';

export interface BackupResult {
  stamp: string;
  dbPath: string;
  jsonPath: string;
  canonicalPath: string;
  hash: string;
  rows: number;
}

export function backup(
  db: DB = getDb(),
  at: Date = new Date(),
  sourcePath: string = DB_PATH,
): BackupResult {
  ensureDirs();
  const stamp = at.toISOString().replace(/[:.]/g, '-');

  // Checkpoint the WAL so the copied file is complete on its own.
  db.pragma('wal_checkpoint(TRUNCATE)');

  const dbPath = resolve(BACKUP_DIR, `gate-${stamp}.db`);
  mkdirSync(BACKUP_DIR, { recursive: true });
  copyFileSync(sourcePath, dbPath);

  const bundle = buildExport(db, at);
  const text = serialise(bundle);
  const hash = contentHash(bundle);
  const rows = Object.values(bundle.tables).reduce((a, r) => a + r.length, 0);

  const jsonPath = resolve(BACKUP_DIR, `gate-${stamp}.json`);
  writeFileSync(jsonPath, text, 'utf8');

  // The canonical export is the one that gets committed.
  const canonicalPath = resolve(EXPORT_DIR, 'gate-export.json');
  writeFileSync(canonicalPath, text, 'utf8');

  append({ op: 'insert', table: '_backup', id: stamp, note: `${rows} rows, sha256 ${hash}` }, at);

  return { stamp, dbPath, jsonPath, canonicalPath, hash, rows };
}

if (isMain(import.meta.url)) {
  const r = backup();
  console.log(`backup: ${r.rows} rows`);
  console.log(`backup: db     ${r.dbPath}`);
  console.log(`backup: json   ${r.jsonPath}`);
  console.log(`backup: export ${r.canonicalPath}  (commit this)`);
  console.log(`backup: sha256 ${r.hash}`);
}
