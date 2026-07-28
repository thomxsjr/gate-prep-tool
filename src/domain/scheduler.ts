/**
 * SM-2 spaced repetition. Pure, so it can be swapped for FSRS later without
 * touching anything that calls it.
 *
 * Grades follow the original SM-2 scale:
 *   0 total blackout · 1 wrong, familiar · 2 wrong, easy to recall once shown
 *   3 correct, serious difficulty · 4 correct, hesitation · 5 perfect
 *
 * Grades below 3 are lapses: the interval resets and the card comes back
 * tomorrow. The ease factor floors at 1.3, as in the original algorithm.
 */

export interface CardState {
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
}

export interface ReviewResult extends CardState {
  dueDate: string; // ISO date, no time component
  wasLapse: boolean;
}

export const MIN_EASE = 1.3;
export const DEFAULT_EASE = 2.5;
export const PASS_GRADE = 3;

export function newCard(): CardState {
  return { intervalDays: 0, ease: DEFAULT_EASE, reps: 0, lapses: 0 };
}

export function review(
  state: CardState,
  grade: number,
  reviewedAt: Date = new Date(),
): ReviewResult {
  if (!Number.isInteger(grade) || grade < 0 || grade > 5) {
    throw new RangeError(`grade must be an integer 0–5, received ${grade}`);
  }

  // SM-2 order matters: the interval is computed from the ease the card
  // carried INTO this review, and the ease is updated afterwards. Applying
  // the update first inflates every interval by one review's worth of ease.
  const ease = nextEase(state.ease, grade);

  if (grade < PASS_GRADE) {
    // Lapse: back to a one-day interval, rep count reset, ease already
    // penalised above.
    return {
      intervalDays: 1,
      ease,
      reps: 0,
      lapses: state.lapses + 1,
      dueDate: isoDate(addDays(reviewedAt, 1)),
      wasLapse: true,
    };
  }

  const reps = state.reps + 1;
  let intervalDays: number;
  if (reps === 1) intervalDays = 1;
  else if (reps === 2) intervalDays = 6;
  else intervalDays = Math.round(state.intervalDays * state.ease);

  // A card can never be scheduled backwards.
  intervalDays = Math.max(1, intervalDays);

  return {
    intervalDays,
    ease,
    reps,
    lapses: state.lapses,
    dueDate: isoDate(addDays(reviewedAt, intervalDays)),
    wasLapse: false,
  };
}

/** SM-2 ease update: EF' = EF + (0.1 − (5−q)(0.08 + (5−q)·0.02)) */
export function nextEase(ease: number, grade: number): number {
  const q = grade;
  const delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
  return Math.max(MIN_EASE, round2(ease + delta));
}

export function isDue(dueDate: string, on: Date = new Date()): boolean {
  return dueDate <= isoDate(on);
}

export function dueCards<T extends { dueDate: string; suspended?: boolean }>(
  cards: readonly T[],
  on: Date = new Date(),
): T[] {
  return cards
    .filter((c) => !c.suspended && isDue(c.dueDate, on))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
