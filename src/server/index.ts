/**
 * Local API. Binds to 0.0.0.0 so the error log and flashcards are reachable
 * from a phone on the same network — no cloud, no account, no external call.
 *
 * M0 exposes health and config only. Domain routes arrive with M2.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { networkInterfaces } from 'node:os';
import { DB_PATH, getDb } from '../db/index.ts';
import { isMain } from '../lib/is-main.ts';
import { appliedVersions } from '../db/migrate.ts';

export const app = new Hono();

app.get('/api/health', (c) => {
  const db = getDb();
  const versions = [...appliedVersions(db)].sort((a, b) => a - b);
  const counts: Record<string, number> = {};
  for (const t of ['config', 'error_classes', 'subjects', 'rungs', 'questions', 'attempts']) {
    counts[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  }

  return c.json({
    ok: true,
    db: DB_PATH,
    schemaVersion: versions.at(-1) ?? 0,
    migrations: versions,
    counts,
  });
});

app.get('/api/config', (c) => {
  const rows = getDb()
    .prepare('SELECT key, value_json, grp, verified_against_brochure, updated_at FROM config')
    .all() as {
    key: string;
    value_json: string;
    grp: string;
    verified_against_brochure: number;
    updated_at: string;
  }[];

  return c.json(
    Object.fromEntries(
      rows.map((r) => [
        r.key,
        {
          value: JSON.parse(r.value_json),
          verifiedAgainstBrochure: r.verified_against_brochure === 1,
          updatedAt: r.updated_at,
        },
      ]),
    ),
  );
});

/** Groups still awaiting a check against the official brochure. */
app.get('/api/config/unverified', (c) => {
  const rows = getDb()
    .prepare('SELECT key FROM config WHERE verified_against_brochure = 0 ORDER BY key')
    .all() as { key: string }[];
  return c.json({ unverified: rows.map((r) => r.key) });
});

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
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}
