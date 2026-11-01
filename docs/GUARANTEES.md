# Guarantees: the rulebook

What the guarantee contract does, in plain words, written before it existed. `contracts/src/FactorGuarantee.sol` is
exactly this. Like the desk, nothing here can be changed after deployment: the contract has no owner, every number is
a constant, and the only addresses in it (the desk, the line contract, and the burn pot read from the desk) are fixed.

All amounts are in ETH.

## 1. What a guarantee is

An agent puts up a **guarantee bond** and sets a standing offer: "Guaranteed up to X ETH". A customer hiring that agent
can hire **with cover**. If the agent does not deliver, the customer is paid the cover out of the agent's bond, on top
of the desk's own refund. If the job is delivered, the cover goes back to the bond.

| | |
|---|---|
| **The guarantee contract** | `FactorGuarantee`. Beside the desk, which knows nothing of it. Holds every agent's guarantee bond, keeps every cover, reads the desk's own record of each job to decide. No owner. |
| **The guarantee bond** | The agent's own ETH in the guarantee contract. Apart from its bond on the desk: it backs covers and nothing else. |
| **The offer** | The most cover the agent sells on one job ("Guaranteed up to X ETH"). Set by the agent; 0 sells none. |
| **A cover** | A promise on one desk job: this much ETH, held back from the agent's bond for that job alone, paid to the customer if the job is refunded. |
| **The keeper** | Factor's engine. It has no special rights: every call it makes, anyone can make. |

**Every cover is backed in full by the agent's own bond, at the moment it is sold.** No pool stands behind it, nothing
is lent and nothing needs seeding. The worst any cover can do is move the agent's own ETH to its customer.

## 2. Who runs an agent's bond

The agent's desk address. When that address is a credit line account (`docs/CREDIT-LINES.md`), the line account cannot
make calls of its own, so its key runs it: the contract asks the line contract whose account it is. Anyone may add to
any registered agent's bond; nobody gets a claim on it by doing so.

| Call | Who | What |
|---|---|---|
| `addBond(agent)` | anyone | adds the ETH sent to the agent's bond. The agent must be registered on the desk. |
| `takeBond(agent, amount)` | the agent, or its line key | takes out up to what is **free**: the bond less every cover held back from it. The ETH goes to the agent's desk address, never anywhere else (to a line account, where it repays the line first). |
| `setOffer(agent, amount)` | the agent, or its line key | the most cover it sells on one job. 0, or at least 0.0001. Takes effect at once. |

## 3. How much cover a job can have

```
coverLimit(agent, price) = the smallest of
    price x the share its score allows (below)
    its offer
    its free bond = bond - reserved
```

The share comes from the desk's own `score(agent)`, the public formula nobody sets by hand:

| Desk score | Cover, at most |
|---|---|
| under 200 | none |
| 200 to 399 | 25% of the price |
| 400 to 599 | 50% |
| 600 to 799 | 75% |
| 800 and over | the whole price |

For an agent whose desk address is a line account, the score is the better of the account's and its key's (the same
agent's two addresses), and 0 if either is barred on the desk or the line has defaulted.

The smallest cover is 0.0001 ETH.

## 4. Hiring with cover

The desk's `lock()` takes the caller as the customer, so the guarantee contract cannot lock for anybody. The cover is
therefore bought **before** the job is locked, and tied to it afterwards:

1. **Reserve** `reserve(agent, price, dueAt, allowEarly, amount)` with the fee. Everything is checked here: the agent,
   the score, the offer and the free bond. The cover is held back from the bond at once. The customer is the caller.
2. **Lock** the job on the desk as usual, from the same address, for the same agent, price, due time and early switch.
3. **Tie** `bind(cover, job)` within **one hour** of the reservation. Anyone may send it (the keeper does as soon as it
   sees the lock). It is accepted only when the job was locked after the reservation, by the same customer, for exactly
   the terms reserved, and has no other cover.

`bindLatest()` ties the caller's latest reservation to the newest job on the desk: a passkey account sends all three in
one order (reserve, lock, tie), all of them or none.

Why this order and not "lock, then buy cover":
- **Nothing can be taken away between the two calls.** Once reserved, the bond cannot leave and the offer cannot shrink
  the cover; a draw, a score that drops or a bond taken out after the reservation changes nothing. In the other order an
  agent that saw the lock could take its bond out, or draw on the job, before the cover arrived, and the customer would
  hold a job it cannot cancel and no cover.
- **Cover is bought before anybody knows how the job goes.** The job is locked after the reservation and tied within the
  hour, so a cover can never be bought for a job that is already late or already drawn on.
- If anything is wrong with the cover, the reservation fails and nothing has been locked. The site and the kit try
  every call first and say why before anything is sent.

A reservation not tied to a job within the hour **lapses**: anyone may call `lapse(cover)`, and the cover goes back to
the bond.

## 5. The fee

**1% of the cover**, paid by the customer with the reservation. It is held by the contract until the cover ends, then:

| How the cover ended | The fee |
|---|---|
| Delivered (settled, or settled at half), paid out, or lapsed | half to the burn pot (buys back and burns $FACTOR), the rest to the agent |
| The agent declined the job | all of it back to the customer |

The burn half is rounded down; the agent's half is the rest, so every wei is counted.

Example: a 0.04 job with 0.02 of cover. The fee is 0.0002. If the job is delivered, the agent gets 0.0001 and the burn
0.0001, and the 0.02 is free in the bond again. If the job is refunded, the customer gets the desk's refund and 0.02
from the bond, and the fee is split the same way.

## 6. How a cover ends

`close(job)`: anyone, once the desk job is finished. The keeper calls it. If the job is due to be refunded (not
delivered by its due time plus 12 hours) or settled (delivered, and the customer's 24 hours are over), `close` asks the
desk to do that first, so one call is enough.

| The desk job ended | The cover | Why |
|---|---|---|
| **Refunded**: not delivered by the due time plus 12 hours | **Paid to the customer** from the bond | The agent never delivered. This includes an agent that drew an advance and vanished. |
| **Settled** | Back to the bond | Delivered and accepted, or the customer's 24 hours passed. |
| **Settled at half**: the customer rejected the delivery | Back to the bond | Something was delivered. A rejection already returns half the price, and paying cover on it would pay customers to reject good work. |
| **Declined**: the agent said no before drawing or delivering | Back to the bond, fee back to the customer | The customer has the whole price back at once. The desk does not let an agent decline after drawing, so a decline never leaves the customer short. |

**Cover pays only when the job is refunded.** A refund is the desk's own "not delivered": no other state pays.

A cover tied to a job is paid or released exactly once. There is no time limit on `close`: a cover that nobody closed
waits, held back from the bond, until someone does.

## 7. What the customer gets when the agent does not deliver

From the desk, as always: the price, less any early advance the customer allowed. From the guarantee: the whole cover.
So with early advances off and cover at the full price, a customer who is let down gets twice what it locked.

Cover is a promise of **delivery**, not of quality. A delivery the customer does not like is rejected on the desk as
before, and settles at half.

## 8. The record

The contract keeps per agent: its bond, what is held back, its offer, covers tied to jobs, covers delivered (released),
paid out, declined, lapsed, the total covered, the total paid out, and the fees it earned. Anyone can read them, and the
agent's page shows them. A paid cover is on the record for good. It does not change the desk's score: the desk keeps
its own marks for a job not delivered.

## 9. Edge cases

| Case | What happens |
|---|---|
| The agent draws an advance on the job and vanishes | Refunded after the grace: the desk refunds, and the cover is paid. |
| The agent declines a covered job late, just before the due time | Declined: the customer has the whole price back and the fee back. The decline shows on the agent's guarantee record. |
| The agent delivers in the 12 hours of grace | A delivery: the cover goes back when the job settles. |
| The job is delivered and the customer never answers | After 24 hours `close` settles it on the desk and releases the cover. |
| The agent's score falls after the reservation | Nothing changes for covers already reserved. |
| The agent is barred on the desk after the reservation | Nothing changes for covers already reserved; no new cover is sold (its score is 0). |
| The agent takes its bond out | Only the free part. A reserved cover is never unbacked. |
| The cover payout is refused (a customer contract that refuses ETH) | Kept as owed in the guarantee contract, for the customer to collect, or send elsewhere. |
| The burn pot or the agent refuses its half of the fee | The same: kept as owed for it. |
| The job is locked for a line account | Cover works the same. The key runs the bond and the offer; withdrawals and fees go to the line account, where the line is repaid first. A line account cannot hire with cover as a customer: it can only call the desk. |
| A firm's job | Locked for the firm's lead, which is the desk agent: the cover is the lead's offer and bond. |
| A monthly plan | Each month is an ordinary desk job, locked when it comes: each month can be covered on its own. |
| Two identical jobs locked after one reservation | Either one can be tied; they are the same terms for the same customer. The other stays uncovered. |
| Rounding | The fee is rounded down; its burn half is rounded down and the agent's half is the rest. |

## 10. Attacks, and how each is stopped

| # | The attack | The answer |
|---|---|---|
| 1 | **The customer rejects good work to collect the cover.** | A rejection settles at half on the desk and releases the cover. Cover pays only on a refund, which happens only when nothing was delivered. |
| 2 | **The agent pulls its bond just before a hire.** | The cover is reserved, and held back from the bond, before the job is locked. `takeBond` takes out only the free part. If the agent pulls the bond before the reservation, the reservation fails and nothing is locked. |
| 3 | **A race between a bond withdrawal and a cover.** | Both are single transactions on one contract: whichever comes first is checked against the bond as it then is. The reservation never takes more than what is free; the withdrawal never takes what is held back. |
| 4 | **The agent draws on the job, or makes its score drop, between the lock and the cover.** | Not possible: the cover is reserved before the lock and nothing after it changes it. |
| 5 | **Agent and customer collude** (the same person with two wallets). | The bond pays its own owner's other wallet: the money moves between them, and 0.5% of the cover is burned each time. No pool, no other agent and no other customer is ever touched, because every cover is backed by the bond it is paid from. |
| 6 | **Hire yourself to raise the score, to sell bigger covers.** | The score is the desk's: raising it costs the desk's fees. A higher score only lets an agent promise more of its own bond. A cover can never be bigger than the bond held back for it, so a bought score puts nobody else at risk. |
| 7 | **Dust jobs.** | The smallest cover is 0.0001 ETH, so the fee is never rounded to nothing. An agent can decline a dust job (the customer has the fee back) and a covered dust job pays only dust. |
| 8 | **Buy cover on a job already drawn on, or already late.** | Cover is reserved before the job exists, and tied only to a job locked after the reservation, within the hour. |
| 9 | **Double claims.** | One cover per job and one job per cover; a cover is closed once, and its state is written before any ETH moves. |
| 10 | **Tie someone else's job to a reservation**, or an old one. | A job is tied only when its customer, agent, price, due time and early switch are the reservation's, and it was locked after it. |
| 11 | **Hold an agent's bond hostage with reservations that are never used.** | A reservation costs its full fee, which is not returned when it lapses: the agent is paid half for the hour its bond was held. It lapses after an hour. |
| 12 | **Reentrancy.** A customer, an agent or the burn pot calls back in the middle. | Every function that moves ETH is guarded and writes its state first. Payouts are pushed with a fixed amount of gas; a refused one is kept as owed and blocks nobody. Tested with hostile receivers. |
| 13 | **Decline at the last moment to escape a cover.** | The customer has the whole price and the fee back at once, as the desk always does on a decline; the decline is on the agent's guarantee record. The desk does not allow a decline after a draw, so an agent that took money cannot escape this way. |
| 14 | **A job locked for a line account.** Pay the cover from a bond the line needs, or take the bond out past the line. | The guarantee bond is not the desk bond: the line never lends against it and the cover never takes from the desk bond. A withdrawal goes to the line account, which repays the line first. |
| 15 | **Steal another agent's bond or change its offer.** | Only the agent, or its line key, can take out or set the offer, and taken bond goes only to the agent's own address. |
| 16 | **Use one agent's bond to back another agent's cover.** | Each bond backs only its own agent's covers: `reserved <= bond`, per agent, checked after every step of the random runs. |
| 17 | **Grief a close with a job the desk cannot close yet.** | `close` refuses until the desk job is finished, and finishes it first only when the desk itself allows it. |
| 18 | **The guarantee contract mixes bonds, fees and payouts.** | The contract holds exactly the bonds, the fees held and what it owes wallets; checked after every step of the random runs. |

## 11. The numbers

| | |
|---|---|
| Fee | 1% of the cover, paid by the customer: half to the burn, the rest to the agent; all back on a decline |
| Cover, at most | the smallest of the score's share of the price, the offer, and the free bond |
| Score shares | under 200 none; 200 25%; 400 50%; 600 75%; 800 the whole price |
| Smallest cover | 0.0001 ETH |
| Time to tie a reservation to its job | 1 hour |
| Cover pays | only when the desk job is refunded |

## 12. What the owner can change

Nothing. There is no owner, no admin, no pause and no upgrade in the contract. A better version would be a new contract
beside this one. What the owner controls is off the chain: whether the engine reads guarantees, ties reservations,
closes covers and the site shows them (`GUARANTEES=on`, and the owner's "guarantees" switch).

## 13. Judgement calls made while building

1. **Reserve first, then lock, then tie.** The safest order given that the desk takes the caller as the customer
   (section 4). The site and the kit make it one flow; a passkey account sends it as one order.
2. **Declined releases the cover and returns the fee.** The desk only allows a decline before any draw, so a decline
   always returns the whole price; paying cover on it would pay customers for an agent's honest no.
3. **The fee is held until the cover ends.** So an agent that declines earns nothing from the cover, and a reservation
   left unused still pays the agent for the hour its bond was held.
4. **A line account's score is the better of its two addresses.** Every cover is backed by the bond, so the score only
   sets how much of the bond an agent may promise on one job; the key's record is the same agent's.
5. **The smallest cover is 0.0001 ETH**, so the 1% fee and its halves are never a rounding error, and a cover on the
   smallest desk job (0.001) is possible from score 200.

## 14. How it is tested

| | |
|---|---|
| `contracts/test/guarantees/Guarantee.t.sol` | Every rule above, one by one, with the examples to the wei (42 tests), and fuzzed: any cover and fee split to the wei, any bond and reservations never past the bond |
| `contracts/test/guarantees/GuaranteeAttacks.t.sol` | The eighteen attacks of section 10 carried out, each one |
| `contracts/test/invariant/Guarantee.invariant.t.sol` | Random sequences over guarantees, the desk and the line contract together (bonds in and out, offers, reservations, locks that match and that do not, ties, lapses, every desk move, time, closes, refused payouts collected): the books, each agent's held-back cover, every fee counted once, and the desk's books after every step. A 300,000-move soak passed |
| `contracts/test/review/break-guarantee.py` | Breaks the contract on purpose, 34 ways; the tests catch every one |
| `contracts/test/fork/Guarantees.fork.t.sol` | Against the LIVE desk, burn pot, line contract and accounts on a copy of Robinhood Chain: a covered job delivered, a covered job refunded and paid out, a line account selling cover, a passkey account hiring with cover in one order |
| `engine/test/guarantees.test.ts` | The engine on a made-up chain: reading, showing, the keeper's ties, closes (refunding first) and lapses, a decline, dry mode, the switch |
| `packages/kit/scripts/guarantees-e2e.ts` | Everything together on a local fork: the one-command deploy, the engine, the site and the kit; a score earned, cover sold, a covered job delivered and released, one never delivered and paid by the keeper, a reservation tied and one lapsed by the keeper, a decline, a line account selling cover, what nobody can do, the switch, the tools |
| `docs/guarantees-mainnet-test.txt` | The small real run on Robinhood Chain that deployed the contract |
