/**
 * M7 — Calibration and attempt policy.
 *
 * Overconfidence and underconfidence are different diseases, so the curve is
 * plotted against the diagonal and the bias carries a sign.
 *
 * The EV arithmetic is shown rather than asserted, because the folk rule it
 * replaces ("only attempt above 70% confidence") is expensive: MCQ breakeven
 * is exactly 0.25 at both weights, so a blind four-option guess is EV-neutral
 * and eliminating even one option makes it positive.
 */

import type { CalibrationDto } from '../../shared/types.ts';
import { marks, pct, useApi } from '../lib.ts';
import { Empty, Metric, Panel, Procedural, Table, Td } from '../ui.tsx';

export function Calibration(): React.ReactElement {
  const { data } = useApi<CalibrationDto>('/calibration');
  if (!data) return <Empty>Loading…</Empty>;

  const disease =
    Math.abs(data.bias) < 0.03 ? 'calibrated' : data.bias > 0 ? 'overconfident' : 'underconfident';

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel label="Calibration curve" right={`n=${data.n}`}>
          <Curve data={data} />
          {!data.sufficient && (
            <p className="mt-2 border-t border-rule pt-2 text-[11px] text-ink-muted">
              Below {data.minSampleSize} observations the curve is noise. Until then the EV
              threshold falls back to stated confidence and says so, rather than inventing a
              correction.
            </p>
          )}
        </Panel>

        <div className="space-y-3">
          <Panel label="Which disease">
            <Metric
              label="bias — stated minus observed"
              value={`${data.bias >= 0 ? '+' : ''}${(data.bias * 100).toFixed(1)}`}
              size="xl"
              sub={
                <>
                  {disease}
                  {data.sufficient ? '' : ' · not enough data to correct with'}
                </>
              }
            />
            <div className="num mt-3 grid grid-cols-2 gap-3 border-t border-rule pt-3 text-[11px]">
              <div>
                <div className="text-ink-muted">Brier score</div>
                <div className="text-lg">{data.brier.toFixed(3)}</div>
                <div className="text-[10px] text-ink-muted">0.250 = always saying 50%</div>
              </div>
              <div>
                <div className="text-ink-muted">Observations</div>
                <div className="text-lg">{data.n}</div>
                <div className="text-[10px] text-ink-muted">needs {data.minSampleSize}</div>
              </div>
            </div>
          </Panel>

          <Panel label="Net effect of attempt decisions">
            <Metric
              label="gained minus forgone"
              value={`${data.netPolicy.net >= 0 ? '+' : ''}${marks(data.netPolicy.net)}`}
              size="lg"
              sub={`gained ${marks(data.netPolicy.gained)} · forgone ${marks(data.netPolicy.forgone)}`}
            />
            <p className="mt-2 border-t border-rule pt-2 text-[11px] leading-relaxed text-ink-muted">
              Forgone counts positive-expectation questions that were skipped. A negative net
              means the attempt policy is costing marks.
            </p>
          </Panel>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Panel label="Discipline violations" right={`${data.violations.length}`}>
          {data.violations.length === 0 ? (
            <Empty>No violations recorded. Blank MSQ/NAT answers and below-EV MCQ attempts appear here.</Empty>
          ) : (
            <Table head={['Question', 'Kind', 'Marks', 'Cost']}>
              {data.violations.slice(0, 40).map((v, i) => (
                <tr key={i} className="border-b border-rule last:border-0">
                  <Td align="left">{v.sourceQNo ?? '—'}</Td>
                  <Td align="left">
                    <Procedural>{v.kind.replace(/_/g, ' ')}</Procedural>
                  </Td>
                  <Td>{marks(v.marks)}</Td>
                  <Td>{marks(v.cost)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        <Panel label="The EV arithmetic">
          <div className="space-y-3 text-[12px] leading-relaxed">
            <div>
              <div className="text-[10px] tracking-[0.16em] text-ink-muted uppercase">MCQ breakeven</div>
              <pre className="num mt-1 overflow-x-auto border border-rule bg-ground p-2 text-[11px]">
{`EV(p) = p·m − (1−p)·(m/3)
      = 0   ⇒   3p = 1 − p   ⇒   p = 1/4`}
              </pre>
              <p className="mt-1 text-ink-muted">
                The marks cancel. Breakeven is <strong className="text-ink">0.25</strong> for a
                1-mark and a 2-mark MCQ alike, because the penalty scales with the reward.
              </p>
            </div>

            <Table head={['Eliminated', 'p', 'EV per mark']}>
              {[
                [0, 1 / 4, 0],
                [1, 1 / 3, 1 / 9],
                [2, 1 / 2, 1 / 3],
              ].map(([e, p, ev]) => (
                <tr key={e as number} className="border-b border-rule last:border-0">
                  <Td align="left">{e as number} of 4</Td>
                  <Td>{(p as number).toFixed(3)}</Td>
                  <Td className={(ev as number) > 0 ? 'font-semibold' : 'text-ink-muted'}>
                    {(ev as number) >= 0 ? '+' : ''}
                    {(ev as number).toFixed(3)}
                  </Td>
                </tr>
              ))}
            </Table>

            <p className="text-ink-muted">
              A blind four-option guess is <strong className="text-ink">exactly EV-neutral</strong>,
              not negative. Eliminate one option and it is positive. MSQ and NAT carry no negative
              marking at all, so leaving one blank is always a violation.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Curve({ data }: { data: CalibrationDto }): React.ReactElement {
  const size = 260;
  const pad = 28;
  const inner = size - pad * 2;
  const x = (v: number): number => pad + v * inner;
  const y = (v: number): number => size - pad - v * inner;

  const points = data.buckets.filter((b) => b.n > 0);

  return (
    <svg width="100%" viewBox={`0 0 ${size} ${size}`} className="max-w-[320px]" role="img">
      <rect x={pad} y={pad} width={inner} height={inner} fill="none" stroke="var(--color-rule)" />

      {/* Perfect calibration. */}
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--color-rule)" strokeDasharray="3 3" />

      {points.length > 1 && (
        <path
          d={points.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(b.statedMean)},${y(b.observed)}`).join(' ')}
          fill="none"
          stroke="var(--color-ink)"
          strokeWidth="1.5"
        />
      )}

      {points.map((b) => (
        <circle
          key={b.decile}
          cx={x(b.statedMean)}
          cy={y(b.observed)}
          r={Math.min(6, 2 + Math.sqrt(b.n))}
          fill="var(--color-ink)"
          opacity={0.85}
        />
      ))}

      <text x={pad} y={size - 8} className="num" fontSize="9" fill="var(--color-ink-muted)">
        stated confidence →
      </text>
      <text
        x={10}
        y={pad + 8}
        className="num"
        fontSize="9"
        fill="var(--color-ink-muted)"
        transform={`rotate(-90, 10, ${pad + 8})`}
      >
        observed accuracy →
      </text>
      <text x={x(0.02)} y={y(0.93)} className="num" fontSize="9" fill="var(--color-ink-muted)">
        above the line = underconfident
      </text>
      <text x={x(0.34)} y={y(0.06)} className="num" fontSize="9" fill="var(--color-ink-muted)">
        below = overconfident
      </text>
    </svg>
  );
}
