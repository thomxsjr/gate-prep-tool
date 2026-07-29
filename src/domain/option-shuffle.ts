/**
 * Detecting whether recorded option labels can be compared to an answer key.
 *
 * GATE shuffles option order per candidate. A response sheet's "Chosen Option:
 * A" means the option displayed to that candidate in position A, which need
 * not be the master paper's option A. Scoring across that gap produces a
 * confident, badly wrong number — on the 2026 sitting it yields 21.00 against
 * a true 53.00, with General Aptitude coming out NEGATIVE.
 *
 * NAT questions have no options, so they are immune. That makes them a
 * built-in control group: if the option-bearing types score at chance while
 * NAT scores far above it, the labels are noise.
 *
 * This is deliberately pure and tested. The failure it prevents is silent.
 */

export type OptionQType = 'MCQ' | 'MSQ' | 'NAT';

export interface ScoredSample {
  qtype: OptionQType;
  /** Number of options presented. Used for the chance rate. */
  optionCount?: number;
  wasCorrect: boolean;
}

export interface TypeAccuracy {
  qtype: OptionQType;
  attempted: number;
  correct: number;
  accuracy: number;
  /** Accuracy expected if the recorded label carried no information. */
  chanceRate: number;
  hasOptions: boolean;
}

export interface ShuffleVerdict {
  /** True when option labels must NOT be compared to the key. */
  labelsUnusable: boolean;
  reason: string;
  byType: TypeAccuracy[];
  /** P(observed or fewer correct) if skill matched the NAT control. */
  pIfSkillMatchedControl: number | null;
  /** P(observed or MORE correct) if labels were pure noise. Large = consistent with noise. */
  pIfNoise: number | null;
  controlAccuracy: number | null;
  controlSize: number;
}

/** MCQ: one of N. MSQ: one of the 2^N − 1 non-empty subsets. */
export function chanceRate(qtype: OptionQType, optionCount = 4): number {
  if (qtype === 'NAT') return 0;
  if (optionCount < 1) return 0;
  return qtype === 'MCQ' ? 1 / optionCount : 1 / (2 ** optionCount - 1);
}

export function accuracyByType(samples: readonly ScoredSample[]): TypeAccuracy[] {
  const types: OptionQType[] = ['MCQ', 'MSQ', 'NAT'];
  return types.map((qtype) => {
    const rows = samples.filter((s) => s.qtype === qtype);
    const correct = rows.filter((s) => s.wasCorrect).length;
    const optionCount = rows[0]?.optionCount ?? 4;
    return {
      qtype,
      attempted: rows.length,
      correct,
      accuracy: rows.length === 0 ? 0 : correct / rows.length,
      chanceRate: chanceRate(qtype, optionCount),
      hasOptions: qtype !== 'NAT',
    };
  });
}

/** Minimum NAT sample before it is trusted as a control group. */
export const MIN_CONTROL_SAMPLE = 10;

/** Below this p-value the "skill matched the control" explanation is rejected. */
export const SIGNIFICANCE = 0.01;

export function detectOptionShuffle(samples: readonly ScoredSample[]): ShuffleVerdict {
  const byType = accuracyByType(samples);
  const control = byType.find((t) => t.qtype === 'NAT')!;
  const optioned = byType.filter((t) => t.hasOptions && t.attempted > 0);

  const base: Omit<ShuffleVerdict, 'labelsUnusable' | 'reason'> = {
    byType,
    pIfSkillMatchedControl: null,
    pIfNoise: null,
    controlAccuracy: control.attempted > 0 ? control.accuracy : null,
    controlSize: control.attempted,
  };

  if (control.attempted < MIN_CONTROL_SAMPLE) {
    return {
      ...base,
      labelsUnusable: false,
      reason:
        `only ${control.attempted} NAT question(s) — too few to use as a control. ` +
        `Option labels are assumed usable; verify by hand.`,
    };
  }
  if (optioned.length === 0) {
    return { ...base, labelsUnusable: false, reason: 'no option-bearing questions to judge.' };
  }

  const attempted = optioned.reduce((a, t) => a + t.attempted, 0);
  const correct = optioned.reduce((a, t) => a + t.correct, 0);
  const chance =
    optioned.reduce((a, t) => a + t.chanceRate * t.attempted, 0) / attempted;

  // Two different tails, and the direction matters.
  //
  // "Below the control" is a LOWER tail: P(X <= observed | control accuracy).
  //
  // "Consistent with noise" is an UPPER tail: P(X >= observed | chance). Using
  // the lower tail here would call an accuracy far ABOVE chance "consistent
  // with noise", because P(X <= observed) tends to 1 as performance improves —
  // the guard would fire on a candidate whose labels were perfectly fine.
  const pSkill = binomialCdf(correct, attempted, control.accuracy);
  const pNoise = binomialSf(correct, attempted, chance);

  const looksLikeNoise = pNoise > SIGNIFICANCE;
  const belowControl = pSkill < SIGNIFICANCE;

  return {
    ...base,
    pIfSkillMatchedControl: pSkill,
    pIfNoise: pNoise,
    labelsUnusable: looksLikeNoise && belowControl,
    reason:
      looksLikeNoise && belowControl
        ? `option-bearing accuracy ${(correct / attempted * 100).toFixed(1)}% sits at chance ` +
          `(${(chance * 100).toFixed(1)}%) while NAT reaches ${(control.accuracy * 100).toFixed(1)}%. ` +
          `P(observed | skill matched NAT) = ${pSkill.toExponential(2)}. ` +
          `The recorded labels do not correspond to the key's labels.`
        : `option-bearing accuracy ${(correct / attempted * 100).toFixed(1)}% is consistent with ` +
          `the NAT control at ${(control.accuracy * 100).toFixed(1)}%. Labels appear usable.`,
  };
}

/** P(X <= k) for X ~ Binomial(n, p). Iterative, so large n does not overflow. */
export function binomialCdf(k: number, n: number, p: number): number {
  if (n === 0) return 1;
  if (p <= 0) return k >= 0 ? 1 : 0;
  if (p >= 1) return k >= n ? 1 : 0;

  let term = (1 - p) ** n;
  let sum = term;
  for (let i = 1; i <= k && i <= n; i += 1) {
    term *= ((n - i + 1) / i) * (p / (1 - p));
    sum += term;
  }
  return Math.min(1, sum);
}

/** P(X >= k) for X ~ Binomial(n, p). The upper tail. */
export function binomialSf(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  return Math.max(0, 1 - binomialCdf(k - 1, n, p));
}
