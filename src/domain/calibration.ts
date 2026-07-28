/**
 * Calibration: mapping stated confidence to observed accuracy.
 *
 * The EV threshold is only meaningful against a probability that means what
 * it says. Feeding stated confidence into the EV calculator would use the
 * exact number the calibration curve exists to prove wrong, so
 * `calibrate()` corrects it — but only once there is enough data, and it
 * reports `uncalibrated` until then rather than inventing a correction.
 *
 * Overconfidence and underconfidence are different diseases: the sign of
 * `bias` tells them apart.
 */

export interface ConfidenceObservation {
  /** Stated confidence 0–100 at the time of answering. */
  confidence: number;
  /** Whether the answer turned out to be right. */
  wasCorrect: boolean;
}

export interface CalibrationBucket {
  /** Decile index 0–9, covering [lo, hi). */
  decile: number;
  lo: number;
  hi: number;
  n: number;
  /** Mean stated confidence in the bucket, as a proportion. */
  statedMean: number;
  /** Observed accuracy in the bucket, as a proportion. */
  observed: number;
}

export interface CalibrationCurve {
  buckets: CalibrationBucket[];
  n: number;
  /**
   * Mean(stated) − mean(observed) across all observations.
   * Positive = overconfident. Negative = underconfident.
   */
  bias: number;
  /** Brier score. Lower is better; 0.25 is the score of always saying 50%. */
  brier: number;
  /** Whether there is enough data to correct with. */
  sufficient: boolean;
  minSampleSize: number;
}

/**
 * Below this many observations the curve is noise and the app says so
 * instead of correcting. 50 is a judgement call, not a theorem — it is
 * roughly one mock's worth of attempted questions.
 */
export const MIN_CALIBRATION_SAMPLES = 50;

export function buildCurve(
  observations: readonly ConfidenceObservation[],
  minSamples: number = MIN_CALIBRATION_SAMPLES,
): CalibrationCurve {
  const buckets: CalibrationBucket[] = Array.from({ length: 10 }, (_, i) => ({
    decile: i,
    lo: i / 10,
    hi: (i + 1) / 10,
    n: 0,
    statedMean: 0,
    observed: 0,
  }));

  let statedSum = 0;
  let correctSum = 0;
  let brierSum = 0;

  for (const o of observations) {
    const p = clamp01(o.confidence / 100);
    // 100% lands in the top decile rather than falling off the end.
    const idx = Math.min(9, Math.floor(p * 10));
    const b = buckets[idx]!;
    b.n += 1;
    b.statedMean += p;
    b.observed += o.wasCorrect ? 1 : 0;

    statedSum += p;
    correctSum += o.wasCorrect ? 1 : 0;
    brierSum += (p - (o.wasCorrect ? 1 : 0)) ** 2;
  }

  for (const b of buckets) {
    if (b.n > 0) {
      b.statedMean /= b.n;
      b.observed /= b.n;
    }
  }

  const n = observations.length;
  return {
    buckets,
    n,
    bias: n === 0 ? 0 : statedSum / n - correctSum / n,
    brier: n === 0 ? 0 : brierSum / n,
    sufficient: n >= minSamples,
    minSampleSize: minSamples,
  };
}

export interface CalibratedP {
  /** The probability to actually use. */
  p: number;
  /** True when `p` is the raw stated value because the curve is too thin. */
  uncalibrated: boolean;
  statedP: number;
  /** Observations backing the correction. */
  n: number;
}

/**
 * Correct a stated confidence using the curve.
 *
 * Uses the observed accuracy of the containing decile, falling back to the
 * nearest populated decile. When the curve is insufficient overall, or the
 * relevant region of it is empty, returns the stated value flagged
 * `uncalibrated` so the UI can mark it rather than quietly pretending.
 */
export function calibrate(
  statedConfidence: number,
  curve: CalibrationCurve,
): CalibratedP {
  const statedP = clamp01(statedConfidence / 100);

  if (!curve.sufficient) {
    return { p: statedP, uncalibrated: true, statedP, n: curve.n };
  }

  const idx = Math.min(9, Math.floor(statedP * 10));
  const exact = curve.buckets[idx]!;
  if (exact.n > 0) {
    return { p: clamp01(exact.observed), uncalibrated: false, statedP, n: exact.n };
  }

  const nearest = nearestPopulated(curve.buckets, idx);
  if (!nearest) {
    return { p: statedP, uncalibrated: true, statedP, n: 0 };
  }
  return {
    p: clamp01(nearest.observed),
    uncalibrated: false,
    statedP,
    n: nearest.n,
  };
}

function nearestPopulated(
  buckets: readonly CalibrationBucket[],
  from: number,
): CalibrationBucket | null {
  for (let d = 1; d < buckets.length; d += 1) {
    const lo = buckets[from - d];
    if (lo && lo.n > 0) return lo;
    const hi = buckets[from + d];
    if (hi && hi.n > 0) return hi;
  }
  return null;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
