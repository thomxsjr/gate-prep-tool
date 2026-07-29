/**
 * M5 — Spaced repetition.
 *
 * Card types are not cosmetic. A *procedure* card asks for the steps recited
 * in order; a *counterexample* card asks you to break a claim. Rendering them
 * all as generic question/answer would let recognition stand in for recall.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, useApi, useHotkeys } from '../lib.ts';
import { Button, Empty, Metric, Panel, Table, Td } from '../ui.tsx';

interface CardRow {
  id: number;
  type: 'formula' | 'definition' | 'procedure' | 'counterexample' | 'boundary';
  front: string;
  back: string;
  subject_name: string | null;
  due_date: string;
  interval_days: number;
  ease: number;
  reps: number;
  lapses: number;
  origin_attempt_id: number | null;
}

const PROMPTS: Record<CardRow['type'], string> = {
  formula: 'Write the formula from memory, including its conditions.',
  definition: 'State the definition precisely, in your own words.',
  procedure: 'Recite the steps in order. Do not skip one because it feels obvious.',
  counterexample: 'Break the claim. Produce a case where it fails.',
  boundary: 'State the boundary rule exactly — which side is included, and why.',
};

export function Cards(): React.ReactElement {
  const due = useApi<CardRow[]>('/cards/due');
  const all = useApi<CardRow[]>('/cards');
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);

  const card = due.data?.[0];

  useEffect(() => setRevealed(false), [card?.id]);

  const grade = useCallback(
    async (g: number) => {
      if (!card) return;
      await api(`/cards/${card.id}/review`, { method: 'POST', body: JSON.stringify({ grade: g }) });
      setDone((d) => d + 1);
      due.reload();
      all.reload();
    },
    [card, due, all],
  );

  useHotkeys({
    ' ': () => setRevealed(true),
    '0': () => revealed && void grade(0),
    '1': () => revealed && void grade(1),
    '2': () => revealed && void grade(2),
    '3': () => revealed && void grade(3),
    '4': () => revealed && void grade(4),
    '5': () => revealed && void grade(5),
  });

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Panel label="Due now" right={due.data ? `${due.data.length} left · ${done} done` : ''}>
        {!due.data ? (
          <Empty>Loading…</Empty>
        ) : !card ? (
          <Empty>
            Nothing due. Cards are created from the prevention rule when you triage an error.
          </Empty>
        ) : (
          <div className="py-2">
            <div className="num flex items-baseline justify-between text-[10px] tracking-[0.16em] text-ink-muted uppercase">
              <span>{card.type}</span>
              <span>
                {card.subject_name ?? '—'} · rep {card.reps} · lapses {card.lapses}
              </span>
            </div>

            <p className="mt-1 text-[11px] text-ink-muted">{PROMPTS[card.type]}</p>

            <p className="mt-4 border-y border-rule py-6 text-lg leading-relaxed">{card.front}</p>

            {revealed ? (
              <>
                <p className="mt-4 bg-ground p-3 text-[15px] leading-relaxed">{card.back}</p>
                <div className="mt-4 border-t border-rule pt-3">
                  <div className="text-[10px] tracking-[0.16em] text-ink-muted uppercase">
                    How did that go
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {[
                      [0, 'blackout'],
                      [1, 'wrong'],
                      [2, 'wrong, familiar'],
                      [3, 'hard'],
                      [4, 'hesitant'],
                      [5, 'perfect'],
                    ].map(([g, label]) => (
                      <button
                        key={g as number}
                        onClick={() => void grade(g as number)}
                        className={`border px-2.5 py-1 text-[11px] ${
                          (g as number) < 3
                            ? 'border-procedural text-procedural hover:bg-procedural hover:text-panel'
                            : 'border-rule hover:border-ink'
                        }`}
                      >
                        <span className="num mr-1">{g as number}</span>
                        {label as string}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[10px] text-ink-muted">
                    Below 3 is a lapse: the interval resets to one day.
                  </p>
                </div>
              </>
            ) : (
              <button
                onClick={() => setRevealed(true)}
                className="mt-4 w-full border border-dashed border-rule py-8 text-[11px] tracking-[0.16em] text-ink-muted uppercase hover:border-ink hover:text-ink"
              >
                Answer aloud, then press space
              </button>
            )}
          </div>
        )}
      </Panel>

      <div className="space-y-3">
        <Panel label="Deck">
          <div className="grid grid-cols-2 gap-3">
            <Metric label="Total cards" value={String(all.data?.length ?? 0)} size="md" />
            <Metric label="Due today" value={String(due.data?.length ?? 0)} size="md" />
          </div>
          {all.data && all.data.length > 0 && (
            <div className="num mt-3 space-y-1 border-t border-rule pt-3 text-[11px]">
              {(['formula', 'definition', 'procedure', 'counterexample', 'boundary'] as const).map((t) => {
                const n = all.data!.filter((c) => c.type === t).length;
                return n === 0 ? null : (
                  <div key={t} className="flex justify-between">
                    <span className="text-ink-muted">{t}</span>
                    <span>{n}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel label="Upcoming">
          {!all.data || all.data.length === 0 ? (
            <Empty>No cards yet.</Empty>
          ) : (
            <Table head={['Front', 'Type', 'Due', 'Ease']}>
              {[...all.data]
                .sort((a, b) => a.due_date.localeCompare(b.due_date))
                .slice(0, 14)
                .map((c) => (
                  <tr key={c.id} className="border-b border-rule last:border-0">
                    <Td align="left" className="max-w-[200px] truncate">{c.front}</Td>
                    <Td>{c.type}</Td>
                    <Td>{c.due_date}</Td>
                    <Td>{c.ease.toFixed(2)}</Td>
                  </tr>
                ))}
            </Table>
          )}
        </Panel>
      </div>
    </div>
  );
}
