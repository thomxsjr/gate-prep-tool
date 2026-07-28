import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EASE,
  MIN_EASE,
  dueCards,
  isDue,
  newCard,
  nextEase,
  review,
} from '../src/domain/scheduler.ts';

const AT = new Date('2026-07-28T00:00:00.000Z');

describe('SM-2 intervals', () => {
  it('steps 1 → 6 → interval × ease', () => {
    let s = newCard();
    s = review(s, 5, AT);
    expect(s.intervalDays).toBe(1);

    s = review(s, 5, AT);
    expect(s.intervalDays).toBe(6);

    const easeAfterTwo = s.ease;
    s = review(s, 5, AT);
    expect(s.intervalDays).toBe(Math.round(6 * easeAfterTwo));
  });

  it('sets a due date the interval ahead', () => {
    const r = review(newCard(), 4, AT);
    expect(r.dueDate).toBe('2026-07-29');
  });

  it('never schedules backwards', () => {
    const r = review({ intervalDays: 0.2, ease: MIN_EASE, reps: 5, lapses: 0 }, 3, AT);
    expect(r.intervalDays).toBeGreaterThanOrEqual(1);
  });
});

describe('lapses', () => {
  it.each([0, 1, 2])('grade %i resets the interval and counts a lapse', (grade) => {
    const s = { intervalDays: 30, ease: 2.5, reps: 6, lapses: 1 };
    const r = review(s, grade, AT);

    expect(r.wasLapse).toBe(true);
    expect(r.intervalDays).toBe(1);
    expect(r.reps).toBe(0);
    expect(r.lapses).toBe(2);
    expect(r.dueDate).toBe('2026-07-29');
  });

  it.each([3, 4, 5])('grade %i is a pass', (grade) => {
    const r = review({ intervalDays: 10, ease: 2.5, reps: 3, lapses: 0 }, grade, AT);
    expect(r.wasLapse).toBe(false);
    expect(r.lapses).toBe(0);
    expect(r.reps).toBe(4);
  });
});

describe('ease factor', () => {
  it('rises on a perfect recall and falls on a hard one', () => {
    expect(nextEase(2.5, 5)).toBeGreaterThan(2.5);
    expect(nextEase(2.5, 3)).toBeLessThan(2.5);
  });

  it('is unchanged at grade 4', () => {
    expect(nextEase(2.5, 4)).toBe(2.5);
  });

  it('floors at 1.3 however many failures', () => {
    let ease = DEFAULT_EASE;
    for (let i = 0; i < 50; i += 1) ease = nextEase(ease, 0);
    expect(ease).toBe(MIN_EASE);
  });

  it('matches the SM-2 formula', () => {
    // EF' = EF + (0.1 − (5−q)(0.08 + (5−q)·0.02)), q = 3 → −0.14
    expect(nextEase(2.5, 3)).toBeCloseTo(2.36, 10);
  });
});

describe('input validation', () => {
  it.each([-1, 6, 2.5, NaN])('rejects grade %p', (grade) => {
    expect(() => review(newCard(), grade as number, AT)).toThrow(RangeError);
  });
});

describe('due selection', () => {
  it('includes cards due today and overdue', () => {
    expect(isDue('2026-07-28', AT)).toBe(true);
    expect(isDue('2026-07-27', AT)).toBe(true);
    expect(isDue('2026-07-29', AT)).toBe(false);
  });

  it('skips suspended cards and sorts oldest first', () => {
    const cards = [
      { id: 1, dueDate: '2026-07-28' },
      { id: 2, dueDate: '2026-07-20' },
      { id: 3, dueDate: '2026-08-01' },
      { id: 4, dueDate: '2026-07-01', suspended: true },
    ];
    expect(dueCards(cards, AT).map((c) => c.id)).toEqual([2, 1]);
  });
});

describe('a new card starts at the documented defaults', () => {
  it('has no interval and the default ease', () => {
    expect(newCard()).toEqual({ intervalDays: 0, ease: DEFAULT_EASE, reps: 0, lapses: 0 });
  });
});
