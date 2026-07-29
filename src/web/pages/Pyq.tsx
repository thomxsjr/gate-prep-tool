/**
 * M8 — PYQ tracker.
 *
 * First-attempt and re-attempt accuracy are reported separately and never
 * merged. Re-attempt accuracy is inflated by recall; treating the two as one
 * number would show progress that is really just memory of the answer.
 */

import type { AttemptRow, Subject } from '../../shared/types.ts';
import { marks, pct, useApi } from '../lib.ts';
import { Empty, Metric, Panel, Procedural, Table, Td } from '../ui.tsx';

interface Cell {
  sourceId: number;
  subjectId: number | null;
  total: number;
  triaged: number;
  correct: number;
  marksLost: number;
  lastTouched: string | null;
}

interface PyqDto {
  sources: { id: number; label: string; year: number | null }[];
  subjects: Subject[];
  cells: Cell[];
  split: { first: { n: number; correct: number }; repeat: { n: number; correct: number } };
  revisit: AttemptRow[];
}

export function Pyq({ navigate }: { navigate: (to: string) => void }): React.ReactElement {
  const { data } = useApi<PyqDto>('/pyq');
  if (!data) return <Empty>Loading…</Empty>;

  const cell = (sourceId: number, subjectId: number | null): Cell | undefined =>
    data.cells.find((c) => c.sourceId === sourceId && c.subjectId === subjectId);

  const firstAcc = data.split.first.n === 0 ? null : data.split.first.correct / data.split.first.n;
  const repeatAcc = data.split.repeat.n === 0 ? null : data.split.repeat.correct / data.split.repeat.n;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Panel label="First-attempt accuracy" right="the honest number">
          <Metric
            label={`${data.split.first.n} first attempts`}
            value={pct(firstAcc)}
            size="xl"
          />
        </Panel>
        <Panel label="Re-attempt accuracy" right="inflated by recall">
          <Metric
            label={`${data.split.repeat.n} re-attempts`}
            value={pct(repeatAcc)}
            size="xl"
          />
        </Panel>
        <Panel label="Why they stay apart">
          <p className="text-[12px] leading-relaxed text-ink-muted">
            A re-attempt measures memory of the answer as much as understanding. Averaging the two
            together would show progress that is really recall, which is exactly the confusion this
            split exists to prevent.
          </p>
        </Panel>
      </div>

      <Panel label="Coverage" right="papers × subjects">
        {data.sources.length === 0 ? (
          <Empty>No papers yet. Import a response sheet or capture entries against a source.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr>
                  <th className="border-b border-rule px-2 py-1.5 text-left text-[10px] tracking-[0.12em] text-ink-muted uppercase">
                    Paper
                  </th>
                  {data.subjects.map((s) => (
                    <th
                      key={s.id}
                      className="border-b border-rule px-1 py-1.5 text-center text-[9px] tracking-wider text-ink-muted uppercase"
                      title={s.name}
                    >
                      {s.code}
                    </th>
                  ))}
                  <th className="border-b border-rule px-2 py-1.5 text-right text-[10px] tracking-[0.12em] text-ink-muted uppercase">
                    Last
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((src) => {
                  const touched = data.cells
                    .filter((c) => c.sourceId === src.id && c.lastTouched)
                    .map((c) => c.lastTouched!)
                    .sort()
                    .at(-1);
                  return (
                    <tr key={src.id} className="border-b border-rule last:border-0">
                      <td className="px-2 py-1.5 whitespace-nowrap">{src.label}</td>
                      {data.subjects.map((s) => {
                        const c = cell(src.id, s.id);
                        if (!c || c.total === 0) {
                          return (
                            <td key={s.id} className="px-1 py-1.5 text-center text-ink-muted">
                              ·
                            </td>
                          );
                        }
                        const acc = c.triaged === 0 ? null : c.correct / c.triaged;
                        return (
                          <td key={s.id} className="px-1 py-1.5 text-center">
                            <div
                              className="num mx-auto flex h-6 w-9 items-center justify-center text-[10px]"
                              style={{
                                background:
                                  acc === null
                                    ? 'transparent'
                                    : `color-mix(in srgb, var(--color-ink) ${Math.round(acc * 70)}%, transparent)`,
                                color: acc !== null && acc > 0.6 ? 'var(--color-panel)' : undefined,
                              }}
                              title={`${c.total} questions · ${c.correct}/${c.triaged} correct · ${marks(c.marksLost)} lost`}
                            >
                              {acc === null ? c.total : pct(acc, 0)}
                            </div>
                          </td>
                        );
                      })}
                      <td className="num px-2 py-1.5 text-right text-ink-muted">
                        {touched ? touched.slice(0, 10) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 border-t border-rule pt-2 text-[10px] text-ink-muted">
          Ink density is accuracy. A bare number means questions exist but none are triaged yet.
        </p>
      </Panel>

      <Panel label="Revisit queue" right={`${data.revisit.length}`}>
        {data.revisit.length === 0 ? (
          <Empty>Nothing to revisit. Wrong and guessed-correct questions resurface here.</Empty>
        ) : (
          <Table head={['Question', 'Type', 'Marks', 'Outcome', 'Class', 'Last seen']}>
            {data.revisit.map((r) => (
              <tr key={r.id} className="border-b border-rule last:border-0 hover:bg-ground">
                <Td align="left" className="max-w-[240px] truncate">
                  {r.source_label} {r.source_q_no ?? ''}
                </Td>
                <Td>{r.qtype}</Td>
                <Td>{marks(r.marks)}</Td>
                <Td>{r.outcome ?? 'undetermined'}</Td>
                <Td align="left" className="max-w-[180px] truncate">
                  {r.error_name ? (
                    r.is_procedural ? <Procedural>{r.error_name}</Procedural> : r.error_name
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </Td>
                <Td className="text-ink-muted">{r.attempted_at.slice(0, 10)}</Td>
              </tr>
            ))}
          </Table>
        )}
        <div className="mt-3 border-t border-rule pt-3">
          <button
            onClick={() => navigate('/errors?triaged=false')}
            className="text-[11px] underline underline-offset-2"
          >
            Open the triage queue
          </button>
        </div>
      </Panel>
    </div>
  );
}
