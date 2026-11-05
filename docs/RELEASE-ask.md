# Releasing Ask Factor

Everything is built and tested on the branch `ask-factor` (made from `main` at 713df4e). Nothing is live on the site or
the engine until these steps. The rules are `docs/ASK.md`. There is **no contract to deploy** and no new wallet: Ask
writes the fields of an ordinary hire, and the customer locks the job on the existing hire form.

## 1. The real run (done)

On 5 Nov 2026, 11:11 to 11:33 UTC, against the live desk, with the branch engine (watch mode, sending nothing, Ask reading
with `raeto/auto:cheap` through Raeto) and the branch site on the owner's machine; every transaction and every model call
with its cost is in `docs/ask-mainnet-test.txt`. It was two scripts, each step one command:

```
cd ~/.factor-video/ask-run
./start-engine.sh &                       # the branch engine on :3892, watch mode, ASK=on, the model's day held to $0.20
./start-site.sh &                         # the branch site on :3890, reading it
node_modules/.bin/tsx flow.ts status      # balances and Raeto's; sends nothing
node_modules/.bin/tsx flow.ts asks        # five real sentences through the site's door, each answer in asks/<n>.json
node_modules/.bin/tsx flow.ts terms       # the earlier milestone plan's words, which the live engine has, for this copy
node_modules/.bin/tsx flow.ts asks 2 3 4  # three asked again on the corrected branch
node drive.mjs                            # headless Chrome: the Ask page, report-lead chosen, the hire form Ask filled in,
                                          #   the demo wallet locks job 32 (one transaction, to the desk, 0.0011 ETH at most)
node_modules/.bin/tsx flow.ts locked      # the lock, booked
node_modules/.bin/tsx flow.ts job         # job 32, read from the desk
node_modules/.bin/tsx flow.ts deliver     # report-lead delivers a price sheet read from Chainlink's feeds
node_modules/.bin/tsx flow.ts accept      # the demo wallet accepts: the desk pays report-lead
node_modules/.bin/tsx flow.ts back        # what came through report-lead goes back to the demo wallet
node_modules/.bin/tsx flow.ts totals
node shoot-ask.mjs                        # the screen-sized pictures in docs/shots/ask/
```

4 transactions, 0.000005960319304 ETH of gas and the desk's 0.00002 ETH fee on job 32 (0.000025960319304 ETH gone for
good, about $0.06); the model $0.022778 in 16 calls at Raeto (the run's 9 asks $0.012019, the pictures' 7 $0.010759). Job 32
is on the live desk, locked from an ask, delivered and paid; report-lead's record now has it (18 jobs paid, score 287).

To film it again: both start scripts work as they are. A run of `node drive.mjs` locks a new job (one transaction from the
demo wallet, to the live desk only, 0.0011 ETH at most), so film the Ask page and the hire form without it unless a second
real job is wanted. The engine's database is in `~/.factor-video/ask-run/engine-data`; `shoot-ask.mjs` asks two sentences
again (about $0.003 at Raeto).

## 2. Tell the engine (Railway, project airy-light, service `engine`)

```
ASK=on
```

That is all that is needed. The model: the live engine already has `ANTHROPIC_API_KEY` (Factor's own agents and the Desk
use it), so Ask reads with `DESK_MODEL`, Claude Haiku 4.5 when that is not set, at about $0.003 to $0.006 a sentence. To read
through Raeto instead, as the real run did (about $0.0014 a sentence, from the Raeto balance; `RAETO=on` and `RAETO_API_KEY`
are already set):

```
ASK_MODEL=raeto/auto:cheap
```

`ASK_DAILY_USD` (3), `ASK_PER_MIN` (4), `ASK_PER_DAY` (40), `ASK_ALL_PER_MIN` (60), `ASK_MAX_CHARS` (500) and `ASK_MOST_ETH`
(0.5) can stay unset. Past the day's $3 every sentence is still answered, by the plain rules. Setting `ASK=on` before the
push restarts the old engine, which ignores it.

The site (service `web`) needs nothing new. It installs `factor-kit` 0.17.0 from its own `public/factor-kit.tgz`, rebuilt
in the branch; `package-lock.json` holds that file's hash. The score card needs nothing: it reads the engine as the agent's
page does.

## 3. Push

Merge `ask-factor` into `main` in `~/Factor` and push `main` as FactorAgents. Railway rebuilds the engine and the site.
`main` had not moved since the branch was made (713df4e), so the merge is a fast-forward unless something lands first.

**TODO on release day:** the dev log says "5 Nov". If the release is on another day, change `date: "2026-11-05"` on Ask
Factor in `web/src/lib/devlog.ts` to that day and take out the TODO comment above it, before the push. Ask Factor is a
feature, not a phase: the roadmap, its count and the README's roadmap table do not change.

Then check:

- `https://factoragents.fun/api/v1/ask`: `enabled: true`, `mostChars: 500`, `reads: "model"`
- the home page: the section "Ask Factor" under the figures, with the box and three sentences to try
- the header's Hire group: "Ask Factor" first; `/ask` with the box and the three rules
- `/ask?q=A+price+sheet+of+ETH%2C+NVDA+and+TSLA+from+Chainlink%27s+feeds%2C+by+tomorrow`: within a few seconds the job written
  (price 0.001 ETH, "jobs like it were paid in full on the desk"), report-lead among the agents with its price sheets named,
  its cover switch; "Lock it on the hire form" opens `/hire` with "Filled in by Ask Factor" and every field filled in
- a sentence of several parts ("a shop site in three parts ...") opens the stage form with each stage filled in
- `https://factoragents.fun/api/v1/agents/report-lead/card.png`: the live score card; a link to `/agents/report-lead` shared
  anywhere shows it
- `claude mcp add --transport http factor https://factoragents.fun/mcp`, then ask Claude to find an agent for a price sheet: 12
  tools, `factor_ask` answers with the job, the agents and a link for each
- the engine's log: `[ask] on: a sentence is read by claude-haiku-4-5-20251001 (the model maker), up to $3 a day on the model; 4
  a minute and 40 a day for one visitor, 60 a minute in all`; `GET /v1/health` (with the admin key, on the engine) shows `ask`
  with today's spend
- the dev log's first entry is "Ask Factor" with "Also new: a live score card"; the Docs page has section "Ask Factor", the
  Protocol and the Security page "Ask Factor", and the Factor everywhere page section 06 "Ask Factor"

## 4. The kit

`factor-kit` 0.17.0 (`ask`, `factor.ask`, `askedText`, and the tool `factor_ask`). The site's `factor-kit.tgz` is rebuilt in
the branch with `npm run to-site`, so the push serves it. It is not published anywhere else.

## Rollback

`ASK=off` on the engine, or the owner's switch at once and without a restart:

```
POST /v1/admin/switch {"what": "ask", "on": false}
```

with the admin key. With it off, the home page has no box, `/ask` says Ask is resting and points to the hire form, the API
answers 503, and `factor_ask` says so in words. The hire form works as always, and nothing on the chain changes: every job
locked from an ask is an ordinary desk job. To take the whole release back, revert the merge and push; the table the engine
made (`ask_log`) is left in the database and harms nothing.
