/**
 * Settings — the config table, editable.
 *
 * Every date, gate, rung value and marking rule can be changed here without a
 * code change. Groups carrying `_verified_against_brochure: false` show a
 * standing banner until confirmed against the official GATE 2027 brochure.
 */

import { useState } from 'react';
import { api, useApi } from '../lib.ts';
import { Button, Empty, Field, Input, Panel, Procedural, Table, Td, Textarea } from '../ui.tsx';

type ConfigMap = Record<string, { value: unknown; verified: boolean }>;

const BROCHURE_GROUPS = ['exam', 'registration', 'marking'];

export function Settings(): React.ReactElement {
  const cfg = useApi<ConfigMap>('/config');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!cfg.data) return <Empty>Loading…</Empty>;

  const reg = cfg.data['registration']?.value as Record<string, unknown> | undefined;
  const unverified = Object.entries(cfg.data)
    .filter(([, v]) => !v.verified)
    .map(([k]) => k);

  const save = async (key: string): Promise<void> => {
    setError(null);
    try {
      await api(`/config/${key}`, { method: 'PUT', body: JSON.stringify({ value: JSON.parse(draft) }) });
      setEditing(null);
      cfg.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      {unverified.length > 0 && (
        <Panel label="Unverified against the brochure">
          <p className="text-[12px] leading-relaxed">
            <Procedural>
              <strong>{unverified.join(', ')}</strong>
            </Procedural>{' '}
            are carried from the 2026 rules. The organising institute changes for GATE 2027 and
            section weights have moved before. Open the official brochure and confirm each — do not
            clear these from memory.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {unverified
              .filter((k) => BROCHURE_GROUPS.includes(k))
              .map((k) => (
                <Button
                  key={k}
                  onClick={async () => {
                    await api(`/config/${k}`, { method: 'PUT', body: JSON.stringify({ verified: true }) });
                    cfg.reload();
                  }}
                >
                  I checked {k} against the brochure
                </Button>
              ))}
          </div>
        </Panel>
      )}

      <Panel label="Registration" right="highest-consequence dates in the app">
        {reg ? (
          <div className="grid gap-3 sm:grid-cols-4">
            {(['opens', 'regular_close', 'late_fee_close'] as const).map((k) => (
              <Field key={k} label={k.replace(/_/g, ' ')}>
                <Input
                  type="date"
                  value={String(reg[k] ?? '')}
                  onChange={async (e) => {
                    await api('/config/registration', {
                      method: 'PUT',
                      body: JSON.stringify({ value: { ...reg, [k]: e.target.value } }),
                    });
                    cfg.reload();
                  }}
                />
              </Field>
            ))}
            <div className="flex items-end">
              <label className="flex items-center gap-2 pb-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={reg['completed'] === true}
                  onChange={async (e) => {
                    await api('/config/registration', {
                      method: 'PUT',
                      body: JSON.stringify({
                        value: {
                          ...reg,
                          completed: e.target.checked,
                          completed_at: e.target.checked ? new Date().toISOString() : null,
                        },
                      }),
                    });
                    cfg.reload();
                  }}
                />
                Registered
              </label>
            </div>
          </div>
        ) : (
          <Empty>No registration config.</Empty>
        )}
        {reg?.['completed'] !== true && (
          <p className="mt-2 border-t border-rule pt-2 text-[11px] text-procedural">
            Until this is ticked the deck keeps registration in an alarm state. Missing it is the
            one failure the whole plan cannot recover from.
          </p>
        )}
      </Panel>

      <Panel label="All configuration">
        <Table head={['Group', 'Verified', 'Value', '']}>
          {Object.entries(cfg.data).map(([key, entry]) => (
            <tr key={key} className="border-b border-rule align-top last:border-0">
              <Td align="left" className="font-medium">{key}</Td>
              <Td>
                {entry.verified ? (
                  <span className="text-ink-muted">—</span>
                ) : BROCHURE_GROUPS.includes(key) ? (
                  <Procedural>check</Procedural>
                ) : (
                  <span className="text-ink-muted">n/a</span>
                )}
              </Td>
              <Td align="left" className="max-w-[560px]">
                {editing === key ? (
                  <>
                    <Textarea
                      rows={10}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      className="font-mono text-[11px]"
                    />
                    {error && <p className="mt-1 text-[11px] text-procedural">{error}</p>}
                  </>
                ) : (
                  <pre className="max-h-24 overflow-y-auto text-[10px] leading-snug whitespace-pre-wrap text-ink-muted">
                    {JSON.stringify(entry.value, null, 1)}
                  </pre>
                )}
              </Td>
              <Td>
                {editing === key ? (
                  <div className="flex flex-col gap-1">
                    <Button variant="primary" onClick={() => void save(key)}>Save</Button>
                    <Button onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                ) : (
                  <Button
                    onClick={() => {
                      setEditing(key);
                      setDraft(JSON.stringify(entry.value, null, 2));
                      setError(null);
                    }}
                  >
                    Edit
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Panel>

      <Panel label="Durability">
        <p className="text-[12px] leading-relaxed text-ink-muted">
          Every write appends to <code className="text-ink">data/journal/YYYY-MM.jsonl</code>,
          fsynced. Run <code className="text-ink">npm run backup</code> for a timestamped copy plus
          the canonical JSON export, and{' '}
          <code className="text-ink">npm run verify:durability</code> to prove the whole
          write → back up → delete → restore cycle end to end.
        </p>
      </Panel>
    </div>
  );
}
