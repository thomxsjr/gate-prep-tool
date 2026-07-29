/**
 * Boundary drill templates (M4, rung 2, +12 marks).
 *
 * Generated, parameterised, infinite, and DETERMINISTIC: a template plus a
 * seed always produces the same question and the same answer, so a drill can
 * be replayed exactly. No model is involved — this is arithmetic.
 *
 * ---------------------------------------------------------------------------
 * ADDING YOUR OWN TEMPLATE
 *
 * Append a `DrillTemplate` to `TEMPLATES` below:
 *
 *   {
 *     key: 'my_template',              // stable; drill_runs rows reference it
 *     name: 'Short human name',
 *     trap: 'The specific boundary this drill trains.',
 *     timeBudgetSeconds: 40,
 *     answerKind: 'integer',
 *     generate(rng) {
 *       const n = rng.int(5, 50);
 *       return {
 *         params: { n },
 *         prompt: `... ${n} ...`,
 *         answer: String(someExactArithmetic(n)),
 *       };
 *     },
 *   }
 *
 * `rng` is seeded, so use it for every random choice and nothing else — no
 * Math.random, no Date.now. Compute the answer from the same params you put in
 * the prompt, and keep it exact (integers, or a fixed number of decimals).
 * ---------------------------------------------------------------------------
 */

export type AnswerKind = 'integer' | 'number';

export interface Rng {
  /** Uniform integer in [lo, hi], inclusive at both ends. */
  int(lo: number, hi: number): number;
  pick<T>(xs: readonly T[]): T;
  bool(): boolean;
}

export interface GeneratedDrill {
  params: Record<string, number | string>;
  prompt: string;
  answer: string;
}

export interface DrillTemplate {
  key: string;
  name: string;
  /** The specific boundary this trains. Shown after answering. */
  trap: string;
  timeBudgetSeconds: number;
  answerKind: AnswerKind;
  generate(rng: Rng): GeneratedDrill;
}

/** mulberry32 — small, fast, and identical across runs. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)]!,
    bool: () => next() < 0.5,
  };
}

export const TEMPLATES: DrillTemplate[] = [
  {
    key: 'binary_search_comparisons',
    name: 'Binary search comparisons',
    trap: 'Worst-case comparisons are floor(log2 n) + 1, not log2 n or ceil(log2 n).',
    timeBudgetSeconds: 40,
    answerKind: 'integer',
    generate(rng) {
      const n = rng.int(5, 4000);
      return {
        params: { n },
        prompt: `Binary search on a sorted array of ${n} elements. How many comparisons in the worst case, counting one comparison per probe?`,
        answer: String(Math.floor(Math.log2(n)) + 1),
      };
    },
  },
  {
    key: 'loop_iterations',
    name: 'Loop iteration count',
    trap: 'Inclusive vs exclusive bounds, and a step that does not divide the range.',
    timeBudgetSeconds: 45,
    answerKind: 'integer',
    generate(rng) {
      const lo = rng.int(0, 20);
      const len = rng.int(10, 90);
      const hi = lo + len;
      const step = rng.pick([1, 2, 3, 5]);
      const inclusive = rng.bool();
      const last = inclusive ? hi : hi - 1;
      const count = last < lo ? 0 : Math.floor((last - lo) / step) + 1;
      return {
        params: { lo, hi, step, inclusive: inclusive ? 1 : 0 },
        prompt: `for (i = ${lo}; i ${inclusive ? '<=' : '<'} ${hi}; i += ${step})\n\nHow many times does the body execute?`,
        answer: String(count),
      };
    },
  },
  {
    key: 'array_index_bounds',
    name: 'Array index bounds',
    trap: 'Number of valid indices in a slice — the classic off-by-one.',
    timeBudgetSeconds: 35,
    answerKind: 'integer',
    generate(rng) {
      const n = rng.int(20, 200);
      const from = rng.int(0, n - 10);
      const to = rng.int(from + 1, n - 1);
      const inclusive = rng.bool();
      return {
        params: { n, from, to, inclusive: inclusive ? 1 : 0 },
        prompt: `A 0-indexed array has ${n} elements. How many elements lie in indices ${from} to ${to}${inclusive ? ' inclusive' : ' exclusive of the upper bound'}?`,
        answer: String(inclusive ? to - from + 1 : to - from),
      };
    },
  },
  {
    key: 'variance_denominator',
    name: 'Variance denominator',
    trap: 'Population variance divides by n; the unbiased sample estimate divides by n − 1.',
    timeBudgetSeconds: 30,
    answerKind: 'integer',
    generate(rng) {
      const n = rng.int(6, 60);
      const sample = rng.bool();
      return {
        params: { n, sample: sample ? 1 : 0 },
        prompt: `You have ${n} observations and compute the ${sample ? 'unbiased SAMPLE variance' : 'POPULATION variance'}. What number divides the sum of squared deviations?`,
        answer: String(sample ? n - 1 : n),
      };
    },
  },
  {
    key: 'degrees_of_freedom',
    name: 'Degrees of freedom',
    trap: 'Each estimated parameter costs a degree of freedom; chi-square contingency is (r−1)(c−1).',
    timeBudgetSeconds: 45,
    answerKind: 'integer',
    generate(rng): GeneratedDrill {
      const kind = rng.pick(['t_one', 't_two', 'chi_gof', 'chi_contingency'] as const);
      if (kind === 't_one') {
        const n = rng.int(8, 60);
        return {
          params: { n, kind },
          prompt: `One-sample t-test with ${n} observations. Degrees of freedom?`,
          answer: String(n - 1),
        };
      }
      if (kind === 't_two') {
        const a = rng.int(6, 40);
        const b = rng.int(6, 40);
        return {
          params: { a, b, kind },
          prompt: `Two-sample pooled t-test with group sizes ${a} and ${b}. Degrees of freedom?`,
          answer: String(a + b - 2),
        };
      }
      if (kind === 'chi_gof') {
        const k = rng.int(3, 9);
        const est = rng.int(0, 2);
        return {
          params: { k, est, kind },
          prompt: `Chi-square goodness-of-fit over ${k} categories, with ${est} parameter(s) estimated from the data. Degrees of freedom?`,
          answer: String(k - 1 - est),
        };
      }
      const r = rng.int(2, 6);
      const c = rng.int(2, 6);
      return {
        params: { r, c, kind },
        prompt: `Chi-square test of independence on a ${r} x ${c} contingency table. Degrees of freedom?`,
        answer: String((r - 1) * (c - 1)),
      };
    },
  },
  {
    key: 'summation_limits',
    name: 'Summation term count',
    trap: 'Terms from a to b inclusive number b − a + 1, not b − a.',
    timeBudgetSeconds: 30,
    answerKind: 'integer',
    generate(rng) {
      const a = rng.int(-20, 30);
      const b = a + rng.int(5, 80);
      return {
        params: { a, b },
        prompt: `How many terms are in the sum from i = ${a} to i = ${b} inclusive?`,
        answer: String(b - a + 1),
      };
    },
  },
  {
    key: 'critical_points_interval',
    name: 'Closed vs open interval',
    trap: 'A closed interval admits endpoint extrema; an open one does not.',
    timeBudgetSeconds: 40,
    answerKind: 'integer',
    generate(rng) {
      const interior = rng.int(1, 4);
      const closed = rng.bool();
      return {
        params: { interior, closed: closed ? 1 : 0 },
        prompt: `A continuous function on ${closed ? 'the CLOSED interval [a, b]' : 'the OPEN interval (a, b)'} has ${interior} interior stationary point(s). How many points must you evaluate to find the global maximum?`,
        answer: String(closed ? interior + 2 : interior),
      };
    },
  },
  {
    key: 'bfs_levels',
    name: 'BFS levels and hops',
    trap: 'A path of k edges spans k + 1 vertices; level numbering starts at 0.',
    timeBudgetSeconds: 40,
    answerKind: 'integer',
    generate(rng) {
      const hops = rng.int(2, 9);
      const askVertices = rng.bool();
      return {
        params: { hops, askVertices: askVertices ? 1 : 0 },
        prompt: askVertices
          ? `BFS from a source reaches a vertex at distance ${hops} edges. How many vertices lie on that shortest path, including both endpoints?`
          : `BFS from a source reaches a vertex at distance ${hops} edges. If the source is level 0, what is that vertex's level?`,
        answer: String(askVertices ? hops + 1 : hops),
      };
    },
  },
  {
    key: 'complete_tree_nodes',
    name: 'Perfect tree node counts',
    trap: 'A perfect binary tree of height h has 2^(h+1) − 1 nodes and 2^h leaves.',
    timeBudgetSeconds: 40,
    answerKind: 'integer',
    generate(rng) {
      const h = rng.int(2, 12);
      const askLeaves = rng.bool();
      return {
        params: { h, askLeaves: askLeaves ? 1 : 0 },
        prompt: `A perfect binary tree has height ${h} (a single node has height 0). How many ${askLeaves ? 'leaves' : 'nodes in total'}?`,
        answer: String(askLeaves ? 2 ** h : 2 ** (h + 1) - 1),
      };
    },
  },
  {
    key: 'complexity_constant',
    name: 'Operation counts',
    trap: 'Constants and the exact bound: n(n−1)/2 pairs, not n^2/2.',
    timeBudgetSeconds: 40,
    answerKind: 'integer',
    generate(rng): GeneratedDrill {
      const n = rng.int(5, 60);
      const kind = rng.pick(['pairs', 'triangular', 'nested_strict'] as const);
      if (kind === 'pairs') {
        return {
          params: { n, kind },
          prompt: `How many unordered pairs can be formed from ${n} distinct elements?`,
          answer: String((n * (n - 1)) / 2),
        };
      }
      if (kind === 'triangular') {
        return {
          params: { n, kind },
          prompt: `for (i = 1; i <= ${n}; i++) for (j = 1; j <= i; j++) { op }\n\nHow many times does op run?`,
          answer: String((n * (n + 1)) / 2),
        };
      }
      return {
        params: { n, kind },
        prompt: `for (i = 0; i < ${n}; i++) for (j = i + 1; j < ${n}; j++) { op }\n\nHow many times does op run?`,
        answer: String((n * (n - 1)) / 2),
      };
    },
  },
  {
    key: 'integration_limits',
    name: 'Integration over a partition',
    trap: 'n subintervals need n + 1 grid points; the trapezoid rule uses n + 1 evaluations.',
    timeBudgetSeconds: 35,
    answerKind: 'integer',
    generate(rng) {
      const n = rng.int(3, 40);
      const askPoints = rng.bool();
      return {
        params: { n, askPoints: askPoints ? 1 : 0 },
        prompt: askPoints
          ? `An interval [a, b] is split into ${n} equal subintervals. How many grid points, including both endpoints?`
          : `The composite trapezoid rule over ${n} equal subintervals. How many function evaluations are required?`,
        answer: String(n + 1),
      };
    },
  },
  {
    key: 'kfold_split',
    name: 'k-fold split sizes',
    trap: 'Each fold trains on (k−1)/k of the data, and k-fold means k fits, not k−1.',
    timeBudgetSeconds: 40,
    answerKind: 'integer',
    generate(rng) {
      const k = rng.pick([3, 4, 5, 8, 10]);
      const n = k * rng.int(4, 40);
      const askTrain = rng.bool();
      return {
        params: { n, k, askTrain: askTrain ? 1 : 0 },
        prompt: askTrain
          ? `${k}-fold cross-validation on ${n} samples. How many samples are in each TRAINING set?`
          : `${k}-fold cross-validation on ${n} samples. How many model fits are performed in total?`,
        answer: String(askTrain ? n - n / k : k),
      };
    },
  },
];

export function templateByKey(key: string): DrillTemplate | undefined {
  return TEMPLATES.find((t) => t.key === key);
}

export function generate(key: string, seed: number): (GeneratedDrill & { template: DrillTemplate }) | null {
  const t = templateByKey(key);
  if (!t) return null;
  return { ...t.generate(makeRng(seed)), template: t };
}

/** Tolerant comparison: trims, and accepts a trailing ".0" on integers. */
export function answerMatches(given: string, expected: string, kind: AnswerKind): boolean {
  const g = given.trim();
  if (g === '') return false;
  if (kind === 'integer') return Number(g) === Number(expected) && Number.isInteger(Number(g));
  const a = Number(g);
  const b = Number(expected);
  return Number.isFinite(a) && Math.abs(a - b) < 1e-9;
}
