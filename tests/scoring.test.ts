import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKING,
  marksToThirds,
  thirdsToMarks,
  formatMarks,
} from '../src/domain/marking.ts';
import {
  isMsqCorrect,
  isNatCorrect,
  isNearMissMsq,
  mcqPenaltyThirds,
  perOptionAccuracy,
  score,
  totalise,
} from '../src/domain/scoring.ts';

describe('MCQ negative marking', () => {
  it('penalises a 1-mark MCQ by 1/3', () => {
    const r = score({ qtype: 'MCQ', marks: 1, isCorrect: false, attempted: true });
    expect(r.outcome).toBe('wrong');
    expect(thirdsToMarks(r.penaltyThirds)).toBeCloseTo(1 / 3, 10);
    expect(thirdsToMarks(r.obtainedThirds)).toBeCloseTo(-1 / 3, 10);
  });

  it('penalises a 2-mark MCQ by 2/3', () => {
    const r = score({ qtype: 'MCQ', marks: 2, isCorrect: false, attempted: true });
    expect(thirdsToMarks(r.penaltyThirds)).toBeCloseTo(2 / 3, 10);
  });

  it('is exactly marks/3 at both weights', () => {
    expect(mcqPenaltyThirds(1)).toBe(1);
    expect(mcqPenaltyThirds(2)).toBe(2);
  });
});

describe('MSQ and NAT carry no negative marking', () => {
  it.each(['MSQ', 'NAT'] as const)('%s wrong answer costs no penalty', (qtype) => {
    const r = score({ qtype, marks: 2, isCorrect: false, attempted: true });
    expect(r.penaltyThirds).toBe(0);
    expect(r.obtainedThirds).toBe(0);
    expect(thirdsToMarks(r.lostThirds)).toBe(2);
  });
});

describe('marksLost = marksAvailable − marksObtained', () => {
  it('makes a wrong 1-mark MCQ cost 1.33 and a skip cost 1.00', () => {
    const wrong = score({ qtype: 'MCQ', marks: 1, isCorrect: false, attempted: true });
    const skipped = score({ qtype: 'MCQ', marks: 1, isCorrect: false, attempted: false });

    expect(formatMarks(wrong.lostThirds)).toBe('1.33');
    expect(formatMarks(skipped.lostThirds)).toBe('1.00');
    // The whole point of the definition: attempting badly is worse than skipping.
    expect(wrong.lostThirds).toBeGreaterThan(skipped.lostThirds);
  });

  it('costs nothing when correct', () => {
    const r = score({ qtype: 'MCQ', marks: 2, isCorrect: true, attempted: true });
    expect(r.lostThirds).toBe(0);
    expect(thirdsToMarks(r.obtainedThirds)).toBe(2);
  });

  it('flags a correct guess separately without changing the score', () => {
    const r = score({ qtype: 'MCQ', marks: 1, isCorrect: true, attempted: true, guessed: true });
    expect(r.outcome).toBe('correct_but_guessed');
    expect(thirdsToMarks(r.obtainedThirds)).toBe(1);
  });
});

describe('integer thirds keep long sums exact', () => {
  it('does not drift over 300 wrong 1-mark MCQs', () => {
    const results = Array.from({ length: 300 }, () =>
      score({ qtype: 'MCQ', marks: 1, isCorrect: false, attempted: true }),
    );
    const t = totalise(results);

    // 300 × (1 mark forgone + 1/3 penalty) = 300 × 4 thirds = 1200 thirds exactly.
    expect(t.lostThirds).toBe(1200);
    expect(Number.isInteger(t.lostThirds)).toBe(true);
    expect(thirdsToMarks(t.lostThirds)).toBe(400);

    // The float path this design exists to avoid.
    const naive = Array.from({ length: 300 }, () => 1 + 1 / 3).reduce((a, b) => a + b, 0);
    expect(naive).not.toBe(400);
  });

  it('rejects marks that are not a whole number of thirds', () => {
    expect(() => marksToThirds(0.5)).toThrow(RangeError);
  });
});

describe('MSQ correctness is all-or-nothing and variable-N', () => {
  it('requires every correct option and no incorrect ones', () => {
    expect(isMsqCorrect(['A', 'C'], ['A', 'C'])).toBe(true);
    expect(isMsqCorrect(['C', 'A'], ['A', 'C'])).toBe(true);
    expect(isMsqCorrect(['A'], ['A', 'C'])).toBe(false);
    expect(isMsqCorrect(['A', 'C', 'D'], ['A', 'C'])).toBe(false);
    expect(isMsqCorrect([], ['A'])).toBe(false);
  });

  it('handles option sets that are not four long', () => {
    expect(isMsqCorrect(['A', 'B', 'C'], ['A', 'B', 'C'])).toBe(true);
    expect(isMsqCorrect(['A', 'B', 'C', 'D', 'E'], ['A', 'B', 'C', 'D', 'E'])).toBe(true);
  });
});

describe('NAT tolerance', () => {
  it('accepts values inside the key range', () => {
    expect(isNatCorrect(0.333, 0.33, 0.01)).toBe(true);
    expect(isNatCorrect(0.35, 0.33, 0.01)).toBe(false);
  });

  it('treats a blank as wrong', () => {
    expect(isNatCorrect(null, 5, 0.1)).toBe(false);
  });

  it('handles an exact-match key', () => {
    expect(isNatCorrect(12, 12)).toBe(true);
    expect(isNatCorrect(12.0001, 12)).toBe(false);
  });
});

describe('per-option metrics (M3)', () => {
  const verdicts = [
    { myVerdict: true, isCorrect: true },
    { myVerdict: false, isCorrect: false },
    { myVerdict: true, isCorrect: true },
    { myVerdict: true, isCorrect: false }, // the one that cost the question
  ];

  it('scores per option independently of the question', () => {
    const a = perOptionAccuracy(verdicts);
    expect(a.right).toBe(3);
    expect(a.total).toBe(4);
    expect(a.accuracy).toBe(0.75);
  });

  it('identifies the near-miss that scored zero', () => {
    expect(isNearMissMsq(verdicts)).toBe(true);
    expect(isNearMissMsq(verdicts.map((v) => ({ ...v, myVerdict: v.isCorrect })))).toBe(false);
  });

  it('does not call a two-option miss a near miss', () => {
    const worse = [
      { myVerdict: true, isCorrect: true },
      { myVerdict: false, isCorrect: false },
      { myVerdict: false, isCorrect: true },
      { myVerdict: true, isCorrect: false },
    ];
    expect(isNearMissMsq(worse)).toBe(false);
  });
});

describe('paper totals', () => {
  it('reconciles a mixed sitting', () => {
    const results = [
      score({ qtype: 'MCQ', marks: 1, isCorrect: true, attempted: true }),
      score({ qtype: 'MCQ', marks: 2, isCorrect: false, attempted: true }),
      score({ qtype: 'MSQ', marks: 2, isCorrect: false, attempted: true }),
      score({ qtype: 'NAT', marks: 1, isCorrect: false, attempted: false }),
    ];
    const t = totalise(results);

    expect(t.attempted).toBe(3);
    expect(t.correct).toBe(1);
    expect(t.wrong).toBe(2);
    expect(t.skipped).toBe(1);
    expect(thirdsToMarks(t.availableThirds)).toBe(6);
    // 1 − 2/3 + 0 + 0
    expect(formatMarks(t.obtainedThirds)).toBe('0.33');
    expect(formatMarks(t.penaltyThirds)).toBe('0.67');
  });

  it('uses the configured scheme', () => {
    expect(DEFAULT_MARKING.mcqPenalty).toEqual({ numerator: 1, denominator: 3 });
    expect(DEFAULT_MARKING.sectionMarks.GA + DEFAULT_MARKING.sectionMarks.SUBJECT).toBe(
      DEFAULT_MARKING.totalMarks,
    );
  });
});
