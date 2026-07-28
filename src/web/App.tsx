/**
 * M0 health check. Confirms the API is up, the schema is migrated and the
 * seed is loaded. Deliberately plain — the command deck arrives in M1 and the
 * design effort belongs there.
 */

import { useEffect, useState } from 'react';

interface Health {
  ok: boolean;
  db: string;
  schemaVersion: number;
  migrations: number[];
  counts: Record<string, number>;
}

export function App(): React.ReactElement {
  const [health, setHealth] = useState<Health | null>(null);
  const [unverified, setUnverified] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/health').then((r) => r.json() as Promise<Health>),
      fetch('/api/config/unverified').then((r) => r.json() as Promise<{ unverified: string[] }>),
    ])
      .then(([h, u]) => {
        setHealth(h);
        setUnverified(u.unverified);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main className="mx-auto max-w-3xl p-8">
      <header className="mb-8 border-b border-rule pb-4">
        <p className="text-ink-muted text-xs tracking-[0.18em] uppercase">Milestone 0</p>
        <h1 className="mt-1 text-2xl font-semibold">Schema and durability</h1>
      </header>

      {error && (
        <p className="num border border-procedural p-4 text-procedural">
          API unreachable: {error}. Start it with <code>npm run api</code>.
        </p>
      )}

      {unverified.length > 0 && (
        <p className="mb-6 border border-procedural bg-panel p-3 text-sm text-procedural">
          Unverified against the GATE 2027 brochure: {unverified.join(', ')}. Check the official
          brochure before Phase 3.
        </p>
      )}

      {health && (
        <table className="w-full border-collapse text-sm">
          <tbody>
            <Row label="Schema version" value={String(health.schemaVersion)} />
            <Row label="Database" value={health.db} />
            {Object.entries(health.counts).map(([table, n]) => (
              <Row key={table} label={table} value={String(n)} />
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <tr className="border-b border-rule">
      <th scope="row" className="py-2 pr-4 text-left font-normal text-ink-muted">
        {label}
      </th>
      <td className="num py-2 text-right">{value}</td>
    </tr>
  );
}
