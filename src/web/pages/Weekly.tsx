/**
 * M9 — Weekly review. One page, five minutes.
 *
 * Markdown export is a link to the API; PDF comes from the browser's print
 * pipeline via the print stylesheet — offline, no dependency, and a real PDF.
 */

import type { WeeklyReport } from '../../shared/types.ts';
import { marks, pct, useApi } from '../lib.ts';
import { Button, Empty, Metric, Panel, Procedural, Status, Table, Td } from '../ui.tsx';

export function Weekly(): React.ReactElement {
  const { data } = useApi<WeeklyReport>('/weekly');
  if (!data) return <Empty>Loading…</Empty>;

  const delta =
    data.procedural.current !== null && data.procedural.previous !== null
      ? (data.procedural.current - data.procedural.previous) * 100
      : null;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between print:hidden">
        <h1 className="num text-sm tracking-[0.16em] uppercase">
          Week of {data.weekStart} — {data.weekEnd}
        </h1>
        <div className="flex gap-2">
          <Button onClick={() => window.open('/api/weekly.md', '_blank')}>Export Markdown</Button>
          <Button onClick={() => window.print()}>Print / save as PDF</Button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <Panel label="Procedural error share">
          <Metric
            label="this week"
            value={pct(data.procedural.current)}
            size="xl"
            alarm={data.procedural.current !== null}
            sub={
              <>
                last week {pct(data.procedural.previous)}
                {delta !== null && (
                  <>
                    {' · '}
                    {delta <= 0 ? '' : '+'}
                    {delta.toFixed(1)} pts
                  </>
                )}
                {' · 8wk '}
                {data.procedural.direction}
              </>
            }
          />
        </Panel>

        <Panel label="Attack next week" right="chosen by damage">
          {data.attack ? (
            <>
              <div className="text-2xl font-medium">
                {data.attack.isProcedural ? (
                  <Procedural>{data.attack.name}</Procedural>
                ) : (
                  data.attack.name
                )}
              </div>
              <p className="num mt-1 text-[12px] text-ink-muted">
                {marks(data.attack.marksLost)} marks across {data.attack.occurrences} question(s) ·{' '}
                {pct(data.attack.shareOfLoss, 0)} of everything lost
              </p>
              <p className="mt-2 border-t border-rule pt-2 text-[11px] leading-relaxed text-ink-muted">
                Selected by marks lost, not by how it felt. If nothing leaked this week the window
                widens to 28 days rather than reporting no target — a quiet week is not proof a
                leak is closed.
              </p>
            </>
          ) : (
            <Empty>Nothing triaged in the window. Log some work.</Empty>
          )}
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Panel label="Gate">
          {data.gate ? (
            <>
              <Status status={data.gate.status} />
              <p className="mt-1 text-[12px] font-medium">{data.gate.label}</p>
              <p className="mt-1 text-[11px] leading-snug text-ink-muted">{data.gate.detail}</p>
            </>
          ) : (
            <Empty>No gate in this phase.</Empty>
          )}
        </Panel>

        <Panel label="Hours">
          <Metric
            label="logged"
            value={data.hours.logged.toFixed(1)}
            size="lg"
            sub={`target ${data.hours.min}–${data.hours.max}`}
          />
          <div className="mt-2 h-1.5 w-full bg-ground">
            <div
              className="h-full bg-ink"
              style={{ width: `${Math.min(100, (data.hours.logged / data.hours.max) * 100)}%` }}
            />
          </div>
        </Panel>

        <Panel label="Mocks this week">
          {data.mocks.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <ul className="num space-y-1 text-[12px]">
              {data.mocks.map((m) => (
                <li key={m.date} className="flex justify-between">
                  <span className="text-ink-muted">{m.date}</span>
                  <span>
                    {marks(m.score)}
                    {!m.at0930 && <Procedural> off-window</Procedural>}
                    <span className="text-ink-muted"> {m.environment}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel label="Leak table">
          {data.leak.filter((l) => l.occurrences > 0).length === 0 ? (
            <Empty>Nothing lost this week.</Empty>
          ) : (
            <Table head={['Class', 'Proc', 'Count', 'Marks', 'Share']}>
              {data.leak
                .filter((l) => l.occurrences > 0)
                .map((l) => (
                  <tr key={l.errorClassId} className="border-b border-rule last:border-0">
                    <Td align="left">
                      {l.isProcedural ? <Procedural>{l.name}</Procedural> : l.name}
                    </Td>
                    <Td>{l.isProcedural ? 'yes' : 'no'}</Td>
                    <Td>{l.occurrences}</Td>
                    <Td>{marks(l.marksLost)}</Td>
                    <Td>{pct(l.shareOfLoss, 0)}</Td>
                  </tr>
                ))}
            </Table>
          )}
        </Panel>

        <Panel label="Rung progress">
          <Table head={['Rung', 'Fill', 'Change']}>
            {data.rungDelta
              .filter((r) => r.ordinal > 0)
              .map((r) => {
                const change = (r.fill - r.previousFill) * 100;
                return (
                  <tr key={r.ordinal} className="border-b border-rule last:border-0">
                    <Td align="left">
                      {r.ordinal}. {r.name}
                    </Td>
                    <Td>{pct(r.fill, 0)}</Td>
                    <Td className={change > 0 ? 'font-semibold' : change < 0 ? 'text-procedural' : 'text-ink-muted'}>
                      {change >= 0 ? '+' : ''}
                      {change.toFixed(0)} pts
                    </Td>
                  </tr>
                );
              })}
          </Table>
        </Panel>
      </div>

      <Panel label="Subject accuracy">
        {data.subjectAccuracy.length === 0 ? (
          <Empty>No triaged work this week.</Empty>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {data.subjectAccuracy.map((s) => (
              <div key={s.subject} className="flex items-center gap-2">
                <span className="w-40 shrink-0 truncate text-[12px]">{s.subject}</span>
                <div className="h-4 flex-1 bg-ground">
                  <div
                    className="h-full bg-ink"
                    style={{ width: `${Math.round(s.accuracy * 100)}%` }}
                  />
                </div>
                <span className="num w-10 text-right text-[11px]">{pct(s.accuracy, 0)}</span>
                <span className="num w-12 text-right text-[11px] text-procedural">
                  {marks(s.marksLost)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
