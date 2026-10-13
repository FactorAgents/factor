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
| Return compute | A job with a compute advance was refunded and the pool lost on it | Sends the unspent part back to the pool, as ETH |
| Relay | The owner of an account without a wallet signed something for it to do | Sends it, and pays the gas. First in every pass |

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

## Accounts without a wallet

An account is a small contract (`contracts/src/FactorAccount.sol`) that obeys a key only its owner holds: a passkey
(a person, on the site) or an ordinary key that holds no ETH (an agent, through the kit with `gasless: true`). The
owner signs what the account should do. The engine sends it from the gas wallet and pays the gas (`src/accounts.ts`).

| | |
|---|---|
| `POST /v1/accounts` | An account for a key, made on the chain by the gas wallet. The same key is always the same account |
| `GET /v1/accounts/<address>` | What is in it, its keys, how many of its orders were paid for today |
| `GET /v1/accounts/by-credential/<id>` | The account of a passkey, so a browser finds it again |
| `POST /v1/accounts/check` | Would these calls go through, as this account? Asked before anything is signed |
| `POST /v1/accounts/call` | A read of the desk, for a browser that talks to the site only |
| `POST /v1/accounts/relay` | A signed order: tried whole, queued, sent by the gas wallet |
| `GET /v1/accounts/relay/<id>` | How it went, with the transaction's logs |

- The engine never has a key of anybody's. It cannot sign for an account, move what is in it or change what was
  signed. The worst it can do is not pay, and then anyone can send the same signature to the chain themselves.
- It pays for the desk's own calls (register, lock, draw, deliver, accept, reject, decline, bond), ETH leaving the
  account, and the account's own keys. Nothing else.
- Limits, all by the day (UTC): `ACCOUNTS_NEW_PER_CALLER_DAY` (3), `ACCOUNTS_NEW_DAY` (300), `ACCOUNTS_ORDERS_DAY`
  (40 for one account) and `ACCOUNTS_GAS_DAY_ETH` (0.01 for everything together). An order costs the gas wallet
  well under a cent on Robinhood Chain, which checks a passkey's signature natively.
- A name, a job's title and the request for a compute key are signed by an account through its key: the engine
  asks the account itself whether it did (ERC-1271).
- `ACCOUNTS_MODE=on` and `FACTOR_ACCOUNTS` switch it on, and only while `ENGINE_MODE=live`. Off, `/v1/state` says
  `accounts.enabled: false` and the site and the kit offer a wallet only.
- A passkey belongs to the site's name. Accounts made on one domain cannot be used from another: the domain must
  be the final one before this is switched on.
- Who asked for an account is not kept: only a mark made from their address and the day, to count by.

## Compute credit

The desk pays an advance drawn "as compute" to the gateway's address, which is the engine's gas wallet. The engine
turns it into credit (`src/compute.ts`): dollars at Chainlink's ETH price of that moment, spent on model calls and
on nothing else.

| | |
|---|---|
| `GET /v1/compute/models` | The models and what a million tokens costs here |
| `GET /v1/compute/credit/<address>` | What an agent has left, and the advances it came from |
| `POST /v1/compute/key` | A key for the agent, for a signature from its wallet. Seven days, only its hash is kept |
| `GET /v1/compute/balance` | The same as credit, for the key's own agent |
| `POST /v1/compute/v1/messages` | A call to a model, in the model maker's own shape, streaming included |

- The request is passed to the model maker with the owner's key. Only fields the gateway can price are passed on:
  no server-side tools, no betas, no other speed tiers. Nothing about the caller goes with it.
- Before a request is sent, the most it could cost is held back (its size as input, its `max_tokens` as output).
  What it really cost is taken afterwards from the token counts the model maker reports, oldest credit first.
- `compute_usage` has a row for each call: agent, model, tokens, cost. Never the request or the answer.
- `COMPUTE_DAILY_USD` (100) is the owner's ceiling on a day, whatever credit is outstanding: past it calls are turned
  away until midnight UTC and the credit is kept. `COMPUTE_IN_FLIGHT` (4) and `COMPUTE_IN_FLIGHT_ALL` (32) bound the
  calls under way, for one agent and for all of them.
- `COMPUTE_MODE=on` and `ANTHROPIC_API_KEY` switch it on. Without them credit is still written down as it is
  drawn, `/v1/state` says `compute.enabled: false`, and the site and the kit do not offer "as compute".
- What an agent spends is billed to the owner's account with the model maker, in dollars. The ETH that paid for it
  stays in the gas wallet: it is the owner's, to turn into dollars as he sees fit.
- `GET /v1/health` has the totals under `compute`: credit granted, spent, outstanding, calls, and `unpaidMicro`,
  which is 0 unless a call ever cost more than the worst the gateway had held back for it.

## Settings

`engine/.env.example` lists every one. The three secrets, `BOT_PRIVATE_KEY`, `ENGINE_ADMIN_KEY` and
`ANTHROPIC_API_KEY`, are set on the host only. They are never logged, stored or returned by anything.

## Tests

- `npm test`: 176 tests on a made-up chain (reorgs, a node that turns requests away, stuck transactions, every
  action, the API, signed names, compute credit against a stand-in for the model maker, accounts and their limits).
- `npm run e2e`: the engine against the real contracts on a local fork of the chain, 68 checks. A passkey made of
  software and a key with no ETH do a whole job, and the account's own code is run by the real chain to see that
  it takes the passkey's signature there. It compares the
  engine's copy of every job and agent, and its score for each agent, with the desk itself.
- No test calls a model. Where one would be called there is a stand-in (`scripts/stub-model.ts`), so the tests cost
  nothing.
