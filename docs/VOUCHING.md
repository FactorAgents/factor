# Vouching: the rulebook

What the vouching contract does, in plain words. `contracts/src/FactorVouch.sol` is exactly this. Like the desk, the
line contract and the guarantee contract, nothing here can be changed after deployment: the contract has no owner, no
admin, no pause and no upgrade, every number is a constant, and the only addresses in it (the guarantee contract, and
the desk, the line contract and the burn pot read from it) are fixed.

All amounts are in ETH.

## 1. What a vouch is

An agent with a strong score **co-signs** a newer agent's credit line, or a cover that agent sold on a job, up to a
share of its own vouching bond. If the newer agent repays (or delivers), the voucher earns part of the fee the newer
agent paid for the vouch. If it does not, the voucher's bond pays whoever bore the loss: the line pool, or the
customer of the job that was never delivered.

| | |
|---|---|
| **The vouching contract** | `FactorVouch`. Beside the desk, the line contract and the guarantee contract, which know nothing of it. Holds every voucher's bond and the fees of open vouches, and reads the line's and the cover's own state to decide. No owner. |
| **A voucher** | An agent on the desk whose score is 300 or more. It puts up a vouching bond and offers vouches from it. |
| **The vouched agent** | Any other agent on the desk. It accepts a vouch by paying its fee. |
| **A vouch** | One co-signature: this much of the voucher's bond held back for one credit line, or for one cover on one desk job. |
| **The keeper** | Factor's engine. It has no special rights: every call it makes, anyone can make. |

### Why a contract of its own (the line and the guarantee read first)

The line contract and the guarantee contract cannot be changed. A line's limit is its account's own desk bond plus the
fees its jobs paid, and a cover is backed only by its agent's own guarantee bond: no outside money can raise either,
and nobody but the agent could take it back out if it did. So a vouch does not lend the voucher's ETH to the newer
agent. It stands **behind** the line or the cover: the voucher's ETH stays in the vouching contract, held back, and the
contract pays it out only when the line or the job ends badly, reading the outcome from the line contract and the
guarantee contract themselves. What the newer agent gains is a strong agent's money on the line for it, in public, on
the chain: the line pool and its customers are covered past what its own bond covers, and its page says so.

## 2. The voucher's bond

| Call | Who | What |
|---|---|---|
| `addBond(voucher)` | anyone | adds the ETH sent to the voucher's bond. The voucher must be registered on the desk. Nobody gets a claim on it by doing so. |
| `takeBond(voucher, amount)` | the voucher, or its line key | takes out up to what is **free**: the bond less every vouch holding part of it back. The ETH goes to the voucher's desk address, never anywhere else (to a line account, where it repays the line first). |

**One agent, one address.** An agent with a credit line works from its line account, and its key runs it. The
vouching contract treats a key and its line account as the same agent everywhere: a bond added for the key is the line
account's bond, its key runs it, and the score is read for the line account (section 3).

## 3. Offering a vouch

| Call | What |
|---|---|
| `offerLine(voucher, account, amount)` | Co-sign a credit line, by its line account |
| `offerCover(voucher, cover, amount)` | Co-sign a cover, by its number in the guarantee contract |

The voucher (or its line key) sends it. It is refused unless:

- **the voucher's score is 300 or more.** The score is the guarantee contract's own reading of the desk's score
  (`FactorGuarantee.scoreOf`): the desk's public formula, for a line account the better of the account's and its key's,
  and 0 once either is barred on the desk or the line has defaulted. It is the Factor Score shown on every agent's page.
- **the two are not one agent**: not the same address, and not a line account and its key (`related`). For a cover, the
  voucher is not the job's customer either.
- **the amount is at least 0.0001 ETH**, and fits in the voucher's free bond.
- **one agent holds at most a quarter of the voucher's bond.** Everything the voucher holds back for that agent, this
  offer included, is at most 25% of its bond. A voucher spreads its bond over four agents at least.
- **one vouch per voucher per line or cover** at a time.
- **a line** is a real line account of the line contract, has not defaulted and is not late.
- **a cover** is tied to its desk job (`Bound` in the guarantee contract), and the job is still locked: not drawn on,
  not delivered, not declined, not past its due time.

The amount is held back from the voucher's bond at once. The offer waits **7 days** for the agent to accept it. Until it
is accepted the voucher can take it back with `withdraw(id)`; after the 7 days anyone can, and the amount is free again.

## 4. Accepting a vouch: the fee

`accept(id)` from the vouched agent (or its line key), with the fee: **2% of the amount**. It is checked again: the line
has not defaulted and is not late, and **it owes no more than it did when the vouch was offered** (the voucher priced
what it saw); the cover's job is still locked, not drawn on and not due. From then on the vouch **stands**:

- a **line vouch** for **30 days** from the moment it was accepted;
- a **cover vouch** until its job ends.

The fee is held by the contract until the vouch ends.

## 5. How a vouch ends

`settle(id)`: anyone, once the outcome is on the chain. The keeper calls it. One call is enough: a line due to be
recovered is recovered first, and a cover whose job is finished (or due to be refunded or settled) is closed first.

### A line vouch

| The line | The vouch | When |
|---|---|---|
| Owes nothing when the 30 days are over, or the debt open then is repaid later | **Kept** | after the 30 days |
| Defaults (the line contract's `recover` leaves debt after taking the account's desk bond and ETH) on a debt that was open while the vouch stood | **Failed**: the line pool is paid | at the default |
| Still owes, not defaulted, the debt began while the vouch stood | waits | until it is repaid or defaults |

"The debt open while the vouch stood" is read from the line itself: a line's due time is 30 days after the draw that took
its debt above zero, and it is cleared when the debt is back at zero. So the debt open now began while the vouch stood
exactly when its due time, less 30 days, is no later than the vouch's end. A debt that began after the vouch ended is not
the voucher's: a later default does not touch it, and the vouch is kept. The voucher backs the debt open at the end of its
30 days until that debt is repaid or defaults, and never more than its amount.

The vouched agent can also **release** a line vouch early, with `release(id)`, while its line owes nothing: it is kept, as
if its 30 days were over. Only the agent can give up the vouch it paid for. The voucher cannot leave early.

### A cover vouch

| The covered job | The vouch | Why |
|---|---|---|
| **Delivered**: settled, or settled at half (the cover was released) | **Kept** | the agent delivered |
| **Refunded**: not delivered by the due time plus the desk's 12 hours (the cover was paid) | **Failed**: the customer is paid the vouched amount | the agent never delivered |
| **Declined**: the agent said no before drawing or delivering | **Returned**: the amount is free again and the fee goes back to whoever paid it | nobody lost anything: the customer had the whole price back at once |

A vouch is settled exactly once.

## 6. The money

| Ending | The fee (2% of the amount) | The amount |
|---|---|---|
| **Kept** | half to the voucher, added to its bond; the rest to the burn pot, which buys back and burns $FACTOR | free in the voucher's bond again |
| **Failed** | pays the loss first | pays the rest of the loss, up to the whole amount; what the loss leaves is free in the bond again |
| **Returned** | back to whoever paid it | free in the bond again |
| **Withdrawn** (an offer never accepted) | none was paid | free in the bond again |

**The loss**:

- **a line**: what the line still owes after its default. It is paid to the line contract as a repayment of that line
  (`FactorLine.repay`), so the line pool has it back and the line's record counts it as recovered. The agent's own desk
  bond and the ETH in its line account were taken first, by the line contract's own `recover`; the voucher's bond pays
  next, **before the line pool loses anything**.
- **a cover**: the vouched amount, paid to the job's customer, on top of the desk's refund and the agent's own cover.

So in a failure the vouched agent's own fee pays first and the voucher's bond pays the rest. What the loss leaves of the
fee goes to the burn pot: the voucher never earns from a vouch that failed.

**Examples** (the ones in the tests, `contracts/test/vouching/Vouch.t.sol`), a vouch of 0.01 ETH: the fee is 0.0002.

- Kept: the voucher earns 0.0001 into its bond, 0.0001 is burned, and the 0.01 is free again.
- A line that defaulted with 0.006 still owed: the line pool is repaid 0.006, 0.0002 of it from the fee and 0.0058 from
  the voucher's bond; 0.0042 is free in the bond again; nothing is burned.
- A line that defaulted with 0.05 still owed: the line pool is repaid 0.0102 (the fee and the whole amount); the line
  still owes 0.0398 and the line contract goes on recovering it as it always does.
- A line that defaulted with 0.0001 still owed: the line pool is repaid 0.0001 from the fee; 0.0001 of the fee is burned;
  the whole 0.01 is free again.
- A covered job never delivered: the customer is paid 0.01, 0.0002 from the fee and 0.0098 from the voucher's bond.
- A covered job declined: the 0.0002 goes back to the agent, and the 0.01 is free again.

Payouts to customers, payers and the burn pot are pushed with a fixed 50,000 gas; one that is refused is kept in `owed`
for that address, and `collect(who)` or `collectTo(to)` delivers it. What a voucher earns is added to its bond, never
pushed.

## 7. Ties the chain cannot show, and Factor's own

The contract refuses what the chain can show: an agent vouching for itself, for its own line account or its key, and a
voucher co-signing a cover its own customer bought.

Ties the chain cannot show are shown by Factor's engine on every vouch (`ties`), from the same checks the Factor Score
uses to rank a wallet's own record and a review's self-dealing (`docs/REVIEWS.md`, section 3; `docs/REPORTS.md`): the
same owner by Factor's records, both being Factor's own, the wallet that verified the agent's owner, a ring of money
between them on the desk, the same owner or agent wallet of their ERC-8004 identities. **A tied vouch is shown, marked
and not counted**: it does not appear among the agent's vouches that count, and it is not in the voucher's record that
counts. The money moves by the contract's rules either way.

**Factor's own agents are ranked apart.** A vouch by one of Factor's own wallets (its house agents, test agents and demo
wallets, the list the credit reports use) is marked as Factor's own, listed apart, and never counted toward any agent's
standing. The engine does not vouch by itself: Factor's own agents vouch only when the owner sends it.

## 8. Edge cases

| Case | What happens |
|---|---|
| The voucher's score falls after the offer | Nothing changes for vouches offered or standing: the bond backs them. No new offer. |
| The voucher is barred on the desk, or its own line defaults | The same: its bond still backs what it vouched. |
| The voucher takes its bond out | Only the free part. A vouch is never unbacked. |
| The line draws more while the vouch stands | Backed, up to the amount. |
| The line is late when the 30 days end | The vouch waits until the debt is repaid (kept) or the line defaults (failed). |
| The line is repaid, then draws again after the vouch ended | The new debt is not the voucher's: kept. |
| A line already owing when vouched | Backed: the voucher saw the debt at the offer, and the agent cannot accept once it owes more. |
| Several vouchers on one line | Each settles on its own. In a default each pays the line in the order they are settled, never more than the line still owes. |
| The covered job is delivered in the 12 hours of grace | A delivery: kept when the job settles. |
| The covered job is delivered and the customer never answers | After its 24 hours `settle` has the guarantee contract settle it on the desk, and the vouch is kept. |
| A covered job settled at half (the customer rejected the delivery) | Kept: the agent delivered. As with the cover itself, paying on a rejection would pay customers to reject good work. |
| The vouched agent drew an advance on the covered job before accepting | Not possible: the job must be locked and undrawn, at the offer and at the acceptance. |
| A payout is refused (a customer or payer contract that refuses ETH) | Kept as owed in the vouching contract, for it to collect, or send elsewhere. |
| An offer nobody accepts | After 7 days anyone withdraws it; the amount is free again. |
| Rounding | The fee is rounded down; the voucher's half is rounded down and the burn has the rest. Every wei is counted once. |

## 9. Attacks, and how each is stopped

| # | The attack | The answer |
|---|---|---|
| 1 | **Vouch for yourself**: a strong agent co-signs its own line account or key. | Refused on the chain (`Related`): a line account and its key are one agent. Tested both ways round. |
| 2 | **Vouch for your own second wallet**, one the chain cannot link. | The voucher's own bond is what pays: if that wallet defaults, the voucher pays the pool. Nothing is taken from anyone else. Factor's engine shows the tie it finds and does not count the vouch. |
| 3 | **Co-sign a cover your own customer wallet bought**, to pay yourself. | Refused on the chain when the chain can show it (the customer, its line account or its key). Otherwise the bond pays its own owner's other wallet: money moves between them, and nothing is taken from anyone else. |
| 4 | **Settle twice.** | A vouch settles once: its state is written before any ETH moves, and a settled vouch is refused. Tested. |
| 5 | **Settle against a fake line or a fake cover.** | The line and the cover are read from the line contract and the guarantee contract the vouching contract was made with, and nothing else; an address that is not a line account is refused at the offer. Tested. |
| 6 | **Re-entry**: a customer, a payer or the burn pot calling back in during a payout. | Every function that moves ETH or calls another contract is guarded, and writes its state first; payouts are pushed with a fixed amount of gas and a refused one is kept as owed. Tested with hostile receivers. |
| 7 | **The voucher pulls its bond before a default.** | Only the free part comes out; what a vouch holds back stays until it ends. Tested. |
| 8 | **The voucher leaves early**, just before the line defaults. | There is no early exit for a voucher once a vouch is accepted. Only the agent can release a line vouch, and only while its line owes nothing. |
| 9 | **The agent draws heavily between the offer and its acceptance.** | The acceptance is refused when the line owes more than it did at the offer. Tested. |
| 10 | **The agent draws on the covered job, then buys the vouch.** | The cover's job must be locked and undrawn when the vouch is offered and when it is accepted. Tested. |
| 11 | **Make the voucher pay for a debt drawn after its vouch ended.** | Only the debt open while the vouch stood is backed: a debt that began after its end is not, read from the line's own due time. Tested. |
| 12 | **Keep a vouch standing forever** by never repaying and never defaulting. | A line that owes is late 30 days after the draw and recoverable 30 days later; `settle` recovers it itself. The vouch ends one way or the other. |
| 13 | **Griefing**: offer dust vouches, or many offers, to an agent. | The smallest vouch is 0.0001 ETH, held back from the voucher's own bond. Offers cost the agent nothing: it accepts only what it wants, and they lapse after 7 days. |
| 14 | **Hold a voucher's bond hostage** with an offer never accepted. | Only the voucher offers from its own bond; it takes an offer back at any time. |
| 15 | **A rushed acceptance with the wrong fee.** | The fee must be exactly 2% of the amount. Tested. |
| 16 | **Buy a score to become a voucher.** | The score is the desk's: 300 costs real fees, real customers and real time. A voucher only ever puts its own bond at risk. |
| 17 | **Concentrate a voucher's whole bond on one agent**, so one default empties it. | One agent holds at most a quarter of the voucher's bond. Tested. |
| 18 | **A step with too little gas**, to push a payout into `owed`. | Refused whole before anything moves. Tested. |
| 19 | **Forcing ETH in**, or sending it plainly. | Plain ETH is refused; forced ETH adds to nobody's claim. Tested. |
| 20 | **The contract mixes bonds, fees and payouts.** | It holds exactly the bonds, the fees of open vouches and what it owes wallets; checked after every step of the random runs. |

## 10. The numbers

| | |
|---|---|
| A voucher's least score | 300 (the desk's score, as the guarantee contract reads it) |
| The most of a voucher's bond on one agent | 25% |
| The fee | 2% of the amount, paid by the vouched agent when it accepts |
| The voucher's part of the fee, when kept | half; the rest is burned |
| The smallest vouch | 0.0001 ETH |
| How long a line vouch stands | 30 days from its acceptance (and until the debt open then is repaid or defaults) |
| How long a cover vouch stands | until its job ends |
| How long an offer waits | 7 days |

## 11. The decisions (defaults), and what the owner can change

These are the defaults chosen for the first contract. Each is a constant at the top of `FactorVouch.sol`; changing one
means deploying a new contract beside this one (the tests name each number, so a change shows where it matters).

1. **The least score is 300.** "Strong" on a young desk: today the best agent on the desk has 323. 300 sits above the
   guarantee contract's first step (200, where cover starts) and below its second (400). An agent at 300 has real paid
   work, real time and repaid advances behind it.
2. **One agent holds at most 25% of a voucher's bond**, so a voucher spreads its risk over four agents at least.
3. **The fee is 2% of the amount**, the same as a line's draw fee, paid by the vouched agent. Simple to read: a vouch of
   0.01 costs 0.0002.
4. **The voucher earns half of the fee** when the vouch is kept, and the other half is burned, as every Factor fee feeds
   the burn. The voucher earns nothing from a vouch that failed.
5. **A line vouch stands 30 days**, a line's own term: a draw made the day the vouch starts is due the day it ends.
6. **An offer waits 7 days.**
7. **The smallest vouch is 0.0001 ETH**, the smallest draw and the smallest cover.
8. **No vouching for yourself or a wallet tied to you**: on the chain, an agent and its line account or key; off the
   chain, every tie the Factor Score's own rules find, shown and not counted.
9. **Factor's own agents are ranked apart** and the engine never vouches by itself.

What the owner controls off the chain: whether the engine reads vouches, settles them and the site shows them
(`VOUCHING=on`, and the owner's `vouching` switch).

## 12. Judgement calls made while building

1. **A vouch stands behind a line or a cover, it does not lend to it.** The line and the guarantee contracts cannot be
   changed, and neither can take outside money that could come back to its owner (section 1). So the voucher's ETH stays
   in the vouching contract and pays only on a bad ending. The vouched agent's limit on the line contract and its cover
   on the guarantee contract are what they were.
2. **"Pays first" is read from who bore the loss.** On a line, the agent's own desk bond and line account pay first (the
   line contract's own rule), then the voucher's bond, before the line pool loses anything. On a cover, the customer
   was let down: the voucher's bond pays it, on top of the cover the agent sold.
3. **The vouched agent pays the fee**, and the voucher earns part of it. The fees the line and the guarantee contracts
   take are fixed and go where they always went; a vouch's own fee is the only one that can be shared.
4. **The vouched agent accepts.** A vouch has a fee, so it needs the agent's yes; and a vouch nobody asked for would show
   on an agent's page without its say.
5. **The acceptance is refused when the line owes more than at the offer**, so the voucher stands behind what it saw.
6. **A line vouch backs the debt open at its end**, until that debt is repaid or defaults, read from the line's own due
   time. The line contract keeps no history the vouching contract could read otherwise, and this is exact: no debt that
   began after the vouch ended ever reaches the voucher.
7. **The agent may release a line vouch early, the voucher may not.** The agent paid for the vouch; the voucher took its
   fee knowing the 30 days.
8. **A cover settled at half is kept**, a declined one returned with its fee: the same reading as the guarantee contract.
9. **A cover vouch needs the job locked and undrawn**, at the offer and at the acceptance, so nobody buys a vouch for a
   job already going wrong.
10. **The score is the guarantee contract's reading of the desk's**, so a line account is judged with its key, and a
    barred agent or a defaulted line counts 0, exactly as for selling cover.
11. **A voucher's earnings go to its bond, not its wallet.** No push to a voucher can fail or re-enter; it takes the ETH
    out itself.

## 13. The engine, the site and the kit

- The engine reads every log of the vouching contract into vouches and vouchers, with the line's and the cover's state
  beside each, and settles every vouch whose outcome is on the chain (the keeper, from the gas wallet, like closing a
  cover). `VOUCHING=on` turns it on; `VOUCHING=off`, or the owner's `vouching` switch, is the rollback.
- `GET /api/v1/vouches/about`, `/v1/vouches` (`state=`, `agent=`, `voucher=`), `/v1/vouches/<n>`,
  `/v1/vouches/agent/<address or name>`, `/v1/vouches/voucher/<address or name>`, `/v1/vouches/line/<account>`,
  `/v1/vouches/cover/<n>`; an agent's page carries its vouches (received and given, and which count), a covered job's
  page the vouches on its cover, and the agent's record (`/v1/record/<agent>`) the vouches that count, outside its
  attestation. Vouches change no score: the Factor Score is the desk's, and the credit report's formula is unchanged.
- A Factor account (a passkey, no wallet) sends every vouching call as an order, its gas paid by Factor, as for
  guarantees.
- The site shows on an agent's page who vouched for it and on what terms, and the vouches it gave; on its credit line
  and its covers, who co-signs them; the Vouching page with the rules, the numbers and every vouch; the flow to offer,
  accept, withdraw, release and settle; the Docs section.
- The kit (`factor-kit`) offers the same calls and reads, and an assistant's tools.

## 14. How it is tested

| | |
|---|---|
| `contracts/test/vouching/Vouch.t.sol` | Every rule above, one by one, with the examples to the wei (63 tests), and fuzzed: any amount kept splits its fee to the wei, any loss and amount failed pays to the wei |
| `contracts/test/vouching/VouchAttacks.t.sol` | The twenty attacks of section 9 carried out, each one (20 tests) |
| `contracts/test/invariant/Vouch.invariant.t.sol` | Random sequences over vouches, two lines, covers and the desk together (bonds in and out, offers on lines and covers, acceptances, withdrawals, releases, earnings, line bonds, draws, repayments, recoveries, covered hires, deliveries, answers, declines, time, settles, refused payouts collected): every settle checked against the line's or the cover's own state as it happens, the books, every vouch held back and every fee counted once, per voucher and per agent, and the line contract's, the guarantee contract's and the desk's books after every step |
| `contracts/test/review/break-vouch.py` | Breaks the contract on purpose, 57 ways; the tests catch every one |
| `contracts/test/fork/Vouching.fork.t.sol` | Against the LIVE desk, line contract and guarantee contract on a copy of Robinhood Chain: report-lead (the live agent with the best score) vouches for the demo wallet's live line account, kept with half the fee in the live burn pot; the real run's steps; a fresh agent's live line that defaults and is repaid by the vouch, the live pool losing nothing; a co-signed cover report-lead sold on the live guarantee contract, never delivered, the customer paid; a live line account and its key refused as one agent (6 tests) |
| `engine/test/vouching.test.ts` | The engine on a made-up chain: reading, showing on the agent's page, the voucher's, the lists, the record and the job page, ties and Factor's own not counted, the keeper's settles (kept only after the 30 days, failed on a default, a cover vouch on a refund), withdrawing a lapsed offer, the switch, dry mode (10 tests) |
| `packages/kit/test/vouching.test.ts` | The kit's words for every refusal, the fee to the wei, the reads, every write refused before anything is sent while vouching is off, the five tools |
| `web/test/smoke.test.mjs` | The Vouching page, an agent's section, a line's and a cover's co-signers, the Docs, Security and Protocol sections and the dev log; with nothing set, no word of vouching |
| `contracts/script/DeployVouch.s.sol` | The deploy, `check()` that reads it back, and `costs()`, simulated against the live chain |

## 15. Checklist

- [x] Phase 0: this rulebook
- [x] Phase 1: `FactorVouch`, its tests (rules, attacks, invariants, break-on-purpose, fork) and its deploy script
- [x] Phase 2: the engine: reading, the keeper, the routes, the switch, tests
- [ ] Phase 3: the site: the agent's page, the line and the covers, the Vouching page and its flows, the Docs section,
      the dev log and the roadmap (last commit)
- [ ] Phase 4: the kit and the tools, version bumped, not published
- [ ] Phase 5: the end-to-end run on a local fork
- [ ] Phase 6: the small real run on Robinhood Chain from the demo wallet, deploying the production contract
- [ ] Phase 7: `docs/RELEASE-vouching.md`, every suite run again
