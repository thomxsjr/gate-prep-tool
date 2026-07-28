import { describe, expect, it } from 'vitest';
import {
  MIN_CALIBRATION_SAMPLES,
  buildCurve,
  calibrate,
  type ConfidenceObservation,
} from '../src/domain/calibration.ts';

function observations(
  spec: ReadonlyArray<[confidence: number, correct: number, total: number]>,
): ConfidenceObservation[] {
  const out: ConfidenceObservation[] = [];
  for (const [confidence, correct, total] of spec) {
    for (let i = 0; i < total; i += 1) {
      out.push({ confidence, wasCorrect: i < correct });
    }
  }
  return out;
}

describe('bias distinguishes the two diseases', () => {
  it('reports overconfidence as positive bias', () => {
    const curve = buildCurve(observations([[80, 25, 50], [90, 25, 50]]));
    expect(curve.bias).toBeGreaterThan(0);
  });

  it('reports underconfidence as negative bias', () => {
    const curve = buildCurve(observations([[30, 45, 50], [40, 45, 50]]));
    expect(curve.bias).toBeLessThan(0);
  });

  it('reports a calibrated forecaster as near zero', () => {
    const curve = buildCurve(observations([[80, 40, 50], [40, 20, 50]]));
    expect(Math.abs(curve.bias)).toBeLessThan(0.01);
  });
});

describe('bucketing', () => {
  it('places 100% in the top decile rather than off the end', () => {
    const curve = buildCurve(observations([[100, 1, 1]]));
    expect(curve.buckets[9]!.n).toBe(1);
  });

  it('places 0% in the bottom decile', () => {
    const curve = buildCurve(observations([[0, 0, 1]]));
    expect(curve.buckets[0]!.n).toBe(1);
  });

  it('records observed accuracy per bucket', () => {
    const curve = buildCurve(observations([[75, 30, 60]]));
    expect(curve.buckets[7]!.observed).toBeCloseTo(0.5, 10);
    expect(curve.buckets[7]!.statedMean).toBeCloseTo(0.75, 10);
  });
});

describe('Brier score', () => {
  it('is zero for a perfect forecaster', () => {
    expect(buildCurve(observations([[100, 10, 10], [0, 0, 10]])).brier).toBeCloseTo(0, 10);
  });

  it('is 0.25 for always saying 50%', () => {
    expect(buildCurve(observations([[50, 50, 100]])).brier).toBeCloseTo(0.25, 10);
  });
});

describe('correction only happens with enough data', () => {
  it('returns the stated value flagged uncalibrated below the threshold', () => {
    const curve = buildCurve(observations([[80, 2, 10]]));
    const c = calibrate(80, curve);

    expect(curve.sufficient).toBe(false);
    expect(c.uncalibrated).toBe(true);
    expect(c.p).toBeCloseTo(0.8, 10);
  });

  it('corrects a stated 80% down to observed accuracy once sufficient', () => {
    const curve = buildCurve(observations([[80, 30, 60], [40, 10, 40]]));
    expect(curve.n).toBeGreaterThanOrEqual(MIN_CALIBRATION_SAMPLES);

    const c = calibrate(80, curve);
    expect(c.uncalibrated).toBe(false);
    expect(c.p).toBeCloseTo(0.5, 10);
    expect(c.statedP).toBeCloseTo(0.8, 10);
  });

  it('falls back to the nearest populated decile', () => {
    const curve = buildCurve(observations([[80, 30, 60], [10, 0, 40]]));
    const c = calibrate(50, curve); // decile 5 is empty
    expect(c.uncalibrated).toBe(false);
    expect(c.n).toBeGreaterThan(0);
  });
});

describe('the correction feeds the EV threshold', () => {
  it('turns an apparently safe MCQ into a violation', () => {
    // Stated 30% clears the 0.25 breakeven. Calibrated, it does not.
    const curve = buildCurve(observations([[30, 6, 60], [70, 20, 40]]));
    const c = calibrate(30, curve);

    expect(c.statedP).toBeCloseTo(0.3, 10);
    expect(c.p).toBeCloseTo(0.1, 10);
    expect(c.statedP).toBeGreaterThan(0.25);
    expect(c.p).toBeLessThan(0.25);
  });
});

describe('empty input', () => {
  it('does not divide by zero', () => {
    const curve = buildCurve([]);
    expect(curve.n).toBe(0);
    expect(curve.bias).toBe(0);
    expect(curve.brier).toBe(0);
    expect(calibrate(50, curve).uncalibrated).toBe(true);
  });
});
