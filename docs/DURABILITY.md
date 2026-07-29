# Durability

Six months of error logs is the most valuable thing in this project. The
database is a derived artifact; the journal and the exports are the asset.

## Three independent copies

| Artifact | Path | Written | Committed | Survives |
|---|---|---|---|---|
| SQLite database | `gate.db` | every write | no | nothing — it is the thing that fails |
| Write journal | `data/journal/YYYY-MM.jsonl` | every write, fsynced | **yes** | corrupt db, SQLite upgrade, lost laptop |
| Canonical export | `data/export/gate-export.json` | `npm run backup` | **yes** | same, and is the restore path |
| Timestamped backup | `data/backups/gate-<stamp>.{db,json}` | `npm run backup` | no | accidental deletion, bad migration |

The journal and the export are committed because they are text: diffable,
readable without tooling, and recoverable from any git clone. The `.db` binary
is gitignored — committing it would produce unreadable diffs and merge
conflicts on a file that can be rebuilt from either text artifact.

## Settings that matter

- `journal_mode = WAL` — readers never block the writer; a crash mid-write
  rolls back to the last committed transaction instead of tearing the file.
- `synchronous = FULL` — fsync on every commit. This is a laptop that gets
  closed mid-sentence; the microseconds are worth it.
- `foreign_keys = ON` — enforced at all times, and re-checked after a restore.
- The journal is `fsync`ed per append, so a crash cannot leave a torn line.

## Commands

```bash
npm run backup            # timestamped .db + .json, refreshes the canonical export
npm run restore           # from data/export/gate-export.json
npm run restore -- --latest   # from the most recent timestamped backup
npm run restore -- --force    # required when the target database is not empty
npm run export            # canonical export only, no timestamped copy
npm run verify:durability # the proof, end to end
```

`restore` refuses to run over a non-empty database without `--force`. The one
thing worse than losing the error log is overwriting it with an older copy.

## The proof

`npm run verify:durability` runs the full cycle in an isolated sandbox
(`GATE_DB` and `GATE_DATA_DIR` are redirected to a temp directory, so the live
`gate.db` is never touched):

1. migrate and seed a fresh database
2. write representative rows across the schema — questions, options, a mock, a
   triaged error-log attempt with per-option verdicts, a card, a session, a
   rung item
3. export and hash
4. back up
5. **delete the database file**
6. restore from the JSON export
7. re-export, and compare content hashes

The hash excludes `exported_at`, so it compares data and nothing else. Any
mismatch exits non-zero and keeps the sandbox for inspection.

Current status: **13/13 checks pass.**

```
1. build      migrations applied · seed loaded
2. write      47 rows across the schema
3. back up    .db + .json · canonical export · hash matches · journal populated
4. destroy    database deleted
5. restore    47 rows across 13 tables · foreign keys intact
6. compare    row count identical · content hash identical · content verbatim
```

## Test isolation

`tests/setup.ts` redirects `GATE_DATA_DIR` to a temp directory before any test
imports `src/db/index.ts`. Without it, every test that seeds or captures
appends to the real journal from a throwaway database.

This is not hypothetical: it happened. A test run wrote thousands of entries
describing attempts that never occurred, and the journal reached 22,558
entries against ~120 real writes — 6,048 question inserts where the truth was
65. The database and the canonical export were never affected, but a rebuild
from the journal would have produced fabricated data. The journal has since
been reconstructed from the real writes only, and the setup file prevents a
recurrence.

If you add a script that writes outside the test suite, point it at a temp
`GATE_DATA_DIR` too unless the write is genuinely yours to keep.

## Recovering from nothing

If `gate.db` is gone and you have a git clone:

```bash
npm install
npm run restore          # rebuilds from the committed export
```

If the export is stale, the journal holds every write since. It is JSONL — one
object per line, `{ts, op, table, id, data}` — and can be replayed or read by
hand.
