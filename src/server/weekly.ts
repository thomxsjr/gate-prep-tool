/**
 * Weekly review (M9). One page, readable in five minutes, exportable to
 * Markdown. PDF comes from the browser's own print pipeline via the print
 * stylesheet — no headless browser, no PDF library, works offline.
 *
 * The "attack next" choice is made by damage, never by feel.
 */

import { type DB, getDb } from '../db/index.ts';
import type { WeeklyReport } from '../shared/types.ts';
import { computeLadder, type Rung } from '../domain/ladder.ts';
import {
  addDays,
  direction,
  leakTable,
  proceduralShare,
  startOfWeek,
  weeklySeries,
  worstClass,
} from '../domain/procedural.ts';
import * as repo from './repo.ts';
import { buildDeck } from './deck.ts';

export function buildWeekly(db: DB = getDb(), today: Date = new Date()): WeeklyReport {
  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 7);
  const prevStart = addDays(weekStart, -7);

  const attempts = repo.shareAttempts(db);
  const classes = repo.errorClasses(db).map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    isProcedural: c.is_procedural,
  }));

  const thisWeek = proceduralShare(attempts, { from: weekStart, to: weekEnd });
  const lastWeek = proceduralShare(attempts, { from: prevStart, to: weekStart });
  const leak = leakTable(attempts, classes, { from: weekStart, to: weekEnd });

  // If nothing leaked this week, widen to 28 days rather than reporting "no
  // target" — a quiet week is not evidence that the leak is closed.
  const leakForAttack = leak.some((r) => r.marksLost > 0)
    ? leak
    : leakTable(attempts, classes, { from: addDays(today, -28), to: weekEnd });

  const targets = (repo.getConfig<Record<string, number>>('targets', db) ?? {}) as Record<string, number>;

  const rungRows = repo.rungs(db);
  const asRungs = rungRows.map<Rung>((r) => ({
    ordinal: r.ordinal,
    name: r.name,
    itemsTarget: r.items_target,
    marksSwing: r.marks_swing,
    cumulativeScore: r.cumulative_score,
    errorClassId: r.error_class_id,
    isProcedural: r.is_procedural,
  }));
  const itemsClosed = repo.rungItemsClosed(db);
  const baseline = targets['baseline_score'] ?? 53;

  const nowLadder = computeLadder({
    rungs: asRungs,
    attempts,
    itemsClosed,
    window: { from: addDays(weekEnd, -28), to: weekEnd },
    baselineScore: baseline,
  });
  const thenLadder = computeLadder({
    rungs: asRungs,
    attempts,
    itemsClosed,
    window: { from: addDays(weekStart, -28), to: weekStart },
    baselineScore: baseline,
  });

  const deck = buildDeck(db, today);
  const mocks = repo
    .listMocks(db)
    .filter((m) => m.date >= weekStart.toISOString().slice(0, 10) && m.raw_score !== null)
    .map((m) => ({
      date: m.date,
      score: m.raw_score!,
      at0930: m.started_at_0930 === 1,
      environment: m.environment,
    }));

  return {
    weekStart: weekStart.toISOString().slice(0, 10),
    weekEnd: addDays(weekEnd, -1).toISOString().slice(0, 10),
    procedural: {
      current: thisWeek.share,
      previous: lastWeek.share,
      direction: direction(weeklySeries(attempts, 8, today)),
    },
    leak,
    attack: worstClass(leakForAttack),
    hours: {
      logged: repo.hoursSince(weekStart.toISOString().slice(0, 10), db),
      min: targets['weekly_hours_min'] ?? 32,
      max: targets['weekly_hours_max'] ?? 40,
    },
    gate: deck.phase
      ? { label: deck.phase.gateLabel ?? '—', status: deck.phase.gateStatus, detail: deck.phase.gateDetail }
      : null,
    rungDelta: nowLadder.rungs.map((r) => ({
      ordinal: r.ordinal,
      name: r.name,
      fill: r.fill,
      previousFill: thenLadder.rungs.find((x) => x.ordinal === r.ordinal)?.fill ?? 0,
    })),
    subjectAccuracy: repo.subjectAccuracy(weekStart.toISOString(), db),
    mocks,
  };
}

const pct = (x: number | null): string => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const num = (x: number): string => x.toFixed(2);

export function weeklyMarkdown(r: WeeklyReport): string {
  const lines: string[] = [];

  lines.push(`# Weekly review — ${r.weekStart} to ${r.weekEnd}`, '');

  const delta =
    r.procedural.current !== null && r.procedural.previous !== null
      ? `${((r.procedural.current - r.procedural.previous) * 100).toFixed(1)} pts`
      : '—';
  lines.push('## Procedural error share', '');
  lines.push(`- This week: **${pct(r.procedural.current)}**`);
  lines.push(`- Last week: ${pct(r.procedural.previous)}  (change ${delta})`);
  lines.push(`- 8-week direction: **${r.procedural.direction}**`, '');

  lines.push('## Attack next week', '');
  if (r.attack) {
    lines.push(
      `**${r.attack.name}** — ${num(r.attack.marksLost)} marks lost across ` +
        `${r.attack.occurrences} question(s), ${(r.attack.shareOfLoss * 100).toFixed(0)}% of the total.`,
    );
    lines.push('', 'Chosen by damage, not by feel.');
  } else {
    lines.push('No triaged losses in the window. Log some work.');
  }
  lines.push('');

  lines.push('## Leak table', '');
  lines.push('| Error class | Procedural | Occurrences | Marks lost | Share |');
  lines.push('|---|---|---:|---:|---:|');
  for (const row of r.leak.filter((x) => x.occurrences > 0)) {
    lines.push(
      `| ${row.name} | ${row.isProcedural ? 'yes' : 'no'} | ${row.occurrences} | ` +
        `${num(row.marksLost)} | ${(row.shareOfLoss * 100).toFixed(0)}% |`,
    );
  }
  if (!r.leak.some((x) => x.occurrences > 0)) lines.push('| — | — | 0 | 0.00 | — |');
  lines.push('');

  lines.push('## Gate', '');
  lines.push(r.gate ? `**${r.gate.label}** — ${r.gate.status}. ${r.gate.detail}` : 'No gate in this phase.');
  lines.push('');

  lines.push('## Hours', '');
  lines.push(`${r.hours.logged.toFixed(1)} logged against a ${r.hours.min}–${r.hours.max} target.`, '');

  lines.push('## Rung progress', '');
  lines.push('| Rung | Fill | Change |');
  lines.push('|---|---:|---:|');
  for (const d of r.rungDelta.filter((x) => x.ordinal > 0)) {
    const change = (d.fill - d.previousFill) * 100;
    lines.push(
      `| ${d.ordinal}. ${d.name} | ${(d.fill * 100).toFixed(0)}% | ` +
        `${change >= 0 ? '+' : ''}${change.toFixed(0)} pts |`,
    );
  }
  lines.push('');

  lines.push('## Subject accuracy', '');
  lines.push('| Subject | Attempts | Accuracy | Marks lost |');
  lines.push('|---|---:|---:|---:|');
  for (const s of r.subjectAccuracy) {
    lines.push(`| ${s.subject} | ${s.attempts} | ${(s.accuracy * 100).toFixed(0)}% | ${num(s.marksLost)} |`);
  }
  if (r.subjectAccuracy.length === 0) lines.push('| — | 0 | — | 0.00 |');
  lines.push('');

  if (r.mocks.length > 0) {
    lines.push('## Mocks this week', '');
    lines.push('| Date | Score | 09:30 start | Environment |');
    lines.push('|---|---:|---|---|');
    for (const m of r.mocks) {
      lines.push(`| ${m.date} | ${num(m.score)} | ${m.at0930 ? 'yes' : '**no**'} | ${m.environment} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
