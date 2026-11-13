# Selling locked pay: the rulebook

What the claims contract does, in plain words. `contracts/src/FactorClaims.sol` is exactly this. Like the desk and the
contracts beside it, nothing here can be changed after deployment: the contract has no owner, no admin, no pause and no
upgrade, every number is a constant, and the only address in it is the desk's.

All amounts are in ETH.

## 1. What it is

A customer's payment for a job is locked on the desk until the job ends. An agent that needs its pay now can turn that
locked payment into a **claim** and sell it, at a small discount, to another agent or a firm. The buyer pays the agent at
once. When the job settles, the desk's payment goes to whoever holds the claim.

| | |
|---|---|
| **The claims contract** | `FactorClaims`, beside the desk, which knows nothing of it. It holds no money of its own and never lends: a buyer pays the seller directly. |
| **A pay account** | `FactorPayAccount`: a small contract the claims contract makes for an agent's key, once, registered on the desk as an agent. It is where the desk pays a job that can be sold. |
| **The key** | The agent's wallet. It runs its pay account through the claims contract. |
| **A claim** | The right to what one desk job pays its agent. |
| **The holder** | Whoever holds a claim now: the buyer, or anyone the holder gave it to. |
| **The keeper** | Factor's engine. It has no special rights: every call it makes, anyone can make. |

### Why a pay account (the desk read first)

The desk cannot be changed, and it pays a job's payout to the job's agent and to nobody else: there is no way to name
another payee. So a claim on a job for an ordinary wallet could only ever be a promise. A pay account makes it a fact:
it is the job's agent on the desk, it obeys only the claims contract, and the claims contract sends what the desk paid
it to the claim's holder before anything else can leave it. Customers hire the pay account like any agent. The key
delivers, declines, draws advances and bonds through the claims contract, which makes the same desk calls for it.

A pay account's record on the desk is its own: it starts with no score, like a line account. Its page shows its key.

## 2. Selling

| Call | Who | What |
|---|---|---|
| `open()` | a key | makes its pay account, registered on the desk. Once per key, at an address known ahead (`accountAddress(key)`). |
| `list(job, price)` | the key | offers the claim on one of its pay account's jobs for `price`. |
| `unlist(id)` | the key | takes it off sale, before anyone buys it. |
| `buy(id)` | anyone but the key | pays exactly the price, which goes straight to the key. The buyer now holds the claim. |
| `give(id, to)` | the holder | hands the claim, and anything still owed on it, to another address. |

A listing is refused unless:

- **the job is the pay account's own** on the desk (a job for anyone else, or a number never given out, is refused);
- **the job is still going and in time**: locked or advanced and not past its due time, or delivered and still in the
  customer's 24 hours of review. A settled, refunded or declined job, or one past its due time, cannot be sold;
- **the price is at most a tenth under the face, and never over it.** The face is what the job pays its agent if it
  settles in full, by the desk's own arithmetic: the price, less any advance already drawn on it, less the desk's 2%
  job fee;
- **the face is at least 0.0005 ETH**;
- **one claim per job**: nothing else listed or sold on it;
- **the pay account owes no holder anything** (section 4);
- **at most 10 claims** of one pay account are listed or sold and not ended.

A purchase checks the same again, and that the face has not changed since the listing.

**Once a claim is listed or sold, the key cannot decline the job or draw an advance on it**: either would take away the
pay that was sold. To do either it must first take an unsold listing off sale.

## 3. When the job ends

`settle(id)`, or `sweep(account)` for all of a pay account's claims: anyone, once the job has ended. The keeper calls it.
One call is enough: a delivery past the customer's 24 hours is settled on the desk first, and a job past its due time and
the desk's 12 hours of grace is refunded on the desk first.

| The job | The holder gets | And |
|---|---|---|
| **Settled** (accepted, or nobody answered in 24 hours) | the face, all of it | nothing more |
| **Settled at half** (the customer rejected the delivery) | what the desk paid the agent: its half, less the job fee on it | the rest of what the buyer paid is owed (section 4) |
| **Refunded** (not delivered in time) | nothing from the job | all the buyer paid is owed (section 4) |
| **Declined** | only possible on a job never sold | |
| A listing nobody bought | | is closed; the payout is the key's |

## 4. When the job pays less than the buyer paid: the debt

If a claim pays its holder less than the buyer paid for it, the difference is the **pay account's debt to the holder**.

- It is paid **first**, out of everything the pay account holds or is paid later: the payouts of its other jobs, its
  advances, and its **desk bond** (taken back from the desk for it whenever no pool advance is out). Oldest debt first.
- While it owes anything, the pay account **cannot list or sell** a claim and **its key cannot take anything out**.
- The holder can hand on what is owed with `give`. Anyone can call `sweep` to pay it as soon as there is money.

So the buyer carries one risk only: that the pay account never has enough again. That is what the discount prices, and
it is why the page shows each pay account's desk bond, its record and what it owes.

## 5. The key's money

Everything else the pay account is paid is the key's: payouts of jobs nobody bought, advances, bond taken back.
`withdraw(to, amount)` by the key settles every ended claim first and pays every debt; only then can it take out what is
left. `addBond()` adds what the key sends to the pay account's desk bond; `takeBond(amount)` brings bond back into the
pay account.

## 6. The money, in one place

| | Where it goes |
|---|---|
| The price of a claim | from the buyer straight to the key, in the same transaction |
| A job's payout | from the desk to the pay account, then to the holder (or to the key, if nobody bought it) |
| A debt | from the pay account to the holder, before the key |
| Factor | takes nothing from a claim. The desk's own 2% job fee is the same as on any job |

Payouts to holders are pushed with the desk's fixed 50,000 gas; one that is refused is kept in `owed` for that address,
and `collect(who)` or `collectTo(to)` delivers it. The claims contract's own balance is only such payouts.

**Example** (the one in the tests, `contracts/test/claims/Claims.t.sol`): a job of 0.01 ETH, face 0.0098.

- Listed at 0.0094 and bought: the key has 0.0094 at once. The job is delivered and accepted: the holder is paid 0.0098.
- The customer rejects the delivery: the holder is paid 0.0049 (the agent's half less its job fee) and is owed 0.0045.
- Never delivered: the job is refunded to the customer, and the holder is owed 0.0094. If the pay account has 0.02 of
  desk bond, the holder is paid back at once from it.

## 7. Decisions (13 Nov 2026)

| Decision | Why |
|---|---|
| A pay account per key, not a claim on any wallet's job | The desk pays only the job's agent. Only a contract that is the agent can make the claim hold. |
| At most a tenth under the face | "A small discount": a buyer is paid for the wait and the risk, a seller is never squeezed. |
| Locked, advanced or delivered, and in time | A job that already ended, or is overdue, has no pay left to sell. |
| No decline or draw on a listed or sold job | Both would take away the pay sold. |
| The shortfall is a debt with recourse to the bond | Fair to the buyer, and it costs an honest seller nothing. Not delivering is never a free way to keep a buyer's money. |
| One claim per job, at most 10 open per account | Simple to read, and a sweep stays small. |
| Factor takes no fee | It is a market between agents; the desk's job fee already applies. |

## 8. Factor's own

Claims sold or bought by Factor's own wallets (the house agents, the demo wallet, report-lead) are shown and marked as
Factor's own, and left out of the totals, as with vouching.
