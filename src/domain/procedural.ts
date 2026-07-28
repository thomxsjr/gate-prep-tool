/**
 * Procedural error share — the primary metric.
 *
 * Definition, fixed here and nowhere else:
 *
 *     share = Σ marksLost[procedural] / Σ marksLost[all]
 *
 * marks-weighted (not count-weighted), over attempts that are:
 *
 *   - real work: context ∈ {mock, sectional, pyq, practice}. DRILLS ARE
 *     EXCLUDED. M4 generates boundary questions by construction, so letting
 *     them in would inflate the numerator toward 100% and the instrument
 *     would congratulate the user for practising.
 *   - triaged: an untriaged attempt has no verified error class. Excluding
 *     them means the metric cannot be improved by leaving hard entries
 *     unlabelled.
 *   - within the window.
 *
 * Baseline is 46% on the 2026 paper. Target is zero.
 */

export const PROCEDURAL_BASELINE = 0.46;

/** Contexts that count as real work. Drill is deliberately absent. */
export const SCORED_CONTEXTS = [
  'mock',
  'sectional',
  'pyq',
  'practice',
] as const;
export type ScoredContext = (typeof SCORED_CONTEXTS)[number];

export interface ShareAttempt {
  attemptedAt: string; // ISO date
  context: string;
  marksLost: number;
  isProcedural: boolean | null;
  errorClassId: number | null;
  errorCode?: string | null;
  triagedAt: string | null;
}

export interface ShareResult {
  share: number | null;
  proceduralMarksLost: number;
  totalMarksLost: number;
  attempts: number;
  /** Rows in the window that were dropped for want of a triage. */
  excludedUntriaged: number;
  /** True when nothing qualified, so `share` is null rather than 0. */
  empty: boolean;
}

export interface Window {
  from: Date;
  to: Date;
}

export function isScoredContext(context: string): context is ScoredContext {
  return (SCORED_CONTEXTS as readonly string[]).includes(context);
}

export function proceduralShare(
  attempts: readonly ShareAttempt[],
  window?: Window,
): ShareResult {
  let procedural = 0;
  let total = 0;
  let counted = 0;
  let excludedUntriaged = 0;

  for (const a of attempts) {
    if (!isScoredContext(a.context)) continue;
    if (window && !inWindow(a.attemptedAt, window)) continue;

    if (a.triagedAt === null) {
      excludedUntriaged += 1;
      continue;
    }
    if (a.marksLost <= 0) continue;

    counted += 1;
    total += a.marksLost;
    if (a.isProcedural) procedural += a.marksLost;
  }

  return {
    share: total > 0 ? procedural / total : null,
    proceduralMarksLost: procedural,
    totalMarksLost: total,
    attempts: counted,
    excludedUntriaged,
    empty: total === 0,
  };
}

export interface SeriesPoint {
  weekStart: string;
  share: number | null;
  totalMarksLost: number;
  attempts: number;
}

/**
 * Weekly series for the sparkline. Weeks with no qualifying loss carry a null
 * share rather than a zero — a quiet week is missing data, not a perfect one,
 * and plotting it as zero would draw a triumphant line through nothing.
 */
export function weeklySeries(
  attempts: readonly ShareAttempt[],
  weeks: number,
  now: Date = new Date(),
): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  const thisWeekStart = startOfWeek(now);

  for (let i = weeks - 1; i >= 0; i -= 1) {
    const from = addDays(thisWeekStart, -7 * i);
    const to = addDays(from, 7);
    const r = proceduralShare(attempts, { from, to });
    out.push({
      weekStart: from.toISOString().slice(0, 10),
      share: r.share,
      totalMarksLost: r.totalMarksLost,
      attempts: r.attempts,
    });
  }
  return out;
}

export type Direction = 'falling' | 'rising' | 'flat' | 'unknown';

/**
 * Direction of travel over the series. Compares the mean of the first half
 * against the second half rather than endpoint-to-endpoint, so one loud week
 * cannot flip the reading.
 */
export function direction(series: readonly SeriesPoint[], epsilon = 0.02): Direction {
  const vals = series.filter((p) => p.share !== null).map((p) => p.share!);
  if (vals.length < 4) return 'unknown';

  const mid = Math.floor(vals.length / 2);
  const first = mean(vals.slice(0, mid));
  const second = mean(vals.slice(mid));
  const delta = second - first;

  if (Math.abs(delta) < epsilon) return 'flat';
  return delta < 0 ? 'falling' : 'rising';
}

export interface LeakRow {
  errorClassId: number;
  code: string;
  name: string;
  isProcedural: boolean;
  occurrences: number;
  marksLost: number;
  /** Share of all marks lost in the window. */
  shareOfLoss: number;
}

/**
 * The leak table: marks lost per error class over a window, sorted by damage.
 * Pareto ordering, because the point is to pick the next target by damage
 * rather than by feel.
 */
export function leakTable(
  attempts: readonly ShareAttempt[],
  classes: ReadonlyArray<{ id: number; code: string; name: string; isProcedural: boolean }>,
  window?: Window,
): LeakRow[] {
  const acc = new Map<number, { occurrences: number; marksLost: number }>();
  let total = 0;

  for (const a of attempts) {
    if (!isScoredContext(a.context)) continue;
    if (window && !inWindow(a.attemptedAt, window)) continue;
    if (a.triagedAt === null || a.errorClassId === null) continue;
    if (a.marksLost <= 0) continue;

    const cur = acc.get(a.errorClassId) ?? { occurrences: 0, marksLost: 0 };
    cur.occurrences += 1;
    cur.marksLost += a.marksLost;
    acc.set(a.errorClassId, cur);
    total += a.marksLost;
  }

  return classes
    .map((c) => {
      const hit = acc.get(c.id) ?? { occurrences: 0, marksLost: 0 };
      return {
        errorClassId: c.id,
        code: c.code,
        name: c.name,
        isProcedural: c.isProcedural,
        occurrences: hit.occurrences,
        marksLost: hit.marksLost,
        shareOfLoss: total > 0 ? hit.marksLost / total : 0,
      };
    })
    .sort((a, b) => b.marksLost - a.marksLost || a.code.localeCompare(b.code));
}

/**
 * The one error class to attack next, chosen by damage over the window.
 * Returns null rather than guessing when nothing has leaked.
 */
export function worstClass(rows: readonly LeakRow[]): LeakRow | null {
  const top = rows.find((r) => r.marksLost > 0);
  return top ?? null;
}

/**
 * Trailing incidence per 100 attempts for one error class. This — not a
 * checkbox — is what fills a rung, and it is the part of the Ladder that
 * transfers to a paper the user has not sat.
 */
export function classIncidence(
  attempts: readonly ShareAttempt[],
  errorClassId: number,
  window?: Window,
): { per100: number; occurrences: number; denominator: number } {
  let occurrences = 0;
  let denominator = 0;

  for (const a of attempts) {
    if (!isScoredContext(a.context)) continue;
    if (window && !inWindow(a.attemptedAt, window)) continue;
    if (a.triagedAt === null) continue;

    denominator += 1;
    if (a.errorClassId === errorClassId) occurrences += 1;
  }

  return {
    per100: denominator === 0 ? 0 : (occurrences / denominator) * 100,
    occurrences,
    denominator,
  };
}

function inWindow(iso: string, w: Window): boolean {
  const t = new Date(iso).getTime();
  return t >= w.from.getTime() && t < w.to.getTime();
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Monday-anchored, UTC, so weeks do not shift with local time. */
export function startOfWeek(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - dow);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
