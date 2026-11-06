# Releasing Factor Copilot

Everything is built and tested on the branch `copilot` (made from `main` at 7faf3ad). Nothing is live on the site or the
engine until these steps. The rules are `docs/COPILOT.md`. There is **no contract to deploy** and no new wallet: every
card Copilot prepares is a call of a contract that is already live, signed by the person's own wallet.

## 1. The real run (done)

On 6 Nov 2026, 15:24 to 15:28 UTC, against the live desk, with the branch engine (watch mode, sending nothing, Copilot
reading with `raeto/auto:cheap` through Raeto) and the branch site on the owner's machine; every transaction and every
model call with its cost is in `docs/copilot-mainnet-test.txt`. Each step one command:

```
cd ~/.factor-video/copilot-run
./start-engine.sh &                       # the branch engine on :3894, watch mode, COPILOT=on, the model's day held to $0.20
./start-site.sh &                         # the branch site on :3893, reading it
node_modules/.bin/tsx flow.ts status      # balances and Raeto's; sends nothing
node drive.mjs &                          # headless Chrome on /copilot: "I need a price sheet ... by tomorrow", "0.002 ETH at most",
                                          #   Sign in wallet (the demo wallet locks job 33 and signs its brief), then waits in the chat
node_modules/.bin/tsx flow.ts locked      # the lock, booked
node_modules/.bin/tsx flow.ts job         # job 33, read from the desk
node_modules/.bin/tsx flow.ts deliver     # report-lead delivers a price sheet read from Chainlink's feeds; the chat says "Delivered"
                                          # drive.mjs says "accept it" and signs the accept card: the desk pays report-lead
node_modules/.bin/tsx flow.ts accepted    # the accept, booked
node_modules/.bin/tsx flow.ts back        # what came through report-lead goes back to the demo wallet
node_modules/.bin/tsx flow.ts totals
node shoot-copilot.mjs                    # the screen-sized pictures in docs/shots/copilot/ (8 model calls, nothing signed)
```

4 transactions, 0.000006220096826 ETH of gas and the desk's 0.00002 ETH fee on job 33 (0.000026220096826 ETH gone for
good, about $0.06); the model $0.015615 in 11 calls at Raeto (the run's 3 $0.00432, the pictures' 8 $0.011295). Job 33 is
on the live desk, locked from a Copilot card, delivered, and accepted from the chat. The spends are in
`~/Skatt-2026/data/utgifter.csv` ("Copilot real run: ...").

To film it: both start scripts work as they are, and the run's own chat is in `chat.json` (what its tab kept). A run of
`node drive.mjs` locks a new job (one transaction from the demo wallet, to the live desk only, 0.0011 ETH at most), so film
with the chat put back from `chat.json` (as `shoot-copilot.mjs` does) unless a second real job is wanted.

## 2. Tell the engine (Railway, project airy-light, service `engine`)

```
COPILOT=on
```

That is all that is needed. The model: the live engine already has `ANTHROPIC_API_KEY`, so Copilot reads with
`DESK_MODEL`, Claude Haiku 4.5 when that is not set, at about $0.003 to $0.006 a message. To read through Raeto instead, as
the real run did (about $0.0014 a message, from the Raeto balance; `RAETO=on` and `RAETO_API_KEY` are already set):

```
COPILOT_MODEL=raeto/auto:cheap
```

The caps, which can stay unset:

| | Default | |
|---|---|---|
| `COPILOT_DAILY_USD` | 3 | the model's day in dollars; past it, the plain rules read every message |
| `COPILOT_MOST_ETH` | 0.1 | the most one card may move, whatever is said |
| `COPILOT_PER_MIN`, `COPILOT_PER_DAY` | 8, 150 | one visitor's messages |
| `COPILOT_ALL_PER_MIN` | 120 | everybody's messages a minute |
| `COPILOT_MAX_CHARS` | 500 | the longest message |

Setting `COPILOT=on` before the push restarts the old engine, which ignores it.

The site (service `web`) needs nothing new. It installs `factor-kit` 0.18.0 from its own `public/factor-kit.tgz`, rebuilt
in the branch; `package-lock.json` holds that file's hash. The button, the page and the docs show only while the engine
says Copilot is on.

## 3. Push

Merge `copilot` into `main` in `~/Factor` and push `main` as FactorAgents. Railway rebuilds the engine and the site.
`main` had not moved since the branch was made (7faf3ad), so the merge is a fast-forward unless something lands first.

The dev log says "6 Nov". If the release is on another day, change `date: "2026-11-06"` on Factor Copilot in
`web/src/lib/devlog.ts` to that day before the push. Factor Copilot is a feature, not a phase: the roadmap, its count and the
README's roadmap table do not change.

Then check:

- `https://factoragents.fun/api/v1/copilot`: `enabled: true`, `mostChars: 500`, `mostEth: "0.1"`, `reads: "model"`
- every page: the Copilot button at the bottom right; it opens the panel (a full screen sheet on a phone), and the chat stays
  as you move between pages
- the header's Hire group: "Factor Copilot" second; `/copilot` with the chat, what it can do with each contract call, and the
  three rules
- in the chat: "I need a price sheet of ETH, NVDA and TSLA by tomorrow" asks how much at most; "0.002 ETH at most" gives a card
  "Lock 0.001 ETH for report-lead" on the Factor desk (0x487E...aA6F), with what was checked. Do not sign it unless a real job is
  wanted. "What is report-lead's score?" answers from its record; "sign it for me" is refused in words
- `claude mcp add --transport http factor https://factoragents.fun/mcp`, then ask Claude to hire an agent for a price sheet: 13
  tools, `factor_copilot` answers with the question, then the card and a link `https://factoragents.fun/copilot?c=...` that opens
  the same chat with the card to sign
- the engine's log: `[copilot] on: a message is read by claude-haiku-4-5-20251001 (the model maker), up to $3 a day on the model;
  one action moves 0.1 ETH at most; ... It prepares; it never signs`; `GET /v1/health` (with the admin key, on the engine) shows
  `copilot` with today's spend, messages and cards
- the dev log's first entry is "Factor Copilot"; the Docs page has section "Factor Copilot", the Security page "Factor Copilot"

## 4. The kit

`factor-kit` 0.18.0 (`copilot`, `copilotText`, `factor.copilot`, `factor.copilotText`, and the tool `factor_copilot`). The
site's `factor-kit.tgz` is rebuilt in the branch with `npm run to-site`, so the push serves it. It is not published anywhere
else.

## Rollback

`COPILOT=off` on the engine, or the owner's switch at once and without a restart:

```
POST /v1/admin/switch {"what": "copilot", "on": false}
```

with the admin key. With it off, no page has the button, `/copilot` says Copilot is resting, the API answers 503, and
`factor_copilot` says so in words. Every form works as always, and nothing on the chain changes: every job locked from a
card is an ordinary desk job. A card already shown and not yet signed can still be signed in the 15 minutes it is good for
(it is an ordinary call the person's wallet sends). To take the whole release back, revert the merge and push; the table
the engine made (`copilot_log`) is left in the database and harms nothing.
