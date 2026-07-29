import { describe, expect, it } from 'vitest';
import {
  MIN_CONTROL_SAMPLE,
  accuracyByType,
  binomialCdf,
  chanceRate,
  detectOptionShuffle,
  type ScoredSample,
} from '../src/domain/option-shuffle.ts';

function samples(
  spec: ReadonlyArray<[qtype: 'MCQ' | 'MSQ' | 'NAT', correct: number, total: number]>,
): ScoredSample[] {
  const out: ScoredSample[] = [];
  for (const [qtype, correct, total] of spec) {
    for (let i = 0; i < total; i += 1) {
      out.push({ qtype, optionCount: 4, wasCorrect: i < correct });
    }
  }
  return out;
}

describe('chance rates', () => {
  it('is 1/N for MCQ', () => {
    expect(chanceRate('MCQ', 4)).toBeCloseTo(0.25, 10);
    expect(chanceRate('MCQ', 5)).toBeCloseTo(0.2, 10);
  });

  it('is 1/(2^N − 1) for MSQ, because any non-empty subset is selectable', () => {
    expect(chanceRate('MSQ', 4)).toBeCloseTo(1 / 15, 10);
    expect(chanceRate('MSQ', 3)).toBeCloseTo(1 / 7, 10);
  });

  it('is zero for NAT, which has nothing to shuffle', () => {
    expect(chanceRate('NAT')).toBe(0);
  });
});

describe('binomialCdf', () => {
  it('sums to 1 over the full support', () => {
    expect(binomialCdf(10, 10, 0.3)).toBeCloseTo(1, 10);
  });

  it('matches a hand-computed case', () => {
    // P(X <= 1), n = 3, p = 0.5  ->  (1 + 3)/8
    expect(binomialCdf(1, 3, 0.5)).toBeCloseTo(0.5, 10);
  });

  it('handles degenerate probabilities', () => {
    expect(binomialCdf(0, 5, 0)).toBe(1);
    expect(binomialCdf(4, 5, 1)).toBe(0);
    expect(binomialCdf(5, 5, 1)).toBe(1);
  });

  it('does not overflow at large n', () => {
    const p = binomialCdf(500, 1000, 0.5);
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.6);
  });
});

describe('the 2026 sitting', () => {
  // The real numbers: MCQ 8/28, MSQ 2/14, NAT 11/18.
  const real = samples([
    ['MCQ', 8, 28],
    ['MSQ', 2, 14],
    ['NAT', 11, 18],
  ]);

  it('declares the labels unusable', () => {
    const v = detectOptionShuffle(real);
    expect(v.labelsUnusable).toBe(true);
    expect(v.pIfSkillMatchedControl).toBeLessThan(1e-5);
    expect(v.controlAccuracy).toBeCloseTo(11 / 18, 10);
  });

  it('explains itself in the reason', () => {
    const v = detectOptionShuffle(real);
    expect(v.reason).toContain('chance');
    expect(v.reason).toContain('61.1%');
  });

  it('reports per-type accuracy', () => {
    const t = accuracyByType(real);
    expect(t.find((x) => x.qtype === 'MCQ')!.accuracy).toBeCloseTo(8 / 28, 10);
    expect(t.find((x) => x.qtype === 'NAT')!.accuracy).toBeCloseTo(11 / 18, 10);
  });
});

describe('a candidate whose labels ARE usable', () => {
  it('passes when option types track the NAT control', () => {
    const v = detectOptionShuffle(
      samples([
        ['MCQ', 17, 28],
        ['MSQ', 8, 14],
        ['NAT', 11, 18],
      ]),
    );
    expect(v.labelsUnusable).toBe(false);
    expect(v.reason).toContain('usable');
  });

  it('does not fire merely because option types are somewhat weaker', () => {
    // Real papers make MSQ harder than NAT; that is not evidence of shuffling.
    const v = detectOptionShuffle(
      samples([
        ['MCQ', 15, 28],
        ['MSQ', 6, 14],
        ['NAT', 13, 18],
      ]),
    );
    expect(v.labelsUnusable).toBe(false);
  });
});

describe('refusing to judge without evidence', () => {
  it('stays silent when the NAT control is too small', () => {
    const v = detectOptionShuffle(
      samples([
        ['MCQ', 2, 28],
        ['NAT', 4, 5],
      ]),
    );
    expect(v.labelsUnusable).toBe(false);
    expect(v.controlSize).toBeLessThan(MIN_CONTROL_SAMPLE);
    expect(v.reason).toContain('too few');
  });

  it('stays silent when there are no option-bearing questions', () => {
    const v = detectOptionShuffle(samples([['NAT', 11, 18]]));
    expect(v.labelsUnusable).toBe(false);
  });

  it('handles an empty sample', () => {
    const v = detectOptionShuffle([]);
    expect(v.labelsUnusable).toBe(false);
    expect(v.controlAccuracy).toBeNull();
  });

  it('does not fire when the candidate was weak at everything', () => {
    // Low NAT too — that is a knowledge problem, not a mapping problem.
    const v = detectOptionShuffle(
      samples([
        ['MCQ', 7, 28],
        ['NAT', 4, 18],
      ]),
    );
    expect(v.labelsUnusable).toBe(false);
  });
});

describe('the noise test uses the correct tail', () => {
  it('does not call far-above-chance performance "consistent with noise"', () => {
    // The lower tail P(X <= observed | chance) tends to 1 as accuracy rises,
    // so using it here would fire the guard on a strong candidate.
    const strong = samples([
      ['MCQ', 24, 28],
      ['MSQ', 12, 14],
      ['NAT', 13, 18],
    ]);
    const v = detectOptionShuffle(strong);
    expect(v.labelsUnusable).toBe(false);
    expect(v.pIfNoise!).toBeLessThan(1e-6);
  });

  it('reports a large noise probability when accuracy really is at chance', () => {
    const v = detectOptionShuffle(
      samples([
        ['MCQ', 8, 28],
        ['MSQ', 2, 14],
        ['NAT', 11, 18],
      ]),
    );
    expect(v.pIfNoise!).toBeGreaterThan(0.01);
    expect(v.labelsUnusable).toBe(true);
  });
});
