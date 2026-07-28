import { describe, expect, it } from 'vitest';
import {
  breakevenP,
  evAfterElimination,
  expectedValue,
  findViolations,
  netFromAttemptPolicy,
} from '../src/domain/ev.ts';

describe('MCQ breakeven is 0.25 at every weight', () => {
  it('is identical for 1-mark and 2-mark questions', () => {
    // The penalty scales with the reward, so the marks cancel out of the
    // breakeven equation entirely.
    expect(breakevenP('MCQ')).toBeCloseTo(0.25, 12);
    expect(expectedValue({ qtype: 'MCQ', marks: 1, p: 0.25 }).breakevenP).toBeCloseTo(0.25, 12);
    expect(expectedValue({ qtype: 'MCQ', marks: 2, p: 0.25 }).breakevenP).toBeCloseTo(0.25, 12);
  });

  it('gives EV exactly zero at p = 0.25, at both weights', () => {
    expect(expectedValue({ qtype: 'MCQ', marks: 1, p: 0.25 }).evAttempt).toBeCloseTo(0, 12);
    expect(expectedValue({ qtype: 'MCQ', marks: 2, p: 0.25 }).evAttempt).toBeCloseTo(0, 12);
  });
});

describe('the finding that inverts the 70% rule', () => {
  it('makes a blind 4-option guess EV-neutral, not negative', () => {
    const r = evAfterElimination('MCQ', 1, 4, 0);
    expect(r.evAttempt).toBeCloseTo(0, 12);
    expect(r.evAttempt).not.toBeLessThan(0);
  });

  it('makes eliminating one option strictly positive', () => {
    const r = evAfterElimination('MCQ', 1, 4, 1);
    expect(r.evAttempt).toBeCloseTo(1 / 9, 10); // (1/3)(1) − (2/3)(1/3)
    expect(r.evAttempt).toBeGreaterThan(0);
    expect(r.shouldAttempt).toBe(true);
  });

  it('scales that edge with the marks', () => {
    const one = evAfterElimination('MCQ', 1, 4, 1);
    const two = evAfterElimination('MCQ', 2, 4, 1);
    expect(two.evAttempt).toBeCloseTo(one.evAttempt * 2, 10);
  });

  it('shows the 70% rule discarding positive-EV questions', () => {
    // Two of four eliminated: a coin flip, and well worth taking.
    const coinFlip = evAfterElimination('MCQ', 2, 4, 2);
    expect(coinFlip.evAttempt).toBeGreaterThan(0);
    // Yet a 70%-confidence gate would have refused it.
    expect(0.5).toBeLessThan(0.7);
  });
});

describe('MSQ and NAT are free shots', () => {
  it.each(['MSQ', 'NAT'] as const)('%s has breakeven 0 and never a penalty', (qtype) => {
    const r = expectedValue({ qtype, marks: 2, p: 0.05 });
    expect(r.breakevenP).toBe(0);
    expect(r.freeShot).toBe(true);
    expect(r.shouldAttempt).toBe(true);
    expect(r.evAttempt).toBeGreaterThan(0);
  });

  it('never goes negative however low the probability', () => {
    expect(expectedValue({ qtype: 'MSQ', marks: 1, p: 0 }).evAttempt).toBe(0);
    expect(expectedValue({ qtype: 'NAT', marks: 2, p: 0 }).evAttempt).toBe(0);
  });
});

describe('discipline violations', () => {
  it('flags every blank MSQ and NAT', () => {
    const v = findViolations([
      { qtype: 'MSQ', marks: 2, attempted: false, p: 0.4 },
      { qtype: 'NAT', marks: 1, attempted: false, p: 0.1 },
    ]);
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.kind)).toEqual(['msq_left_blank', 'nat_left_blank']);
    expect(v[0]!.cost).toBe(2);
  });

  it('flags a blank MSQ even at very low confidence', () => {
    const v = findViolations([{ qtype: 'MSQ', marks: 2, attempted: false, p: 0.01 }]);
    expect(v).toHaveLength(1);
  });

  it('does not flag a blank MCQ', () => {
    const v = findViolations([{ qtype: 'MCQ', marks: 1, attempted: false, p: 0.1 }]);
    expect(v).toHaveLength(0);
  });

  it('flags an MCQ attempted below breakeven', () => {
    const v = findViolations([{ qtype: 'MCQ', marks: 2, attempted: true, p: 0.1 }]);
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe('mcq_attempted_below_ev');
  });

  it('does not flag an MCQ attempted above breakeven', () => {
    expect(findViolations([{ qtype: 'MCQ', marks: 2, attempted: true, p: 0.3 }])).toHaveLength(0);
  });

  it('stays silent when there is no probability to judge by', () => {
    // A fabricated violation is worse than a missed one.
    expect(findViolations([{ qtype: 'MCQ', marks: 1, attempted: true, p: null }])).toHaveLength(0);
  });
});

describe('net effect of the attempt policy', () => {
  it('counts skipped positive-EV questions as a cost', () => {
    const r = netFromAttemptPolicy([
      { qtype: 'MCQ', marks: 2, attempted: true, p: 0.8 },
      { qtype: 'MSQ', marks: 2, attempted: false, p: 0.6 }, // forgone
    ]);
    expect(r.gained).toBeGreaterThan(0);
    expect(r.forgone).toBeCloseTo(1.2, 10);
    expect(r.net).toBeCloseTo(r.gained - r.forgone, 10);
  });

  it('does not credit skipping a negative-EV question as a cost', () => {
    const r = netFromAttemptPolicy([{ qtype: 'MCQ', marks: 1, attempted: false, p: 0.1 }]);
    expect(r.forgone).toBe(0);
  });

  it('ignores decisions with no probability', () => {
    const r = netFromAttemptPolicy([{ qtype: 'MCQ', marks: 1, attempted: true, p: null }]);
    expect(r).toEqual({ gained: 0, forgone: 0, net: 0 });
  });
});
