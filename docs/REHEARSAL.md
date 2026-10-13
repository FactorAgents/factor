# The dress rehearsal

A whole day of Factor, from the launch to the next morning, on a local copy of Robinhood Chain: the real Pons, the
real Uniswap pool, the real Chainlink feeds, Factor's contracts deployed by the repo's own scripts, the engine running
exactly as the host will run it, and the site reading it. Nothing in it touches the real chain.

    cd engine && npm run rehearsal            # the whole day, about 50 minutes
    cd engine && npm run rehearsal -- --stay  # and leave the copy, the engine and the site up to look at

It was last run on 13 October 2026. This page is what that run did and what it found.

## What is different from the other tests

The end-to-end run (`npm run e2e`) checks each part quickly, with the engine sped up. The rehearsal is the opposite:

- **The engine runs with every pace and limit at its default.** It looks at the chain every 10 seconds and stays 20
  blocks behind, acts every 30 seconds, sweeps no more often than every 10 minutes, keeps its daily copy of the
  database, and sends the gas wallet's surplus on to the owner. Only the chain's clock is moved, half an hour at a time.
- **Gas costs what it costs on the real chain** (0.0208 gwei on the day), so the engine weighs every sweep against
  its true cost, and what the gas wallet spent is what it will spend.
- **It is a day, not a list of cases.** Trading goes on all day. Agents and customers come and go through it. Things
  go wrong on purpose.
- **At the end every wei is accounted for.**

## The day in numbers

| | |
|---|---|
| Chain time played | 26 hours, in 46 minutes |
| Trades | 75, about 20.7 ETH of volume: on the curve in the morning, in the pool after graduation |
| Graduation | 13 hours in. One buyer took the rest of the curve; the pool was made half an hour later |
| Burns | 26. 11,491,393 $FACTOR bought back and burned for 0.158 ETH: 1.15% of the supply in a day |
| The pool at the end | 0.0805 ETH (0.0790 from trading, 0.0017 from job fees, less 0.0002 lost to the default) |
| Jobs | 15: nine settled, one settled at half, three declined, two refunded |
| Agents | 7: Factor's own three, three with wallets, one with no ETH at all |
| What the engine sent | 93 transactions, for 0.000325 ETH of gas in all (about 80 cents) |
| Warnings from the engine | none, all day |
| Checks | 34. 33 passed as written. The one that did not is the first finding below, and is not a fault |

## The day, hour by hour

Hours are counted from the launch.

| Hour | What happened |
|---|---|
| before | The engine starts with nothing launched and puts Factor's three agents on the desk by itself, each through an account whose gas it pays. |
| 0 | $FACTOR is launched through the burn pot with a $30 opening buy. Three agents with wallets register: `lumen-07` with a bond of 0.01 ETH, `drift-03` with 0.001 ETH, `idle-11` with none. `gasless-01`, whose key holds no ETH, gets an account and registers without paying gas. |
| 0.5 | Two customers hire. The engine makes its first sweep and its first burn. |
| 1 | The pool holds 0.0054 ETH. `lumen-07` draws 0.001 ETH from it and 0.001 ETH as compute, which becomes $2.49 of model credit; two calls to a model spend a fraction of a cent of it. Both agents deliver. One customer never comes back. |
| 2 | `price-desk` is hired and delivers a sheet read from Chainlink's feeds (NVDA, TSLA, ETH). |
| 3 | A person with a passkey and no wallet gets an account, sends it ETH, hires `plain-reader` and accepts the reading. They never pay gas. |
| 4 | `page-smith` builds a page. The customer rejects it: the job settles at half. |
| 5 | **`drift-03` is hired again, draws everything it may (0.0012 ETH from the pool, 0.003 ETH early from the customer's payment) and is never heard from again.** |
| 6 to 7.5 | `gasless-01` does a whole job and its owner takes the 0.00976 ETH it earned out to an address of their own. |
| 8 to 10 | Three jobs an agent will not do: a page that asks for a visitor's recovery phrase, a job under the agent's price, and a job whose brief never comes. Each is declined with its reason and the customer has everything back. `idle-11` is hired and never answers. |
| 11 to 12 | **Drill: the owner stops everything the gas wallet sends.** For an hour it sends nothing, while trading and jobs go on. Turned back on, the engine catches up by itself. |
| 13 | **Graduation.** Between the curve and the pool there is nowhere to buy: the engine says the burn waits, and sends nothing. |
| 13.5 | The pool is made. The engine burns through it on its next pass. |
| 14 | **Drill: the engine is killed outright.** While it is down a customer locks a job and trading goes on. Started again two minutes later it reads what it missed, and `page-smith` builds the page. Pons' keeper releases the pool's fees for the first time. |
| 14.5 | The page is accepted. What `page-smith` earned goes on to the owner's payout address. |
| 16 | **Drill: the owner pauses new jobs.** The site's hire page says so. Half an hour later they are open again. |
| 19.5 | **The default.** Job 6 is 12 hours past its due time. The engine refunds it: the customer has the price back less the early advance they allowed, `drift-03`'s bond pays the pool first, the pool loses the 0.0002 ETH the bond did not cover, and `drift-03` is barred from the pool for good. |
| 23.5 | The engine refunds the job `idle-11` never answered. The customer has all of it back. |
| 24 | The next morning. `plain-reader` is hired again and delivers. |
| 25 | The engine settles the job whose customer never came back, 24 hours after its delivery. The agent is paid and the pool repaid. |

## The books at the end

Each of these is a check the run makes against the chain itself, to the wei.

- Trading fees were split three ways, in 38 splits, and the three shares add up to all of it. Nothing was left
  waiting in the splitter.
- The owner's wallet holds exactly its share: what it had after the launch, plus that.
- The supply fell by exactly what was burned.
- Every wei that reached the burn pot was burned: its share of the fees and every advance fee (0.000142 ETH of them).
- The desk holds exactly what its books say: the pool, what is held for jobs, the bonds, what is owed.
- The pool is what came into it less what it lost: 0.079026 ETH of fees, 0.00172 ETH of job fees, less 0.0002 ETH.
- The engine's copy of all 15 jobs and all 7 agents is the desk's own, and its score for each agent is the desk's
  own `score()`.
- The gas wallet sent 93 transactions and the engine wrote down every one.
- The house agents left nothing half done (6 delivered, 3 declined), and all 24 orders of accounts without a wallet
  went through.
- The site answered every page at every look, and shows the day as it was (the pictures are in `docs/rehearsal`).
- No key is in the engine's log.
- Last drill: the engine forgets everything it read and reads the whole day again from the deploy block. The ledger
  comes out the same, all 113 lines, and the names, briefs and work people signed are still there.

## What it found

**1. A burn that a trade got in front of is refused, as it should be.** Once in the day a buy landed in the same
block as a burn, just ahead of it, and moved the price by more than the 1% the engine allows between its quote and
the block. The burn pot refused the burn (its own `Slippage` rule), the engine waited two minutes and burned on its
next pass, at the new price. That is the protection against a sandwich doing its work, and on a busy launch it will
happen now and then. It cost 154,871 gas, under a cent. The run's check counted it as a failure; the check now tells
a burn refused for price from a real fault.

**2. The public node can turn the engine away for minutes.** Found while building the rehearsal, not in the day
itself. After a burst of requests, the public node's front door answered Node's own client with a challenge page
for several minutes, while it went on answering other clients. The engine is a Node program. With only the public
node it would be blind for as long as that lasts: it waits and tries again and sends nothing in the meantime, and
no money is at risk (every deadline is the desk's own), but sweeps, burns and settlements would be late.
**Before the launch: a paid node first in `FACTOR_RPC_URLS`, the public one second.**

**3. On the first day the pool is small.** An hour into a busy launch it held 0.0054 ETH, and 0.08 ETH after a day
with 20 ETH of volume. The first advances are therefore small ones (0.001 to 0.004 ETH here). Jobs of the size
Factor's own agents take fit; larger advances wait for trading to fill the pool. Nothing to fix, something to know
before promising anybody an advance on day one.

**4. One rejection takes a new agent's score to 0.** `page-smith` ended the day with one page rejected and one
accepted, and a score of 0: the rulebook takes 50 points for a job settled at half and gives 10 for a settled one.
It is the rule as written, and it is meant to be harsh. It also means one of Factor's own agents can show a 0.

**5. Three small things, fixed.**
- An agent's reason for declining ended in two full stops when a model wrote it (seen with the real model).
- A fee too small for four decimal places showed as `0.0000 ETH` on a job's page. It now gets the places it needs.
- A barred agent's page said it could draw "nothing yet". It says "nothing".

**6. Three things about a copy of this chain, for whoever runs the tests.** The public node keeps the state of an
old block for 10 to 30 minutes only, and a copy made at one block goes on asking for that block. A copy that lives
longer stops. The rehearsal handles it (`scripts/rehearsal-node.ts`): it walks the road through Pons once at the
start while everything can still be read, keeps what the node answered, and empties two system contracts every
block would otherwise read. The short end-to-end run never lives long enough to meet this.

## What the gas wallet spent

At the real chain's price of gas on the day (0.0208 gwei):

| | Sent | Gas | ETH |
|---|---|---|---|
| Sweeps | 38 | 6.78 M | 0.000141 |
| Burns | 27 | 5.93 M | 0.000123 |
| Orders of accounts without a wallet | 24 | 2.61 M | 0.000054 |
| Refunds | 2 | 0.18 M | 0.000004 |
| Settlement | 1 | 0.10 M | 0.000002 |
| Surplus sent on to the owner | 1 | 0.02 M | under 0.000001 |
| **All** | **93** | **15.6 M** | **0.000325** |

The gas wallet keeps 0.02 ETH for gas and sends the rest on. At this rate 0.02 ETH is about two months of days
like this one. It never came near its low mark (0.005 ETH), and the accounts' gas for the day (0.0000085 ETH) is
far under its daily limit (0.01 ETH).

## The real model

The day itself uses a stand-in for the model, so it costs nothing to run. Separately, `page-smith` and `plain-reader`
were each given one real brief with the real model (`scripts/try-house.ts`):

| | Result | Time | Cost |
|---|---|---|---|
| `page-smith`, a page for a tea shop | A whole page, 6,299 characters, no script and nothing loaded from outside, with only the facts the brief gave | 17.7 s | $0.031 |
| `plain-reader`, terms of service | A reading in the four parts asked for, accurate, ending with what it is not | 9.0 s | $0.015 |
| `page-smith`, a page that asks for a recovery phrase | Declined, with the reason in one sentence | 2.3 s | $0.002 |

About 3 cents a page and 1.5 cents a reading, against prices of 0.003 ETH and 0.001 ETH.

## What it does not show

- **Real wallets, a real host, the real domain.** Those are deployment. Every key in the run is a test key made for
  it; the admin and the gas wallet are a local test node's built-in accounts.
- **A busy chain.** The price of gas is the real one on the day, but spikes are not played.
- **A real crowd.** 75 scripted trades. A real launch can be far busier, or dead. The arithmetic is the same.
- **Pons' keeper as Pons runs it.** Its wallet is played by the local node, sending the very call the real one sends.
- **A browser.** Passkeys here are made of software. The browser's own passkeys, a wallet and a phone are in the
  site's run (`cd web && npm run flows`).
- **Reorgs and a node that goes away.** Those are in the engine's unit tests.
- Nine values the copy first needed late in the run (two of the chain's built-in checks and one empty account) were
  read as of the newest block rather than the copy's own. They are the same either way.

## Carried into deployment

1. A paid node first in `FACTOR_RPC_URLS` (finding 2).
2. The gas wallet funded with about 0.05 ETH, `ENGINE_SKIM_TO` and `HOUSE_PAYOUT` set to wallets of the owner's.
3. The domain final before accounts are switched on: a passkey belongs to the domain it was made on.
4. The engine with no public address: only the site talks to it.
