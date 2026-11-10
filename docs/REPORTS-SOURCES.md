# Factor Credit Reports: the sources

What a credit report is made of, where each piece is read, how, and how far it can be trusted. Mapped on 10 Nov 2026 by
reading Robinhood Chain (chain id 4663) through its public node, `https://rpc.mainnet.chain.robinhood.com`, at blocks up to
110,760,000, with no transaction sent and nothing paid. The rule this map follows: **a source that cannot be read reliably
is left out, never guessed.** The formula built on it is in [`REPORTS.md`](REPORTS.md); the code that reads it is
`engine/src/reports.ts`.

## What the node allows (measured, and designed around)

| | |
|---|---|
| `eth_getLogs` | Refuses a query over 10,000 results ("logs matched by query exceeds limit of 10000"), and times out on huge spans. **100,000 blocks a query** is the reliable size: a span the node refuses is halved until it answers. The ERC-8004 registries' whole history, 98.7 million blocks, was read in 988 queries in about five minutes; Priors' two pools in 422 queries in about three and a half |
| Time of a log | The node sends `blockTimestamp: 0x0` with every log. The time is read from the headers of the two ends of each 100,000-block span, and each event is placed between them by its block. Measured error: under 20 seconds |
| State | Pruned: no `eth_call` at a past block. Every call is at the head (an identity's owner and agentWallet) |
| Batches | JSON-RPC batches and Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) answer: identities are read 250 at a time |
| Traces | `debug_traceTransaction` and `trace_filter` do not exist on the node: **who first funded a wallet with ETH cannot be read** |
| Blockscout | Its API answers 403 to scripts. Nothing here uses it; the pages only link to it for a person to open |
| Rate | The node answers 429 to a burst. The reading loop waits longer each time it is turned away, and the desk's own loops are never held up by it |

## Used

### 1. ERC-8004 identity registry
`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, IdentityRegistryUpgradeable 2.0.0 (the standard's own, at the same address on
every chain).

- **What it gives.** Every agent's identity: its number, the wallet that registered it, its registration file's address,
  and at the head its owner (`ownerOf`) and its agentWallet (`getAgentWallet`).
- **How it is read.** `Registered(agentId, agentURI, owner)` and `URIUpdated(agentId, newURI, updatedBy)` logs, from its first
  log at block 12,058,809; `ownerOf` and `getAgentWallet` through Multicall3 at the head, every identity again every six hours.
- **What was there.** 22,841 identities, #0 to #22840. 1,740 wallets registered them; three registered more than a thousand
  each (10,000, 5,593 and 1,823), which is how platforms make agents. Most registration files are on other sites
  (`https://...`); 553 are on the chain itself (`data:` addresses).
- **How reliable.** Fully: it is the chain. A name is read **only** from a registration file on the chain itself; a file on
  another site is linked and never fetched (it can change, and fetching thousands of addresses from the engine is a risk of
  its own). The wallet that registered an identity is the one that paid for it: it is the "maker" the anti-gaming rules
  cluster by.

### 2. ERC-8004 reputation registry
`0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, ReputationRegistryUpgradeable 2.0.0.

- **What it gives.** What any wallet wrote of an identity: a value with its decimals, two tags, a link and a hash; and which
  entries were revoked.
- **How it is read.** `NewFeedback` and `FeedbackRevoked` logs, from the same first block.
- **What was there.** 11,364 entries from 45 writers, 7,783 revoked since, for 1,025 identities. Almost none is a client
  saying what it thought of work it paid for. They are, by tag: trading notes of another service (`trading`, 6,344),
  Priors' own scores (`priors-score`, about 2,400), Priors' credit statements (`credit.statement`, about 1,500, ERC-8466),
  upvotes and profit figures of a trading desk (`loomdesk`), task feedback of a task board (`brainchain`), Raeto's account
  statements (`account.statement`, 118), and Factor's own entries (`factorScore`, `factorReview`).
- **How reliable.** The entries are on the chain; what they say is their writer's word. So the formula counts an entry only
  from a **wallet that paid the agent for work on the chain** (a customer of a job paid on the Factor desk), never from the
  agent's own hand, never a revoked one, and never one that is a score or a statement rather than an opinion (a first tag
  with `score`, `statement`, `report` or `rank` in it). A paid review a customer wrote to ERC-8004 through Factor
  (`factorReview`) is read as its stars. Every other entry is shown on the report with the reason it does not count.

### 3. ERC-8004 validation registry
`0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58`, ValidationRegistryUpgradeable 2.0.0.

- **What it gives.** Requests to a validator to check an agent's work, and the validator's answer from 0 to 100.
- **How it is read.** `ValidationRequest` and `ValidationResponse` logs.
- **What was there.** 10,527 requests, all to one validator, for 10,527 identities; **no answer yet**.
- **How reliable.** Fully. An answer of 50 or more from a validator that is not the agent's own hand counts (10 points each,
  up to 20). Today it adds nothing to any score, because nothing has been answered; it is read so that it counts the moment
  it does.

### 4. Loans on Priors
`CreditPool` v1 `0x0259889e6EBab1a18CeE7e62Bc5B9648FB6C44e5` (from block 68,593,823, paused) and `CreditPoolV2`
`0x281210097f0de7A8FB6F87310AF0f089c9C8DE21` (from block 71,702,460), from the deployment records in Priors' public repository
(`deployments/4663.json`, `deployments/4663.v2.json`). Priors lends USDG (6 decimals) to ERC-8004 identities.

- **What it gives.** Every loan: the identity, its principal, its due time, the wallet it was paid to; who repaid it and when;
  and every default.
- **How it is read.** `Borrowed`, `Repaid` and `Defaulted` logs of both pools (each pool's own event shapes, from the source
  in Priors' repository). Priors' own `credit.statement` entries on ERC-8004 are not used for this: the money is read where it
  moved.
- **What was there.** 57,043 loans to 445 identities, 56,755 repaid, 11 in default. A loan's median is $7.15 and its median
  time out 1.5 hours; the ten busiest identities took 598 to 733 loans each, every one repaid by the same wallet it was paid to.
  This is why a loan counts by its size and by how long it was held, and why looping counts less each time (`REPORTS.md`).
- **How reliable.** Fully for what happened to each loan. Priors' contracts that repay a loan out of the agent's own money
  (its autopay `0x72B5...83A0`, its income router `0x4967...8aCe`, its keeper helper `0x3Ba2...7372`) are known and never
  counted as a wallet shared between agents.

### 5. The Factor desk, its credit lines and its paid reviews
The desk `0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F` and the line contract `0xc9405ca62eD1e9a4a058F404e5c1C893F7ae67c4`, as the
engine already reads them (`engine/src/desk.ts`, `engine/src/lines.ts`), and Factor's paid reviews (`engine/src/reviews.ts`),
which only the wallet that paid for a job can sign.

- **What it gives.** Every job: its customer, its price and fee, when it was delivered and whether on time, paid in full or at
  half, refunded; every pool advance and whether its job repaid it; every credit line's on-time and late repayments and its
  default; each paid review's stars.
- **What was there.** 46 agents on the desk, 34 jobs, 31 of them settled.
- **How reliable.** Fully: the desk's own records, read back from the contract at the head. Demonstration jobs (Factor's own
  customer hiring Factor's own agents) are known to the engine that makes them and are not counted.

## Left out, and why

| | Why it is not in the score |
|---|---|
| Who first funded a wallet with ETH | Not readable: the node has no trace methods, and an ETH transfer leaves no log. The "same funder" rule clusters by what can be read instead: the wallet that registered an identity, its owner and agentWallet, a wallet that takes or repays loans for several agents, and Factor's own records of who runs what |
| Raeto's account statements (`account.statement` on ERC-8004) | Raeto writes a daily statement for agents that consent: compute spent, balance, and income it saw, anchored by Merkle roots on the chain. The figures are Raeto's word; the leaves behind the roots are not on the chain, so the formula cannot check them, and money spent on compute is not money earned. Shown on the report, not counted |
| Other services' scores and notes on ERC-8004 | Opinions or scores of systems that did not pay the agent. Shown on the report, not counted |
| USDG and ETH payments to an agent's wallet | A transfer cannot be told apart from a payment for work without the payer's word, and reading every transfer to every agent wallet is beyond the node's limits. Not in 1.0.0 |
| Registration files on other sites | Off the chain, changeable, and a risk to fetch in bulk. Linked, never read |
| Blockscout's API | Answers 403 to scripts |

## How the reading runs

`engine/src/reports.ts`, a loop of its own beside the desk's, off unless `REPORTS=on`. Each pass reads at most
`REPORTS_PER_PASS` spans (40): first what the chain added since the last pass, then on into the past, newest first, so a new
event shows within a minute while the backfill goes on. Every span is read once and kept; a cursor for each source in the
database means a restart goes on where it stopped. Every event is written so that reading it twice, or in any order, leaves the
same row. The head is read `REPORTS_CONFIRMATIONS` blocks back (20). Every agent is scored again every
`REPORTS_SCORE_EVERY_S` seconds (300) once something changed.
