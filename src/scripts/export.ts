/**
 * Full JSON export — the canonical, human-readable, committable snapshot.
 *
 * Deterministic: tables in fixed order, rows by primary key, keys sorted. Two
 * exports of the same data are byte-identical, which is what makes the
 * durability proof meaningful and what keeps git diffs readable.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXPORT_DIR, TABLES, type DB, ensureDirs, getDb } from '../db/index.ts';
import { isMain } from '../lib/is-main.ts';

export interface ExportBundle {
  format: 'gate-prep-tool/export';
  version: 1;
  exported_at: string;
  schema_version: number;
  tables: Record<string, Record<string, unknown>[]>;
}

/** Stable key order so the JSON text is reproducible. */
function sortKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row).sort()) out[k] = row[k];
  return out;
}

export function buildExport(db: DB = getDb(), at: Date = new Date()): ExportBundle {
  const tables: Record<string, Record<string, unknown>[]> = {};

  for (const t of TABLES) {
    const rows = db
      .prepare(`SELECT * FROM ${t} ORDER BY rowid`)
      .all() as Record<string, unknown>[];
    tables[t] = rows.map(sortKeys);
  }

  const sv = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };

  return {
    format: 'gate-prep-tool/export',
    version: 1,
    exported_at: at.toISOString(),
    schema_version: sv.v ?? 0,
    tables,
  };
}

export function serialise(bundle: ExportBundle): string {
  return JSON.stringify(bundle, null, 2) + '\n';
}

/**
 * Hash of the DATA only — `exported_at` is excluded so two exports taken at
 * different moments of identical data compare equal. This is the check the
 * durability proof relies on.
 */
export function contentHash(bundle: ExportBundle): string {
  return createHash('sha256')
    .update(JSON.stringify({ tables: bundle.tables, schema_version: bundle.schema_version }))
    .digest('hex');
}

export function writeExport(
  db: DB = getDb(),
  path: string = resolve(EXPORT_DIR, 'gate-export.json'),
): { path: string; hash: string; rows: number } {
  ensureDirs();
  mkdirSync(resolve(path, '..'), { recursive: true });

  const bundle = buildExport(db);
  writeFileSync(path, serialise(bundle), 'utf8');

  const rows = Object.values(bundle.tables).reduce((a, r) => a + r.length, 0);
  return { path, hash: contentHash(bundle), rows };
}

if (isMain(import.meta.url)) {
  const r = writeExport();
  console.log(`export: ${r.rows} rows → ${r.path}`);
  console.log(`export: sha256 ${r.hash}`);
}
