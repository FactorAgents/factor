# Credit lines: the rulebook

What the credit line contracts do, in plain words, written before they existed. `contracts/src/FactorLine.sol` is
exactly this. Like the desk, nothing here can be changed after deployment: the contracts have no owner, every number
is a constant, and the only addresses in them (the desk, and the burn pot and the gateway read from it) are fixed.

All amounts are in ETH.

## 1. What a credit line is

An advance on the desk needs a job: a customer locks a payment and the agent may draw up to half of it. A credit line
needs no job. An agent with a record on the desk opens a line once, and from then on it can draw ETH, or compute
credit, whenever it needs it, up to its limit, and pays it back from its next income.

| | |
|---|---|
| **The line contract** | `FactorLine`. Holds the line pool, makes each agent's line account, keeps every line's debt, due time and record. No owner. |
| **The line pool** | ETH that belongs to the protocol, apart from the desk's pool. Filled by ETH sent to the line contract (the owner seeds it at release) and by half of every draw fee. Nobody can take it out: ETH leaves it only as a draw. |
| **The agent's key** | The wallet (or Factor account) the agent has used on the desk so far. It opens the line, draws, and runs its line account. |
| **The line account** | A small contract made for the agent when it opens its line (a clone of `FactorLineAccount`). It registers on the desk in the same transaction and is the agent's desk address for new jobs. |
| **The keeper** | Factor's engine. It has no special rights: every call it makes, anyone can make. |

## 2. Opening a line

`open()` from the agent's key. It works when:

- the key is a registered agent on the desk, and is not barred there;
- the key has no line yet (one line per key, ever);
- the key is not itself a line account.

The line contract makes the line account at an address that follows from the key alone, gives it the key, and the
account registers itself on the desk. The link is one to one and permanent: one key, one account, and neither can be
linked to anything else afterwards. The transaction from the key is the signature that links them: no message to sign
and nothing that can be replayed.

From then on the agent takes new jobs at its line account (customers lock jobs for the account's address). Jobs already
locked for the key go on as before.

## 3. The limit

```
limit(account) = bond(account) + feesPaid(account)          on the desk, counted once
                 0 if the account or the key is barred on the desk, or the line has defaulted
room(account)  = limit - advancedNow(account) on the desk - debt(account) on the line
                 0 while the line is late
canDraw(key)   = room, and never more than the line pool can send out (80% rule, section 6)
```

- **bond** is the line account's bond on the desk. The account adds it with ETH the key sends, or with ETH the
  account holds that it does not owe. It cannot be taken out while the line owes anything.
- **feesPaid** is the job fees the line account's settled jobs have paid into the desk's pool. They can never be
  taken back.
- **Counted once.** The same bond and the same fees back the line AND the account's own advances from the desk's pool.
  The line subtracts what the desk has advanced the account now, and the account refuses a pool or compute advance
  from the desk bigger than what the line leaves room for. So at every draw, from either side:
  `advanced by the desk + owed to the line <= bond + fees paid`.
- **The score moves no money.** A verified owner is shown beside the agent and never raises a limit.

### Judgement call: the key's old record counts for the score, not the limit

The plan said the limit would count the job fees of the old address and the new one together. It cannot, safely,
while the desk stays as it is. The old address is still an agent on the desk, and the desk advances it up to its own
bond plus its own fees whatever the line does. If the line also lent against those fees, the same fees would back two
loans, and the attack is cheap:

1. An agent's old address has paid 0.1 ETH in job fees (by hiring itself; that cost it 0.1 ETH) and has a 0.05 bond.
2. It opens a line and draws 0.1 from the line pool against the old fees.
3. From the old address it draws 0.15 from the desk's pool on a job its own second wallet locked.
4. It defaults on both. The desk takes the 0.05 bond and the customer wallet gets its whole payment back.

It paid in 0.15 (fees and bond) and walked off with about 0.245: about 0.095 ahead, all of it the line pool's money. The line cannot stop step 3: only the desk could, and the desk has no owner and cannot be changed. Subtracting
what the old address has drawn so far does not help, because the old address can draw after the line does.

So the limit counts the line account's own bond and fees only, which no other loan can use, and the old record carries
over where it is safe: the agent's page, its record and its Factor Score show both addresses as one agent. An agent
that wants a line from the first day moves its bond: it takes its bond out at the old address and adds it at the line
account. From there every job it is paid for at the line account raises the limit by that job's fee.

## 4. Drawing

`draw(amount, asCompute)` from the key.

- **As cash**: the ETH goes to the key.
- **As compute**: the ETH goes to the compute gateway's address (the desk's own `gateway`), never to the agent, and
  Factor's engine turns it into compute credit for the agent, as it does for an advance as compute. When the line is
  repaid, what is left of that credit is the agent's to keep. If the line defaults, the line pool takes back what was
  not spent, and no more.
- No job is needed, so a draw can come before any job is locked.
- The smallest draw is 0.0001 ETH.
- **The fee is 2% of the draw**, taken out of it as it is drawn: 1% goes to the burn pot, which buys back and burns
  $FACTOR (the same burn the desk's advance fee feeds), and 1% goes back into the line pool. The agent owes the whole
  draw. Draw 0.0100: the agent receives 0.0098, 0.0001 is burned, 0.0001 goes to the pool, 0.0100 is owed.
- A draw is refused when: the amount is over the room, over what the pool can send out, under 0.0001; the line is
  late or has defaulted; the account or key is barred on the desk; or the caller has no line.

## 5. Paying back, due time, late, default

**Due.** A line is due 30 days after the draw that took its debt above zero. Later draws while it owes do not move the
due time. When the debt is back at zero the due time is cleared, and the next draw starts a new 30 days. Paying all
but a little does not move it either.

**Paying back.** Every payment into the line account goes to the line first:

- ETH that arrives at the account (a job's payout from the desk, a refund, an advance, a gift) sits there until
  anyone calls `sweep()`, which pays the line as much as it owes. The engine calls it as soon as income arrives.
- The account lets the key take ETH out only after a sweep has left the line owing nothing: the agent can only
  withdraw the rest.
- Anyone may also pay any line directly with `repay(account)`, up to what it owes.

**On time and late.** When a debt reaches zero on or before its due time, the line's record counts it on time. After
the due time it is late:

- a late line cannot draw;
- the agent's record shows it as late, publicly, until it is repaid, and the repayment is counted late.

**Default: never repaid.** 30 days after the due time (60 days after the draw), anyone may call `recover(account)`:

1. the account's desk bond is taken out of the desk and pays the line (only what is owed, and only when the desk has no
   advance out to the account: the desk's own pool comes first, because the desk takes the bond for its losses);
2. whatever the account holds pays the line;
3. if anything is still owed, the line has **defaulted**: it is barred from drawing for good, its key can never open
   another line, the debt left is written off the pool's books as lost, and the Factor Score of the agent is 0.

A defaulted line still owes. Every payment into the account goes on repaying it, and `recover` can be called again
whenever the bond is free; what comes back is counted as recovered.

## 6. The line pool

- The line pool is `pool` (ETH here) plus `out` (ETH owed by lines that have not defaulted).
- **At most 80% of it is out at once.** The fifth that stays is a buffer: it stops the pool from being drained at once
  even by many agents each within its own limit, and keeps ETH on hand for the next agent.
- It is filled by plain ETH sent to the line contract (anyone may; nobody gets a claim on it by doing so) and by 1% of
  every draw. ETH sent from a line account is a repayment, not a gift to the pool.
- **The seed is permanent.** ETH sent to the line contract can never be taken out by anyone, the owner included. It
  only ever leaves as a draw and comes back as a repayment.
- What the pool can lose: an agent can owe the line no more than its line account's bond plus fees, less what the desk
  has out with it. On default the line takes the bond first. So the two pools together lose at most the fees the
  account's jobs paid into the desk's pool. The line pool can lose up to that much to the desk's pool, at a cost of
  the 2% fee to whoever does it: nobody makes money doing it.

## 7. The line account

The account is the agent's desk address. It does only these, each called by the key:

| Desk, as the agent | `addBond(fromBalance)`, `takeBond(amount)` (only while the line owes nothing), `drawAdvance(job, amount, kind)` (a pool or compute advance only up to the line's room), `deliver(job, proof)`, `decline(job)` |
|---|---|
| **Desk, as a customer** | `lock(agent, dueAt, allowEarly, fromBalance)` (to hire another agent, as agents that hire agents do), `accept(job)`, `reject(job)` |
| **Money** | `withdraw(to, amount)`: sweeps first, then only while the line owes nothing |

And anyone may call `sweep()` (pay the line what it owes from the account) and `collect()` (have the desk deliver a
payout the account was owed). Nothing else: no call to any other contract, and no `collectTo` on the desk, which
would send the account's money somewhere else.

ETH the account spends (a bond, a lock) comes from what the key sends with the call, or from what the account holds
beyond what it owes, never from money the line is owed.

The account answers ERC-1271 for its key: a signature by the key counts as the account's. That is how Factor's signed
names, titles, deliveries and compute keys work for an agent on its line account. The key signs texts that carry the
account's address, so a signature for one address is never taken for the other.

The line contract can make the account do exactly one more thing, in `recover`: take the bond out of the desk so it
pays the line.

## 8. Edge cases

| Case | What happens |
|---|---|
| The key is barred on the desk later | The line's limit is 0. Nothing new can be drawn; what is owed is still owed and still repaid from income. |
| The account is barred on the desk (it drew a desk advance and did not deliver) | The same. The desk took the bond first for its own loss; what is left of the bond is the line's at default. |
| The desk advanced the account and the line also lent | Never more than bond + fees together at the moment of either draw. |
| Income arrives while nothing is owed | It is the agent's: it can withdraw it or use it on the desk. |
| Income arrives while something is owed | It repays the line first, at the next sweep. Only the rest is the agent's. |
| A desk payout the account did not take | Waits on the desk as owed; anyone calls `collect()` and it arrives at the account. |
| A payout from the line the key did not take (a key that refuses ETH) | Waits in the line contract as owed, for the key to collect or send elsewhere. The debt stands. |
| Someone sends ETH to the account | It repays the line, or is the agent's if nothing is owed. |
| Repaid exactly at the due time | On time. One second later is late. |
| Repaid by `recover` taking the bond | Repaid, late. Not a default. |
| The pool is short | The draw is refused with the room there is. |
| An agent abandons its line account and works from another address | The debt stays and is never more than the account's bond plus fees. At default the bond pays first. |
| Rounding | The fee is rounded down, the burn half rounded down and the pool half is the rest, so every wei is counted once. |

## 9. Attacks, and how each is stopped

| # | The attack | The answer |
|---|---|---|
| 1 | **Sybil fake jobs.** Hire yourself to pump the limit, draw and run. | The limit grows only by fees the jobs paid into the desk's pool, once. Drawing that and defaulting gives back, at best, the fees paid less the 2% fee: a loss. Tested: the attacker ends below where it started. |
| 2 | **Count the same fees twice** (desk advance and line draw on the same record). | Counted once: the line subtracts the desk's advance, and the account refuses a desk pool advance over the line's room. Tested in both orders. |
| 3 | **The old address borrows on the desk while the new one borrows on the line.** | The old address's fees and bond do not count toward the line (section 3). Tested: the attack of section 3 leaves the line pool whole. |
| 4 | **Drain the pool with many lines.** | Each line is held to its own account's bond and fees, and the pool never has more than 80% out. |
| 5 | **Take the bond out, then default.** | The account refuses `takeBond` while the line owes anything. The desk refuses it while the desk has an advance out. |
| 6 | **Flash loan a bond.** | A bond added with borrowed ETH cannot leave in the same transaction (or any other) while the line owes, so the loan cannot be repaid from it. |
| 7 | **Divert income.** Get paid somewhere the line cannot see. | Jobs locked for the account pay the account; the account has no call that sends ETH anywhere but to the line, the desk (bond, a lock, from free ETH only) or, when nothing is owed, a withdrawal. `collectTo` is not offered. An agent that takes work at another address leaves its bond behind (attack 1 covers what it can take). |
| 8 | **Withdraw before the line sees the income.** | `withdraw` sweeps first in the same call, and refuses while anything is owed. |
| 9 | **Re-entry.** A key or a receiver that calls back in the middle. | State is written before ETH moves; draws and recovery are guarded; payouts are pushed with a fixed amount of gas and a refused one is kept as owed. A repayment arriving during `recover` is accounted before `recover` reads the debt. Tested with hostile receivers. |
| 10 | **Front-running.** | `open` binds the line to the sender: nobody can open a line for someone else or take its address. The account's address follows from the key, and only the line contract can make it. A front-run `repay` or `sweep` only pays the debt. A draw racing another for the pool's room is refused, never short-paid. |
| 11 | **Griefing the line account.** Dust ETH, dust jobs, calling sweep or collect. | ETH sent to it repays its line (a gift). Dust jobs are the desk's rule: unanswered, no mark. Sweep and collect only move ETH where it already belongs. The account's `receive` does nothing, so the desk's 50,000-gas push always lands. |
| 12 | **Moving the record.** Link a good old record to a new account, or a bad one away. | Only the key can open its line, once, and only while it is not barred. A barred key cannot open one. The link is permanent. The record that carries over is shown, not lent against. |
| 13 | **Roll the debt forever.** Draw, pay most of it, draw again. | The due time is set by the draw that took the debt above zero and moves only when the debt is fully repaid. |
| 14 | **Rounding.** Many dust draws to keep fees at zero. | The smallest draw is 0.0001 ETH; fee and parts are tested to the wei, and the books are checked after every step. |
| 15 | **The 80% rule worked around with a deposit.** Seed the pool, draw, and leave. | A seed is the pool's for good: the seeder has no claim on it. |
| 16 | **Compute draws used as cash.** | Paid to the gateway, never the agent. On default the unspent credit goes back to the line pool. |
| 17 | **Default to wipe the debt.** | A defaulted line still owes: income into the account keeps repaying it, and `recover` can be called again. The key can never open another line. |
| 18 | **The key is a contract that refuses ETH or burns gas.** | A cash draw to it is pushed with 50,000 gas; refused, it waits as owed. It cannot block a repayment, a sweep or a recovery. |
| 19 | **Using the line pool's ETH to repay the desk, or the reverse.** | The two contracts hold their ETH apart. The line contract always holds at least its pool plus what it owes to wallets; checked after every step of the random runs. |

## 10. The numbers

| | |
|---|---|
| Draw fee | 2% of the draw: 1% to the burn, 1% to the line pool |
| Smallest draw | 0.0001 ETH |
| Due | 30 days after the draw that took the debt above zero |
| Default | 30 days after the due time |
| Most of the line pool out | 80% |
| Limit | the line account's bond + fees paid, less the desk's advance to it, counted once |
| One line per key | for good |

## 11. What the owner can change

Nothing. There is no owner, no admin, no pause and no upgrade in either contract. A better version would be a new
line contract beside this one. What the owner controls is off the chain: whether the engine reads lines and the site
shows them (`LINES=on`), and whether he seeds the pool.

## 12. Judgement calls made while building

1. **The old record counts for the score, not the limit** (section 3). The safe choice: the alternative lets an agent
   take the line pool's money at no cost.
2. **"Never repaid" is 30 days past due.** A line becomes late at the due time; it defaults 30 days later if still
   owed. The plan gave the due time (30 days) but no moment for "never".
3. **Cash goes to the key**, not the account. Cash paid to the account would repay the line at once.
4. **The bond is taken at default, not when late.** A late agent keeps its bond working for it for 30 more days.
5. **The smallest draw is 0.0001 ETH**, so the 1% parts are never a rounding error.
6. **Late is not barred.** A late line that is then repaid can draw again; the late repayment stays on its record and
   costs it 50 points of its Factor Score, as a job settled at half does. A repayment on time adds to "advances
   repaid", as a desk advance does.

## 13. How it is tested

| | |
|---|---|
| `contracts/test/lines/Line.t.sol` | Every rule above, one by one, with the examples to the wei, and two fuzzed: any draw splits to the wei, and any bond, fees, desk advance and line draw, in either order, never pass bond plus fees |
| `contracts/test/lines/LineAttacks.t.sol` | The attacks of section 9 carried out, each one, plus both pools defaulting on one account at once |
| `contracts/test/invariant/Line.invariant.t.sol` | Random sequences over lines and the desk together (open, bond, hire, desk advances of all three kinds, line draws, repayments, sweeps, withdrawals, bonds out, time, recoveries): the line's books, every wei counted, each line adding up, counted once, the 80% rule and the desk's books after every step. A 300,000-move soak passed |
| `contracts/test/review/break-line.py` | Breaks the two contracts on purpose, thirty ways; the tests catch every one |
| `contracts/test/fork/Lines.fork.t.sol` | Against the LIVE desk, burn pot, gateway and accounts on a copy of Robinhood Chain: a whole line with a real job, a passkey account opening a line, the burn half burned by the live pot, and a default that leaves the live desk untouched |
| `engine/test/lines.test.ts` | The engine on a made-up chain: reading, showing, compute credit kept and taken back, the keeper's sweeps and recoveries, the record carried over, signatures, the switch |
| `packages/kit/scripts/lines-e2e.ts` | Everything together on a local fork: the one-command deploy, the engine, the site and the kit, a line opened, drawn both ways, repaid from a job's payout by the keeper, late, recovered, defaulted, and switched off |
| `docs/credit-lines-mainnet-test.txt` | One small run on the real chain against a test instance of the line contract beside the live desk |
