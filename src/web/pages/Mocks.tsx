/**
 * M6 — Mock import and blocking triage.
 *
 * Built as import + triage rather than a 3-hour exam simulator: the value is
 * in the analytics and the mandatory triage, not in reimplementing a question
 * palette and an on-screen calculator. A subtly wrong calculator would train
 * wrong keystroke habits — precisely the class of failure this app exists to
 * remove.
 *
 * The score is withheld until every wrong, skipped and guessed-correct
 * question carries an error class. The score is the reward for the triage.
 */

import { useCallback, useMemo, useState } from 'react';
import type { AttemptRow, ErrorClass, LeakRowDto, Subject } from '../../shared/types.ts';
import { api, marks, pct, useApi } from '../lib.ts';
import { Button, Empty, Field, Input, Metric, Panel, Procedural, Select, Table, Td, Textarea } from '../ui.tsx';
import { TriageForm } from './Errors.tsx';

interface MockRow {
  id: number;
  date: string;
  started_at: string | null;
  started_at_0930: number;
  environment: string;
  raw_score: number | null;
  attempted: number | null;
  correct: number | null;
  wrong: number | null;
  skipped: number | null;
  marks_lost_negative: number | null;
  triage_completed_at: string | null;
}

interface MockDetail {
  mock: MockRow;
  attempts: AttemptRow[];
  triage: { pending: number; total: number; revealed: boolean };
  leak: LeakRowDto[];
}

export function Mocks({
  navigate,
  params,
}: {
  navigate: (to: string) => void;
  params: URLSearchParams;
}): React.ReactElement {
  const selected = params.get('id');
  const creating = params.get('new') === '1';
  const list = useApi<MockRow[]>('/mocks');

  if (selected) return <Detail id={Number(selected)} navigate={navigate} />;
  if (creating) return <Create navigate={navigate} onDone={() => list.reload()} />;

  return (
    <div className="space-y-3">
      <Panel
        label="Mocks"
        right={<Button onClick={() => navigate('/mocks?new=1')}>New mock</Button>}
      >
        {!list.data || list.data.length === 0 ? (
          <Empty>No mocks yet. Sit one wherever is most faithful, then import the rows here.</Empty>
        ) : (
          <Table head={['Date', 'Score', '09:30', 'Env', 'Att', 'Right', 'Wrong', 'Skip', 'Negatives', '']}>
            {list.data.map((m) => (
              <tr key={m.id} className="border-b border-rule last:border-0 hover:bg-ground">
                <Td align="left">{m.date}</Td>
                <Td>
                  {m.triage_completed_at ? (
                    marks(m.raw_score)
                  ) : (
                    <span className="text-ink-muted">withheld</span>
                  )}
                </Td>
                <Td>{m.started_at_0930 ? 'yes' : <Procedural>no</Procedural>}</Td>
                <Td>{m.environment}</Td>
                <Td>{m.attempted ?? '—'}</Td>
                <Td>{m.correct ?? '—'}</Td>
                <Td>{m.wrong ?? '—'}</Td>
                <Td>{m.skipped ?? '—'}</Td>
                <Td className={m.marks_lost_negative ? 'text-procedural' : ''}>
                  {m.marks_lost_negative === null ? '—' : marks(m.marks_lost_negative)}
                </Td>
                <Td>
                  <button
                    onClick={() => navigate(`/mocks?id=${m.id}`)}
                    className="text-[11px] underline underline-offset-2"
                  >
                    open
                  </button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}

function Create({
  navigate,
  onDone,
}: {
  navigate: (to: string) => void;
  onDone: () => void;
}): React.ReactElement {
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ date: today, time: '09:30', environment: 'home', notes: '' });
  const [rows, setRows] = useState('');
  const [error, setError] = useState<string | null>(null);

  const inWindow = f.time >= '09:15' && f.time <= '09:45';

  const submit = useCallback(async () => {
    setError(null);
    try {
      const { id } = await api<{ id: number }>('/mocks', {
        method: 'POST',
        body: JSON.stringify({
          date: f.date,
          startedAt: `${f.date}T${f.time}:00`,
          environment: f.environment,
          notes: f.notes,
        }),
      });

      const parsed = rows
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [qNo, qtype, mk, outcome, seconds, confidence] = line.split(/[,\t]/).map((s) => s.trim());
          return {
            sourceLabel: `Mock ${f.date}`,
            sourceQNo: qNo,
            qtype: (qtype ?? 'MCQ').toUpperCase(),
            marks: Number(mk ?? 1),
            outcome: (outcome ?? 'wrong').toLowerCase(),
            timeSeconds: seconds ? Number(seconds) : null,
            confidence: confidence ? Number(confidence) : null,
          };
        });

      if (parsed.length > 0) {
        await api(`/mocks/${id}/rows`, { method: 'POST', body: JSON.stringify({ rows: parsed }) });
      }
      onDone();
      navigate(`/mocks?id=${id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [f, rows, navigate, onDone]);

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Panel label="New mock">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date">
            <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label="Actual start" hint="09:15–09:45">
            <Input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
          </Field>
          <Field label="Environment">
            <Select value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })}>
              <option value="home">home</option>
              <option value="away">away</option>
            </Select>
          </Field>
        </div>

        {!inWindow && (
          <p className="mt-2 border border-procedural px-2 py-1.5 text-[11px] text-procedural">
            Outside the 09:15–09:45 window. This will record{' '}
            <code>started_at_0930 = false</code> and every analytic on this mock will be segmented
            by that flag — the exam is at 09:30 and numbers from another time of day are not
            interchangeable.
          </p>
        )}

        <div className="mt-3">
          <Field
            label="Per-question rows"
            hint="q_no, type, marks, outcome, seconds, confidence"
          >
            <Textarea
              rows={10}
              value={rows}
              onChange={(e) => setRows(e.target.value)}
              placeholder={'Q1,MCQ,1,correct,72,90\nQ2,MSQ,2,wrong,210,60\nQ3,NAT,2,skipped,0,20'}
              className="font-mono text-[11px]"
            />
          </Field>
        </div>

        {error && <p className="mt-2 text-[12px] text-procedural">{error}</p>}

        <div className="mt-3 flex gap-2 border-t border-rule pt-3">
          <Button variant="primary" onClick={submit}>Create and triage</Button>
          <Button onClick={() => navigate('/mocks')}>Cancel</Button>
        </div>
      </Panel>

      <Panel label="Why import rather than simulate">
        <p className="text-[12px] leading-relaxed text-ink-muted">
          Sit the mock wherever the interface is most faithful. What this app needs is the data:
          per-question time, the start-time flag, the environment, and — above all — the triage.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
          Outcomes accepted: <code className="text-ink">correct</code>,{' '}
          <code className="text-ink">wrong</code>, <code className="text-ink">skipped</code>,{' '}
          <code className="text-ink">correct_but_guessed</code>. Mark guesses honestly — the
          calibration curve is only as good as that column.
        </p>
      </Panel>
    </div>
  );
}

function Detail({ id, navigate }: { id: number; navigate: (to: string) => void }): React.ReactElement {
  const detail = useApi<MockDetail>(`/mocks/${id}`);
  const ref = useApi<{ errorClasses: ErrorClass[]; subjects: Subject[]; sources: { id: number; label: string }[]; limits: { minBrokeAtStep: number; minPreventionRule: number; minWhatIThought: number } }>('/reference');
  const [i, setI] = useState(0);

  const pending = useMemo(
    () =>
      (detail.data?.attempts ?? []).filter(
        (a) =>
          (a.outcome === 'wrong' || a.outcome === 'skipped' || a.outcome === 'correct_but_guessed') &&
          a.triaged_at === null,
      ),
    [detail.data],
  );

  const refresh = useCallback(async () => {
    await api(`/mocks/${id}/recompute`, { method: 'POST' });
    detail.reload();
    setI(0);
  }, [id, detail]);

  if (!detail.data || !ref.data) return <Empty>Loading…</Empty>;
  const d = detail.data;

  if (pending.length > 0) {
    const row = pending[Math.min(i, pending.length - 1)]!;
    return (
      <div className="space-y-3">
        <Panel label="Triage blocks the score" right={`${pending.length} remaining`}>
          <p className="mb-3 text-[12px] leading-relaxed text-ink-muted">
            Every wrong, skipped and guessed-correct question needs an error class before the score
            appears. The score is the reward for doing the triage, not the other way round.
          </p>
          <div className="h-1.5 w-full bg-ground">
            <div
              className="h-full bg-ink motion-safe:transition-[width]"
              style={{
                width: `${((d.triage.total - pending.length) / Math.max(1, d.triage.total)) * 100}%`,
              }}
            />
          </div>
        </Panel>

        <Panel label={`Question ${row.source_q_no ?? row.id}`}>
          <TriageForm key={row.id} row={row} reference={ref.data} onDone={refresh} />
        </Panel>
      </div>
    );
  }

  const negShare = d.mock.raw_score !== null && d.mock.marks_lost_negative
    ? d.mock.marks_lost_negative
    : 0;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Panel label="Score">
          <Metric label={d.mock.date} value={marks(d.mock.raw_score)} size="xl" />
        </Panel>
        <Panel label="Discipline">
          <div className="space-y-1.5 text-[12px]">
            <div className="flex justify-between">
              <span className="text-ink-muted">Started 09:15–09:45</span>
              <span>{d.mock.started_at_0930 ? 'yes' : <Procedural>no</Procedural>}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-muted">Environment</span>
              <span>{d.mock.environment}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-muted">Lost to negatives</span>
              <span className={negShare > 0 ? 'text-procedural' : ''}>{marks(negShare)}</span>
            </div>
          </div>
        </Panel>
        <Panel label="Counts">
          <div className="num grid grid-cols-2 gap-2 text-[12px]">
            <div><span className="text-ink-muted">attempted </span>{d.mock.attempted}</div>
            <div><span className="text-ink-muted">correct </span>{d.mock.correct}</div>
            <div><span className="text-ink-muted">wrong </span>{d.mock.wrong}</div>
            <div><span className="text-ink-muted">skipped </span>{d.mock.skipped}</div>
          </div>
        </Panel>
        <Panel label="Procedural share, this mock">
          <Metric
            label="of marks lost"
            value={pct(proceduralShareOf(d.leak))}
            size="lg"
            alarm
          />
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel label="Marks lost per error class">
          {d.leak.filter((l) => l.occurrences > 0).length === 0 ? (
            <Empty>Nothing lost.</Empty>
          ) : (
            <Table head={['Class', 'Count', 'Marks', 'Share']}>
              {d.leak
                .filter((l) => l.occurrences > 0)
                .map((l) => (
                  <tr key={l.errorClassId} className="border-b border-rule last:border-0">
                    <Td align="left">
                      {l.isProcedural ? <Procedural>{l.name}</Procedural> : l.name}
                    </Td>
                    <Td>{l.occurrences}</Td>
                    <Td>{marks(l.marksLost)}</Td>
                    <Td>{pct(l.shareOfLoss, 0)}</Td>
                  </tr>
                ))}
            </Table>
          )}
        </Panel>

        <Panel label="Time distribution" right="budget 1.5m / 3m">
          <Table head={['Q', 'Type', 'Marks', 'Time', 'Budget']}>
            {d.attempts
              .filter((a) => a.time_seconds !== null)
              .sort((a, b) => (b.time_seconds ?? 0) - (a.time_seconds ?? 0))
              .slice(0, 12)
              .map((a) => {
                const budget = a.marks === 1 ? 90 : 180;
                const over = (a.time_seconds ?? 0) > budget;
                const hard = (a.time_seconds ?? 0) > budget * 2;
                return (
                  <tr key={a.id} className="border-b border-rule last:border-0">
                    <Td align="left">{a.source_q_no}</Td>
                    <Td>{a.qtype}</Td>
                    <Td>{marks(a.marks)}</Td>
                    <Td className={hard ? 'text-procedural font-semibold' : over ? 'text-procedural' : ''}>
                      {a.time_seconds}s
                    </Td>
                    <Td className="text-ink-muted">{budget}s</Td>
                  </tr>
                );
              })}
          </Table>
        </Panel>
      </div>

      <Button onClick={() => navigate('/mocks')}>Back to all mocks</Button>
    </div>
  );
}

function proceduralShareOf(leak: LeakRowDto[]): number | null {
  const total = leak.reduce((a, l) => a + l.marksLost, 0);
  if (total === 0) return null;
  return leak.filter((l) => l.isProcedural).reduce((a, l) => a + l.marksLost, 0) / total;
}
