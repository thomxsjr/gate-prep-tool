import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

// GATE_DB / GATE_DATA_DIR let the durability proof run fully isolated from the
// real gate.db instead of testing the backup path against the live asset.
export const DB_PATH = process.env.GATE_DB ?? resolve(REPO_ROOT, 'gate.db');
export const DATA_DIR = process.env.GATE_DATA_DIR ?? resolve(REPO_ROOT, 'data');
export const JOURNAL_DIR = resolve(DATA_DIR, 'journal');
export const EXPORT_DIR = resolve(DATA_DIR, 'export');
export const BACKUP_DIR = resolve(DATA_DIR, 'backups');

export type DB = Database.Database;

let cached: DB | null = null;

export function openDb(path: string = DB_PATH): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);

  // WAL: readers never block the writer, and a crash mid-write rolls back to
  // the last committed transaction rather than corrupting the file.
  db.pragma('journal_mode = WAL');
  // FULL, not NORMAL. This is a six-month error log on a laptop that gets
  // closed mid-sentence; fsync on every commit is worth the microseconds.
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return db;
}

export function getDb(): DB {
  if (!cached) cached = openDb();
  return cached;
}

export function closeDb(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

export function dbExists(path: string = DB_PATH): boolean {
  return existsSync(path);
}

export function ensureDirs(): void {
  for (const d of [DATA_DIR, JOURNAL_DIR, EXPORT_DIR, BACKUP_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}

/** Tables exported and restored, in FK-safe insert order. */
export const TABLES = [
  'config',
  'error_classes',
  'subjects',
  'topics',
  'concepts',
  'rungs',
  'sources',
  'questions',
  'question_topics',
  'question_options',
  'rung_items',
  'mocks',
  'attempts',
  'attempt_options',
  'cards',
  'card_reviews',
  'drill_runs',
  'sessions',
] as const;

export type TableName = (typeof TABLES)[number];
