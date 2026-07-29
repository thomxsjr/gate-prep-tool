# Deploying

## What gets deployed, and what deliberately does not

The app is local-first: SQLite on disk, an fsynced write journal, and a
durability proof. Serverless hosts have **no persistent disk**, so running the
live API on one would accept writes and lose them between invocations — the
exact failure `npm run verify:durability` exists to catch. It would also break
the offline requirement and put a personal error log behind no auth.

So the deployed artifact is a **read-only snapshot**, matching the split the
spec already names: *log on a laptop, revise on a phone.*

| | Local (`npm run dev`) | Deployed snapshot |
|---|---|---|
| Deck, Ladder, procedural share | yes | yes |
| Error log, leak table, morning review | yes | yes, read-only |
| Flashcard review | yes | read-only |
| Formula sheet + recall test | yes | yes |
| Boundary drills | yes | **yes** — pure seeded functions, no server |
| Recording a drill run | yes | no |
| Capture, triage, CSV import | yes | refused with a clear message |
| MSQ trainer, mock entry, settings | yes | no |

Writes are **refused**, never accepted-and-dropped. Silently discarding a write
would be worse than not offering the button.

## Connect the repo to Vercel (recommended)

Everything is committed and tested. In Vercel: **Add New → Project → import
this repo → Deploy.** `vercel.json` supplies the rest.

The build command is `npm run deploy:ci`, which:

1. runs migrations against a fresh database,
2. restores from the committed `data/export/gate-export.json`,
3. builds the snapshot,
4. builds the static site.

`gate.db` is gitignored, so the deploy reconstructs it from the committed
export — one source of truth for deployed data, and it exercises the restore
path on every deploy. Verified from a clean checkout with no `gate.db` present.

Every push to the branch redeploys, so the phone catches up automatically.

### Make it private

The deployed page contains your error log. Vercel's **Settings → Deployment
Protection → Vercel Authentication** limits it to your own account, which is
the right default for this.

## Refresh the snapshot without deploying

```bash
npm run deploy:build     # snapshot + static build into dist/
npx serve dist           # or any static server
```

The snapshot is frozen at build time; the banner in the deployed app states
when. Re-run and redeploy whenever the phone should catch up.

## Why not a hosted database

Swapping `better-sqlite3` for a hosted libSQL/Postgres would make the deployed
app fully read-write, and the repository layer is small enough that the change
is contained. It is deliberately not done here because it trades away three
things the spec asks for by name: offline operation, no cloud dependency, and
no accounts. If those constraints ever change, the seam to cut is
`src/server/repo.ts` — every query lives there, and the four load-bearing
computations are pure functions that do not touch the database at all.
