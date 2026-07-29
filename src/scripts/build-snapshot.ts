/**
 * Build a read-only snapshot for static hosting.
 *
 * WHY THIS EXISTS AND WHAT IT IS NOT
 *
 * The app is local-first by design: SQLite on disk, a fsynced write journal,
 * and a durability proof. A serverless host has no persistent disk, so
 * deploying the live API there would accept writes and silently lose them —
 * the precise failure the whole durability chapter exists to prevent.
 *
 * So the deployed build is a SNAPSHOT: every read the UI performs, frozen at
 * build time, served as one JSON file. Reading and revising work. Writing is
 * refused loudly rather than accepted and dropped.
 *
 * Regenerate and redeploy whenever you want the phone to catch up:
 *
 *     npm run deploy:build
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, getDb } from '../db/index.ts';
import { isMain } from '../lib/is-main.ts';
import * as repo from '../server/repo.ts';
import { buildDeck } from '../server/deck.ts';
import { buildWeekly, weeklyMarkdown } from '../server/weekly.ts';
import { addDays, leakTable } from '../domain/procedural.ts';
import { buildCurve, calibrate } from '../domain/calibration.ts';
import { findViolations, netFromAttemptPolicy, type AttemptDecision } from '../domain/ev.ts';

export const LEAK_WINDOWS = [7, 14, 30, 90, 365] as const;

export interface Snapshot {
  format: 'gate-prep-tool/snapshot';
  version: 1;
  generatedAt: string;
  readOnly: true;
  config: unknown;
  reference: unknown;
  deck: unknown;
  /** Every attempt. The client filters this in memory. */
  errors: unknown[];
  errorsQueue: unknown[];
  leak: Record<string, unknown>;
  msqQuestions: unknown;
  msqReport: unknown;
  drillTemplates: unknown;
  drillStats: unknown;
  cards: unknown;
  cardsDue: unknown;
  mocks: unknown;
  mockDetail: Record<string, unknown>;
  calibration: unknown;
  pyq: unknown;
  weekly: unknown;
  weeklyMarkdown: string;
  sessions: unknown;
  conceptCost: unknown;
  health: unknown;
}

export function buildSnapshot(db = getDb(), at = new Date()): Snapshot {
  const attempts = repo.shareAttempts(db);
  const classes = repo.errorClasses(db);
  const asLeakClasses = classes.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    isProcedural: c.is_procedural,
  }));

  const leak: Record<string, unknown> = {};
  for (const days of LEAK_WINDOWS) {
    leak[String(days)] = leakTable(attempts, asLeakClasses, {
      from: addDays(at, -days),
      to: addDays(at, 1),
    });
  }

  // Calibration mirrors the API exactly, including running the EV threshold on
  // CALIBRATED confidence rather than stated.
  const obs = repo.confidenceObservations(db);
  const minSamples =
    (repo.getConfig<Record<string, number>>('calibration', db)?.['min_samples'] as number) ?? 50;
  const curve = buildCurve(obs, minSamples);
  const rows = repo.listAttempts({ limit: 1000 }, db);
  const decisions: AttemptDecision[] = rows
    .filter((r) => r.outcome !== null && r.context !== 'drill')
    .map((r) => ({
      qtype: r.qtype,
      marks: r.marks as 1 | 2,
      attempted: r.outcome !== 'skipped',
      p: r.confidence === null ? null : calibrate(r.confidence, curve).p,
    }));
  const scoped = rows.filter((r) => r.outcome !== null && r.context !== 'drill');

  const msqRows = repo.msqPerOptionRows(db);
  const right = msqRows.reduce((a, r) => a + r.right, 0);
  const total = msqRows.reduce((a, r) => a + r.total, 0);
  const perfect = msqRows.filter((r) => r.right === r.total).length;

  const mocks = repo.listMocks(db);
  const mockDetail: Record<string, unknown> = {};
  for (const m of mocks) {
    const rowsForMock = repo.mockAttempts(m.id, db);
    const pending = rowsForMock.filter(
      (r) =>
        (r.outcome === 'wrong' || r.outcome === 'skipped' || r.outcome === 'correct_but_guessed') &&
        r.triaged_at === null,
    );
    const revealed = pending.length === 0 && rowsForMock.length > 0;
    mockDetail[String(m.id)] = {
      mock: revealed ? m : { ...m, raw_score: null },
      attempts: rowsForMock,
      triage: { pending: pending.length, total: rowsForMock.length, revealed },
      leak: revealed
        ? leakTable(
            rowsForMock.map((r) => ({
              attemptedAt: r.attempted_at,
              context: r.context,
              marksLost: r.marks_lost ?? 0,
              isProcedural: r.is_procedural,
              errorClassId: r.error_class_id,
              triagedAt: r.triaged_at,
            })),
            asLeakClasses,
          )
        : [],
    };
  }

  const weekly = buildWeekly(db, at);

  return {
    format: 'gate-prep-tool/snapshot',
    version: 1,
    generatedAt: at.toISOString(),
    readOnly: true,
    config: repo.allConfig(db),
    reference: {
      errorClasses: classes,
      subjects: repo.subjects(db),
      rungs: repo.rungs(db),
      sources: repo.sources(db),
      limits: repo.triageLimits(db),
    },
    deck: buildDeck(db, at),
    errors: repo.listAttempts({ limit: 1000 }, db),
    errorsQueue: repo.triageQueue(db),
    leak,
    msqQuestions: repo.msqQuestions(db),
    msqReport: {
      perOptionRight: right,
      perOptionTotal: total,
      perOptionAccuracy: total === 0 ? 0 : right / total,
      questionsAttempted: msqRows.length,
      questionAccuracy: msqRows.length === 0 ? 0 : perfect / msqRows.length,
      nearMisses: msqRows.filter((r) => r.total > 0 && r.right === r.total - 1).length,
      trend: msqRows.map((r) => ({
        date: r.attemptedAt.slice(0, 10),
        accuracy: r.total === 0 ? 0 : r.right / r.total,
        n: r.total,
      })),
    },
    drillTemplates: null, // generated client-side; templates are pure functions
    drillStats: repo.drillStats(db),
    cards: repo.allCards(db),
    cardsDue: repo.dueCards(at.toISOString().slice(0, 10), db),
    mocks,
    mockDetail,
    calibration: {
      ...curve,
      violations: findViolations(decisions).map((v, i) => ({
        ...v,
        sourceQNo: scoped[i]?.source_q_no ?? null,
      })),
      netPolicy: netFromAttemptPolicy(decisions),
    },
    pyq: {
      ...repo.pyqGrid(db),
      split: repo.attemptSplit(db),
      revisit: repo.revisitQueue(db).slice(0, 50),
    },
    weekly,
    weeklyMarkdown: weeklyMarkdown(weekly),
    sessions: repo.listSessions(60, db),
    conceptCost: repo.conceptCost(db),
    health: { ok: true, readOnly: true, counts: {} },
  };
}

if (isMain(import.meta.url)) {
  const outDir = resolve(REPO_ROOT, 'public');
  mkdirSync(outDir, { recursive: true });
  const snap = buildSnapshot();
  const path = resolve(outDir, 'snapshot.json');
  writeFileSync(path, JSON.stringify(snap), 'utf8');

  const bytes = JSON.stringify(snap).length;
  console.log(`snapshot: ${(bytes / 1024).toFixed(0)} kB → ${path}`);
  console.log(`snapshot: ${(snap.errors as unknown[]).length} attempts, ${(snap.mocks as unknown[]).length} mocks`);
  console.log('snapshot: READ ONLY. Writes are refused in the deployed build.');
}
