/**
 * Morning review — full screen, one error at a time, keyboard only.
 *
 * `what I thought` is shown first and the correct reasoning stays hidden
 * until a keypress. Seeing the repair before recalling it turns review into
 * reading, which is the failure mode this screen exists to prevent.
 *
 * Space reveal · J/K or arrows to move · R to reset · Esc to leave
 */

import { useEffect, useState } from 'react';
import type { AttemptRow } from '../../shared/types.ts';
import { marks, useApi, useHotkeys } from '../lib.ts';
import { Empty, Procedural } from '../ui.tsx';

export function Review(): React.ReactElement {
  const { data } = useApi<AttemptRow[]>('/errors?triaged=true&limit=300');
  const [i, setI] = useState(0);
  const [revealed, setRevealed] = useState(false);

  const rows = data ?? [];
  const row = rows[i];

  useEffect(() => setRevealed(false), [i]);

  useHotkeys({
    ' ': () => setRevealed((r) => !r),
    enter: () => setRevealed((r) => !r),
    arrowright: () => setI((x) => Math.min(rows.length - 1, x + 1)),
    arrowleft: () => setI((x) => Math.max(0, x - 1)),
    j: () => setI((x) => Math.min(rows.length - 1, x + 1)),
    k: () => setI((x) => Math.max(0, x - 1)),
    r: () => { setI(0); setRevealed(false); },
    escape: () => { window.location.hash = '/errors'; },
  });

  if (!data) return <Empty>Loading…</Empty>;
  if (rows.length === 0) {
    return <Empty>No triaged errors yet. Diagnose some entries in the triage queue first.</Empty>;
  }
  if (!row) return <Empty>Nothing here.</Empty>;

  return (
    <div className="flex min-h-[78vh] flex-col">
      <div className="num flex items-baseline justify-between border-b border-rule pb-2 text-[11px] text-ink-muted">
        <span>
          {i + 1} / {rows.length}
        </span>
        <span>space reveal · J/K move · R restart · esc exit</span>
      </div>

      <div className="flex flex-1 flex-col justify-center py-8">
        <div className="mx-auto w-full max-w-3xl">
          <div className="num flex flex-wrap items-baseline gap-x-4 text-[11px] text-ink-muted">
            <span className="text-base font-semibold text-ink">
              {row.source_label} {row.source_q_no ?? ''}
            </span>
            <span>{row.qtype}</span>
            <span>{marks(row.marks)} marks</span>
            {row.error_name &&
              (row.is_procedural ? <Procedural>{row.error_name}</Procedural> : <span>{row.error_name}</span>)}
            <span className="ml-auto">lost {marks(row.marks_lost)}</span>
          </div>

          {row.paraphrase && <p className="mt-5 text-lg leading-relaxed">{row.paraphrase}</p>}

          <div className="mt-6 border-l-2 border-rule pl-4">
            <div className="text-[10px] tracking-[0.16em] text-ink-muted uppercase">
              What I thought at the time
            </div>
            <p className="mt-1 text-[15px] leading-relaxed">{row.what_i_thought || '—'}</p>
          </div>

          {revealed ? (
            <div className="mt-5 space-y-4 motion-safe:animate-none">
              <div className="border-l-2 border-ink pl-4">
                <div className="text-[10px] tracking-[0.16em] text-ink-muted uppercase">
                  The step where it broke
                </div>
                <p className="mt-1 text-[15px] leading-relaxed">{row.broke_at_step || '—'}</p>
              </div>
              <div className="border-l-2 border-ink bg-panel py-2 pl-4">
                <div className="text-[10px] tracking-[0.16em] text-ink-muted uppercase">
                  The rule that prevents it
                </div>
                <p className="mt-1 text-[15px] leading-relaxed font-medium">
                  {row.prevention_rule || '—'}
                </p>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setRevealed(true)}
              className="mt-6 w-full border border-dashed border-rule py-8 text-[11px] tracking-[0.16em] text-ink-muted uppercase hover:border-ink hover:text-ink"
            >
              Recall the repair, then press space
            </button>
          )}
        </div>
      </div>

      <div className="h-1 w-full bg-ground">
        <div
          className="h-full bg-ink motion-safe:transition-[width] motion-safe:duration-200"
          style={{ width: `${((i + 1) / rows.length) * 100}%` }}
        />
      </div>
    </div>
  );
}
