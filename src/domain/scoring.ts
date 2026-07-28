/**
 * Scoring engine. Pure. All arithmetic in integer thirds.
 *
 * The one definition everything downstream inherits:
 *
 *     marksLost = marksAvailable - marksObtained
 *
 * so a wrong 1-mark MCQ loses 1.33 (the mark forgone plus the negative
 * incurred) while a skipped one loses 1.00. This is what makes a wrong
 * attempt correctly worse than a skip, and it is what makes negative marking
 * visible in the leak table instead of hiding inside the raw score.
 */

import {
  type Marks,
  type MarkingScheme,
  type QuestionType,
  type Thirds,
  DEFAULT_MARKING,
  marksToThirds,
} from './marking.ts';

export type Outcome = 'correct' | 'wrong' | 'skipped' | 'correct_but_guessed';

export interface ScoreInput {
  qtype: QuestionType;
  marks: Marks;
  /** Whether the answer given was right. Ignored when `attempted` is false. */
  isCorrect: boolean;
  attempted: boolean;
  /** Self-reported guess, for calibration. Does not change the score. */
  guessed?: boolean;
}

export interface ScoreResult {
  outcome: Outcome;
  availableThirds: Thirds;
  obtainedThirds: Thirds;
  lostThirds: Thirds;
  /** Negative marking incurred, as a positive magnitude. */
  penaltyThirds: Thirds;
}

/**
 * MCQ penalty in thirds: `marks * numerator / denominator * 3`.
 * With the standard 1/3 rule this is exactly `marks` thirds — a 1-mark MCQ
 * costs 1 third, a 2-mark MCQ costs 2 thirds. Integer, always.
 */
export function mcqPenaltyThirds(
  marks: Marks,
  scheme: MarkingScheme = DEFAULT_MARKING,
): Thirds {
  const { numerator, denominator } = scheme.mcqPenalty;
  const penalty = (marksToThirds(marks) * numerator) / denominator;
  if (!Number.isInteger(penalty)) {
    throw new RangeError(
      `penalty for ${marks}-mark MCQ is ${penalty} thirds, not an integer; ` +
        `the scheme ${numerator}/${denominator} breaks exact arithmetic`,
    );
  }
  return penalty;
}

export function score(
  input: ScoreInput,
  scheme: MarkingScheme = DEFAULT_MARKING,
): ScoreResult {
  const availableThirds = marksToThirds(input.marks);

  if (!input.attempted) {
    return {
      outcome: 'skipped',
      availableThirds,
      obtainedThirds: 0,
      lostThirds: availableThirds,
      penaltyThirds: 0,
    };
  }

  if (input.isCorrect) {
    return {
      outcome: input.guessed ? 'correct_but_guessed' : 'correct',
      availableThirds,
      obtainedThirds: availableThirds,
      lostThirds: 0,
      penaltyThirds: 0,
    };
  }

  // Wrong. Only MCQ carries a negative; MSQ and NAT do not.
  const penaltyThirds =
    input.qtype === 'MCQ' ? mcqPenaltyThirds(input.marks, scheme) : 0;

  return {
    outcome: 'wrong',
    availableThirds,
    // `0 - x` rather than `-x`: negating zero yields -0, which is not
    // Object.is-equal to 0 and would leak a signed zero into the DB and every
    // comparison downstream.
    obtainedThirds: 0 - penaltyThirds,
    lostThirds: availableThirds + penaltyThirds,
    penaltyThirds,
  };
}

/**
 * MSQ: all correct options selected and no incorrect ones, or zero.
 * No partial credit, no negative marking.
 *
 * Deliberately variable-N — GATE MSQs are not always four options.
 */
export function isMsqCorrect(
  selected: readonly string[],
  correct: readonly string[],
): boolean {
  const sel = new Set(selected);
  const cor = new Set(correct);
  if (sel.size !== cor.size) return false;
  for (const label of cor) if (!sel.has(label)) return false;
  return true;
}

/**
 * NAT: numeric within tolerance. The official key gives ranges, so a
 * tolerance of 0 is almost always wrong to use.
 */
export function isNatCorrect(
  given: number | null,
  correct: number,
  tolerance = 0,
): boolean {
  if (given === null || !Number.isFinite(given)) return false;
  return Math.abs(given - correct) <= Math.abs(tolerance) + Number.EPSILON;
}

/** Count of options whose True/False verdict was right. M3's real metric. */
export function perOptionAccuracy(
  verdicts: ReadonlyArray<{ myVerdict: boolean; isCorrect: boolean }>,
): { right: number; total: number; accuracy: number } {
  const total = verdicts.length;
  const right = verdicts.filter((v) => v.myVerdict === v.isCorrect).length;
  return { right, total, accuracy: total === 0 ? 0 : right / total };
}

/**
 * The money metric of M3: an MSQ where all but one option verdict was right
 * and the question therefore scored zero. Near-misses are the habit, and the
 * raw question score renders them invisible.
 */
export function isNearMissMsq(
  verdicts: ReadonlyArray<{ myVerdict: boolean; isCorrect: boolean }>,
): boolean {
  const { right, total } = perOptionAccuracy(verdicts);
  return total > 0 && right === total - 1;
}

export interface Totals {
  availableThirds: Thirds;
  obtainedThirds: Thirds;
  lostThirds: Thirds;
  penaltyThirds: Thirds;
  attempted: number;
  correct: number;
  wrong: number;
  skipped: number;
}

export function totalise(results: readonly ScoreResult[]): Totals {
  const t: Totals = {
    availableThirds: 0,
    obtainedThirds: 0,
    lostThirds: 0,
    penaltyThirds: 0,
    attempted: 0,
    correct: 0,
    wrong: 0,
    skipped: 0,
  };
  for (const r of results) {
    t.availableThirds += r.availableThirds;
    t.obtainedThirds += r.obtainedThirds;
    t.lostThirds += r.lostThirds;
    t.penaltyThirds += r.penaltyThirds;
    if (r.outcome === 'skipped') t.skipped += 1;
    else {
      t.attempted += 1;
      if (r.outcome === 'wrong') t.wrong += 1;
      else t.correct += 1;
    }
  }
  return t;
}
