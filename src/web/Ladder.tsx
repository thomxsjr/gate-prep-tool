/**
 * The Ladder — the signature element.
 *
 * A vertical scale from the baseline to 100. Rung HEIGHT is proportional to
 * its mark swing, so a +12 rung is visibly taller than a +9 one: height is
 * data, not decoration.
 *
 * Each rung fills with INK as its error class stops appearing in recent work.
 * The un-closed remainder of a PROCEDURAL rung renders in the one hue the app
 * reserves for process failure. So the column is ink rising through red, and
 * winning looks like the red draining out of the top.
 *
 * This is the only place in the application that animates, and only when a
 * fill actually changes.
 */

import { useEffect, useRef, useState } from 'react';
import type { RungFillDto } from '../shared/types.ts';
import { marks } from './lib.ts';

interface Props {
  baselineScore: number;
  targetScore: number;
  rungs: RungFillDto[];
  recoverableScore: number;
}

export function Ladder({ baselineScore, targetScore, rungs, recoverableScore }: Props): React.ReactElement {
  const working = rungs.filter((r) => r.marksSwing > 0).sort((a, b) => a.ordinal - b.ordinal);
  const top = working.at(-1)?.cumulativeScore ?? 100;
  const span = top - baselineScore;

  return (
    <div className="flex h-full gap-3">
      <Scale baselineScore={baselineScore} top={top} rungs={working} targetScore={targetScore} />

      <div className="flex min-w-0 flex-1 flex-col-reverse">
        {working.map((r) => (
          <Rung key={r.ordinal} rung={r} heightPct={(r.marksSwing / span) * 100} />
        ))}
      </div>

      <div className="flex w-28 shrink-0 flex-col justify-end pb-1 text-right">
        <div className="text-[10px] tracking-[0.14em] text-ink-muted uppercase">Recoverable</div>
        <div className="num text-3xl leading-none font-medium">{marks(recoverableScore)}</div>
        <div className="mt-1 text-[10px] leading-snug text-ink-muted">
          on the 2026 paper, if every filled rung held. Not a forecast.
        </div>
      </div>
    </div>
  );
}

function Scale({
  baselineScore,
  top,
  rungs,
  targetScore,
}: {
  baselineScore: number;
  top: number;
  rungs: RungFillDto[];
  targetScore: number;
}): React.ReactElement {
  const span = top - baselineScore;
  const pos = (score: number): number => ((score - baselineScore) / span) * 100;

  return (
    <div className="relative w-12 shrink-0 border-r border-rule">
      {[{ score: baselineScore, label: marks(baselineScore) }, ...rungs.map((r) => ({
        score: r.cumulativeScore,
        label: marks(r.cumulativeScore),
      }))].map((t) => (
        <div
          key={t.score}
          className="absolute right-1 flex translate-y-1/2 items-center gap-1"
          style={{ bottom: `${pos(t.score)}%` }}
        >
          <span className="num text-[10px] text-ink-muted tabular-nums">{t.label}</span>
          <span className="block h-px w-1.5 bg-rule" />
        </div>
      ))}

      {/* Target line: the score that actually matters. */}
      <div
        className="absolute right-0 left-0 border-t border-dashed border-ink"
        style={{ bottom: `${pos(targetScore)}%` }}
      >
        <span className="num absolute -top-3.5 left-0 bg-panel pr-1 text-[9px] font-semibold tracking-wider uppercase">
          target {marks(targetScore)}
        </span>
      </div>
    </div>
  );
}

function Rung({ rung, heightPct }: { rung: RungFillDto; heightPct: number }): React.ReactElement {
  const fillPct = Math.round(rung.fill * 100);
  const animate = useFillAnimation(rung.fill);

  return (
    <div
      className="relative flex min-h-[44px] items-stretch border-t border-rule first:border-t-0"
      style={{ height: `${heightPct}%` }}
    >
      {/* The bar. Ink is closed; the remainder of a procedural rung is the hue.
          A rung with too little recent work behind it is NOT painted red —
          red asserts measured leakage, and asserting it from four questions
          would be the same lie as reporting a share of 0% for an empty log.
          Unknown is hatched neutral. */}
      <div
        className={`relative w-16 shrink-0 overflow-hidden border-r border-rule ${
          rung.isProcedural && !rung.insufficientData ? 'bg-procedural' : 'bg-ground'
        }`}
      >
        <div
          className="absolute inset-x-0 bottom-0 bg-ink motion-safe:transition-[height] motion-safe:duration-500 motion-safe:ease-out"
          style={{ height: `${fillPct}%`, transitionDuration: animate ? undefined : '0ms' }}
        />
        {rung.insufficientData && (
          <div
            className="absolute inset-0"
            aria-label="not enough recent work to judge"
            style={{
              backgroundImage:
                'repeating-linear-gradient(45deg, transparent 0 4px, var(--color-rule) 4px 5px)',
            }}
          />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center px-3 py-1">
        <div className="flex items-baseline gap-2">
          <span className="num text-[11px] text-ink-muted">{rung.ordinal}</span>
          <span className="truncate text-[13px] leading-tight font-medium">{rung.name}</span>
          <span className="num ml-auto shrink-0 text-[11px] text-ink-muted">
            +{marks(rung.marksSwing)}
          </span>
        </div>

        <div className="num mt-0.5 flex items-baseline gap-3 text-[10px] text-ink-muted">
          <span className="tabular-nums">{fillPct}% closed</span>
          {rung.insufficientData ? (
            <span>too little recent work to judge</span>
          ) : rung.incidencePer100 !== null ? (
            <span className="tabular-nums">
              {rung.incidencePer100.toFixed(1)} per 100 · n={rung.sampleSize}
            </span>
          ) : (
            <span className="tabular-nums">
              {rung.itemsClosed}/{rung.itemsTarget} items
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Animate only when the value actually changes, never on first paint. */
function useFillAnimation(fill: number): boolean {
  const previous = useRef<number | null>(null);
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    if (previous.current !== null && previous.current !== fill) setAnimate(true);
    previous.current = fill;
  }, [fill]);

  return animate;
}
