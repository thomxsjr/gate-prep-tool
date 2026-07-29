import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate.ts';
import { seed } from '../src/db/seed.ts';
import * as repo from '../src/server/repo.ts';
import { ValidationError } from '../src/server/repo.ts';
import { buildDeck, currentPhase, daysBetween, evaluateGate, type PhaseCfg } from '../src/server/deck.ts';
import { importErrorCsv, parseCsv } from '../src/server/csv.ts';
import { buildWeekly, weeklyMarkdown } from '../src/server/weekly.ts';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'gate-api-'));
  db = new Database(resolve(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  migrate(db, true);
  seed(db, undefined, true);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const classId = (code: string): number => repo.errorClasses(db).find((c) => c.code === code)!.id;

describe('two-stage capture', () => {
  it('captures without a diagnosis and leaves the row untriaged', () => {
    const a = repo.capture(
      {
        sourceLabel: 'GATE DA 2025',
        sourceQNo: 'Q12',
        qtype: 'MCQ',
        marks: 1,
        context: 'pyq',
        outcome: 'wrong',
      },
      db,
    );
    expect(a.triaged_at).toBeNull();
    expect(a.error_class_id).toBeNull();
    // Marks lost uses available − obtained, so a wrong MCQ costs 1.33.
    expect(a.marks_lost).toBeCloseTo(4 / 3, 6);
  });

  it('numbers re-attempts of the same question', () => {
    const base = { sourceLabel: 'S', sourceQNo: 'Q1', qtype: 'NAT', marks: 2, context: 'pyq' } as const;
    const first = repo.capture({ ...base, outcome: 'wrong' }, db);
    const second = repo.capture({ ...base, outcome: 'correct' }, db);

    expect(first.attempt_no).toBe(1);
    expect(first.is_first_attempt).toBe(true);
    expect(second.attempt_no).toBe(2);
    expect(second.is_first_attempt).toBe(false);
    expect(second.question_id).toBe(first.question_id);
  });
});

describe('triage validation is structural, not just a character count', () => {
  let id: number;
  beforeEach(() => {
    id = repo.capture(
      { sourceLabel: 'S', sourceQNo: 'Q1', qtype: 'MCQ', marks: 1, context: 'pyq', outcome: 'wrong' },
      db,
    ).id;
  });

  const good = {
    errorClassId: 0,
    whatIThought: 'I thought the loop ran n times.',
    brokeAtStep: 'Dropped the +1 when converting the loop bound.',
    preventionRule: 'Write the first and last index explicitly before counting.',
  };

  it('refuses without an error class', () => {
    expect(() => repo.triage(id, { ...good, errorClassId: 0 }, db)).toThrow(ValidationError);
  });

  it('refuses a vague broken step', () => {
    expect(() =>
      repo.triage(id, { ...good, errorClassId: classId('BOUNDARY'), brokeAtStep: 'silly' }, db),
    ).toThrow(/step that broke/);
  });

  it('refuses a vague prevention rule', () => {
    expect(() =>
      repo.triage(id, { ...good, errorClassId: classId('BOUNDARY'), preventionRule: 'be careful' }, db),
    ).toThrow(/rule that prevents/);
  });

  it('accepts a complete diagnosis and stamps triaged_at', () => {
    const a = repo.triage(id, { ...good, errorClassId: classId('BOUNDARY') }, db);
    expect(a.triaged_at).not.toBeNull();
    expect(a.error_code).toBe('BOUNDARY');
    expect(a.is_procedural).toBe(true);
  });

  it('can create a flashcard from the diagnosis', () => {
    repo.triage(id, { ...good, errorClassId: classId('BOUNDARY'), createCard: true }, db);
    const cards = repo.allCards(db);
    expect(cards).toHaveLength(1);
    // The prevention rule is the back of the card — it earns its keep twice.
    expect(cards[0]!.back).toBe(good.preventionRule);
    expect(cards[0]!.type).toBe('boundary');
  });

  it('links a concept and makes its cost queryable', () => {
    repo.triage(id, { ...good, errorClassId: classId('CONCEPT'), conceptName: 'Loop invariants' }, db);
    const cost = repo.conceptCost(db) as { name: string; marks_lost: number }[];
    expect(cost.find((x) => x.name === 'Loop invariants')!.marks_lost).toBeCloseTo(4 / 3, 6);
  });
});

describe('MSQ trainer refuses to be bypassed', () => {
  function makeMsq(): number {
    const sourceId = Number(
      db.prepare("INSERT INTO sources (kind, label, created_at) VALUES ('pyq','S',?)").run('x')
        .lastInsertRowid,
    );
    const qid = Number(
      db
        .prepare(
          `INSERT INTO questions (source_id, source_q_no, marks, qtype, paraphrase, created_at, updated_at)
           VALUES (?, 'Q1', 2, 'MSQ', '', 'x', 'x')`,
        )
        .run(sourceId).lastInsertRowid,
    );
    for (const [i, [label, correct]] of ([['A', 1], ['B', 0], ['C', 1], ['D', 0]] as const).entries()) {
      db.prepare(
        'INSERT INTO question_options (question_id, label, is_correct, sort_order) VALUES (?,?,?,?)',
      ).run(qid, label, correct, i);
    }
    return qid;
  }

  it('rejects a submission missing a verdict', () => {
    const qid = makeMsq();
    const opts = db.prepare('SELECT id FROM question_options WHERE question_id = ?').all(qid) as {
      id: number;
    }[];
    expect(() =>
      repo.recordMsqAttempt(
        {
          questionId: qid,
          totalSeconds: 100,
          verdicts: opts.slice(0, 3).map((o) => ({
            optionId: o.id,
            myVerdict: true,
            justification: 'a justification long enough',
            seconds: 10,
          })),
        },
        db,
      ),
    ).toThrow(/every option needs a verdict/);
  });

  it('rejects a short justification even when every option has a verdict', () => {
    const qid = makeMsq();
    const opts = db.prepare('SELECT id FROM question_options WHERE question_id = ?').all(qid) as {
      id: number;
    }[];
    expect(() =>
      repo.recordMsqAttempt(
        {
          questionId: qid,
          totalSeconds: 100,
          verdicts: opts.map((o) => ({ optionId: o.id, myVerdict: true, justification: 'short', seconds: 5 })),
        },
        db,
      ),
    ).toThrow(/15\+ characters/);
  });

  it('scores all-or-nothing and stores per-option rows', () => {
    const qid = makeMsq();
    const opts = db
      .prepare('SELECT id, is_correct FROM question_options WHERE question_id = ? ORDER BY sort_order')
      .all(qid) as { id: number; is_correct: number }[];

    // Three of four right — the near miss that scores zero.
    repo.recordMsqAttempt(
      {
        questionId: qid,
        totalSeconds: 200,
        verdicts: opts.map((o, i) => ({
          optionId: o.id,
          myVerdict: i === 3 ? true : o.is_correct === 1,
          justification: 'checked against the definition',
          seconds: 20,
        })),
      },
      db,
    );

    const rows = repo.msqPerOptionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.right).toBe(3);
    expect(rows[0]!.total).toBe(4);

    const a = db.prepare('SELECT outcome, marks_obtained FROM attempts').get() as {
      outcome: string;
      marks_obtained: number;
    };
    expect(a.outcome).toBe('wrong');
    expect(a.marks_obtained).toBe(0);
  });
});

describe('drill runs feed the error log but not the metric', () => {
  it('creates a boundary-tagged attempt on a wrong answer', () => {
    const r = repo.recordDrillRun(
      {
        templateKey: 'loop_iterations',
        seed: 1,
        params: { lo: 0, hi: 10, step: 1 },
        expected: '11',
        given: '10',
        correct: false,
        seconds: 20,
        boundaryClassId: classId('BOUNDARY'),
      },
      db,
    );
    expect(r.attemptId).not.toBeNull();

    const a = repo.getAttempt(r.attemptId!, db)!;
    expect(a.error_code).toBe('BOUNDARY');
    expect(a.context).toBe('drill');
  });

  it('creates no attempt on a correct answer', () => {
    const r = repo.recordDrillRun(
      {
        templateKey: 'loop_iterations',
        seed: 2,
        params: {},
        expected: '11',
        given: '11',
        correct: true,
        seconds: 9,
        boundaryClassId: classId('BOUNDARY'),
      },
      db,
    );
    expect(r.attemptId).toBeNull();
  });
});

describe('mock triage gates the score', () => {
  function seedMock(): number {
    const mockId = repo.createMock(
      { date: '2026-07-20', startedAt: '2026-07-20T09:31:00', environment: 'home' },
      db,
    );
    for (const [i, outcome] of (['correct', 'wrong', 'skipped'] as const).entries()) {
      const a = repo.capture(
        {
          sourceLabel: 'Mock 1',
          sourceQNo: `Q${i + 1}`,
          qtype: 'MCQ',
          marks: 1,
          context: 'mock',
          outcome,
        },
        db,
      );
      db.prepare('UPDATE attempts SET mock_id = ? WHERE id = ?').run(mockId, a.id);
    }
    return mockId;
  }

  it('records the 09:30 discipline flag', () => {
    const id = seedMock();
    expect(repo.getMock(id, db)!.started_at_0930).toBe(1);
  });

  it('flags a start outside the window', () => {
    const id = repo.createMock(
      { date: '2026-07-21', startedAt: '2026-07-21T14:30:00', environment: 'away' },
      db,
    );
    expect(repo.getMock(id, db)!.started_at_0930).toBe(0);
  });

  it('withholds triage completion until every loss has an error class', () => {
    const id = seedMock();
    let m = repo.recomputeMock(id, db);
    expect(m.triage_completed_at).toBeNull();

    for (const a of repo.mockAttempts(id, db)) {
      if (a.outcome === 'correct') continue;
      repo.triage(
        a.id,
        {
          errorClassId: classId('MISREAD'),
          whatIThought: 'Misread the question stem.',
          brokeAtStep: 'Answered the quantity that was not asked for.',
          preventionRule: 'Underline the asked quantity before solving.',
        },
        db,
      );
    }
    m = repo.recomputeMock(id, db);
    expect(m.triage_completed_at).not.toBeNull();
    expect(m.raw_score).toBeCloseTo(1 - 1 / 3, 6);
  });
});

describe('CSV import', () => {
  it('parses quoted fields containing commas', () => {
    const rows = parseCsv('a,b\n"x,y",z');
    expect(rows[0]).toEqual({ a: 'x,y', b: 'z' });
  });

  it('parses doubled quotes', () => {
    expect(parseCsv('a\n"he said ""hi"""')[0]!['a']).toBe('he said "hi"');
  });

  it('imports a fully diagnosed row as triaged', () => {
    const csv = [
      'source,q_no,qtype,marks,subject,context,outcome,error_class,what_i_thought,broke_at_step,prevention_rule',
      'GATE DA 2025,Q7,MSQ,2,ALGO,pyq,wrong,MSQ_STOP,I stopped at option C,Committed before evaluating option D,Read every option to the end before submitting',
    ].join('\n');

    const r = importErrorCsv(csv, db);
    expect(r.imported).toBe(1);
    expect(r.triaged).toBe(1);
    expect(r.queued).toBe(0);
  });

  it('queues a row whose diagnosis is too thin rather than accepting it', () => {
    const csv = [
      'source,q_no,qtype,marks,outcome,error_class,broke_at_step,prevention_rule',
      'GATE DA 2025,Q8,MCQ,1,wrong,BOUNDARY,oops,fix it',
    ].join('\n');

    const r = importErrorCsv(csv, db);
    expect(r.imported).toBe(1);
    expect(r.triaged).toBe(0);
    expect(r.queued).toBe(1);
  });

  it('reports bad rows with line numbers instead of failing the batch', () => {
    const csv = [
      'source,qtype,marks,outcome',
      'S,MCQ,1,wrong',
      'S,BADTYPE,1,wrong',
      ',MCQ,1,wrong',
    ].join('\n');

    const r = importErrorCsv(csv, db);
    expect(r.imported).toBe(1);
    expect(r.skipped).toBe(2);
    expect(r.errors.map((e) => e.row)).toEqual([3, 4]);
  });
});

describe('gates', () => {
  const today = new Date('2026-08-01T00:00:00.000Z');
  const base = {
    today,
    registrationCompleted: false,
    proceduralDirection: 'unknown',
    proceduralWeeks: 0,
    mockAverage: null,
    mockCount: 0,
    sectionalsBelow: [] as string[],
    sectionalsMeasured: 0,
  };

  it('registration is at risk until marked complete', () => {
    expect(evaluateGate({ kind: 'registered', label: 'Registered' }, base).status).toBe('at_risk');
    expect(
      evaluateGate({ kind: 'registered', label: 'Registered' }, { ...base, registrationCompleted: true })
        .status,
    ).toBe('met');
  });

  it('reports unknown rather than on-track without data', () => {
    expect(
      evaluateGate({ kind: 'procedural_share_falling', label: 'x', min_weeks: 4 }, base).status,
    ).toBe('unknown');
  });

  it('is on track only when the share is actually falling', () => {
    const ctx = { ...base, proceduralWeeks: 6 };
    expect(
      evaluateGate({ kind: 'procedural_share_falling', label: 'x' }, { ...ctx, proceduralDirection: 'falling' })
        .status,
    ).toBe('on_track');
    expect(
      evaluateGate({ kind: 'procedural_share_falling', label: 'x' }, { ...ctx, proceduralDirection: 'flat' })
        .status,
    ).toBe('at_risk');
  });

  it('marks a mock gate missed once its date has passed', () => {
    const gate = {
      kind: 'mock_average',
      label: 'x',
      checkpoints: [{ threshold: 88, by: '2026-07-01' }],
    };
    expect(evaluateGate(gate, { ...base, mockAverage: 70 }).status).toBe('missed');
    expect(evaluateGate(gate, { ...base, mockAverage: 90 }).status).toBe('met');
  });

  it('names the subjects holding a sectional gate back', () => {
    const g = evaluateGate(
      { kind: 'sectional_min', label: 'x', threshold: 85, by: '2026-09-30' },
      { ...base, sectionalsMeasured: 3, sectionalsBelow: ['Algorithms', 'DBMS'] },
    );
    expect(g.status).toBe('at_risk');
    expect(g.detail).toContain('Algorithms');
  });
});

describe('phase selection and countdown', () => {
  const phases: PhaseCfg[] = [
    { ordinal: 0, name: 'A', start: null, end: '2026-08-14', gate: null },
    { ordinal: 1, name: 'B', start: '2026-08-14', end: '2026-09-30', gate: null },
  ];

  it('picks the phase containing today', () => {
    expect(currentPhase(phases, new Date('2026-07-01T00:00:00Z'))!.ordinal).toBe(0);
    expect(currentPhase(phases, new Date('2026-08-20T00:00:00Z'))!.ordinal).toBe(1);
  });

  it('counts whole days regardless of clock time', () => {
    expect(daysBetween(new Date('2026-08-01T23:00:00Z'), '2026-08-14')).toBe(13);
  });
});

describe('the deck holds together on real data', () => {
  it('reports nulls rather than zeros when there is nothing to measure', () => {
    const deck = buildDeck(db, new Date('2026-07-28T00:00:00Z'));
    expect(deck.procedural.current).toBeNull();
    expect(deck.mocks.rollingAverage).toBeNull();
    expect(deck.ladder.baselineScore).toBe(53);
    expect(deck.ladder.targetScore).toBe(90);
    expect(deck.ladder.rungs).toHaveLength(6);
  });

  it('puts registration in an alarm state until it is done', () => {
    const deck = buildDeck(db, new Date('2026-07-28T00:00:00Z'));
    const reg = deck.countdown.find((x) => x.label === 'Registration closes')!;
    expect(reg.alarm).toBe(true);

    repo.setConfig('registration', { ...(repo.getConfig('registration', db) as object), completed: true }, db);
    const after = buildDeck(db, new Date('2026-07-28T00:00:00Z'));
    expect(after.countdown.find((x) => x.label === 'Registration closes')?.alarm ?? false).toBe(false);
  });

  it('computes a procedural share once work is triaged', () => {
    for (const [code, outcome] of [
      ['MSQ_STOP', 'wrong'],
      ['CONCEPT', 'wrong'],
    ] as const) {
      const a = repo.capture(
        {
          sourceLabel: 'S',
          sourceQNo: `Q-${code}`,
          qtype: 'MSQ',
          marks: 2,
          context: 'pyq',
          outcome,
          attemptedAt: new Date().toISOString(),
        },
        db,
      );
      repo.triage(
        a.id,
        {
          errorClassId: classId(code),
          whatIThought: 'Recorded during review.',
          brokeAtStep: 'Committed before checking every option carefully.',
          preventionRule: 'Verdict every option before submitting anything.',
        },
        db,
      );
    }

    const deck = buildDeck(db);
    expect(deck.procedural.current).toBeCloseTo(0.5, 6);
    expect(deck.today.recommendedDrill).not.toBeNull();
  });

  it('excludes drills from the share', () => {
    repo.recordDrillRun(
      {
        templateKey: 'loop_iterations',
        seed: 3,
        params: {},
        expected: '5',
        given: '4',
        correct: false,
        seconds: 10,
        boundaryClassId: classId('BOUNDARY'),
      },
      db,
    );
    // The drill produced a procedural attempt, but the metric must not see it.
    expect(buildDeck(db).procedural.current).toBeNull();
  });
});

describe('weekly review', () => {
  it('renders Markdown even with no data', () => {
    const md = weeklyMarkdown(buildWeekly(db, new Date('2026-07-28T00:00:00Z')));
    expect(md).toContain('# Weekly review');
    expect(md).toContain('## Attack next week');
    expect(md).toContain('Log some work.');
  });

  it('names the worst class by damage, not frequency', () => {
    const mk = (code: string, marks: 1 | 2, n: number): void => {
      for (let i = 0; i < n; i += 1) {
        const a = repo.capture(
          {
            sourceLabel: 'S',
            sourceQNo: `${code}-${i}`,
            qtype: 'NAT',
            marks,
            context: 'pyq',
            outcome: 'wrong',
          },
          db,
        );
        repo.triage(
          a.id,
          {
            errorClassId: classId(code),
            whatIThought: 'Logged in review.',
            brokeAtStep: 'The specific step where the working broke down.',
            preventionRule: 'The rule that stops this happening again.',
          },
          db,
        );
      }
    };
    mk('MISREAD', 1, 4); // 4 marks over 4 questions
    mk('BOUNDARY', 2, 3); // 6 marks over 3 questions

    const r = buildWeekly(db);
    expect(r.attack!.code).toBe('BOUNDARY');
    expect(weeklyMarkdown(r)).toContain('Chosen by damage, not by feel.');
  });
});
