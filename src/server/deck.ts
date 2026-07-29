/**
 * Command deck assembly (M1).
 *
 * Everything here is derived from real rows via the pure functions in
 * src/domain/. Nothing is stubbed, and any figure without enough data behind
 * it comes back null rather than zero — a zero would read as an achievement.
 */

import { type DB, getDb } from '../db/index.ts';
import type { DeckDto, RungFillDto } from '../shared/types.ts';
import { computeLadder, type Rung } from '../domain/ladder.ts';
import {
  addDays,
  direction,
  leakTable,
  proceduralShare,
  startOfWeek,
  weeklySeries,
  worstClass,
} from '../domain/procedural.ts';
import * as repo from './repo.ts';

export interface PhaseCfg {
  ordinal: number;
  name: string;
  start: string | null;
  end: string | null;
  gate: GateCfg | null;
}

export interface GateCfg {
  kind: string;
  label: string;
  threshold?: number;
  by?: string;
  window?: number;
  min_weeks?: number;
  checkpoints?: { threshold: number; by: string }[];
}

export type GateStatus = 'on_track' | 'at_risk' | 'missed' | 'met' | 'unknown';

export function daysBetween(from: Date, toIso: string): number {
  const to = new Date(`${toIso.slice(0, 10)}T00:00:00.000Z`);
  const f = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  return Math.round((to.getTime() - f.getTime()) / 86_400_000);
}

export function currentPhase(phases: readonly PhaseCfg[], today: Date): PhaseCfg | null {
  const iso = today.toISOString().slice(0, 10);
  for (const p of phases) {
    const afterStart = !p.start || iso >= p.start;
    const beforeEnd = !p.end || iso < p.end;
    if (afterStart && beforeEnd) return p;
  }
  return phases.at(-1) ?? null;
}

export interface GateEvaluation {
  status: GateStatus;
  detail: string;
  threshold: number | null;
}

export function evaluateGate(
  gate: GateCfg | null,
  ctx: {
    today: Date;
    registrationCompleted: boolean;
    proceduralDirection: string;
    proceduralWeeks: number;
    mockAverage: number | null;
    mockCount: number;
    sectionalsBelow: string[];
    sectionalsMeasured: number;
  },
): GateEvaluation {
  if (!gate) return { status: 'unknown', detail: 'no gate for this phase', threshold: null };

  switch (gate.kind) {
    case 'registered':
      return ctx.registrationCompleted
        ? { status: 'met', detail: 'registration marked complete', threshold: null }
        : { status: 'at_risk', detail: 'registration not yet marked complete', threshold: null };

    case 'sectional_min': {
      if (ctx.sectionalsMeasured === 0) {
        return { status: 'unknown', detail: 'no sectional data yet', threshold: gate.threshold ?? null };
      }
      if (ctx.sectionalsBelow.length === 0) {
        return {
          status: 'met',
          detail: `every measured subject at or above ${gate.threshold}%`,
          threshold: gate.threshold ?? null,
        };
      }
      const overdue = gate.by ? daysBetween(ctx.today, gate.by) < 0 : false;
      return {
        status: overdue ? 'missed' : 'at_risk',
        detail: `${ctx.sectionalsBelow.length} subject(s) below ${gate.threshold}%: ${ctx.sectionalsBelow.slice(0, 4).join(', ')}`,
        threshold: gate.threshold ?? null,
      };
    }

    case 'procedural_share_falling': {
      const need = gate.min_weeks ?? 4;
      if (ctx.proceduralWeeks < need) {
        return {
          status: 'unknown',
          detail: `${ctx.proceduralWeeks} of ${need} weeks of data`,
          threshold: null,
        };
      }
      if (ctx.proceduralDirection === 'falling') {
        return { status: 'on_track', detail: 'procedural share falling', threshold: null };
      }
      return {
        status: 'at_risk',
        detail: `procedural share ${ctx.proceduralDirection}, not falling`,
        threshold: null,
      };
    }

    case 'mock_average': {
      const cps = gate.checkpoints ?? [];
      const next = cps.find((c) => daysBetween(ctx.today, c.by) >= 0) ?? cps.at(-1);
      if (!next) return { status: 'unknown', detail: 'no checkpoints', threshold: null };

      if (ctx.mockAverage === null) {
        return {
          status: 'unknown',
          detail: `no mocks yet; needs ${next.threshold.toFixed(2)} by ${next.by}`,
          threshold: next.threshold,
        };
      }
      const overdue = daysBetween(ctx.today, next.by) < 0;
      if (ctx.mockAverage >= next.threshold) {
        return {
          status: 'met',
          detail: `rolling average ${ctx.mockAverage.toFixed(2)} ≥ ${next.threshold.toFixed(2)}`,
          threshold: next.threshold,
        };
      }
      return {
        status: overdue ? 'missed' : 'at_risk',
        detail: `rolling average ${ctx.mockAverage.toFixed(2)}, needs ${next.threshold.toFixed(2)} by ${next.by}`,
        threshold: next.threshold,
      };
    }

    default:
      return { status: 'unknown', detail: `unrecognised gate kind "${gate.kind}"`, threshold: null };
  }
}

export function buildDeck(db: DB = getDb(), today: Date = new Date()): DeckDto {
  const cfg = repo.allConfig(db);
  const targets = (cfg['targets']?.value ?? {}) as Record<string, number>;
  const registration = (cfg['registration']?.value ?? {}) as Record<string, unknown>;
  const exam = (cfg['exam']?.value ?? {}) as { exam_dates?: string[] };
  const phases = (cfg['phases']?.value ?? []) as PhaseCfg[];

  const attempts = repo.shareAttempts(db);
  const classes = repo.errorClasses(db);

  // --- procedural share ---------------------------------------------------
  const windowStart = addDays(today, -56);
  const share = proceduralShare(attempts, { from: windowStart, to: addDays(today, 1) });
  const series = weeklySeries(attempts, 8, today);
  const dir = direction(series);

  // --- ladder -------------------------------------------------------------
  const rungRows = repo.rungs(db);
  const ladder = computeLadder({
    rungs: rungRows.map<Rung>((r) => ({
      ordinal: r.ordinal,
      name: r.name,
      itemsTarget: r.items_target,
      marksSwing: r.marks_swing,
      cumulativeScore: r.cumulative_score,
      errorClassId: r.error_class_id,
      isProcedural: r.is_procedural,
    })),
    attempts,
    itemsClosed: repo.rungItemsClosed(db),
    window: { from: addDays(today, -28), to: addDays(today, 1) },
    baselineScore: targets['baseline_score'] ?? 53,
  });

  // --- mocks --------------------------------------------------------------
  const mocks = repo.listMocks(db).filter((m) => m.raw_score !== null && m.triage_completed_at !== null);
  const last3 = mocks.slice(0, 3);
  const rollingAverage =
    last3.length > 0 ? last3.reduce((a, m) => a + (m.raw_score ?? 0), 0) / last3.length : null;

  const avgOf = (rows: typeof mocks): number | null =>
    rows.length === 0 ? null : rows.reduce((a, m) => a + (m.raw_score ?? 0), 0) / rows.length;
  const home = avgOf(mocks.filter((m) => m.environment === 'home'));
  const away = avgOf(mocks.filter((m) => m.environment === 'away'));
  const at0930 = avgOf(mocks.filter((m) => m.started_at_0930 === 1));
  const off0930 = avgOf(mocks.filter((m) => m.started_at_0930 === 0));

  // --- phase and gate -----------------------------------------------------
  const phase = currentPhase(phases, today);
  const sectionalAcc = repo.subjectAccuracy(addDays(today, -120).toISOString(), db);
  const sectionalThreshold = (phase?.gate?.threshold ?? 85) / 100;
  const below = sectionalAcc.filter((s) => s.accuracy < sectionalThreshold).map((s) => s.subject);

  const gateEval = evaluateGate(phase?.gate ?? null, {
    today,
    registrationCompleted: registration['completed'] === true,
    proceduralDirection: dir,
    proceduralWeeks: series.filter((p) => p.share !== null).length,
    mockAverage: rollingAverage,
    mockCount: mocks.length,
    sectionalsBelow: below,
    sectionalsMeasured: sectionalAcc.length,
  });

  // --- countdown ----------------------------------------------------------
  const countdown: DeckDto['countdown'] = [];
  const regDone = registration['completed'] === true;
  for (const [label, key, alarmWhenPending] of [
    ['Registration opens', 'opens', false],
    ['Registration closes', 'regular_close', true],
    ['Late-fee close', 'late_fee_close', true],
  ] as const) {
    const date = registration[key] as string | undefined;
    if (!date) continue;
    const d = daysBetween(today, date);
    if (d < 0 && regDone) continue;
    countdown.push({
      label,
      date,
      daysRemaining: d,
      // Registration is the one deadline whose miss cannot be recovered from.
      alarm: alarmWhenPending && !regDone,
    });
  }
  const firstExam = exam.exam_dates?.[0];
  if (firstExam) {
    countdown.push({
      label: 'First exam date',
      date: firstExam,
      daysRemaining: daysBetween(today, firstExam),
      alarm: false,
    });
  }
  countdown.sort((a, b) => a.daysRemaining - b.daysRemaining);

  // --- today --------------------------------------------------------------
  const iso = today.toISOString().slice(0, 10);
  const due = repo.dueCards(iso, db).length;
  const queue = repo.triageQueue(db).length;
  const reattempts = repo.revisitQueue(db).length;

  const leak = leakTable(
    attempts,
    classes.map((c) => ({ id: c.id, code: c.code, name: c.name, isProcedural: c.is_procedural })),
    { from: addDays(today, -14), to: addDays(today, 1) },
  );
  const worst = worstClass(leak);

  const weekStart = startOfWeek(today);
  const hoursLogged = repo.hoursSince(weekStart.toISOString().slice(0, 10), db);

  return {
    ladder: {
      baselineScore: ladder.baselineScore,
      targetScore: targets['target_score'] ?? 90,
      rungs: ladder.rungs as RungFillDto[],
      recoverableScore: ladder.recoverableScore,
      topClosedOrdinal: ladder.topClosedOrdinal,
    },
    procedural: {
      current: share.share,
      baseline: targets['procedural_share_baseline'] ?? 0.46,
      direction: dir,
      series: series.map((p) => ({ weekStart: p.weekStart, share: p.share, attempts: p.attempts })),
      marksLost: round2(share.totalMarksLost),
      proceduralMarksLost: round2(share.proceduralMarksLost),
      sampleSize: share.attempts,
    },
    phase: phase
      ? {
          ordinal: phase.ordinal,
          name: phase.name,
          start: phase.start,
          end: phase.end,
          daysRemaining: phase.end ? daysBetween(today, phase.end) : null,
          gateLabel: phase.gate?.label ?? null,
          gateStatus: gateEval.status,
          gateDetail: gateEval.detail,
        }
      : null,
    countdown,
    mocks: {
      rollingAverage,
      count: mocks.length,
      gateThreshold: gateEval.threshold,
      homeAwayDelta: home !== null && away !== null ? round2(home - away) : null,
      at0930Delta: at0930 !== null && off0930 !== null ? round2(at0930 - off0930) : null,
    },
    hours: {
      logged: round2(hoursLogged),
      min: targets['weekly_hours_min'] ?? 32,
      max: targets['weekly_hours_max'] ?? 40,
      weekStart: weekStart.toISOString().slice(0, 10),
    },
    today: {
      dueCards: due,
      triageQueue: queue,
      reattempts,
      recommendedDrill: worst
        ? { code: worst.code, name: worst.name, marksLost: round2(worst.marksLost) }
        : null,
    },
    unverified: repo.unverifiedGroups(db),
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
