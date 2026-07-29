/**
 * M1 — Command deck. One screen, no scrolling on a laptop.
 *
 * The Ladder takes the full-height left rail; everything else is a dense
 * field of small panels. The procedural share is the largest number on the
 * page after the Ladder, because it is the metric decisions are made on.
 */

import type { DeckDto } from '../../shared/types.ts';
import { days, marks, pct, useApi } from '../lib.ts';
import { Ladder } from '../Ladder.tsx';
import { Empty, Metric, Panel, Sparkline, Status } from '../ui.tsx';

export function Deck({ navigate }: { navigate: (to: string) => void }): React.ReactElement {
  const { data, error } = useApi<DeckDto>('/deck');

  if (error) return <Empty>Deck unavailable: {error}</Empty>;
  if (!data) return <Empty>Loading the deck…</Empty>;

  const d = data;
  const alarm = d.countdown.find((c) => c.alarm);

  return (
    <div className="space-y-3">
      {d.unverified.length > 0 && (
        <p className="border border-procedural bg-panel px-3 py-2 text-[12px] text-procedural">
          Unverified against the GATE 2027 brochure: <strong>{d.unverified.join(', ')}</strong>. Check
          the official brochure before Phase 3 — these drive every score on this page.
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(420px,1fr)_minmax(0,1.05fr)]">
        <Panel label="The Ladder" right={`baseline ${marks(d.ladder.baselineScore)}`} className="min-h-[460px]">
          <div className="h-[400px]">
            <Ladder
              baselineScore={d.ladder.baselineScore}
              targetScore={d.ladder.targetScore}
              rungs={d.ladder.rungs}
              recoverableScore={d.ladder.recoverableScore}
            />
          </div>
        </Panel>

        <div className="space-y-3">
          <Panel
            label="Procedural error share"
            right={`${d.procedural.sampleSize} triaged · 8wk`}
          >
            <div className="flex items-end justify-between gap-4">
              <div>
                <div
                  className={`num text-6xl leading-none font-medium tabular-nums ${
                    d.procedural.current === null ? 'text-ink-muted' : 'text-procedural'
                  }`}
                >
                  {pct(d.procedural.current)}
                </div>
                <div className="num mt-1.5 text-[11px] text-ink-muted">
                  baseline {pct(d.procedural.baseline, 0)} · {d.procedural.direction}
                  {d.procedural.current !== null && (
                    <> · {marks(d.procedural.proceduralMarksLost)} of {marks(d.procedural.marksLost)} marks</>
                  )}
                </div>
              </div>
              <Sparkline
                values={d.procedural.series.map((p) => p.share)}
                baseline={d.procedural.baseline}
                width={200}
                height={48}
              />
            </div>
            {d.procedural.current === null && (
              <p className="mt-2 border-t border-rule pt-2 text-[11px] text-ink-muted">
                No triaged losses in the window. The number stays blank rather than showing 0% —
                an empty log is not a clean one.
              </p>
            )}
          </Panel>

          <div className="grid gap-3 sm:grid-cols-2">
            <Panel label="Phase">
              {d.phase ? (
                <>
                  <Metric
                    label={`Phase ${d.phase.ordinal}`}
                    value={d.phase.daysRemaining === null ? '—' : days(d.phase.daysRemaining)}
                    sub={d.phase.name}
                    size="md"
                  />
                  <div className="mt-2 border-t border-rule pt-2">
                    <Status status={d.phase.gateStatus} />
                    <p className="mt-1 text-[11px] leading-snug text-ink-muted">{d.phase.gateDetail}</p>
                  </div>
                </>
              ) : (
                <Empty>No phase configured.</Empty>
              )}
            </Panel>

            <Panel label={alarm ? 'Registration — act' : 'Next hard date'}>
              {d.countdown.slice(0, 3).map((c) => (
                <div key={c.label} className="flex items-baseline justify-between border-b border-rule py-1 last:border-0">
                  <span className={`text-[11px] ${c.alarm ? 'font-semibold text-procedural' : 'text-ink-muted'}`}>
                    {c.alarm && '● '}
                    {c.label}
                  </span>
                  <span className={`num text-sm tabular-nums ${c.alarm ? 'text-procedural' : ''}`}>
                    {days(c.daysRemaining)}
                  </span>
                </div>
              ))}
              {alarm && (
                <button
                  onClick={() => navigate('/settings')}
                  className="mt-2 w-full border border-procedural px-2 py-1 text-[10px] tracking-wide text-procedural uppercase"
                >
                  Mark registration done
                </button>
              )}
            </Panel>

            <Panel label="Mock average" right={`last ${Math.min(3, d.mocks.count)} of ${d.mocks.count}`}>
              <Metric
                label="rolling"
                value={marks(d.mocks.rollingAverage)}
                size="lg"
                sub={
                  d.mocks.gateThreshold !== null
                    ? `gate ≥ ${marks(d.mocks.gateThreshold)}`
                    : 'no gate active'
                }
              />
              <div className="num mt-2 space-y-0.5 border-t border-rule pt-2 text-[10px] text-ink-muted">
                <div>home − away {d.mocks.homeAwayDelta === null ? '—' : marks(d.mocks.homeAwayDelta)}</div>
                <div>09:30 − off-window {d.mocks.at0930Delta === null ? '—' : marks(d.mocks.at0930Delta)}</div>
              </div>
            </Panel>

            <Panel label="Weekly hours" right={`from ${d.hours.weekStart}`}>
              <Metric
                label="logged"
                value={d.hours.logged.toFixed(1)}
                size="lg"
                sub={`target ${d.hours.min}–${d.hours.max}`}
              />
              <div className="mt-2 h-1.5 w-full bg-ground">
                <div
                  className="h-full bg-ink"
                  style={{ width: `${Math.min(100, (d.hours.logged / d.hours.max) * 100)}%` }}
                />
              </div>
            </Panel>
          </div>

          <Panel label="Today">
            <div className="grid grid-cols-3 gap-3 border-b border-rule pb-3">
              <button onClick={() => navigate('/cards')} className="text-left">
                <Metric label="Cards due" value={String(d.today.dueCards)} size="md" />
              </button>
              <button onClick={() => navigate('/errors?triaged=false')} className="text-left">
                <Metric
                  label="Awaiting triage"
                  value={String(d.today.triageQueue)}
                  size="md"
                  alarm={d.today.triageQueue > 20}
                />
              </button>
              <button onClick={() => navigate('/pyq')} className="text-left">
                <Metric label="To re-attempt" value={String(d.today.reattempts)} size="md" />
              </button>
            </div>

            <div className="pt-3">
              <div className="text-[10px] tracking-[0.16em] text-ink-muted uppercase">
                Drill the app thinks you need
              </div>
              {d.today.recommendedDrill ? (
                <button
                  onClick={() => navigate('/drills?mode=rapid')}
                  className="mt-1 flex w-full items-baseline justify-between text-left"
                >
                  <span className="text-sm font-medium">{d.today.recommendedDrill.name}</span>
                  <span className="num text-[11px] text-procedural">
                    {marks(d.today.recommendedDrill.marksLost)} lost, 14d
                  </span>
                </button>
              ) : (
                <p className="mt-1 text-[12px] text-ink-muted">
                  Nothing has leaked in 14 days. Chosen by damage — no damage, no recommendation.
                </p>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
