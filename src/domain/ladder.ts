/**
 * The Ladder.
 *
 * The rung swings sum to exactly +47.00 and land on 100.00 because they are a
 * decomposition of ONE paper already sat, not a forecast. Presenting the
 * cumulative figure as a predicted score would be the most expensive lie the
 * instrument could tell, so this module keeps two things apart:
 *
 *   recoverable  — "score if the 2026 paper were re-sat with this rung closed".
 *                  Retrodictive. Always labelled.
 *   fill         — how far the rung's error class has actually stopped
 *                  appearing in recent real work. Transferable. This is what
 *                  predicts February.
 *
 * A rung fills on measured incidence, never on a checkbox.
 */

import { classIncidence, type ShareAttempt, type Window } from './procedural.ts';

export interface Rung {
  ordinal: number;
  name: string;
  itemsTarget: number;
  marksSwing: number;
  cumulativeScore: number;
  errorClassId: number | null;
  isProcedural: boolean;
}

export interface RungFill {
  ordinal: number;
  name: string;
  marksSwing: number;
  cumulativeScore: number;
  isProcedural: boolean;
  /** 0–1. Proportion of the rung considered closed. */
  fill: number;
  /** 0–1. The un-closed remainder — the part rendered in the procedural hue. */
  residual: number;
  /** Items marked closed / items targeted. */
  itemsClosed: number;
  itemsTarget: number;
  /** Trailing incidence per 100 attempts, or null when not incidence-driven. */
  incidencePer100: number | null;
  /** Attempts backing the incidence figure. */
  sampleSize: number;
  /** True when there is too little recent work to judge. */
  insufficientData: boolean;
}

/**
 * Incidence at or below this (per 100 attempts) counts a procedural rung as
 * fully closed. Not zero: demanding a literal zero over a finite window makes
 * the Ladder hostage to a single bad morning.
 */
export const CLOSED_INCIDENCE_PER_100 = 1.0;

/**
 * Incidence at or above this counts as no progress at all. Anchored near the
 * 2026 baseline rate so the bar starts where the user actually started.
 */
export const BASELINE_INCIDENCE_PER_100 = 8.0;

/** Minimum triaged attempts in the window before incidence is trusted. */
export const MIN_INCIDENCE_SAMPLE = 40;

export interface LadderInput {
  rungs: readonly Rung[];
  attempts: readonly ShareAttempt[];
  /** Closed-item counts per rung ordinal, from `rung_items`. */
  itemsClosed: ReadonlyMap<number, number>;
  window?: Window;
  baselineScore: number;
}

export interface LadderResult {
  baselineScore: number;
  rungs: RungFill[];
  /** Retrodictive: baseline + Σ (swing × fill). Labelled, never forecast. */
  recoverableScore: number;
  /** Highest rung whose fill is complete. */
  topClosedOrdinal: number;
}

export function computeLadder(input: LadderInput): LadderResult {
  const rungs = [...input.rungs].sort((a, b) => a.ordinal - b.ordinal);
  const out: RungFill[] = [];
  let recoverable = input.baselineScore;
  let topClosed = 0;

  for (const r of rungs) {
    // Rung 0 is the baseline itself: always full, contributes no swing.
    if (r.marksSwing === 0) {
      out.push(baselineRung(r));
      continue;
    }

    const itemsClosed = input.itemsClosed.get(r.ordinal) ?? 0;
    const itemFill =
      r.itemsTarget > 0 ? Math.min(1, itemsClosed / r.itemsTarget) : 0;

    let incidencePer100: number | null = null;
    let sampleSize = 0;
    let insufficientData = false;
    let fill: number;

    if (r.errorClassId !== null) {
      const inc = classIncidence(input.attempts, r.errorClassId, input.window);
      incidencePer100 = inc.per100;
      sampleSize = inc.denominator;

      if (inc.denominator < MIN_INCIDENCE_SAMPLE) {
        // Not enough recent work to make a claim. Fall back to item progress
        // and mark it, rather than reporting a confident fill from four
        // questions.
        insufficientData = true;
        fill = itemFill;
      } else {
        fill = incidenceToFill(inc.per100);
      }
    } else {
      // Rungs with no error class (concept gaps, the hard tail) are item-driven.
      fill = itemFill;
    }

    fill = clamp01(fill);
    recoverable += r.marksSwing * fill;
    if (fill >= 1) topClosed = Math.max(topClosed, r.ordinal);

    out.push({
      ordinal: r.ordinal,
      name: r.name,
      marksSwing: r.marksSwing,
      cumulativeScore: r.cumulativeScore,
      isProcedural: r.isProcedural,
      fill,
      residual: 1 - fill,
      itemsClosed,
      itemsTarget: r.itemsTarget,
      incidencePer100,
      sampleSize,
      insufficientData,
    });
  }

  return {
    baselineScore: input.baselineScore,
    rungs: out,
    recoverableScore: round2(recoverable),
    topClosedOrdinal: topClosed,
  };
}

/**
 * Map trailing incidence to rung fill. Linear between the baseline rate and
 * the closed threshold; clamped at both ends.
 */
export function incidenceToFill(
  per100: number,
  closedAt: number = CLOSED_INCIDENCE_PER_100,
  baselineAt: number = BASELINE_INCIDENCE_PER_100,
): number {
  if (per100 <= closedAt) return 1;
  if (per100 >= baselineAt) return 0;
  return (baselineAt - per100) / (baselineAt - closedAt);
}

/**
 * Consistency check between the Ladder and the phase gates.
 *
 * Rung 3 tops out at 86.00 but the Phase 3 gate wants a mock average of 88 by
 * 15 Dec — which requires rung 4 progress a month before rung 4's own phase.
 * The app surfaces the contradiction rather than quietly disagreeing with
 * itself.
 */
export interface GateConsistency {
  target: number;
  /** Rungs that must close to reach the target. */
  requiredOrdinals: number[];
  /** Fraction of the last required rung that is needed. */
  partialOfLast: number;
  conflicts: string[];
}

export function checkGateConsistency(
  rungs: readonly Rung[],
  target: number,
  gates: ReadonlyArray<{ label: string; threshold: number; by: string }>,
): GateConsistency {
  const sorted = [...rungs].sort((a, b) => a.ordinal - b.ordinal);
  const required: number[] = [];
  let running = sorted[0]?.cumulativeScore ?? 0;
  let partialOfLast = 0;

  for (const r of sorted) {
    if (r.marksSwing === 0) continue;
    if (running >= target) break;
    required.push(r.ordinal);
    const need = target - running;
    if (need < r.marksSwing) {
      partialOfLast = need / r.marksSwing;
      running = target;
      break;
    }
    running += r.marksSwing;
    partialOfLast = 1;
  }

  const conflicts: string[] = [];
  for (const g of gates) {
    const reachable = highestCumulativeAtOrdinal(sorted, Math.max(...required, 0));
    if (g.threshold > reachable) {
      conflicts.push(
        `Gate "${g.label}" wants ${g.threshold.toFixed(2)} by ${g.by}, but the ` +
          `rungs scheduled by then top out at ${reachable.toFixed(2)}. The gate ` +
          `requires rung ${required.length + 1} progress ahead of its phase.`,
      );
    }
  }

  return { target, requiredOrdinals: required, partialOfLast, conflicts };
}

function highestCumulativeAtOrdinal(rungs: readonly Rung[], ordinal: number): number {
  let best = 0;
  for (const r of rungs) if (r.ordinal <= ordinal) best = Math.max(best, r.cumulativeScore);
  return best;
}

function baselineRung(r: Rung): RungFill {
  return {
    ordinal: r.ordinal,
    name: r.name,
    marksSwing: 0,
    cumulativeScore: r.cumulativeScore,
    isProcedural: false,
    fill: 1,
    residual: 0,
    itemsClosed: 0,
    itemsTarget: 0,
    incidencePer100: null,
    sampleSize: 0,
    insufficientData: false,
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
