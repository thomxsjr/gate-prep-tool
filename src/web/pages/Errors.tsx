/**
 * M2 — Error log. The flow used most, so it is optimised hardest.
 *
 * Two stages:
 *   Capture  (<20s, during practice) — source, type, marks, outcome, time,
 *            confidence, optional class. Cmd+Enter saves and clears for the
 *            next one without touching the mouse.
 *   Triage   (later) — the diagnosis, gated on structure rather than length.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AttemptRow, ErrorClass, LeakRowDto, Subject } from '../../shared/types.ts';
import { api, marks, pct, useApi, useSubmitShortcut } from '../lib.ts';
import { Button, Empty, Field, Input, Panel, Procedural, Select, Table, Td, Textarea } from '../ui.tsx';

interface Reference {
  errorClasses: ErrorClass[];
  subjects: Subject[];
  sources: { id: number; label: string }[];
  limits: { minBrokeAtStep: number; minPreventionRule: number; minWhatIThought: number };
}

type Tab = 'capture' | 'queue' | 'log' | 'leak' | 'import';

export function Errors({
  navigate,
  params,
}: {
  navigate: (to: string) => void;
  params: URLSearchParams;
}): React.ReactElement {
  // The URL IS the tab, not merely its initial value. Seeding state from the
  // URL would leave the palette unable to switch tabs while already on this
  // page, because the component never remounts on a hash change.
  const fromUrl = params.get('tab') as Tab | null;
  const tab: Tab =
    fromUrl && ['capture', 'queue', 'log', 'leak', 'import'].includes(fromUrl)
      ? fromUrl
      : params.get('triaged') === 'false'
        ? 'queue'
        : 'capture';
  const setTab = (t: Tab): void => navigate(`/errors?tab=${t}`);
  const ref = useApi<Reference>('/reference');
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  if (!ref.data) return <Empty>Loading…</Empty>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1 border-b border-rule">
        {(['capture', 'queue', 'log', 'leak', 'import'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`border-b-2 px-3 py-1.5 text-xs tracking-wide uppercase ${
              tab === t ? 'border-ink font-semibold' : 'border-transparent text-ink-muted hover:text-ink'
            }`}
          >
            {t === 'queue' ? 'Triage queue' : t}
          </button>
        ))}
      </div>

      {tab === 'capture' && <Capture reference={ref.data} onSaved={bump} />}
      {tab === 'queue' && <Queue reference={ref.data} version={version} onTriaged={bump} />}
      {tab === 'log' && <Log reference={ref.data} version={version} navigate={navigate} />}
      {tab === 'leak' && <Leak />}
      {tab === 'import' && <Import onDone={bump} />}
    </div>
  );
}

// --- stage 1 ---------------------------------------------------------------

function Capture({
  reference,
  onSaved,
}: {
  reference: Reference;
  onSaved: () => void;
}): React.ReactElement {
  const [form, setForm] = useState({
    sourceLabel: '',
    sourceQNo: '',
    qtype: 'MCQ',
    marks: '1',
    subjectId: '',
    context: 'pyq',
    outcome: 'wrong',
    timeSeconds: '',
    confidence: '',
    errorClassId: '',
  });
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = useCallback(async () => {
    setError(null);
    if (!form.sourceLabel.trim()) {
      setError('a source is required');
      return;
    }
    try {
      const row = await api<AttemptRow>('/errors', {
        method: 'POST',
        body: JSON.stringify({
          sourceLabel: form.sourceLabel.trim(),
          sourceQNo: form.sourceQNo.trim() || null,
          qtype: form.qtype,
          marks: Number(form.marks),
          subjectId: form.subjectId ? Number(form.subjectId) : null,
          context: form.context,
          outcome: form.outcome,
          timeSeconds: form.timeSeconds ? Number(form.timeSeconds) : null,
          confidence: form.confidence ? Number(form.confidence) : null,
          errorClassId: form.errorClassId ? Number(form.errorClassId) : null,
        }),
      });
      setSaved(row.id);
      // Keep the source and context — the next question is usually from the
      // same paper. Clear only what changes per question.
      setForm((f) => ({ ...f, sourceQNo: '', timeSeconds: '', confidence: '', errorClassId: '' }));
      onSaved();
      first.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [form, onSaved]);

  useSubmitShortcut(submit);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Panel label="Capture" right="⌘↵ to save">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Field label="Source" hint="paper or mock">
              <Input
                ref={first}
                autoFocus
                list="sources"
                value={form.sourceLabel}
                onChange={set('sourceLabel')}
                placeholder="GATE DA 2025"
              />
              <datalist id="sources">
                {reference.sources.map((s) => (
                  <option key={s.id} value={s.label} />
                ))}
              </datalist>
            </Field>
          </div>
          <Field label="Q no">
            <Input value={form.sourceQNo} onChange={set('sourceQNo')} placeholder="Q41" />
          </Field>

          <Field label="Type">
            <Select value={form.qtype} onChange={set('qtype')}>
              <option>MCQ</option>
              <option>MSQ</option>
              <option>NAT</option>
            </Select>
          </Field>
          <Field label="Marks">
            <Select value={form.marks} onChange={set('marks')}>
              <option value="1">1</option>
              <option value="2">2</option>
            </Select>
          </Field>
          <Field label="Outcome">
            <Select value={form.outcome} onChange={set('outcome')}>
              <option value="wrong">wrong</option>
              <option value="skipped">skipped</option>
              <option value="correct_but_guessed">correct, guessed</option>
              <option value="correct">correct</option>
            </Select>
          </Field>

          <Field label="Subject">
            <Select value={form.subjectId} onChange={set('subjectId')}>
              <option value="">—</option>
              {reference.subjects.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Context">
            <Select value={form.context} onChange={set('context')}>
              <option value="pyq">pyq</option>
              <option value="mock">mock</option>
              <option value="sectional">sectional</option>
              <option value="practice">practice</option>
            </Select>
          </Field>
          <Field label="Time" hint="seconds">
            <Input type="number" value={form.timeSeconds} onChange={set('timeSeconds')} />
          </Field>

          <Field label="Confidence" hint="0–100">
            <Input type="number" min="0" max="100" value={form.confidence} onChange={set('confidence')} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Error class" hint="optional now, required to triage">
              <Select value={form.errorClassId} onChange={set('errorClassId')}>
                <option value="">— decide during triage —</option>
                {reference.errorClasses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.is_procedural ? ' (procedural)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        {error && <p className="mt-3 text-[12px] text-procedural">{error}</p>}

        <div className="mt-4 flex items-center gap-3 border-t border-rule pt-3">
          <Button variant="primary" onClick={submit}>Save and next</Button>
          {saved !== null && <span className="num text-[11px] text-ink-muted">saved #{saved}</span>}
        </div>
      </Panel>

      <Panel label="Why two stages">
        <p className="text-[12px] leading-relaxed text-ink-muted">
          Capture is meant to take under twenty seconds, mid-practice. Stopping to write a real
          diagnosis in the middle of a deep-work block is itself a time-management error — the
          thing this app exists to remove.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
          The diagnosis happens in the triage queue, later. Until a row is triaged it is
          <strong className="text-ink"> excluded from the procedural share</strong>, so the metric
          cannot be improved by leaving the hard entries unlabelled.
        </p>
      </Panel>
    </div>
  );
}

// --- stage 2 ---------------------------------------------------------------

export function TriageForm({
  row,
  reference,
  onDone,
}: {
  row: AttemptRow;
  reference: Reference;
  onDone: () => void;
}): React.ReactElement {
  const [f, setF] = useState({
    errorClassId: row.error_class_id ? String(row.error_class_id) : '',
    outcome: row.outcome ?? 'wrong',
    whatIThought: row.what_i_thought,
    brokeAtStep: row.broke_at_step,
    preventionRule: row.prevention_rule,
    confidence: row.confidence !== null ? String(row.confidence) : '',
    subjectId: row.subject_id ? String(row.subject_id) : '',
    conceptName: '',
    paraphrase: row.paraphrase,
    createCard: true,
  });
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  const lim = reference.limits;
  const ready =
    f.errorClassId !== '' &&
    f.brokeAtStep.trim().length >= lim.minBrokeAtStep &&
    f.preventionRule.trim().length >= lim.minPreventionRule &&
    f.whatIThought.trim().length >= lim.minWhatIThought;

  const submit = useCallback(async () => {
    setError(null);
    try {
      await api(`/errors/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          errorClassId: Number(f.errorClassId),
          outcome: f.outcome,
          whatIThought: f.whatIThought,
          brokeAtStep: f.brokeAtStep,
          preventionRule: f.preventionRule,
          confidence: f.confidence ? Number(f.confidence) : null,
          subjectId: f.subjectId ? Number(f.subjectId) : null,
          conceptName: f.conceptName || null,
          paraphrase: f.paraphrase,
          createCard: f.createCard,
        }),
      });
      onDone();
    } catch (e) {
      const err = e as Error & { field?: string };
      setError({ message: err.message, field: err.field });
    }
  }, [f, row.id, onDone]);

  useSubmitShortcut(submit, ready);

  return (
    <div className="space-y-3">
      <div className="num flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule pb-2 text-[11px] text-ink-muted">
        <span className="text-sm font-semibold text-ink">
          {row.source_label} {row.source_q_no ?? ''}
        </span>
        <span>{row.qtype}</span>
        <span>{marks(row.marks)} marks</span>
        {row.my_answer && <span>answered {row.my_answer}</span>}
        {row.correct_answer && <span>key {row.correct_answer}</span>}
        {row.time_seconds !== null && <span>{row.time_seconds}s</span>}
        {!row.option_labels_comparable && (
          <Procedural>option labels not comparable to the key — decide from the paper</Procedural>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Outcome">
          <Select value={f.outcome} onChange={set('outcome')}>
            <option value="wrong">wrong</option>
            <option value="skipped">skipped</option>
            <option value="correct_but_guessed">correct, guessed</option>
            <option value="correct">correct</option>
          </Select>
        </Field>
        <Field label="Error class" hint="required">
          <Select value={f.errorClassId} onChange={set('errorClassId')} autoFocus>
            <option value="">— choose —</option>
            {reference.errorClasses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.is_procedural ? ' (procedural)' : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Your own words for the question" hint="never third-party text">
        <Input value={f.paraphrase} onChange={set('paraphrase')} placeholder="Paraphrase, in your words" />
      </Field>

      <Field
        label="What I thought at the time"
        hint={`${f.whatIThought.trim().length}/${lim.minWhatIThought}`}
        error={error?.field === 'whatIThought' ? error.message : null}
      >
        <Textarea rows={2} value={f.whatIThought} onChange={set('whatIThought')} />
      </Field>

      <Field
        label="The step where it broke"
        hint={`${f.brokeAtStep.trim().length}/${lim.minBrokeAtStep}`}
        error={error?.field === 'brokeAtStep' ? error.message : null}
      >
        <Textarea
          rows={2}
          value={f.brokeAtStep}
          onChange={set('brokeAtStep')}
          placeholder="Be specific: which line of the working went wrong, and how"
        />
      </Field>

      <Field
        label="The rule that prevents it next time"
        hint={`${f.preventionRule.trim().length}/${lim.minPreventionRule}`}
        error={error?.field === 'preventionRule' ? error.message : null}
      >
        <Textarea
          rows={2}
          value={f.preventionRule}
          onChange={set('preventionRule')}
          placeholder="An instruction you could follow under exam pressure"
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Subject">
          <Select value={f.subjectId} onChange={set('subjectId')}>
            <option value="">—</option>
            {reference.subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Concept" hint="links cost across questions">
          <Input value={f.conceptName} onChange={set('conceptName')} placeholder="e.g. Loop invariants" />
        </Field>
        <Field label="Confidence" hint="0–100">
          <Input type="number" min="0" max="100" value={f.confidence} onChange={set('confidence')} />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-[12px]">
        <input
          type="checkbox"
          checked={f.createCard}
          onChange={(e) => setF((x) => ({ ...x, createCard: e.target.checked }))}
        />
        Create a flashcard from the prevention rule
      </label>

      {error && !error.field && <p className="text-[12px] text-procedural">{error.message}</p>}

      <div className="flex items-center gap-3 border-t border-rule pt-3">
        <Button variant="primary" onClick={submit} disabled={!ready}>
          Save diagnosis
        </Button>
        <span className="text-[11px] text-ink-muted">
          {ready ? '⌘↵ to save' : 'All three fields and a class are required'}
        </span>
      </div>
    </div>
  );
}

function Queue({
  reference,
  version,
  onTriaged,
}: {
  reference: Reference;
  version: number;
  onTriaged: () => void;
}): React.ReactElement {
  const { data, reload } = useApi<AttemptRow[]>('/errors/queue', [version]);
  const [i, setI] = useState(0);

  useEffect(() => {
    if (data && i >= data.length) setI(Math.max(0, data.length - 1));
  }, [data, i]);

  if (!data) return <Empty>Loading…</Empty>;
  if (data.length === 0) return <Empty>Triage queue is empty. Every captured error has a diagnosis.</Empty>;

  const row = data[Math.min(i, data.length - 1)]!;

  return (
    <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
      <Panel label="Queue" right={`${data.length}`} pad={false}>
        <ul className="max-h-[70vh] overflow-y-auto">
          {data.map((r, idx) => (
            <li key={r.id}>
              <button
                onClick={() => setI(idx)}
                className={`num flex w-full items-baseline justify-between border-b border-rule px-2 py-1.5 text-left text-[11px] ${
                  idx === i ? 'bg-ink text-panel' : 'hover:bg-ground'
                }`}
              >
                <span className="truncate">
                  {r.source_label} {r.source_q_no ?? ''}
                </span>
                <span className={idx === i ? 'text-panel/70' : 'text-ink-muted'}>{r.qtype}</span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel label={`Diagnose — ${data.length} waiting`}>
        <TriageForm
          key={row.id}
          row={row}
          reference={reference}
          onDone={() => {
            reload();
            onTriaged();
          }}
        />
      </Panel>
    </div>
  );
}

// --- views -----------------------------------------------------------------

function Log({
  reference,
  version,
  navigate,
}: {
  reference: Reference;
  version: number;
  navigate: (to: string) => void;
}): React.ReactElement {
  const [filter, setFilter] = useState({ errorClassId: '', subjectId: '', rungOrdinal: '', triaged: '' });
  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) p.set(k, v);
    p.set('limit', '300');
    return `/errors?${p.toString()}`;
  }, [filter]);

  const { data } = useApi<AttemptRow[]>(query, [version]);
  const set = (k: keyof typeof filter) => (e: { target: { value: string } }) =>
    setFilter((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Panel label="Error log" right={data ? `${data.length} rows` : ''}>
      <div className="mb-3 grid gap-2 sm:grid-cols-4">
        <Select value={filter.errorClassId} onChange={set('errorClassId')}>
          <option value="">All classes</option>
          {reference.errorClasses.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
        <Select value={filter.subjectId} onChange={set('subjectId')}>
          <option value="">All subjects</option>
          {reference.subjects.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </Select>
        <Select value={filter.rungOrdinal} onChange={set('rungOrdinal')}>
          <option value="">All rungs</option>
          {[1, 2, 3, 4, 5].map((o) => (
            <option key={o} value={o}>Rung {o}</option>
          ))}
        </Select>
        <Select value={filter.triaged} onChange={set('triaged')}>
          <option value="">Any state</option>
          <option value="true">Triaged</option>
          <option value="false">Awaiting triage</option>
        </Select>
      </div>

      {!data || data.length === 0 ? (
        <Empty>No entries match. Capture one, or widen the filter.</Empty>
      ) : (
        <Table head={['Source', 'Type', 'Marks', 'Outcome', 'Class', 'Lost', 'Conf', 'When']}>
          {data.map((r) => (
            <tr key={r.id} className="border-b border-rule last:border-0 hover:bg-ground">
              <Td align="left" className="max-w-[240px] truncate">
                {r.source_label} {r.source_q_no ?? ''}
              </Td>
              <Td>{r.qtype}</Td>
              <Td>{marks(r.marks)}</Td>
              <Td className={r.outcome === null ? 'text-ink-muted' : ''}>
                {r.outcome ?? 'undetermined'}
              </Td>
              <Td align="left" className="max-w-[200px] truncate">
                {r.error_name ? (
                  r.is_procedural ? <Procedural>{r.error_name}</Procedural> : r.error_name
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </Td>
              <Td>{r.marks_lost === null ? '—' : marks(r.marks_lost)}</Td>
              <Td>{r.confidence ?? '—'}</Td>
              <Td className="text-ink-muted">{r.attempted_at.slice(0, 10)}</Td>
            </tr>
          ))}
        </Table>
      )}
      <div className="mt-3 border-t border-rule pt-3">
        <Button onClick={() => navigate('/review')}>Open morning review</Button>
      </div>
    </Panel>
  );
}

function Leak(): React.ReactElement {
  const [days, setDays] = useState('14');
  const { data } = useApi<LeakRowDto[]>(`/errors/leak?days=${days}`, [days]);
  const total = (data ?? []).reduce((a, r) => a + r.marksLost, 0);
  const max = Math.max(0.001, ...(data ?? []).map((r) => r.marksLost));

  return (
    <Panel
      label="Leak table"
      right={
        <select
          value={days}
          onChange={(e) => setDays(e.target.value)}
          className="border border-rule bg-ground px-1 py-0.5 text-[11px]"
        >
          {['7', '14', '30', '90', '365'].map((d) => (
            <option key={d} value={d}>{d}d</option>
          ))}
        </select>
      }
    >
      {!data || total === 0 ? (
        <Empty>Nothing has leaked in this window.</Empty>
      ) : (
        <>
          <p className="mb-3 text-[11px] text-ink-muted">
            Sorted by damage, not frequency. {marks(total)} marks lost over {days} days.
          </p>
          <div className="space-y-1.5">
            {data
              .filter((r) => r.occurrences > 0)
              .map((r) => (
                <div key={r.errorClassId} className="grid grid-cols-[minmax(0,1fr)_60px_54px] items-center gap-2">
                  <div>
                    <div className="flex items-baseline justify-between text-[12px]">
                      <span className={r.isProcedural ? 'text-procedural' : ''}>{r.name}</span>
                      <span className="num text-[10px] text-ink-muted">{r.occurrences}x</span>
                    </div>
                    <div className="mt-0.5 h-2 w-full bg-ground">
                      <div
                        className={`h-full ${r.isProcedural ? 'bg-procedural' : 'bg-ink'}`}
                        style={{ width: `${(r.marksLost / max) * 100}%` }}
                      />
                    </div>
                  </div>
                  <span className="num text-right text-sm">{marks(r.marksLost)}</span>
                  <span className="num text-right text-[11px] text-ink-muted">{pct(r.shareOfLoss, 0)}</span>
                </div>
              ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function Import({ onDone }: { onDone: () => void }): React.ReactElement {
  const [text, setText] = useState('');
  const [report, setReport] = useState<{
    imported: number;
    triaged: number;
    queued: number;
    skipped: number;
    errors: { row: number; message: string }[];
  } | null>(null);

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Panel label="CSV import">
        <Textarea
          rows={12}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste CSV, including the header row"
          className="font-mono text-[11px]"
        />
        <div className="mt-3 flex gap-2">
          <Button
            variant="primary"
            disabled={!text.trim()}
            onClick={async () => {
              setReport(
                await api('/errors/import', {
                  method: 'POST',
                  headers: { 'content-type': 'text/csv' },
                  body: text,
                }),
              );
              onDone();
            }}
          >
            Import
          </Button>
          <Button
            onClick={async () => {
              const t = await fetch('/api/errors/import/template').then((r) => r.text());
              setText(t);
            }}
          >
            Load template
          </Button>
        </div>
      </Panel>

      <Panel label="Result">
        {!report ? (
          <p className="text-[12px] leading-relaxed text-ink-muted">
            A row carrying an error class and both structured fields imports already triaged.
            Anything less lands in the triage queue — the same rule the form enforces, so an
            import cannot smuggle in undiagnosed rows as diagnosed ones.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2 border-b border-rule pb-3 text-center">
              {[
                ['Imported', report.imported],
                ['Triaged', report.triaged],
                ['Queued', report.queued],
                ['Skipped', report.skipped],
              ].map(([label, n]) => (
                <div key={label as string}>
                  <div className="num text-2xl">{n as number}</div>
                  <div className="text-[10px] tracking-wider text-ink-muted uppercase">{label as string}</div>
                </div>
              ))}
            </div>
            {report.errors.length > 0 && (
              <ul className="mt-3 space-y-1">
                {report.errors.map((e) => (
                  <li key={e.row} className="num text-[11px] text-procedural">
                    row {e.row}: {e.message}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
