/**
 * Local API. Binds 0.0.0.0 so the error log and flashcards are reachable from
 * a phone on the same network — no cloud, no account, no external call.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { networkInterfaces } from 'node:os';
import { DB_PATH, getDb } from '../db/index.ts';
import { isMain } from '../lib/is-main.ts';
import { appliedVersions } from '../db/migrate.ts';
import * as repo from './repo.ts';
import { ValidationError } from './repo.ts';
import { buildDeck } from './deck.ts';
import { buildWeekly, weeklyMarkdown } from './weekly.ts';
import { CSV_TEMPLATE, importErrorCsv } from './csv.ts';
import { TEMPLATES, answerMatches, generate } from '../domain/drills.ts';
import { addDays, leakTable } from '../domain/procedural.ts';
import { buildCurve, calibrate } from '../domain/calibration.ts';
import { findViolations, netFromAttemptPolicy, type AttemptDecision } from '../domain/ev.ts';
import { isNearMissMsq, perOptionAccuracy } from '../domain/scoring.ts';
import type { CaptureInput } from '../shared/types.ts';

export const app = new Hono();

app.onError((err, c) => {
  if (err instanceof ValidationError) {
    return c.json({ error: err.message, field: err.field }, 422);
  }
  console.error(err);
  return c.json({ error: err.message }, 500);
});

const num = (v: string | undefined): number | undefined =>
  v === undefined || v === '' ? undefined : Number(v);

// --- health and config -----------------------------------------------------

app.get('/api/health', (c) => {
  const db = getDb();
  const versions = [...appliedVersions(db)].sort((a, b) => a - b);
  const counts: Record<string, number> = {};
  for (const t of ['config', 'error_classes', 'subjects', 'rungs', 'questions', 'attempts', 'cards', 'mocks']) {
    counts[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  }
  return c.json({ ok: true, db: DB_PATH, schemaVersion: versions.at(-1) ?? 0, migrations: versions, counts });
});

app.get('/api/config', (c) => c.json(repo.allConfig()));

app.put('/api/config/:key', async (c) => {
  const key = c.req.param('key');
  const body = (await c.req.json()) as { value?: unknown; verified?: boolean };
  if (body.value !== undefined) repo.setConfig(key, body.value);
  if (body.verified !== undefined) repo.markVerified(key, body.verified);
  return c.json(repo.allConfig()[key] ?? null);
});

app.get('/api/reference', (c) =>
  c.json({
    errorClasses: repo.errorClasses(),
    subjects: repo.subjects(),
    rungs: repo.rungs(),
    sources: repo.sources(),
    limits: repo.triageLimits(),
  }),
);

// --- command deck ----------------------------------------------------------

app.get('/api/deck', (c) => c.json(buildDeck()));

// --- error log -------------------------------------------------------------

app.get('/api/errors', (c) => {
  const q = c.req.query();
  return c.json(
    repo.listAttempts({
      errorClassId: num(q['errorClassId']),
      subjectId: num(q['subjectId']),
      rungOrdinal: num(q['rungOrdinal']),
      sourceId: num(q['sourceId']),
      context: q['context'] as never,
      qtype: q['qtype'],
      triaged: q['triaged'] === undefined ? undefined : q['triaged'] === 'true',
      since: q['since'],
      limit: num(q['limit']),
      offset: num(q['offset']),
    }),
  );
});

app.get('/api/errors/queue', (c) => c.json(repo.triageQueue()));

app.get('/api/errors/leak', (c) => {
  const days = num(c.req.query('days')) ?? 14;
  const today = new Date();
  const classes = repo.errorClasses();
  return c.json(
    leakTable(
      repo.shareAttempts(),
      classes.map((x) => ({ id: x.id, code: x.code, name: x.name, isProcedural: x.is_procedural })),
      { from: addDays(today, -days), to: addDays(today, 1) },
    ),
  );
});

app.get('/api/errors/:id', (c) => {
  const a = repo.getAttempt(Number(c.req.param('id')));
  return a ? c.json(a) : c.json({ error: 'not found' }, 404);
});

app.post('/api/errors', async (c) => c.json(repo.capture(await c.req.json()), 201));

app.patch('/api/errors/:id', async (c) =>
  c.json(repo.triage(Number(c.req.param('id')), await c.req.json())),
);

app.delete('/api/errors/:id', (c) => {
  repo.deleteAttempt(Number(c.req.param('id')));
  return c.json({ ok: true });
});

app.post('/api/errors/:id/card', (c) =>
  c.json({ cardId: repo.createCardFromAttempt(Number(c.req.param('id')), null) }, 201),
);

app.get('/api/errors/import/template', (c) => c.text(CSV_TEMPLATE));

app.post('/api/errors/import', async (c) => c.json(importErrorCsv(await c.req.text())));

// --- MSQ trainer (M3) ------------------------------------------------------

app.get('/api/msq/questions', (c) => c.json(repo.msqQuestions()));

app.post('/api/msq/attempt', async (c) => c.json(repo.recordMsqAttempt(await c.req.json()), 201));

app.get('/api/msq/report', (c) => {
  const rows = repo.msqPerOptionRows();
  const right = rows.reduce((a, r) => a + r.right, 0);
  const total = rows.reduce((a, r) => a + r.total, 0);
  const nearMisses = rows.filter((r) => r.total > 0 && r.right === r.total - 1).length;
  const perfect = rows.filter((r) => r.right === r.total).length;

  return c.json({
    perOptionRight: right,
    perOptionTotal: total,
    perOptionAccuracy: total === 0 ? 0 : right / total,
    questionsAttempted: rows.length,
    questionAccuracy: rows.length === 0 ? 0 : perfect / rows.length,
    nearMisses,
    trend: rows.map((r) => ({
      date: r.attemptedAt.slice(0, 10),
      accuracy: r.total === 0 ? 0 : r.right / r.total,
      n: r.total,
    })),
  });
});

// --- boundary drills (M4) --------------------------------------------------

app.get('/api/drills/templates', (c) =>
  c.json(
    TEMPLATES.map((t) => ({
      key: t.key,
      name: t.name,
      trap: t.trap,
      timeBudgetSeconds: t.timeBudgetSeconds,
      answerKind: t.answerKind,
    })),
  ),
);

app.get('/api/drills/generate', (c) => {
  const key = c.req.query('template') ?? TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)]!.key;
  const seed = num(c.req.query('seed')) ?? Math.floor(Math.random() * 2 ** 31);
  const g = generate(key, seed);
  if (!g) return c.json({ error: `unknown template "${key}"` }, 404);

  // The answer is withheld until the drill is answered.
  return c.json({
    templateKey: g.template.key,
    templateName: g.template.name,
    seed,
    prompt: g.prompt,
    params: g.params,
    answerKind: g.template.answerKind,
    timeBudgetSeconds: g.template.timeBudgetSeconds,
  });
});

app.post('/api/drills/answer', async (c) => {
  const body = (await c.req.json()) as { templateKey: string; seed: number; given: string; seconds: number };
  const g = generate(body.templateKey, body.seed);
  if (!g) return c.json({ error: 'unknown template' }, 404);

  const correct = answerMatches(body.given ?? '', g.answer, g.template.answerKind);
  const boundary = repo.errorClasses().find((x) => x.code === 'BOUNDARY') ?? null;

  const r = repo.recordDrillRun({
    templateKey: body.templateKey,
    seed: body.seed,
    params: g.params,
    expected: g.answer,
    given: body.given ?? null,
    correct,
    seconds: body.seconds ?? 0,
    boundaryClassId: boundary?.id ?? null,
  });

  return c.json({ correct, expected: g.answer, trap: g.template.trap, ...r });
});

app.get('/api/drills/stats', (c) => c.json(repo.drillStats()));

// --- cards (M5) ------------------------------------------------------------

app.get('/api/cards/due', (c) => c.json(repo.dueCards(new Date().toISOString().slice(0, 10))));
app.get('/api/cards', (c) => c.json(repo.allCards()));
app.post('/api/cards', async (c) => c.json({ id: repo.createCard(await c.req.json()) }, 201));

app.post('/api/cards/:id/review', async (c) => {
  const body = (await c.req.json()) as { grade: number };
  return c.json(repo.reviewCard(Number(c.req.param('id')), body.grade));
});

app.get('/api/concepts/cost', (c) => c.json(repo.conceptCost()));

// --- mocks (M6) ------------------------------------------------------------

app.get('/api/mocks', (c) => c.json(repo.listMocks()));

app.post('/api/mocks', async (c) => {
  const body = (await c.req.json()) as {
    date: string;
    startedAt: string | null;
    environment: 'home' | 'away';
    notes?: string;
  };
  const id = repo.createMock(body);
  return c.json({ id, startedAt0930: repo.startedAt0930(body.startedAt) }, 201);
});

app.get('/api/mocks/:id', (c) => {
  const id = Number(c.req.param('id'));
  const mock = repo.getMock(id);
  if (!mock) return c.json({ error: 'not found' }, 404);

  const rows = repo.mockAttempts(id);
  const pending = rows.filter(
    (r) =>
      (r.outcome === 'wrong' || r.outcome === 'skipped' || r.outcome === 'correct_but_guessed') &&
      r.triaged_at === null,
  );

  // The score is the reward for doing the triage, so it is withheld until
  // every wrong, skipped and guessed-correct question has an error class.
  const revealed = pending.length === 0 && rows.length > 0;

  return c.json({
    mock: revealed ? mock : { ...mock, raw_score: null },
    attempts: rows,
    triage: { pending: pending.length, total: rows.length, revealed },
    leak: revealed
      ? leakTable(
          rows.map((r) => ({
            attemptedAt: r.attempted_at,
            context: r.context,
            marksLost: r.marks_lost ?? 0,
            isProcedural: r.is_procedural,
            errorClassId: r.error_class_id,
            triagedAt: r.triaged_at,
          })),
          repo.errorClasses().map((x) => ({
            id: x.id,
            code: x.code,
            name: x.name,
            isProcedural: x.is_procedural,
          })),
        )
      : [],
  });
});

app.post('/api/mocks/:id/recompute', (c) => c.json(repo.recomputeMock(Number(c.req.param('id')))));

app.post('/api/mocks/:id/rows', async (c) => {
  const mockId = Number(c.req.param('id'));
  const body = (await c.req.json()) as { rows: Record<string, unknown>[] };
  const db = getDb();
  const created: number[] = [];

  for (const row of body.rows) {
    const a = repo.capture({ ...(row as unknown as CaptureInput), context: 'mock' }, db);
    db.prepare('UPDATE attempts SET mock_id = ? WHERE id = ?').run(mockId, a.id);
    created.push(a.id);
  }
  repo.recomputeMock(mockId, db);
  return c.json({ created: created.length });
});

// --- calibration and attempt policy (M7) -----------------------------------

app.get('/api/calibration', (c) => {
  const obs = repo.confidenceObservations();
  const minSamples =
    (repo.getConfig<Record<string, number>>('calibration')?.['min_samples'] as number) ?? 50;
  const curve = buildCurve(obs, minSamples);

  const rows = repo.listAttempts({ limit: 1000 });
  const decisions: AttemptDecision[] = rows
    .filter((r) => r.outcome !== null && r.context !== 'drill')
    .map((r) => ({
      qtype: r.qtype,
      marks: r.marks as 1 | 2,
      attempted: r.outcome !== 'skipped',
      // The EV threshold runs on CALIBRATED confidence — using the stated
      // number would be judging the attempt by the very figure the curve
      // exists to correct. Null when there is no confidence recorded, which
      // keeps the violation list silent rather than fabricated.
      p: r.confidence === null ? null : calibrate(r.confidence, curve).p,
    }));

  const violations = findViolations(decisions);
  const byIndex = rows.filter((r) => r.outcome !== null && r.context !== 'drill');

  return c.json({
    ...curve,
    violations: violations.map((v, i) => ({ ...v, sourceQNo: byIndex[i]?.source_q_no ?? null })),
    netPolicy: netFromAttemptPolicy(decisions),
  });
});

// --- PYQ tracker (M8) ------------------------------------------------------

app.get('/api/pyq', (c) =>
  c.json({ ...repo.pyqGrid(), split: repo.attemptSplit(), revisit: repo.revisitQueue().slice(0, 50) }),
);

// --- sessions --------------------------------------------------------------

app.get('/api/sessions', (c) => c.json(repo.listSessions()));
app.post('/api/sessions', async (c) => c.json({ id: repo.logSession(await c.req.json()) }, 201));

// --- weekly review (M9) ----------------------------------------------------

app.get('/api/weekly', (c) => c.json(buildWeekly()));
app.get('/api/weekly.md', (c) => c.text(weeklyMarkdown(buildWeekly())));

// --- MSQ per-option helpers used by the report -----------------------------

export { perOptionAccuracy, isNearMissMsq };

const PORT = Number(process.env.PORT ?? 5178);

if (isMain(import.meta.url)) {
  serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
    console.log(`api: http://localhost:${info.port}`);
    for (const addr of lanAddresses()) console.log(`api: http://${addr}:${info.port}  (phone)`);
  });
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}
