/**
 * M5 — Formula sheet. Two printable pages, plus a recall test that blanks
 * random terms.
 *
 * Print uses the browser's own pipeline (Cmd+P → Save as PDF): offline, no
 * dependency, and a real PDF. See the print rules in styles.css.
 */

import { useCallback, useMemo, useState } from 'react';
import { api, useApi } from '../lib.ts';
import { Button, Empty, Field, Input, Panel, Select, Textarea } from '../ui.tsx';

interface CardRow {
  id: number;
  type: string;
  front: string;
  back: string;
  subject_name: string | null;
  subject_id: number | null;
}

export function Formula(): React.ReactElement {
  const cards = useApi<CardRow[]>('/cards');
  const ref = useApi<{ subjects: { id: number; name: string }[] }>('/reference');
  const [mode, setMode] = useState<'sheet' | 'recall'>('sheet');
  const [blanked, setBlanked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const sheet = useMemo(
    () => (cards.data ?? []).filter((c) => c.type === 'formula' || c.type === 'boundary'),
    [cards.data],
  );

  const bySubject = useMemo(() => {
    const m = new Map<string, CardRow[]>();
    for (const c of sheet) {
      const k = c.subject_name ?? 'Unassigned';
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sheet]);

  /** Blank roughly a third of the terms, chosen fresh each run. */
  const reroll = useCallback(() => {
    const next = new Set<string>();
    for (const c of sheet) {
      const words = c.back.split(/\s+/);
      words.forEach((w, i) => {
        if (w.length > 2 && Math.random() < 0.33) next.add(`${c.id}:${i}`);
      });
    }
    setBlanked(next);
  }, [sheet]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Button onClick={() => setMode('sheet')} variant={mode === 'sheet' ? 'primary' : 'default'}>
          Anchor sheet
        </Button>
        <Button
          onClick={() => {
            setMode('recall');
            reroll();
          }}
          variant={mode === 'recall' ? 'primary' : 'default'}
        >
          Recall test
        </Button>
        {mode === 'recall' && <Button onClick={reroll}>Reroll blanks</Button>}
        <Button onClick={() => window.print()}>Print / save as PDF</Button>
        <Button onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : 'Add entry'}</Button>
        <span className="num ml-auto text-[11px] text-ink-muted">{sheet.length} entries</span>
      </div>

      {adding && ref.data && (
        <AddEntry
          subjects={ref.data.subjects}
          onDone={() => {
            setAdding(false);
            cards.reload();
          }}
        />
      )}

      {sheet.length === 0 ? (
        <Empty>
          No formula or boundary cards yet. Add one above, or triage a boundary error — the
          prevention rule becomes a card automatically.
        </Empty>
      ) : (
        <div className="columns-1 gap-4 md:columns-2 print:columns-2 print:text-[10px]">
          {bySubject.map(([subject, rows]) => (
            <section key={subject} className="mb-4 break-inside-avoid">
              <h3 className="mb-1 border-b border-ink pb-0.5 text-[10px] font-semibold tracking-[0.16em] uppercase">
                {subject}
              </h3>
              <dl className="space-y-1.5">
                {rows.map((c) => (
                  <div key={c.id} className="break-inside-avoid">
                    <dt className="text-[12px] font-medium">{c.front}</dt>
                    <dd className="num text-[12px] leading-snug text-ink-muted">
                      {mode === 'recall'
                        ? c.back.split(/\s+/).map((w, i) =>
                            blanked.has(`${c.id}:${i}`) ? (
                              <span
                                key={i}
                                className="mx-0.5 inline-block min-w-[2.5em] border-b border-ink align-baseline"
                              >
                                &nbsp;
                              </span>
                            ) : (
                              <span key={i}> {w}</span>
                            ),
                          )
                        : c.back}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function AddEntry({
  subjects,
  onDone,
}: {
  subjects: { id: number; name: string }[];
  onDone: () => void;
}): React.ReactElement {
  const [f, setF] = useState({ type: 'formula', front: '', back: '', subjectId: '' });

  return (
    <Panel label="Add to the sheet">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Type">
          <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="formula">formula</option>
            <option value="boundary">boundary rule</option>
          </Select>
        </Field>
        <Field label="Subject">
          <Select value={f.subjectId} onChange={(e) => setF({ ...f, subjectId: e.target.value })}>
            <option value="">—</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Name / prompt">
            <Input value={f.front} onChange={(e) => setF({ ...f, front: e.target.value })} />
          </Field>
        </div>
        <div className="sm:col-span-4">
          <Field label="The formula or rule">
            <Textarea rows={2} value={f.back} onChange={(e) => setF({ ...f, back: e.target.value })} />
          </Field>
        </div>
      </div>
      <div className="mt-3 border-t border-rule pt-3">
        <Button
          variant="primary"
          disabled={!f.front.trim() || !f.back.trim()}
          onClick={async () => {
            await api('/cards', {
              method: 'POST',
              body: JSON.stringify({
                type: f.type,
                front: f.front,
                back: f.back,
                subjectId: f.subjectId ? Number(f.subjectId) : null,
              }),
            });
            onDone();
          }}
        >
          Add
        </Button>
      </div>
    </Panel>
  );
}
