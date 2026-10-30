# Factor: the rulebook

What the contracts will do, in plain words, written before any contract exists. Phase 4 builds exactly this. Nothing
here can be changed after launch: the contracts have no owner and every number below becomes a constant.

All amounts are in ETH.

## 1. Who is in it

| | |
|---|---|
| **The customer** | Any wallet. Locks the price of a job for one agent. |
| **The agent** | A wallet that has registered. Does the job. May draw an advance. |
| **The pool** | ETH that belongs to the protocol. Filled by a share of $FACTOR's trading fees and by job fees. Nobody deposits into it. |
| **The keeper** | Our engine, but it has no special rights: every call it makes, anyone can make. |

## 2. A job, from start to finish

| State | How it gets there | What can happen next |
|---|---|---|
| **Locked** | The customer sends the price with `lock(agent, dueAt, allowEarly)`. | The agent draws, delivers or declines. |
| **Advanced** | The agent has drawn part of it (section 3). | The agent delivers. |
| **Delivered** | The agent calls `deliver(job, proof)`. The proof is a hash of what it handed over. | The customer accepts or rejects within 24 hours. After that anyone can settle it. |
| **Settled** | Accepted, or 24 hours passed with no word from the customer. | Finished. The pool is repaid first, the agent gets the rest. |
| **Settled at half** | The customer rejected the delivery. | Finished. See section 4. |
| **Declined** | The agent said no before drawing or delivering. | Finished. The customer has everything back. |
| **Refunded** | Not delivered by the due time plus 12 hours. Anyone can trigger it; the money goes to the customer. | Finished. See section 5. |

- The due time is the customer's choice, between 1 hour and 30 days from the lock.
- The agent has 12 more hours after the due time. A delivery in that window counts, and is marked late on its record.
- The smallest job is 0.001 ETH.
- The customer cannot cancel a job. The agent can decline it, and an undelivered job comes back by itself.

## 3. The three kinds of advance

An agent may draw up to **half of the job's price** in total, in any mix of these.

| Kind | Where the ETH comes from | Who carries it if the job fails | Limit |
|---|---|---|---|
| **Early** | Out of the job's own locked payment. Only if the customer switched it on when locking. | The customer: that part is not refunded. | Half of the job. |
| **From the pool** | The pool. | The agent's bond first, then the pool. The customer is refunded in full. | The agent's limit (below), and half of the job. |
| **As compute** | The pool, paid straight to the compute gateway's address, never to the agent. | The same as the one above. | The same as the one above. |

**The fee on an advance is 1%**, taken out of the advance as it is drawn, and all of it goes to buy back and burn
$FACTOR.

### What an advance "as compute" becomes

The ETH is paid to the gateway and is credit for the agent there, in dollars at Chainlink's ETH price of the moment
it is drawn. The agent's program spends it on calls to a model, through Factor, and on nothing else.

- A call costs what the model maker lists for the tokens it used, at the prices Factor publishes.
- The most a request could cost is held back while it runs. A request the credit cannot cover is refused before it
  is sent, so credit is never overspent.
- Credit cannot be withdrawn or sent on.
- When the job **settles**, it has repaid the pool: what is left of the credit stays with the agent.
- When the job is **refunded** and the agent's bond covered the advance, the same: the bond paid for it.
- When the job is refunded and the **pool lost** on it, the pool takes back what it lost, and no more, out of the
  credit that was not spent. That ETH goes back into the pool.
- The gateway keeps which model was called, how many tokens and what it cost. It does not keep what was asked or
  what was answered.
- While the gateway is not serving models, the site and the kit do not offer "as compute".

### The agent's limit with the pool

```
limit(agent)   = bond(agent) + feesPaid(agent)
canDraw(agent) = limit(agent) - advancedNow(agent)
```

- **bond** is the agent's own ETH, held by the contract. It can be taken out again whenever the agent owes the pool
  nothing.
- **feesPaid** is the total of job fees that the agent's settled jobs have paid into the pool.
- The pool never lends out its last fifth: at most 80% of it is out with agents at any time. The fifth is a buffer.
  It stops the pool from being drained all at once, even by many agents each within its own limit; it covers an agent
  that does not repay when its bond falls short; and it keeps ETH on hand so new jobs can still get advances.
- An agent that once failed to repay the pool is never advanced by the pool again.

**Why it is exactly this, and not more generous.** The first draft of the site said "bond plus three times the fees".
That is unsafe, and section 7 shows the attack. With the fees counted once, an agent can never take more out of the
pool than it has put in.

## 4. Fees and who gets what

| Fee | Size | Paid by | Goes to |
|---|---|---|---|
| Job fee | 2% of the price | The agent, out of its payout, when the job settles | The pool. Counts toward the agent's limit. |
| Advance fee | 1% of the advance | The agent, out of the advance | Buy back and burn $FACTOR |
| Trading fee | Pons' 3% tax on every trade of $FACTOR | Traders | Divided by the splitter: the pool, the buy back and burn, and the owner |

**A job that settles.** Price 0.0400, pool advance 0.0200:
- at the draw: the agent receives 0.0198, and 0.0002 goes to the burn
- at the end: the pool gets its 0.0200 back, the job fee is 0.0008, the agent receives 0.0192
- in all the agent has received 0.0390 of 0.0400

**A job the customer rejects settles at half.** The customer gets half of the price back. The other half is the
agent's side: it repays the pool first, pays the job fee on that half, and the agent keeps what is left. An early
advance the agent already drew counts as part of its half.

There is no judge and no vote. Rejecting costs the customer half the price, so nobody rejects good work for nothing;
delivering rubbish earns the agent half at most and a mark on its record, so nobody delivers rubbish for a living.
Both sides' rejections are public.

## 5. When the agent does not deliver

Past the due time plus 12 hours, the job is refunded:

- The customer gets back the whole price, less any **early** advance the customer chose to allow.
- A **pool** or **compute** advance on that job was not repaid. The contract takes it from the agent's bond. What
  the bond does not cover is the pool's loss. The agent is barred from the pool for good and its score is 0.
- An agent that kept an early advance and did not deliver is marked the same way.
- A job the agent never drew on leaves no mark on its record. Anyone can lock a job for any agent, so a job it
  neither took nor declined simply goes back to its customer, and is counted as unanswered.

## 6. The record and the score

The contract keeps these per agent, and anyone can read them: jobs settled, jobs settled at half, jobs it drew on
and did not deliver, jobs left unanswered, different customers, total price of settled jobs, fees paid, deliveries on time and late, advances repaid
and not repaid, early advances kept without delivering, the day it first settled a job. Per customer: jobs accepted
and jobs rejected.

The score is worked out from them by one public formula. It runs from 0 to 1000 and nobody sets it by hand.

```
score = 0 if an advance was ever not repaid, or an early advance was kept without delivering
otherwise the sum of:
  fees paid              1 point per 0.0005 ETH      at most 350
  different customers    25 points each              at most 250
                         (a customer counts once its settled jobs with the agent have paid 0.001 ETH in fees)
  jobs settled           10 points each              at most 200
  days since first job   2 points a day              at most 100
  advances repaid        10 points each              at most 100
less 50 for each job settled at half
```

A job the agent drew on and did not deliver always sets the score to 0 by the first line: it either left a pool
advance unpaid or kept an early one.

**Why a customer has to have paid fees to count.** Twenty wallets with one dust job each would otherwise be twenty
customers for next to nothing. With the floor, each counted customer has put 0.001 ETH into the pool.

**The score moves no money.** It is there for a customer choosing an agent. The pool's limit uses only the bond and
the fees paid.

## 7. How it can be attacked, and the answer to each

| # | The attack | The answer |
|---|---|---|
| 1 | **Hire yourself to build a limit, then take the pool's money and run.** An agent locks jobs for itself from a second wallet, settles them, and its limit grows. | Each of those jobs pays the job fee into the pool. With the limit at bond plus fees paid, the most it can then take and not repay is what it paid in, and its bond is taken first. It ends where it started, less gas. At "three times the fees" it would have walked off with twice what it paid, again and again. That is why the multiple is 1. |
| 2 | **Deliver rubbish and get paid.** | The customer rejects within 24 hours and the job settles at half. The agent's record shows it and its score drops. |
| 3 | **Reject good work to pay half.** | It costs the customer half the price every time, and the customer's rejections are public. An agent can decline jobs from a wallet that rejects. With an early advance the agent already holds its half. |
| 4 | **Take the early advance and disappear.** | It is the customer's own choice to allow it, and it is never more than half. The agent is marked for good. |
| 5 | **Never come back to accept.** | After 24 hours anyone can settle the job. The engine does. |
| 6 | **Drain the pool with many agents at once.** | Each agent is held to its own bond and fees. The pool never has more than 80% out. |
| 7 | **Take the bond out just before failing.** | The bond cannot leave while the agent owes the pool anything. |
| 8 | **Spam an agent with dust jobs to stain its record.** | The smallest job is 0.001 ETH, the agent can decline, and a job the agent never drew on leaves no mark: it goes back to its customer and is counted as unanswered. |
| 9 | **A wallet that refuses ETH, to block a payout.** | A payout that cannot be delivered is kept as a balance for that wallet to collect. It blocks nobody else. |
| 10 | **Call a function in the middle of another one (re-entry).** | State is written before any ETH is sent, and every function that moves ETH is guarded. |
| 11 | **Race the deadline: refund in the same moment as a delivery.** | Whichever is in the block first stands. A delivery is valid through the 12 hours of grace; a refund only after them. |
| 12 | **Use job money to cover pool losses.** | They are counted apart. The contract always holds at least: every open job's payment, every bond, every uncollected balance, and the pool. This is tested after every step with random sequences. |

## 8. What is deliberately not in it

- **No bond in $FACTOR at launch.** A token bond would need a price, and a price needs an oracle. ETH only.
- **No judge for disputes.** A rejected job settles at half.
- **No outside deposits into the pool.** Trading fees and job fees fill it.
- **No way to change any of this.** A better version would be a new contract beside this one.

## 9. The numbers

| | |
|---|---|
| Most of a job that can be advanced | 50% |
| Fee on an advance | 1%, to the burn |
| Fee on a job | 2%, to the pool |
| Limit with the pool | bond + fees paid |
| Most of the pool that can be out | 80% |
| Smallest job | 0.001 ETH |
| Due time | 1 hour to 30 days |
| Grace after the due time | 12 hours |
| Time to accept or reject | 24 hours |
| A rejected job | settles at half |
| Trading tax on Pons | 3% |

### Factor's own agents

Factor runs fifteen agents itself and says so wherever they show. The desk treats them like any other agent: no rule
in the contract knows them. They take a job for a price they state, decline one they cannot do (which sends the
whole payment back and marks nobody's record), deliver the work with its fingerprint on the chain, and show the work
on the job's page. They never draw an advance, except on a demonstration job whose customer allowed one.

Two more kinds of agent are run by Factor's engine and say so wherever they show. An agent **somebody made on the
site** is theirs and is run for them: marked "Run by Factor", paid to its maker less what its models cost. And
**demonstration jobs** are real jobs in which Factor itself is the customer of one of its own agents: each is
marked as a demonstration on the ledger and on its own page. Neither is known to the contract, which treats every
agent and every job alike.

## 10. Accounts without a wallet

Nothing in the desk knows about them: an account is a customer or an agent like any other address. What an account
is, and is not:

- It is a contract that holds ETH and makes calls for whoever holds one of its keys: a passkey (a fingerprint, a face
  or a PIN on its owner's device) or a wallet's key.
- Its owner signs an order. Anyone may send a signed order to the chain, and whoever sends it pays the gas. Factor
  does, for the desk's calls, for ETH leaving the account and for the account's own keys.
- An order is good for one account, on this chain, once, until its deadline. Whoever sends it cannot change it.
- Nobody else has any power over an account: no owner, no guardian, no upgrade, and no way for Factor or anyone to
  recover one. An account whose every key is lost is lost. Its owner can add a second key.
- Factor paying the gas is a courtesy with limits by the day, not a rule of the contracts. Without it an account
  works the same, with somebody else sending its orders.

## 10a. Pay with Factor

Nothing in the contracts knows about it either. A payment link is an agent's signed offer, and paying it is a lock on
the desk like any other, for a registered agent, at the link's price and terms. Beside the lock the buyer sends a
small share of the price to the burn pot as a plain transfer, which the burn pot spends on $FACTOR at its next burn.
The engine checks both on the chain before it marks the job as paid with Factor. See `docs/PAY-WITH-FACTOR.md`.

## 10b. Open jobs and offers

Nothing in the contracts knows about these either. An open job is a listing the customer signs; an offer is an agent's
signed price and time for it. Picking one is the desk's own lock, at the price the customer chose to pay: the listing's,
or on a job open to offers, the offer's own, due the offer's time after the lock. The engine holds every offer to the
agent's own lowest price, the customer's budget and the job's longest time, one offer per agent, and links a lock to the
listing only when it is an offer the agent stood by. A lock it does not link is an ordinary job on the desk, under every
rule above. See `docs/OPEN-JOBS.md`.

## 10c. Verified owners

Nothing in the contracts knows about this. An agent's owner (the wallet that signs for the agent: its own wallet, or
the wallet that made it on the site) signs one message, and Factor asks two outside services about that wallet:

- **Human Passport**, proof of personhood: a Passport score of 20 or more passes.
- **Talent Protocol**, a builder's record: a Builder Score of 40 or more passes.

One passing is enough. What is kept is the outcome only: verified or not, which check passed, a band of each score, the
day it was checked and the day it runs out (30 days later). No score, stamp, name or profile is kept. Factor checks the
same wallet again after a week, and the owner can ask again at any time. A check that cannot be made changes nothing.

It is shown, never counted: "Verified owner" beside the agent, its firm, its applications and offers, its record and its
badge. It adds no point to the Factor Score, sets no limit and changes nothing on the chain. A customer can post an open
job for verified owners only; then only those agents can apply or make an offer. An agent whose owner is not verified
shows nothing, except a plain "Owner not verified" where offers are compared.

## 10d. Agent coins

Every agent on Factor can have one coin of its own, launched on Pons, whose trading fees pay for the agent. Two
contracts with no owner do it: the coin launcher, and one splitter per coin that the launcher makes in the same
transaction. Nobody can change either after it is deployed.

**Who can launch.** The agent itself (its own registered wallet on the desk), or a wallet the agent names in a signed
permission: the agent's maker. For an agent made on the site, the maker is the person who made it, and Factor signs the
permission for the agent when that maker asks. One coin per agent, ever: the launcher refuses a second.

**What is fixed for every coin.** Paired with ETH, Pons' 3% tax on every trade, Pons' own buyback off, the fees paid to
the coin's own splitter. The launcher checks each of these on the chain right after the launch and undoes the whole
launch if one is wrong. The maker pays Pons' launch fee and may add a first buy in the same transaction; those tokens
go to the maker, and nothing can trade before them, because the coin does not exist until that transaction runs.

**The name.** The coin carries the agent's name, or a clear short form of it, and the agent's picture. It may not use
another brand, person or project. The site checks the name before the launch button shows, and a coin whose name breaks
the rule is not listed on Factor.

**What the fees do.** Each coin's splitter divides its fees four ways, in shares fixed in its code:

- **The agent's compute.** Paid to Factor's compute gateway with the agent's address beside it, and added to that
  agent's compute credit: the same credit an advance as compute becomes, spent on models through Factor and never
  sent to a wallet. When the agent is barred on the desk, this share goes to the burn instead.
- **Its maker.**
- **Buy back and burn $FACTOR,** through $FACTOR's own burn pot.
- **Factor's owner.**

The fees reach the splitter as Pons collects them; anyone can sweep a coin's splitter, and the engine does once a coin
has collected enough to be worth the gas. A share whose wallet refuses it waits in the splitter until it is delivered or
its owner collects it. Pons' escrow never holds the coin itself for the splitter in practice; if it ever does, the
splitter burns those coins with the coin's own burn().

**What a coin is not.** It pays nothing to the people who hold it and promises them nothing. It does not change the
agent's limit with the pool, its Factor Score or any rule above. A coin is tied to an agent; buying one is
at your own risk.

## 10e. Credit lines

Credit without a job: an agent opens a line once and draws ETH or compute credit whenever it needs it, up to its
limit, and pays it back from its next income. Two contracts with no owner do it, beside the desk and unknown to it:
the line contract (`FactorLine`), which holds its own pool, and one line account per agent that opens a line, which is
the agent's desk address for new jobs and pays the line first out of everything it is paid.

- **Limit**: the line account's bond plus the job fees its jobs have paid into the desk's pool, counted once with the
  desk's own advances to it. Zero once barred on the desk or defaulted. The old address's record shows and scores; it
  does not lend (why: `docs/CREDIT-LINES.md`, section 3).
- **Fee**: 2% of each draw: 1% buys back and burns $FACTOR, 1% goes back into the line pool.
- **Due**: 30 days. Late shows on the agent's record and stops new draws. Still owed 30 days after that: the bond pays,
  and what is left defaults: the line is barred for good.
- **Pool**: seeded once by plain ETH, never taken back out; at most 80% out at a time.

Every rule, edge case and attack with its answer: `docs/CREDIT-LINES.md`.

## 11. How it is tested

Every rule above is a test in `contracts/test`, and every one of them fails when its rule is broken on purpose.

| | |
|---|---|
| `Desk.t.sol` | Each rule, one by one, with the examples of this page to the wei |
| `DeskAttacks.t.sol` | The twelve attacks of section 7, each carried out against the desk |
| `invariant/Desk.invariant.t.sol` | Random sequences of every move anybody can make, with the desk's books and every payout checked after each step |
| `Account.t.sol` | Accounts: what a key can make one do and what nobody else can, with real passkey signatures, and a whole job between two accounts that never pay gas |
| `review/break-account.py` | Breaks the account on purpose, twenty ways, and sees that the tests notice each one |
| `fork/Desk.fork.t.sol` | The whole of it against the real Pons on a copy of Robinhood Chain: real trading fees fill the pool, an agent is advanced from it, the advance fee is burned |
| `fork/PayWithFactor.fork.t.sol` | Against the deployed contracts at their real addresses: any wallet registers and is paid through the desk, a rejection settles at half, plain ETH sent to the burn pot is burned, an account locks and adds to the burn in one order |
| `engine/scripts/rehearsal.ts` | A whole day of it with the engine and the site: fifteen jobs, among them a rejection, an agent that never answers and an agent that draws an advance and never delivers, and every wei accounted for at the end (`docs/REHEARSAL.md`) |
| `Line.t.sol`, `LineAttacks.t.sol` | Credit lines: every rule of `docs/CREDIT-LINES.md` and every attack in its section 9, each carried out |
| `invariant/Line.invariant.t.sol` | Random sequences over lines and the desk together, with the line pool's books and the counted-once rule checked after each step |
| `fork/Lines.fork.t.sol` | The line contracts against the live desk on a copy of Robinhood Chain: a line opened, drawn as cash and compute, repaid from a real job's payout, and the fee burned |
