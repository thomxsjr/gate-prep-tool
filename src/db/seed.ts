/**
 * Seed from config.seed.json. Idempotent: re-running updates seeded rows in
 * place and never duplicates them, so `npm run db:seed` is safe after editing
 * the file.
 *
 * User-entered data is never touched by the seeder.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type DB, REPO_ROOT, getDb } from './index.ts';
import { appendMany, type JournalEntry } from './journal.ts';
import { isMain } from '../lib/is-main.ts';

export const SEED_PATH = resolve(REPO_ROOT, 'config.seed.json');

interface SeedFile {
  exam: Record<string, unknown>;
  registration: Record<string, unknown>;
  marking: Record<string, unknown>;
  targets: Record<string, unknown>;
  rungs: SeedRung[];
  phases: unknown[];
  error_classes: SeedErrorClass[];
  subjects: SeedSubject[];
  study_blocks: unknown[];
  logging: Record<string, unknown>;
  calibration: Record<string, unknown>;
}

interface SeedRung {
  ordinal: number;
  name: string;
  description: string;
  items_target: number;
  marks_swing: number;
  cumulative_score: number;
  error_class_code: string | null;
  is_procedural: boolean;
}

interface SeedErrorClass {
  code: string;
  name: string;
  is_procedural: boolean;
  description: string;
  sort_order: number;
}

interface SeedSubject {
  code: string;
  name: string;
  section: 'GA' | 'SUBJECT';
  sort_order: number;
}

/** Groups written into `config` as whole JSON documents. */
const CONFIG_GROUPS = [
  'exam',
  'registration',
  'marking',
  'targets',
  'phases',
  'study_blocks',
  'logging',
  'calibration',
] as const;

export function readSeed(path: string = SEED_PATH): SeedFile {
  return JSON.parse(readFileSync(path, 'utf8')) as SeedFile;
}

export function seed(db: DB = getDb(), path: string = SEED_PATH, quiet = false): void {
  const cfg = readSeed(path);
  const now = new Date().toISOString();
  const journal: Omit<JournalEntry, 'ts'>[] = [];

  const run = db.transaction(() => {
    // --- config -----------------------------------------------------------
    const upsertConfig = db.prepare(`
      INSERT INTO config (key, value_json, grp, label, verified_against_brochure, updated_at)
      VALUES (@key, @value_json, @grp, @label, @verified, @updated_at)
      ON CONFLICT (key) DO UPDATE SET
        value_json = excluded.value_json,
        grp        = excluded.grp,
        label      = excluded.label,
        updated_at = excluded.updated_at
    `);

    for (const group of CONFIG_GROUPS) {
      const value = (cfg as unknown as Record<string, unknown>)[group];
      // Only groups that explicitly declare the flag are brochure-dependent.
      // Marking every group unverified by default would dilute the alarm until
      // it stopped meaning anything.
      const declares =
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        '_verified_against_brochure' in (value as Record<string, unknown>);
      const verified =
        !declares || (value as Record<string, unknown>)['_verified_against_brochure'] === true;
      upsertConfig.run({
        key: group,
        value_json: JSON.stringify(value),
        grp: group,
        label: group,
        verified: verified ? 1 : 0,
        updated_at: now,
      });
      journal.push({ op: 'seed', table: 'config', id: group });
    }

    // --- error classes ----------------------------------------------------
    const upsertClass = db.prepare(`
      INSERT INTO error_classes (code, name, is_procedural, description, sort_order, active)
      VALUES (@code, @name, @is_procedural, @description, @sort_order, 1)
      ON CONFLICT (code) DO UPDATE SET
        name          = excluded.name,
        is_procedural = excluded.is_procedural,
        description   = excluded.description,
        sort_order    = excluded.sort_order
    `);
    for (const ec of cfg.error_classes) {
      upsertClass.run({ ...ec, is_procedural: ec.is_procedural ? 1 : 0 });
      journal.push({ op: 'seed', table: 'error_classes', id: ec.code });
    }

    // --- subjects ---------------------------------------------------------
    const upsertSubject = db.prepare(`
      INSERT INTO subjects (code, name, section, sort_order)
      VALUES (@code, @name, @section, @sort_order)
      ON CONFLICT (code) DO UPDATE SET
        name       = excluded.name,
        section    = excluded.section,
        sort_order = excluded.sort_order
    `);
    for (const s of cfg.subjects) {
      upsertSubject.run(s);
      journal.push({ op: 'seed', table: 'subjects', id: s.code });
    }

    // --- rungs ------------------------------------------------------------
    const classIdByCode = new Map<string, number>();
    for (const row of db.prepare('SELECT id, code FROM error_classes').all() as {
      id: number;
      code: string;
    }[]) {
      classIdByCode.set(row.code, row.id);
    }

    const upsertRung = db.prepare(`
      INSERT INTO rungs (ordinal, name, description, items_target, marks_swing,
                         cumulative_score, error_class_id, is_procedural)
      VALUES (@ordinal, @name, @description, @items_target, @marks_swing,
              @cumulative_score, @error_class_id, @is_procedural)
      ON CONFLICT (ordinal) DO UPDATE SET
        name             = excluded.name,
        description      = excluded.description,
        items_target     = excluded.items_target,
        marks_swing      = excluded.marks_swing,
        cumulative_score = excluded.cumulative_score,
        error_class_id   = excluded.error_class_id,
        is_procedural    = excluded.is_procedural
    `);
    for (const r of cfg.rungs) {
      upsertRung.run({
        ordinal: r.ordinal,
        name: r.name,
        description: r.description,
        items_target: r.items_target,
        marks_swing: r.marks_swing,
        cumulative_score: r.cumulative_score,
        error_class_id: r.error_class_code
          ? (classIdByCode.get(r.error_class_code) ?? null)
          : null,
        is_procedural: r.is_procedural ? 1 : 0,
      });
      journal.push({ op: 'seed', table: 'rungs', id: r.ordinal });
    }
  });

  run();
  appendMany(journal);

  if (!quiet) {
    console.log(
      `seed: ${CONFIG_GROUPS.length} config groups, ` +
        `${cfg.error_classes.length} error classes, ` +
        `${cfg.subjects.length} subjects, ${cfg.rungs.length} rungs`,
    );
    verifyLadderArithmetic(cfg, quiet);
  }
}

/**
 * The seed file is hand-editable, so the Ladder's internal arithmetic is
 * checked on every seed rather than trusted. A rung table whose swings do not
 * reconcile with its cumulative scores would silently corrupt the signature
 * element of the whole app.
 */
export function verifyLadderArithmetic(cfg: SeedFile, quiet = false): string[] {
  const problems: string[] = [];
  const sorted = [...cfg.rungs].sort((a, b) => a.ordinal - b.ordinal);
  const baseline = sorted[0]?.cumulative_score ?? 0;
  let running = baseline;

  for (const r of sorted) {
    running += r.marks_swing;
    if (Math.abs(running - r.cumulative_score) > 1e-9) {
      problems.push(
        `rung ${r.ordinal} (${r.name}): swing sums to ${running.toFixed(2)} ` +
          `but cumulative_score says ${r.cumulative_score.toFixed(2)}`,
      );
    }
  }

  if (!quiet) {
    if (problems.length === 0) {
      const total = sorted.reduce((a, r) => a + r.marks_swing, 0);
      console.log(
        `seed: ladder reconciles — ${baseline.toFixed(2)} + ${total.toFixed(2)} = ` +
          `${running.toFixed(2)}`,
      );
    } else {
      for (const p of problems) console.error(`seed: LADDER MISMATCH — ${p}`);
    }
  }
  return problems;
}

if (isMain(import.meta.url)) {
  seed();
}
