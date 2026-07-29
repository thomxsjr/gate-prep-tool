/**
 * Static (deployed) mode.
 *
 * The deployed build has no server and no disk. Every read is answered from a
 * snapshot frozen at build time; every write is REFUSED rather than accepted
 * and dropped. Silently discarding a write would be worse than not offering
 * the button — the error log is the asset this whole project protects.
 *
 * Boundary drills still work in full, because the templates are pure seeded
 * functions with no server involvement. Only the recording of a drill run is
 * unavailable.
 */

import { TEMPLATES, answerMatches, generate } from '../domain/drills.ts';

export const IS_STATIC = import.meta.env['VITE_STATIC'] === '1';

export class ReadOnlyError extends Error {
  constructor(action: string) {
    super(
      `This is a read-only snapshot — ${action} is not available here. ` +
        `Log on the machine running the app; nothing is lost, because nothing was written.`,
    );
    this.name = 'ReadOnlyError';
  }
}

interface Snapshot {
  generatedAt: string;
  config: unknown;
  reference: unknown;
  deck: unknown;
  errors: Record<string, unknown>[];
  errorsQueue: unknown;
  leak: Record<string, unknown>;
  msqQuestions: unknown;
  msqReport: unknown;
  drillStats: unknown;
  cards: unknown;
  cardsDue: unknown;
  mocks: unknown;
  mockDetail: Record<string, unknown>;
  calibration: unknown;
  pyq: unknown;
  weekly: unknown;
  sessions: unknown;
  conceptCost: unknown;
  health: unknown;
}

let cache: Promise<Snapshot> | null = null;

export function loadSnapshot(): Promise<Snapshot> {
  cache ??= fetch('/snapshot.json').then((r) => {
    if (!r.ok) throw new Error(`snapshot unavailable (${r.status})`);
    return r.json() as Promise<Snapshot>;
  });
  return cache;
}

export async function snapshotGeneratedAt(): Promise<string> {
  return (await loadSnapshot()).generatedAt;
}

/** Answer an API path from the snapshot. Mirrors the server's own filtering. */
export async function staticApi<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();

  if (method !== 'GET') {
    throw new ReadOnlyError(describeWrite(path, method));
  }

  const [route, qs] = path.split('?');
  const q = new URLSearchParams(qs ?? '');
  const s = await loadSnapshot();

  // Drills are pure functions of (template, seed), so they run entirely here.
  if (route === '/drills/templates') {
    return TEMPLATES.map((t) => ({
      key: t.key,
      name: t.name,
      trap: t.trap,
      timeBudgetSeconds: t.timeBudgetSeconds,
      answerKind: t.answerKind,
    })) as T;
  }
  if (route === '/drills/generate') {
    const key = q.get('template') || TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)]!.key;
    const seed = q.get('seed') ? Number(q.get('seed')) : Math.floor(Math.random() * 2 ** 31);
    const g = generate(key, seed)!;
    return {
      templateKey: g.template.key,
      templateName: g.template.name,
      seed,
      prompt: g.prompt,
      params: g.params,
      answerKind: g.template.answerKind,
      timeBudgetSeconds: g.template.timeBudgetSeconds,
    } as T;
  }

  switch (route) {
    case '/health': return s.health as T;
    case '/config': return s.config as T;
    case '/reference': return s.reference as T;
    case '/deck': return s.deck as T;
    case '/errors/queue': return s.errorsQueue as T;
    case '/errors/leak': return (s.leak[q.get('days') ?? '14'] ?? s.leak['14']) as T;
    case '/msq/questions': return s.msqQuestions as T;
    case '/msq/report': return s.msqReport as T;
    case '/drills/stats': return s.drillStats as T;
    case '/cards': return s.cards as T;
    case '/cards/due': return s.cardsDue as T;
    case '/mocks': return s.mocks as T;
    case '/calibration': return s.calibration as T;
    case '/pyq': return s.pyq as T;
    case '/weekly': return s.weekly as T;
    case '/sessions': return s.sessions as T;
    case '/concepts/cost': return s.conceptCost as T;
    default: break;
  }

  if (route === '/errors') return filterErrors(s.errors, q) as T;

  const mockMatch = /^\/mocks\/(\d+)$/.exec(route ?? '');
  if (mockMatch) {
    const d = s.mockDetail[mockMatch[1]!];
    if (!d) throw new Error('mock not found in snapshot');
    return d as T;
  }

  const errorMatch = /^\/errors\/(\d+)$/.exec(route ?? '');
  if (errorMatch) {
    const row = s.errors.find((r) => String(r['id']) === errorMatch[1]);
    if (!row) throw new Error('not found in snapshot');
    return row as T;
  }

  throw new Error(`"${route}" is not available in the read-only snapshot`);
}

/** Same predicate set the server applies, so filtered views agree. */
function filterErrors(rows: Record<string, unknown>[], q: URLSearchParams): unknown[] {
  const numParam = (k: string): number | undefined =>
    q.get(k) === null || q.get(k) === '' ? undefined : Number(q.get(k));

  const errorClassId = numParam('errorClassId');
  const subjectId = numParam('subjectId');
  const sourceId = numParam('sourceId');
  const qtype = q.get('qtype') || undefined;
  const context = q.get('context') || undefined;
  const triaged = q.get('triaged') === null ? undefined : q.get('triaged') === 'true';
  const since = q.get('since') || undefined;
  const limit = numParam('limit') ?? 200;

  return rows
    .filter((r) => {
      if (errorClassId !== undefined && r['error_class_id'] !== errorClassId) return false;
      if (subjectId !== undefined && r['subject_id'] !== subjectId) return false;
      if (sourceId !== undefined && r['source_id'] !== sourceId) return false;
      if (qtype !== undefined && r['qtype'] !== qtype) return false;
      if (context !== undefined && r['context'] !== context) return false;
      if (triaged === true && r['triaged_at'] === null) return false;
      if (triaged === false && r['triaged_at'] !== null) return false;
      if (since !== undefined && String(r['attempted_at']) < since) return false;
      return true;
    })
    .slice(0, limit);
}

function describeWrite(path: string, method: string): string {
  if (path.startsWith('/errors/import')) return 'importing CSV';
  if (path.startsWith('/errors') && method === 'POST') return 'capturing an error';
  if (path.startsWith('/errors') && method === 'PATCH') return 'saving a diagnosis';
  if (path.startsWith('/msq')) return 'recording an MSQ attempt';
  if (path.startsWith('/drills')) return 'recording a drill run';
  if (path.startsWith('/cards')) return 'reviewing a card';
  if (path.startsWith('/mocks')) return 'saving a mock';
  if (path.startsWith('/config')) return 'changing configuration';
  if (path.startsWith('/sessions')) return 'logging a session';
  return 'writing';
}
