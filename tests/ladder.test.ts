import { describe, expect, it } from 'vitest';
import {
  BASELINE_INCIDENCE_PER_100,
  CLOSED_INCIDENCE_PER_100,
  MIN_INCIDENCE_SAMPLE,
  checkGateConsistency,
  computeLadder,
  incidenceToFill,
  type Rung,
} from '../src/domain/ladder.ts';
import type { ShareAttempt } from '../src/domain/procedural.ts';
import { readSeed, verifyLadderArithmetic } from '../src/db/seed.ts';

const RUNGS: Rung[] = [
  { ordinal: 0, name: 'Baseline', itemsTarget: 0, marksSwing: 0, cumulativeScore: 53, errorClassId: null, isProcedural: false },
  { ordinal: 1, name: 'MSQ per-option discipline', itemsTarget: 5, marksSwing: 9, cumulativeScore: 62, errorClassId: 1, isProcedural: true },
  { ordinal: 2, name: 'Boundary discipline', itemsTarget: 7, marksSwing: 12, cumulativeScore: 74, errorClassId: 2, isProcedural: true },
  { ordinal: 3, name: 'Six named concept gaps', itemsTarget: 6, marksSwing: 12, cumulativeScore: 86, errorClassId: 6, isProcedural: false },
  { ordinal: 4, name: 'Close the five non-attempts', itemsTarget: 5, marksSwing: 8, cumulativeScore: 94, errorClassId: 7, isProcedural: true },
  { ordinal: 5, name: 'Hard tail', itemsTarget: 3, marksSwing: 6, cumulativeScore: 100, errorClassId: null, isProcedural: false },
];

function attempts(n: number, errorClassId: number | null): ShareAttempt[] {
  return Array.from({ length: n }, () => ({
    attemptedAt: '2026-07-20T09:00:00.000Z',
    context: 'mock',
    marksLost: errorClassId === null ? 0 : 2,
    isProcedural: errorClassId !== null,
    errorClassId,
    triagedAt: '2026-07-20T20:00:00.000Z',
  }));
}

describe('the seed file reconciles', () => {
  it('has rung swings that sum to their cumulative scores', () => {
    expect(verifyLadderArithmetic(readSeed(), true)).toEqual([]);
  });

  it('sums to exactly +47.00 from 53.00', () => {
    const rungs = readSeed().rungs;
    const total = rungs.reduce((a, r) => a + r.marks_swing, 0);
    expect(total).toBeCloseTo(47, 10);
    expect(rungs.at(-1)!.cumulative_score).toBe(100);
  });
});

describe('incidence drives fill, not checkboxes', () => {
  it('is full at or below the closed threshold', () => {
    expect(incidenceToFill(0)).toBe(1);
    expect(incidenceToFill(CLOSED_INCIDENCE_PER_100)).toBe(1);
  });

  it('is empty at or above the baseline rate', () => {
    expect(incidenceToFill(BASELINE_INCIDENCE_PER_100)).toBe(0);
    expect(incidenceToFill(50)).toBe(0);
  });

  it('is linear in between', () => {
    const mid = (CLOSED_INCIDENCE_PER_100 + BASELINE_INCIDENCE_PER_100) / 2;
    expect(incidenceToFill(mid)).toBeCloseTo(0.5, 10);
  });
});

describe('computeLadder', () => {
  const itemsClosed = new Map<number, number>();

  it('fills a rung whose error class has stopped appearing', () => {
    // 100 triaged attempts, none of them the MSQ class.
    const r = computeLadder({
      rungs: RUNGS,
      attempts: attempts(100, 6),
      itemsClosed,
      baselineScore: 53,
    });
    const rung1 = r.rungs.find((x) => x.ordinal === 1)!;
    expect(rung1.fill).toBe(1);
    expect(rung1.residual).toBe(0);
    expect(rung1.incidencePer100).toBe(0);
  });

  it('leaves a rung empty while its class is still leaking at baseline', () => {
    const r = computeLadder({
      rungs: RUNGS,
      attempts: [...attempts(10, 1), ...attempts(90, 6)],
      itemsClosed,
      baselineScore: 53,
    });
    expect(r.rungs.find((x) => x.ordinal === 1)!.fill).toBe(0);
  });

  it('marks insufficient data instead of claiming a fill from four questions', () => {
    const r = computeLadder({
      rungs: RUNGS,
      attempts: attempts(4, 6),
      itemsClosed,
      baselineScore: 53,
    });
    const rung1 = r.rungs.find((x) => x.ordinal === 1)!;
    expect(rung1.insufficientData).toBe(true);
    expect(rung1.sampleSize).toBeLessThan(MIN_INCIDENCE_SAMPLE);
    expect(rung1.fill).toBe(0);
  });

  it('always shows the baseline rung as full and swing-free', () => {
    const r = computeLadder({ rungs: RUNGS, attempts: [], itemsClosed, baselineScore: 53 });
    const base = r.rungs.find((x) => x.ordinal === 0)!;
    expect(base.fill).toBe(1);
    expect(base.marksSwing).toBe(0);
  });

  it('reports a recoverable score, never a forecast beyond the decomposition', () => {
    const r = computeLadder({
      rungs: RUNGS,
      attempts: attempts(100, 6), // rungs 1, 2, 4 clean; rung 3 is the concept class
      itemsClosed,
      baselineScore: 53,
    });
    // Rungs 1 (+9), 2 (+12) and 4 (+8) fill; rung 3 stays open at baseline
    // incidence and rung 5 is item-driven with nothing closed.
    expect(r.recoverableScore).toBeCloseTo(53 + 9 + 12 + 8, 10);
    expect(r.recoverableScore).toBeLessThan(100);
  });

  it('falls back to item progress for rungs with no error class', () => {
    const r = computeLadder({
      rungs: RUNGS,
      attempts: attempts(100, 6),
      itemsClosed: new Map([[5, 3]]),
      baselineScore: 53,
    });
    expect(r.rungs.find((x) => x.ordinal === 5)!.fill).toBe(1);
  });

  it('never exceeds full fill when more items are closed than targeted', () => {
    const r = computeLadder({
      rungs: RUNGS,
      attempts: [],
      itemsClosed: new Map([[5, 99]]),
      baselineScore: 53,
    });
    expect(r.rungs.find((x) => x.ordinal === 5)!.fill).toBe(1);
  });
});

describe('gate consistency', () => {
  it('shows that 90 needs rungs 1–3 plus part of rung 4', () => {
    const c = checkGateConsistency(RUNGS, 90, []);
    expect(c.requiredOrdinals).toEqual([1, 2, 3, 4]);
    // 86 after rung 3, so 4 of rung 4's 8 marks — exactly half.
    expect(c.partialOfLast).toBeCloseTo(0.5, 10);
  });

  it('flags the 88-by-15-Dec gate as ahead of its rung', () => {
    const c = checkGateConsistency(RUNGS, 90, [
      { label: 'Mock average ≥88', threshold: 88, by: '2026-12-15' },
    ]);
    expect(c.conflicts).toHaveLength(0); // rung 4 is in the required set, tops out at 94
  });

  it('flags a gate that no scheduled rung can reach', () => {
    const c = checkGateConsistency(RUNGS, 74, [
      { label: 'Mock average ≥92', threshold: 92, by: '2027-01-15' },
    ]);
    expect(c.conflicts.length).toBeGreaterThan(0);
    expect(c.conflicts[0]).toContain('92.00');
  });

  it('needs only rungs 1 and 2 to reach 74 — with no new knowledge', () => {
    const c = checkGateConsistency(RUNGS, 74, []);
    expect(c.requiredOrdinals).toEqual([1, 2]);
    expect(c.partialOfLast).toBe(1);
  });
});
