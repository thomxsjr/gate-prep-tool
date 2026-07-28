/**
 * Expected-value calculator for the attempt decision.
 *
 * The arithmetic, once, in full:
 *
 *     EV(p) = p·m − (1−p)·(m/3)
 *
 * Setting EV = 0:
 *
 *     p·m = (m/3)·(1 − p)
 *     3p  = 1 − p
 *     p   = 1/4
 *
 * The `m` cancels. Breakeven is EXACTLY 0.25 for every MCQ regardless of
 * whether it is worth 1 mark or 2, because the penalty scales with the
 * reward. Two consequences that invert the folk rule:
 *
 *   - Blind guessing on a 4-option MCQ is EV-NEUTRAL. Exactly zero, not
 *     negative.
 *   - Eliminating a single option puts p at 1/3 and EV at +0.11 per mark.
 *     Positive. Every such question walked away from is a donation.
 *
 * MSQ and NAT carry no negative marking, so their EV is non-negative for any
 * p > 0 and leaving one blank is strictly dominated. The app calls that a
 * discipline violation, never a neutral choice.
 *
 * This module reports the margin, not a verdict, so the arithmetic stays
 * visible rather than being trusted as a rule of thumb.
 */

import {
  type Marks,
  type MarkingScheme,
  type QuestionType,
  DEFAULT_MARKING,
} from './marking.ts';

export interface EvInput {
  qtype: QuestionType;
  marks: Marks;
  /** Probability of answering correctly, in [0,1]. Should be CALIBRATED. */
  p: number;
  scheme?: MarkingScheme;
}

export interface EvResult {
  /** Expected marks from attempting. */
  evAttempt: number;
  /** Expected marks from skipping. Always 0. */
  evSkip: number;
  /** evAttempt − evSkip. Positive means attempt. */
  margin: number;
  /** The p at which evAttempt crosses zero. */
  breakevenP: number;
  shouldAttempt: boolean;
  /** True when there is no downside at all, so skipping is dominated. */
  freeShot: boolean;
}

export function breakevenP(
  qtype: QuestionType,
  scheme: MarkingScheme = DEFAULT_MARKING,
): number {
  if (qtype !== 'MCQ') return 0;
  const { numerator, denominator } = scheme.mcqPenalty;
  // p·m = (n/d)·m·(1−p)  →  p = n / (n + d)
  return numerator / (numerator + denominator);
}

export function expectedValue(input: EvInput): EvResult {
  const scheme = input.scheme ?? DEFAULT_MARKING;
  const p = clamp01(input.p);
  const m = input.marks;

  const penalty =
    input.qtype === 'MCQ'
      ? (m * scheme.mcqPenalty.numerator) / scheme.mcqPenalty.denominator
      : 0;

  const evAttempt = p * m - (1 - p) * penalty;
  const be = breakevenP(input.qtype, scheme);
  const freeShot = penalty === 0;

  return {
    evAttempt,
    evSkip: 0,
    margin: evAttempt,
    breakevenP: be,
    // Strictly greater: at exactly breakeven the attempt is a coin-flip with
    // no edge, and the time is better spent elsewhere.
    shouldAttempt: freeShot ? true : p > be,
    freeShot,
  };
}

/**
 * EV given that `eliminated` options have been ruled out of `totalOptions`,
 * assuming a uniform guess among the survivors. This is the number that makes
 * the 70%-confidence rule look as expensive as it is.
 */
export function evAfterElimination(
  qtype: QuestionType,
  marks: Marks,
  totalOptions: number,
  eliminated: number,
  scheme: MarkingScheme = DEFAULT_MARKING,
): EvResult {
  const survivors = Math.max(1, totalOptions - eliminated);
  return expectedValue({ qtype, marks, p: 1 / survivors, scheme });
}

export type ViolationKind =
  | 'mcq_attempted_below_ev'
  | 'msq_left_blank'
  | 'nat_left_blank';

export interface DisciplineViolation {
  kind: ViolationKind;
  marks: Marks;
  /** Marks forgone (blanks) or expected loss (bad attempts), as a magnitude. */
  cost: number;
  detail: string;
}

export interface AttemptDecision {
  qtype: QuestionType;
  marks: Marks;
  attempted: boolean;
  /** Calibrated where available; see `calibration.ts`. */
  p: number | null;
}

/**
 * Discipline violations for one sitting.
 *
 * A blank MSQ or NAT is ALWAYS a violation — there is no downside to an
 * attempt, so the blank forfeits the whole mark for nothing.
 *
 * An MCQ attempted below breakeven is a violation only when we actually have
 * a probability to judge it by. With `p === null` we stay silent rather than
 * guess, because a fabricated violation is worse than a missed one.
 */
export function findViolations(
  decisions: readonly AttemptDecision[],
  scheme: MarkingScheme = DEFAULT_MARKING,
): DisciplineViolation[] {
  const out: DisciplineViolation[] = [];

  for (const d of decisions) {
    if (!d.attempted && (d.qtype === 'MSQ' || d.qtype === 'NAT')) {
      out.push({
        kind: d.qtype === 'MSQ' ? 'msq_left_blank' : 'nat_left_blank',
        marks: d.marks,
        cost: d.marks,
        detail: `${d.qtype} left blank. No negative marking applies, so the attempt was free and the blank forfeits ${d.marks.toFixed(2)}.`,
      });
      continue;
    }

    if (d.attempted && d.qtype === 'MCQ' && d.p !== null) {
      const ev = expectedValue({ qtype: d.qtype, marks: d.marks, p: d.p, scheme });
      if (ev.evAttempt < 0) {
        out.push({
          kind: 'mcq_attempted_below_ev',
          marks: d.marks,
          cost: Math.abs(ev.evAttempt),
          detail: `MCQ attempted at p=${d.p.toFixed(2)}, below breakeven ${ev.breakevenP.toFixed(2)}. Expected ${ev.evAttempt.toFixed(3)}.`,
        });
      }
    }
  }

  return out;
}

/**
 * Net marks attributable to attempt decisions in one sitting: what the
 * choices earned minus what they cost. One number that answers "is my attempt
 * policy helping or costing me".
 */
export function netFromAttemptPolicy(
  decisions: readonly AttemptDecision[],
  scheme: MarkingScheme = DEFAULT_MARKING,
): { gained: number; forgone: number; net: number } {
  let gained = 0;
  let forgone = 0;

  for (const d of decisions) {
    if (d.p === null) continue;
    const ev = expectedValue({ qtype: d.qtype, marks: d.marks, p: d.p, scheme });
    if (d.attempted) {
      gained += ev.evAttempt;
    } else if (ev.evAttempt > 0) {
      // Skipped something with positive expectation: that is the cost.
      forgone += ev.evAttempt;
    }
  }

  return { gained, forgone, net: gained - forgone };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
