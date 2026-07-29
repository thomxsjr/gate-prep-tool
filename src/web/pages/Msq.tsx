/**
 * M3 — MSQ verdict trainer (rung 1, +9 marks).
 *
 * Submit is disabled until EVERY option has an explicit True/False verdict
 * and a typed justification of at least 15 characters. No exceptions, no
 * bypass, no "skip justification" affordance — and the API enforces the same
 * rule, so the disabled button is not the only thing standing in the way.
 *
 * The money metric is the near-miss count: MSQs where all but one option
 * verdict was right and the question therefore scored zero.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MsqQuestion } from '../../shared/types.ts';
import { api, clock, pct, useApi, useSubmitShortcut, useTimer } from '../lib.ts';
import { Button, Empty, Metric, Panel, Procedural, Sparkline, Textarea } from '../ui.tsx';

interface Report {
  perOptionRight: number;
  perOptionTotal: number;
  perOptionAccuracy: number;
  questionsAttempted: number;
  questionAccuracy: number;
  nearMisses: number;
  trend: { date: string; accuracy: number; n: number }[];
}

interface Verdict {
  myVerdict: boolean | null;
  justification: string;
  seconds: number;
}

export function Msq(): React.ReactElement {
  const questions = useApi<MsqQuestion[]>('/msq/questions');
  const report = useApi<Report>('/msq/report');
  const [i, setI] = useState(0);
  const [state, setState] = useState<Record<number, Verdict>>({});
  const [result, setResult] = useState<{ right: number; total: number } | null>(null);

  const list = questions.data ?? [];
  const q = list[i];
  const elapsed = useTimer(q !== undefined && result === null);

  useEffect(() => {
    setState({});
    setResult(null);
  }, [i]);

  const verdicts = useMemo(() => (q ? q.options.map((o) => state[o.id]) : []), [q, state]);
  const ready =
    q !== undefined &&
    q.options.length > 0 &&
    verdicts.every((v) => v && v.myVerdict !== null && v.justification.trim().length >= 15);

  const submit = useCallback(async () => {
    if (!q || !ready || result !== null) return;
    const payload = {
      questionId: q.questionId,
      totalSeconds: elapsed,
      verdicts: q.options.map((o) => ({
        optionId: o.id,
        myVerdict: state[o.id]!.myVerdict!,
        justification: state[o.id]!.justification,
        seconds: state[o.id]!.seconds || 0,
      })),
    };
    await api('/msq/attempt', { method: 'POST', body: JSON.stringify(payload) });
    const right = q.options.filter((o) => state[o.id]!.myVerdict === o.is_correct).length;
    setResult({ right, total: q.options.length });
    report.reload();
  }, [q, ready, result, elapsed, state, report]);

  useSubmitShortcut(submit, ready && result === null);

  if (!questions.data) return <Empty>Loading…</Empty>;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="space-y-3">
        {list.length === 0 ? (
          <Panel label="MSQ trainer">
            <Empty>
              No MSQ questions with options yet. Import a paper, or add options to an MSQ in the
              error log.
            </Empty>
          </Panel>
        ) : (
          q && (
            <Panel
              label={`MSQ ${i + 1} of ${list.length}`}
              right={
                <span className={elapsed > q.options.length * q.perOptionBudgetSeconds ? 'text-procedural' : ''}>
                  {clock(elapsed)} / {clock(q.options.length * q.perOptionBudgetSeconds)}
                </span>
              }
            >
              <div className="num mb-3 flex flex-wrap items-baseline gap-x-4 text-[11px] text-ink-muted">
                <span className="text-sm font-semibold text-ink">
                  {q.sourceLabel} {q.sourceQNo ?? ''}
                </span>
                <span>{q.marks} marks</span>
                {q.subjectName && <span>{q.subjectName}</span>}
              </div>

              {q.paraphrase ? (
                <p className="mb-4 text-[15px] leading-relaxed">{q.paraphrase}</p>
              ) : (
                <p className="mb-4 text-[12px] text-ink-muted">
                  No paraphrase stored. Work from your own copy of the paper — question text is
                  never kept here.
                </p>
              )}

              <div className="space-y-2">
                {q.options.map((o) => {
                  const v = state[o.id] ?? { myVerdict: null, justification: '', seconds: 0 };
                  const decided = result !== null;
                  const wasRight = v.myVerdict === o.is_correct;
                  return (
                    <div
                      key={o.id}
                      className={`border p-2 ${
                        decided ? (wasRight ? 'border-ink' : 'border-procedural') : 'border-rule'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="num w-5 text-sm font-semibold">{o.label}</span>
                        {(['true', 'false'] as const).map((choice) => {
                          const on = v.myVerdict === (choice === 'true');
                          return (
                            <button
                              key={choice}
                              disabled={decided}
                              onClick={() =>
                                setState((s) => ({
                                  ...s,
                                  [o.id]: { ...v, myVerdict: choice === 'true', seconds: v.seconds || elapsed },
                                }))
                              }
                              className={`border px-2.5 py-0.5 text-[10px] tracking-wider uppercase ${
                                on ? 'border-ink bg-ink text-panel' : 'border-rule text-ink-muted hover:border-ink'
                              }`}
                            >
                              {choice}
                            </button>
                          );
                        })}
                        {o.paraphrase && <span className="truncate text-[12px]">{o.paraphrase}</span>}
                        {decided && (
                          <span className="num ml-auto text-[10px] text-ink-muted">
                            key: {o.is_correct ? 'true' : 'false'}
                          </span>
                        )}
                      </div>

                      <Textarea
                        rows={1}
                        disabled={decided}
                        value={v.justification}
                        onChange={(e) =>
                          setState((s) => ({ ...s, [o.id]: { ...v, justification: e.target.value } }))
                        }
                        placeholder="Why — at least 15 characters"
                        className="mt-1.5 text-[12px]"
                      />
                      <div className="num mt-0.5 text-right text-[10px] text-ink-muted">
                        {v.justification.trim().length}/15
                      </div>
                    </div>
                  );
                })}
              </div>

              {result ? (
                <div className="mt-3 border-t border-rule pt-3">
                  <p className="text-sm">
                    {result.right} of {result.total} option verdicts right.{' '}
                    {result.right === result.total ? (
                      <strong>Question scored {q.marks}.</strong>
                    ) : result.right === result.total - 1 ? (
                      <Procedural>
                        <strong>Near miss — one option wrong, so the question scored zero.</strong>
                      </Procedural>
                    ) : (
                      <span>Question scored zero.</span>
                    )}
                  </p>
                  <Button
                    variant="primary"
                    className="mt-3"
                    onClick={() => setI((x) => (x + 1) % list.length)}
                  >
                    Next MSQ
                  </Button>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-3 border-t border-rule pt-3">
                  <Button variant="primary" onClick={submit} disabled={!ready}>
                    Submit verdicts
                  </Button>
                  <span className="text-[11px] text-ink-muted">
                    {ready
                      ? '⌘↵ to submit'
                      : 'Every option needs a verdict and a 15-character justification'}
                  </span>
                </div>
              )}
            </Panel>
          )
        )}
      </div>

      <div className="space-y-3">
        <Panel label="Per-option accuracy" right="the real habit">
          <Metric
            label="options judged correctly"
            value={pct(report.data?.perOptionAccuracy ?? null)}
            size="xl"
            sub={
              report.data
                ? `${report.data.perOptionRight} of ${report.data.perOptionTotal} options`
                : undefined
            }
          />
          {report.data && report.data.trend.length > 1 && (
            <div className="mt-3 border-t border-rule pt-3">
              <Sparkline values={report.data.trend.map((t) => t.accuracy)} width={260} height={40} />
            </div>
          )}
        </Panel>

        <Panel label="Near misses" right="the money metric">
          <Metric
            label="3-of-4 right, scored zero"
            value={String(report.data?.nearMisses ?? 0)}
            size="lg"
            alarm={(report.data?.nearMisses ?? 0) > 0}
            sub="Question-level accuracy hides these entirely."
          />
          <div className="num mt-3 grid grid-cols-2 gap-3 border-t border-rule pt-3 text-[11px]">
            <div>
              <div className="text-ink-muted">Question accuracy</div>
              <div className="text-lg">{pct(report.data?.questionAccuracy ?? null)}</div>
            </div>
            <div>
              <div className="text-ink-muted">Attempted</div>
              <div className="text-lg">{report.data?.questionsAttempted ?? 0}</div>
            </div>
          </div>
        </Panel>

        <Panel label="Why the justification is mandatory">
          <p className="text-[12px] leading-relaxed text-ink-muted">
            Rung 1 is worth <strong className="text-ink">+9 marks</strong> and requires no new
            subject knowledge. The habit being repaired is committing to an MSQ before every option
            has been judged, so the trainer makes that physically impossible rather than merely
            discouraged.
          </p>
        </Panel>
      </div>
    </div>
  );
}
