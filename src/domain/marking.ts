/**
 * GATE DA marking scheme.
 *
 * ⚠ VERIFY AGAINST THE OFFICIAL GATE 2027 BROCHURE BEFORE PHASE 3.
 * Every value here is carried from the 2026 rules. The organising institute
 * changes for GATE 2027 and section weights have moved before. The `config`
 * table carries `verified_against_brochure` per group and the UI shows a
 * standing banner until it is cleared. Do not clear it from memory — open the
 * brochure.
 */

export type QuestionType = 'MCQ' | 'MSQ' | 'NAT';
export type Marks = 1 | 2;

export interface MarkingScheme {
  totalQuestions: number;
  totalMarks: number;
  durationMinutes: number;
  sectionMarks: { GA: number; SUBJECT: number };
  /**
   * MCQ penalty is `marks * penaltyNumerator / penaltyDenominator`.
   *
   * Held as an exact rational, not a float. 1/3 has no binary representation;
   * a `0.3333` here would drift across a six-month error log and the whole
   * instrument would quietly lie. See `scoring.ts`.
   */
  mcqPenalty: { numerator: number; denominator: number };
  /** Seconds allowed per question before the soft warning, keyed by marks. */
  timeBudgetSeconds: Record<Marks, number>;
  /** Multiple of the budget at which a question is hard-flagged. */
  hardFlagMultiplier: number;
}

export const DEFAULT_MARKING: MarkingScheme = {
  totalQuestions: 65,
  totalMarks: 100,
  durationMinutes: 180,
  sectionMarks: { GA: 15, SUBJECT: 85 },
  mcqPenalty: { numerator: 1, denominator: 3 },
  timeBudgetSeconds: { 1: 90, 2: 180 },
  hardFlagMultiplier: 2,
};

/**
 * Marks are held internally as integer THIRDS.
 *
 * Every quantity in GATE DA scoring is a multiple of 1/3: awards are 1 or 2,
 * penalties are 1/3 or 2/3. Working in thirds makes all arithmetic exact
 * integer arithmetic, so sums over hundreds of attempts are exact and
 * `marks_lost` totals never drift. Division happens once, at the display
 * boundary, in `thirdsToMarks`.
 */
export type Thirds = number;

export const THIRDS_PER_MARK = 3;

export function marksToThirds(marks: number): Thirds {
  const t = marks * THIRDS_PER_MARK;
  if (!Number.isInteger(t)) {
    throw new RangeError(
      `marks ${marks} is not a whole number of thirds; GATE marks are 1 or 2`,
    );
  }
  return t;
}

export function thirdsToMarks(thirds: Thirds): number {
  return thirds / THIRDS_PER_MARK;
}

/** Fixed 2dp string for display. Never let a raw float reach the DOM. */
export function formatMarks(thirds: Thirds): string {
  return thirdsToMarks(thirds).toFixed(2);
}
