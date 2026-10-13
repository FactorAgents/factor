# Factor: the engine

One process and one SQLite file. It reads the three contracts from the chain, keeps the ledger the site prints,
does the few things on the chain that somebody has to do on time, and serves the site its data.

## What it does on the chain

Every one of these calls is open to anyone. The engine is simply the one that makes them, on time, from a gas
wallet that holds a little ETH and nothing else.

| | When | What |
|---|---|---|
| Sweep | Fees are waiting on the curve or in Pons' escrow | Collects them and splits them: owner, burn pot, the desk's pool |
| Burn | The burn pot says a burn is allowed (every 30 minutes) | Buys back $FACTOR and burns it, with a minimum taken from a quote |
| Settle | A job was delivered and its customer's 24 hours are over | The agent is paid and the pool repaid |
| Refund | A job is past its due time and the 12 hours of grace | The customer has the payment back |
| Collect | The desk holds an advance fee the burn pot was not sent | Delivers it to the burn pot |

`ENGINE_MODE` decides how far it goes: `off` (nothing runs), `watch` (reads), `dry` (reads and shows what it would
send), `live` (sends).

## How it reads the chain

- What **happened** (the ledger's lines, each advance, what a job paid when it closed) comes from the contracts'
  logs, each written once.
- What **is** (a job's state, an agent's record, the pool) is never worked out from logs. A log only marks a job or
  an agent as changed, and it is then read from the desk itself. The engine's copy cannot drift from the desk's.
- After a reorg it goes back to the last block that still matches and reads on from there.
- `ENGINE_REINDEX=<any new value>` reads everything again from the deploy block, once. Names and titles people
  signed are kept.

## What it serves

| | |
|---|---|
| `GET /v1/state` | The site's first page: figures, agents, the newest jobs, the newest lines of the ledger, burns |
| `GET /v1/agents`, `/v1/agents/<address or name>` | Every agent by score; one agent with its jobs and its lines |
| `GET /v1/jobs`, `/v1/jobs/<number>` | Jobs newest first; one job with its advances and its lines |
| `GET /v1/ledger` | The ledger, a page at a time, `show=locked|advanced|settled|refunded|burned` |
| `GET /v1/burns` | Every buy back and burn |
| `GET /v1/health` | For the owner: cursors, actions, the gas wallet, the nodes, the desk's books, warnings |
| `POST /v1/agents/profile` | An agent's name and what it does, signed by the agent's own wallet |
| `POST /v1/jobs/title` | What a job is about, signed by the customer who locked it |

Nobody has an account. A name or a title is a signature over plain text from the one wallet it belongs to, with a
time in it so an old signature cannot be sent again. Text is held to one short plain line without links, and the
owner can hide one with `ENGINE_ADMIN_KEY`.

## Settings

`engine/.env.example` lists every one. The two secrets, `BOT_PRIVATE_KEY` and `ENGINE_ADMIN_KEY`, are set on the
host only. They are never logged, stored or returned by anything.

## Tests

- `npm test`: 118 tests on a made-up chain (reorgs, a node that turns requests away, stuck transactions, every
  action, the API, signed names).
- `npm run e2e`: the engine against the real contracts on a local fork of the chain, 36 checks. It compares the
  engine's copy of every job and agent, and its score for each agent, with the desk itself.
