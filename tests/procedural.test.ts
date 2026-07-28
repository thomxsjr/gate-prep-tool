import { describe, expect, it } from 'vitest';
import {
  classIncidence,
  direction,
  leakTable,
  proceduralShare,
  weeklySeries,
  worstClass,
  type ShareAttempt,
} from '../src/domain/procedural.ts';

const CLASSES = [
  { id: 1, code: 'MSQ_STOP', name: 'MSQ stopping rule', isProcedural: true },
  { id: 2, code: 'BOUNDARY', name: 'Boundary / off-by-one', isProcedural: true },
  { id: 6, code: 'CONCEPT', name: 'Concept gap', isProcedural: false },
];

function attempt(over: Partial<ShareAttempt> = {}): ShareAttempt {
  return {
    attemptedAt: '2026-07-20T09:00:00.000Z',
    context: 'mock',
    marksLost: 2,
    isProcedural: true,
    errorClassId: 1,
    triagedAt: '2026-07-20T20:00:00.000Z',
    ...over,
  };
}

describe('procedural share is marks-weighted', () => {
  it('weights by marks lost, not by count', () => {
    const r = proceduralShare([
      attempt({ marksLost: 6, isProcedural: true, errorClassId: 1 }),
      attempt({ marksLost: 1, isProcedural: false, errorClassId: 6 }),
      attempt({ marksLost: 1, isProcedural: false, errorClassId: 6 }),
      attempt({ marksLost: 1, isProcedural: false, errorClassId: 6 }),
    ]);
    // Counts would say 25% procedural; marks say 60%.
    expect(r.share).toBeCloseTo(6 / 9, 10);
    expect(r.attempts).toBe(4);
  });

  it('reproduces the 46% baseline shape', () => {
    const r = proceduralShare([
      attempt({ marksLost: 23, isProcedural: true }),
      attempt({ marksLost: 27, isProcedural: false, errorClassId: 6 }),
    ]);
    expect(r.share).toBeCloseTo(0.46, 10);
  });
});

describe('drills are excluded from the denominator', () => {
  it('ignores drill attempts entirely', () => {
    const r = proceduralShare([
      attempt({ context: 'mock', marksLost: 1, isProcedural: false, errorClassId: 6 }),
      attempt({ context: 'drill', marksLost: 99, isProcedural: true, errorClassId: 2 }),
    ]);
    // A boundary drill is procedural by construction; letting it in would
    // drive the share to 99% and congratulate the user for practising.
    expect(r.share).toBe(0);
    expect(r.totalMarksLost).toBe(1);
    expect(r.attempts).toBe(1);
  });

  it('counts mock, sectional, pyq and practice', () => {
    const r = proceduralShare([
      attempt({ context: 'mock', marksLost: 1 }),
      attempt({ context: 'sectional', marksLost: 1 }),
      attempt({ context: 'pyq', marksLost: 1 }),
      attempt({ context: 'practice', marksLost: 1 }),
      attempt({ context: 'review', marksLost: 1 }),
    ]);
    expect(r.attempts).toBe(4);
  });
});

describe('untriaged attempts cannot game the metric', () => {
  it('excludes them and reports the exclusion', () => {
    const r = proceduralShare([
      attempt({ marksLost: 2, isProcedural: true, triagedAt: '2026-07-20T20:00:00.000Z' }),
      attempt({ marksLost: 8, isProcedural: true, triagedAt: null }),
    ]);
    expect(r.totalMarksLost).toBe(2);
    expect(r.excludedUntriaged).toBe(1);
  });

  it('returns null rather than zero when nothing qualifies', () => {
    const r = proceduralShare([attempt({ triagedAt: null })]);
    expect(r.share).toBeNull();
    expect(r.empty).toBe(true);
  });
});

describe('windowing', () => {
  it('respects the window bounds', () => {
    const rows = [
      attempt({ attemptedAt: '2026-07-01T09:00:00.000Z', marksLost: 4, isProcedural: true }),
      attempt({ attemptedAt: '2026-07-20T09:00:00.000Z', marksLost: 1, isProcedural: false, errorClassId: 6 }),
    ];
    const r = proceduralShare(rows, {
      from: new Date('2026-07-15T00:00:00.000Z'),
      to: new Date('2026-07-28T00:00:00.000Z'),
    });
    expect(r.totalMarksLost).toBe(1);
    expect(r.share).toBe(0);
  });
});

describe('weekly series and direction', () => {
  const now = new Date('2026-07-28T12:00:00.000Z');

  it('returns one point per week', () => {
    const s = weeklySeries([attempt({ attemptedAt: '2026-07-27T09:00:00.000Z' })], 8, now);
    expect(s).toHaveLength(8);
    expect(s.at(-1)!.share).toBe(1);
  });

  it('leaves a quiet week null rather than zero', () => {
    // Plotting an empty week as 0% would draw a triumphant line through
    // missing data.
    const s = weeklySeries([], 8, now);
    expect(s.every((p) => p.share === null)).toBe(true);
  });

  it('detects a falling trend', () => {
    const series = [0.5, 0.48, 0.46, 0.3, 0.25, 0.2].map((share, i) => ({
      weekStart: `2026-06-0${i + 1}`,
      share,
      totalMarksLost: 10,
      attempts: 10,
    }));
    expect(direction(series)).toBe('falling');
  });

  it('reads a flat trend as flat, not as progress', () => {
    const series = [0.45, 0.46, 0.45, 0.46, 0.45, 0.46].map((share, i) => ({
      weekStart: `2026-06-0${i + 1}`,
      share,
      totalMarksLost: 10,
      attempts: 10,
    }));
    expect(direction(series)).toBe('flat');
  });

  it('says unknown when there is too little data to claim anything', () => {
    expect(direction([{ weekStart: '2026-07-20', share: 0.4, totalMarksLost: 2, attempts: 1 }]))
      .toBe('unknown');
  });
});

describe('leak table', () => {
  const rows: ShareAttempt[] = [
    attempt({ errorClassId: 1, isProcedural: true, marksLost: 2 }),
    attempt({ errorClassId: 1, isProcedural: true, marksLost: 2 }),
    attempt({ errorClassId: 2, isProcedural: true, marksLost: 6 }),
    attempt({ errorClassId: 6, isProcedural: false, marksLost: 1 }),
    attempt({ errorClassId: 2, isProcedural: true, marksLost: 1, context: 'drill' }),
  ];

  it('sorts by damage, not by frequency', () => {
    const t = leakTable(rows, CLASSES);
    expect(t[0]!.code).toBe('BOUNDARY'); // 6 marks from 1 occurrence
    expect(t[0]!.marksLost).toBe(6);
    expect(t[1]!.code).toBe('MSQ_STOP'); // 4 marks from 2 occurrences
    expect(t[1]!.occurrences).toBe(2);
  });

  it('excludes drills here too', () => {
    const t = leakTable(rows, CLASSES);
    expect(t.find((r) => r.code === 'BOUNDARY')!.occurrences).toBe(1);
  });

  it('computes each class share of total loss', () => {
    const t = leakTable(rows, CLASSES);
    expect(t.reduce((a, r) => a + r.shareOfLoss, 0)).toBeCloseTo(1, 10);
  });

  it('picks the next target by damage', () => {
    expect(worstClass(leakTable(rows, CLASSES))!.code).toBe('BOUNDARY');
  });

  it('returns null when nothing has leaked', () => {
    expect(worstClass(leakTable([], CLASSES))).toBeNull();
  });
});

describe('class incidence drives rung fill', () => {
  it('counts occurrences per 100 triaged attempts', () => {
    const rows = [
      ...Array.from({ length: 4 }, () => attempt({ errorClassId: 1 })),
      ...Array.from({ length: 96 }, () => attempt({ errorClassId: 6, isProcedural: false })),
    ];
    const inc = classIncidence(rows, 1);
    expect(inc.denominator).toBe(100);
    expect(inc.occurrences).toBe(4);
    expect(inc.per100).toBe(4);
  });

  it('counts correct attempts in the denominator', () => {
    // Incidence is per question faced, not per question missed — otherwise
    // getting better would leave the rate unchanged.
    const rows = [
      attempt({ errorClassId: 1, marksLost: 2 }),
      attempt({ errorClassId: null, marksLost: 0, isProcedural: null }),
      attempt({ errorClassId: null, marksLost: 0, isProcedural: null }),
      attempt({ errorClassId: null, marksLost: 0, isProcedural: null }),
    ];
    expect(classIncidence(rows, 1).per100).toBe(25);
  });

  it('reports zero rather than dividing by nothing', () => {
    expect(classIncidence([], 1)).toEqual({ per100: 0, occurrences: 0, denominator: 0 });
  });
});
