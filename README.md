# GATE DA 2027

A measurement instrument for one job: drive the procedural error share toward
zero and prove it with data.

Baseline 53.00/100 on the 2026 paper, of which roughly 46% of lost marks came
from process failures on questions where the material was known. This is not a
study tracker. Every screen either captures an error precisely, drills a
failure mode, or shows whether that mode is closing.

Local-first, offline, single-user. No login, no cloud, no external calls at
runtime.

## Status

**M0 complete** — schema, migrations, seed, backup/restore, durability proof,
test suite, and the GATE DA 2026 response sheet imported. No UI beyond a health
check; the command deck is M1.

```
159 tests passing        scoring · EV · SM-2 · procedural share · calibration
                         ladder · option-shuffle · migrations · answer key
13/13 durability checks  write → back up → delete → restore → verify
65 questions imported    key applied; 37 of 100 marks determinable, 17.00 scored
```

## The 2026 baseline, as imported

| | |
|---|---|
| Questions | 65 — GA 10, subject 55 |
| Marks | 100 — GA 15, subject 85 (per the official key) |
| Types | MCQ 33 (49 marks) · NAT 18 (29) · MSQ 14 (22) |
| Answered | 60 |
| Left blank | 5, all MCQ, worth **exactly 8 marks** |
| Sitting | 15 Feb 2026, **14:30–17:30** (afternoon session) |

Three things fall straight out of this:

**The five non-attempts are worth exactly 8 marks**, matching rung 4's `+8.00`
swing to the decimal. They are seeded as rung-4 items.

That total survived the marks correction below, but only because the two errors
inside it cancelled. It was right by luck before the key arrived, and is right
by evidence now — worth separating, because the reasoning that produced it the
first time was faulty.

**Zero MSQs and zero NATs were left blank.** Leaving a free-shot question blank
is a discipline violation the app will always flag, but it was not a 2026
failure mode. Every blank was an MCQ.

**The 53.00 baseline is not yet reproducible from these documents** — 63 of the
100 marks depend on option labels that cannot be compared to the key. See below.

The sitting was an afternoon slot, so `started_at_0930` segmentation matters
more than it looks: the only real-exam data point comes from a different time
of day than the one being rehearsed.

### Applying the official key: what it settled, and what it could not

The key is joined to the response sheet **on the exam's question ID, never on
position** — GATE shuffles question order per candidate, and position matching
was verified wrong for all 65. The join validates on question type and section
for every question before anything is written, and refuses a partial mapping.

Two things came out of it.

**Option order is shuffled too.** "Chosen Option: A" means the option shown to
this candidate in position A, not the master paper's option A. NAT questions
have no options, so they act as a control group:

| Type | Accuracy on attempted | Chance |
|---|---|---|
| **NAT** (no options) | **61.1%** | — |
| MCQ | 28.6% | 25.0% |
| MSQ | 14.3% | ~6.7% |

If MCQ skill matched NAT skill, P(≤8 correct of 28) = 9.9 × 10⁻⁷. The recorded
labels are noise with respect to the key. Scoring across that gap yields
**21.00 with General Aptitude NEGATIVE** — a confident, badly wrong number.
`questions.option_labels_comparable` is the guard, and
`src/domain/option-shuffle.ts` is the tested detector that sets it.

**The marks reconstruction was wrong on four GA questions.** Deriving marks
from response-sheet position assumed the sheet followed paper order. It does
not. Two errors in each direction cancelled, so the "total = 100, GA = 15"
check passed while the per-question data was wrong — an aggregate check
validating a broken detail. The key corrects them.

So the settled position on the 2026 paper:

| | Questions | Marks | Status |
|---|---|---|---|
| NAT | 18 | 29 | **scored** — 11 correct, 17.00 marks |
| Blank | 5 | 8 | **scored** — all skipped, all MCQ |
| MCQ / MSQ answered | 42 | 63 | **undetermined** — needs a human |

`17.00 of 37.00 determinable marks`. The remaining 63 need you to look at the
paper and recall what you picked; that is what M2's triage flow is for.

Recovering them automatically would need the **HTML** response sheet rather
than a PDF print — the HTML carries per-option image references that may map
displayed positions back to master options. The PDF print has only generic form
XObjects.

## Quick start

```bash
npm install
npm run db:migrate
npm run db:seed
npm run dev          # api on :5178, web on :5177
```

Both bind `0.0.0.0`, so the error log and flashcards are reachable from a phone
on the same network. Nothing leaves the machine.

## Commands

```bash
npm run dev                # api + web
npm test                   # vitest
npm run typecheck
npm run backup             # see docs/DURABILITY.md
npm run restore
npm run verify:durability  # the proof
npm run db:reset -- --yes  # rebuild from config.seed.json (backs up first)
```

## Importing a response sheet

```bash
# HTML saved from the browser (Web Page, HTML only) — the durable path
npm run import:response-sheet -- sheet.html --label "GATE DA 2026" --dry-run

# or, if all you have is a PDF printout
pip install pypdf
python3 tools/extract-response-sheet-pdf.py sheet.pdf -o data/import/gate-da-2026-response.json
npm run import:response-sheet -- data/import/gate-da-2026-response.json

# then the official answer key
python3 tools/extract-answer-key-pdf.py DA_Keys.pdf -o data/import/gate-da-2026-key.json
npm run apply:key -- data/import/gate-da-2026-key.json --source "GATE DA 2026"
```

Marks are not printed on a response sheet. They are derived from the published
GATE DA structure — 1-mark questions precede 2-mark ones within each section —
and the extractor **refuses to write** unless the derived total is exactly 100
with GA at 15. A paper with a different structure fails loudly instead of
seeding bad marks.

Neither path touches the network, and neither stores question or option text.

## Everything configurable lives in one file

`config.seed.json` holds the exam dates, registration deadlines, marking
scheme, phase gates, rung definitions, target score and error classes. Editing
a gate date or the target requires no code change. The seeder is idempotent and
never touches user data.

The Ladder's arithmetic is re-checked on every seed — a rung table whose swings
do not reconcile with its cumulative scores would silently corrupt the
signature element of the app.

### Unverified values

`exam`, `registration` and `marking` carry
`_verified_against_brochure: false` and the UI shows a standing banner until
that is cleared. Every value in them is carried from the 2026 rules. **Check
them against the official GATE 2027 brochure before Phase 3** — the organising
institute changes for 2027 and section weights have moved before.

## Three decisions worth knowing about

**Marks lost is `available − obtained`.** A wrong 1-mark MCQ costs 1.33 (the
mark forgone plus the negative incurred); a skipped one costs 1.00. This makes
a bad attempt correctly worse than a blank, and makes negative marking visible
in the leak table instead of hiding inside the raw score.

**Scoring arithmetic runs in integer thirds.** Every quantity in GATE DA
marking is a multiple of 1/3, which has no exact binary representation.
Accumulating floats over six months of logs would drift. Marks are held as
integer thirds and divided once, at the display boundary.

**Procedural share excludes drills and untriaged rows.** M4 generates boundary
questions by construction, so counting them would drive the share toward 100%
and congratulate the user for practising. Untriaged rows have no verified error
class, so counting them would let the metric be improved by leaving hard
entries unlabelled. Both exclusions are tested.

## Layout

```
config.seed.json         every date, gate, rung and marking rule
src/domain/              pure, tested — nothing load-bearing outside here
  marking.ts             scheme + integer-thirds arithmetic
  scoring.ts             MCQ/MSQ/NAT scoring, per-option metrics
  ev.ts                  expected value, discipline violations
  calibration.ts         stated → observed confidence correction
  procedural.ts          the primary metric, leak table, incidence
  scheduler.ts           SM-2
  ladder.ts              rung fill from measured incidence
src/db/                  connection, migrations, seed, journal
src/scripts/             backup, restore, export, durability proof, importer
src/server/              Hono API
src/web/                 React shell + design tokens
tests/                   vitest
docs/DURABILITY.md
```

The four computations the spec requires to be correct are pure TypeScript, not
SQL. Nothing load-bearing is defined in a view, so nothing load-bearing escapes
the test suite.

## Content policy

No third-party question text, option text, or coaching material is stored
anywhere. The database keeps *your* record of a question: a reference (year,
paper, number), your own paraphrase, your working, your notes, and optionally a
path to a PDF you already own. The response-sheet importer reads question
numbers, types and your own answers, and deliberately drops the question text.
