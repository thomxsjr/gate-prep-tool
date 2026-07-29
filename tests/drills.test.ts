import { describe, expect, it } from 'vitest';
import { TEMPLATES, answerMatches, generate, makeRng } from '../src/domain/drills.ts';

describe('determinism', () => {
  it('produces an identical drill for the same template and seed', () => {
    for (const t of TEMPLATES) {
      const a = generate(t.key, 12345)!;
      const b = generate(t.key, 12345)!;
      expect(a.prompt).toBe(b.prompt);
      expect(a.answer).toBe(b.answer);
      expect(a.params).toEqual(b.params);
    }
  });

  it('produces different drills for different seeds', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 40; s += 1) seen.add(generate('loop_iterations', s)!.prompt);
    expect(seen.size).toBeGreaterThan(20);
  });

  it('has a stable rng sequence', () => {
    const a = makeRng(7);
    const b = makeRng(7);
    for (let i = 0; i < 20; i += 1) expect(a.int(0, 1000)).toBe(b.int(0, 1000));
  });

  it('keeps rng.int inside its bounds', () => {
    const rng = makeRng(99);
    for (let i = 0; i < 500; i += 1) {
      const v = rng.int(3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
    }
  });
});

describe('every template is well-formed', () => {
  it.each(TEMPLATES.map((t) => [t.key, t] as const))('%s', (_key, t) => {
    for (let seed = 0; seed < 60; seed += 1) {
      const g = t.generate(makeRng(seed));
      expect(g.prompt.length).toBeGreaterThan(10);
      expect(g.answer).not.toBe('');
      expect(Number.isFinite(Number(g.answer))).toBe(true);
      if (t.answerKind === 'integer') expect(Number.isInteger(Number(g.answer))).toBe(true);
      // Every value quoted in the prompt must come from params, so a drill can
      // be regenerated and audited from its stored row.
      expect(Object.keys(g.params).length).toBeGreaterThan(0);
    }
  });

  it('has unique keys', () => {
    const keys = TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('covers the boundary families the spec names', () => {
    const keys = TEMPLATES.map((t) => t.key);
    for (const required of [
      'binary_search_comparisons',
      'loop_iterations',
      'array_index_bounds',
      'variance_denominator',
      'degrees_of_freedom',
      'summation_limits',
      'critical_points_interval',
      'bfs_levels',
      'complexity_constant',
      'integration_limits',
    ]) {
      expect(keys).toContain(required);
    }
  });
});

describe('the arithmetic is actually right', () => {
  it('binary search: floor(log2 n) + 1', () => {
    for (let n = 1; n <= 300; n += 1) {
      const naive = countBinarySearchProbes(n);
      const formula = Math.floor(Math.log2(n)) + 1;
      expect(formula, `n=${n}`).toBe(naive);
    }
  });

  it('loop iterations match a brute-force count', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const g = generate('loop_iterations', seed)!;
      const { lo, hi, step, inclusive } = g.params as Record<string, number>;
      let n = 0;
      for (let i = lo!; inclusive ? i <= hi! : i < hi!; i += step!) n += 1;
      expect(Number(g.answer), JSON.stringify(g.params)).toBe(n);
    }
  });

  it('array index bounds count the right number of slots', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const g = generate('array_index_bounds', seed)!;
      const { from, to, inclusive } = g.params as Record<string, number>;
      const expected = inclusive ? to! - from! + 1 : to! - from!;
      expect(Number(g.answer)).toBe(expected);
      expect(Number(g.answer)).toBeGreaterThan(0);
    }
  });

  it('variance denominators are n or n − 1 and never zero', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const g = generate('variance_denominator', seed)!;
      const { n, sample } = g.params as Record<string, number>;
      expect(Number(g.answer)).toBe(sample ? n! - 1 : n!);
      expect(Number(g.answer)).toBeGreaterThan(0);
    }
  });

  it('degrees of freedom never go negative', () => {
    for (let seed = 0; seed < 300; seed += 1) {
      const g = generate('degrees_of_freedom', seed)!;
      expect(Number(g.answer)).toBeGreaterThanOrEqual(0);
    }
  });

  it('perfect tree counts satisfy nodes = 2·leaves − 1', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const g = generate('complete_tree_nodes', seed)!;
      const { h, askLeaves } = g.params as Record<string, number>;
      expect(Number(g.answer)).toBe(askLeaves ? 2 ** h! : 2 ** (h! + 1) - 1);
    }
  });

  it('k-fold training sets divide evenly', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const g = generate('kfold_split', seed)!;
      const { n, k, askTrain } = g.params as Record<string, number>;
      expect(n! % k!).toBe(0);
      expect(Number(g.answer)).toBe(askTrain ? n! - n! / k! : k!);
    }
  });
});

describe('answer matching', () => {
  it('accepts an integer with surrounding space', () => {
    expect(answerMatches('  42 ', '42', 'integer')).toBe(true);
  });

  it('rejects a non-integer answer to an integer question', () => {
    expect(answerMatches('42.5', '42', 'integer')).toBe(false);
  });

  it('rejects an empty answer', () => {
    expect(answerMatches('', '42', 'integer')).toBe(false);
    expect(answerMatches('   ', '42', 'integer')).toBe(false);
  });

  it('allows float slack on number questions', () => {
    expect(answerMatches('0.3333333333', '0.33333333333', 'number')).toBe(true);
    expect(answerMatches('0.34', '0.333', 'number')).toBe(false);
  });
});

describe('unknown templates', () => {
  it('returns null rather than throwing', () => {
    expect(generate('nope', 1)).toBeNull();
  });
});

/**
 * Independent reference: the depth of the binary-search decision tree, which
 * is the worst-case probe count. Recursive rather than a simulated loop —
 * the loop version has to track which half is larger, and getting that subtly
 * wrong is the very off-by-one this drill exists to train.
 */
function countBinarySearchProbes(n: number): number {
  if (n <= 0) return 0;
  const mid = Math.floor((n - 1) / 2);
  return 1 + Math.max(countBinarySearchProbes(mid), countBinarySearchProbes(n - 1 - mid));
}
