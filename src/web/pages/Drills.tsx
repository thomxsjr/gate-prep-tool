/**
 * M4 — Boundary drill (rung 2, +12 marks).
 *
 * Rapid fire: one question, a hard timer, immediate verdict, next. Every
 * wrong answer auto-creates an error-log entry tagged to the boundary class,
 * with context 'drill' — which the procedural-share metric excludes by
 * construction, so practising cannot flatter the number.
 *
 * Drills are seeded, so any question can be replayed exactly from its stored
 * template key and seed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, clock, pct, useApi, useTimer } from '../lib.ts';
import { Button, Empty, Metric, Panel, Procedural, Select, Table, Td } from '../ui.tsx';

interface Template {
  key: string;
  name: string;
  trap: string;
  timeBudgetSeconds: number;
  answerKind: 'integer' | 'number';
}

interface Drill {
  templateKey: string;
  templateName: string;
  seed: number;
  prompt: string;
  params: Record<string, number | string>;
  answerKind: 'integer' | 'number';
  timeBudgetSeconds: number;
}

interface Verdict {
  correct: boolean;
  expected: string;
  trap: string;
  attemptId: number | null;
}

export function Drills(): React.ReactElement {
  const templates = useApi<Template[]>('/drills/templates');
  const stats = useApi<{ templateKey: string; runs: number; correct: number; avgSeconds: number }[]>(
    '/drills/stats',
  );
  const [pick, setPick] = useState('');
  const [drill, setDrill] = useState<Drill | null>(null);
  const [answer, setAnswer] = useState('');
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [session, setSession] = useState({ asked: 0, right: 0 });
  const input = useRef<HTMLInputElement>(null);

  const elapsed = useTimer(drill !== null && verdict === null);
  const overBudget = drill !== null && elapsed > drill.timeBudgetSeconds;

  const next = useCallback(async () => {
    const q = pick ? `?template=${pick}` : '';
    const d = await api<Drill>(`/drills/generate${q}`);
    setDrill(d);
    setAnswer('');
    setVerdict(null);
    setTimeout(() => input.current?.focus(), 0);
  }, [pick]);

  const submit = useCallback(async () => {
    if (!drill || verdict !== null || answer.trim() === '') return;
    const v = await api<Verdict>('/drills/answer', {
      method: 'POST',
      body: JSON.stringify({
        templateKey: drill.templateKey,
        seed: drill.seed,
        given: answer,
        seconds: elapsed,
      }),
    });
    setVerdict(v);
    setSession((s) => ({ asked: s.asked + 1, right: s.right + (v.correct ? 1 : 0) }));
    stats.reload();
  }, [drill, verdict, answer, elapsed, stats]);

  useEffect(() => {
    if (templates.data && drill === null) void next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.data]);

  if (!templates.data) return <Empty>Loading…</Empty>;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="space-y-3">
        <Panel
          label="Rapid fire"
          right={
            drill && (
              <span className={overBudget ? 'text-procedural' : ''}>
                {clock(elapsed)} / {clock(drill.timeBudgetSeconds)}
              </span>
            )
          }
        >
          <div className="mb-3 flex items-center gap-2">
            <Select value={pick} onChange={(e) => setPick(e.target.value)} className="max-w-xs">
              <option value="">Mixed — all templates</option>
              {templates.data.map((t) => (
                <option key={t.key} value={t.key}>{t.name}</option>
              ))}
            </Select>
            <span className="num text-[11px] text-ink-muted">
              {session.right}/{session.asked} this session
            </span>
          </div>

          {drill && (
            <>
              <div className="num mb-2 flex items-baseline justify-between text-[10px] text-ink-muted">
                <span className="tracking-[0.16em] uppercase">{drill.templateName}</span>
                <span>seed {drill.seed}</span>
              </div>

              <p className="border-y border-rule py-5 font-mono text-[15px] leading-relaxed whitespace-pre-wrap">
                {drill.prompt}
              </p>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (verdict === null) void submit();
                  else void next();
                }}
                className="mt-3 flex items-center gap-2"
              >
                <input
                  ref={input}
                  autoFocus
                  inputMode="numeric"
                  value={answer}
                  disabled={verdict !== null}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="Answer"
                  className="num w-40 border border-rule bg-ground px-2 py-1.5 text-lg outline-none focus:border-ink disabled:opacity-60"
                />
                <Button variant="primary" type="submit">
                  {verdict === null ? 'Check' : 'Next'}
                </Button>
                {verdict === null && <span className="text-[11px] text-ink-muted">↵ to check</span>}
              </form>

              {verdict && (
                <div className="mt-3 border-t border-rule pt-3">
                  <p className="text-sm">
                    {verdict.correct ? (
                      <strong>Correct.</strong>
                    ) : (
                      <Procedural>
                        <strong>Wrong — the answer is {verdict.expected}.</strong>
                      </Procedural>
                    )}
                  </p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">
                    <span className="tracking-[0.16em] uppercase">The trap · </span>
                    {verdict.trap}
                  </p>
                  {verdict.attemptId !== null && (
                    <p className="num mt-1.5 text-[11px] text-ink-muted">
                      Logged to the error log as a boundary error (#{verdict.attemptId}). Drill rows
                      never enter the procedural share.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </Panel>
      </div>

      <div className="space-y-3">
        <Panel label="This session">
          <Metric
            label="accuracy"
            value={session.asked === 0 ? '—.—%' : pct(session.right / session.asked)}
            size="lg"
            sub={`${session.asked} asked`}
          />
        </Panel>

        <Panel label="By template" right={`${templates.data.length} templates`}>
          {!stats.data || stats.data.length === 0 ? (
            <Empty>No runs yet.</Empty>
          ) : (
            <Table head={['Template', 'Runs', 'Right', 'Avg s']}>
              {stats.data.map((s) => {
                const t = templates.data!.find((x) => x.key === s.templateKey);
                const acc = s.runs === 0 ? 0 : s.correct / s.runs;
                return (
                  <tr key={s.templateKey} className="border-b border-rule last:border-0">
                    <Td align="left" className="max-w-[180px] truncate">
                      {t?.name ?? s.templateKey}
                    </Td>
                    <Td>{s.runs}</Td>
                    <Td className={acc < 0.7 ? 'text-procedural' : ''}>{pct(acc, 0)}</Td>
                    <Td>{s.avgSeconds?.toFixed(0) ?? '—'}</Td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Panel>

        <Panel label="Add your own">
          <p className="text-[12px] leading-relaxed text-ink-muted">
            Templates live in <code className="text-ink">src/domain/drills.ts</code> with a
            documented interface. A template plus a seed always regenerates the same question, so
            any drill in the history can be replayed exactly.
          </p>
        </Panel>
      </div>
    </div>
  );
}
