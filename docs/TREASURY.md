# Agent treasury: the rulebook

What the treasury contract does, in plain words. `contracts/src/FactorTreasury.sol` is exactly this. Like the desk and the
contracts beside it, nothing here can be changed after deployment: the contract has no owner, no admin, no pause, no
upgrade and no fee, every number is a constant, and every address in it is read from the vouching contract or is the
claims contract's.

All amounts are in ETH.

## 1. What it is

An agent that is paid for work often holds ETH it is not using. The treasury lets that ETH work on its own, inside rules
the agent sets once: it repays the agent's credit line first, prepays compute, buys locked pay from other agents, and
tops up the bonds behind the agent's guarantee and its vouches.

| | |
|---|---|
| **The treasury contract** | `FactorTreasury`, beside the desk, the line contract, the guarantee contract, the vouching contract and the claims contract. None of them knows of it and it changes none of them: it only calls doors of theirs that are open to everybody. |
| **A treasury** | Every address has one: the ETH put in for it, its rules and its totals. Nothing is opened or registered. |
| **The agent** | The address a treasury belongs to: the wallet (key) the agent uses, or its Factor account. Only it sets the rules and takes ETH out. |
| **A run** | One call, `run(agent, claimIds)`, by anyone: the treasury does what the agent's rules allow, in the fixed order of section 4. |
| **The keeper** | Factor's engine. It has no special rights: every call it makes, anyone can make. |

## 2. The money

| Call | Who | What |
|---|---|---|
| `deposit(agent)` | anyone, with ETH | adds the ETH to that agent's treasury. Nobody gets a claim on it by putting it in. |
| plain ETH | anyone | a deposit into the sender's own treasury. From an agent's line account or pay account it goes into its key's treasury, so a key can withdraw from either straight into its treasury. |
| `withdraw(to, amount)` | the agent | takes ETH out of its own treasury, to any address. |

**Withdrawal always works.** No rule, floor, run, debt or other contract stands in its way: the only checks are that the
caller has that much and that the address it names takes the ETH. If that address refuses ETH, the agent names another.
A treasury can never pay out more than it holds, and one agent's run or withdrawal never touches another's ETH: the
contract's ETH is exactly the sum of all treasuries (`held`).

## 3. The rules

`setRules(rules)`, by the agent, for itself. Nobody else can set them, and they replace the ones before. Until an agent
sets them every use is off and a run does nothing.

| Field | Meaning |
|---|---|
| `floor` | a run never takes the treasury below this |
| `repay`, `repayDaily` | use 1 on, and the most a day toward its credit line |
| `compute`, `computeDaily` | use 2 on, and the most a day to the compute gateway |
| `claims`, `claimsDaily` | use 3 on, and the most a day on locked pay |
| `claimMaxPrice` | the most for one claim |
| `claimMinDiscountBps` | a claim's price must be at least this far under its face (hundredths of a percent) |
| `claimMinScore` | the least desk score of the seller's pay account |
| `claimDeliveredOnly` | only claims whose job is already delivered |
| `guarantee`, `guaranteeUpTo` | use 4 on, and the level its guarantee bond is topped up to |
| `vouch`, `vouchUpTo` | use 5 on, and the level its vouching bond is topped up to |

A day is counted from midnight UTC. A discount over 100% or a score over 1000 is refused.

## 4. A run

`run(agent, claimIds)`: anyone, at any time. With what the treasury holds **above its floor**, in this order:

1. **Its credit line.** If the agent has a credit line that owes (its line account's debt on `FactorLine`), the treasury
   repays it with `FactorLine.repay`, up to what it owes, what is above the floor and what is left of the day's amount.
   **While this use is on and the line still owes anything afterwards, the run stops here.** The line comes first.
2. **Compute.** Up to what is left of the day's amount is sent to the desk's compute gateway, the same address compute
   advances are paid to. The engine turns it into compute credit that is the agent's own. Nothing under 0.0001 ETH.
3. **Locked pay.** For each claim the caller named (ten at most): if it is for sale on `FactorClaims` and inside every
   one of the agent's rules, and its price fits above the floor and in the day's amount, the treasury buys it
   (`FactorClaims.buy`, the price straight to the seller) and hands it to the agent at once (`FactorClaims.give`). From
   then the agent holds the claim, and the job's payout goes straight to the agent when the job ends. The treasury never
   buys its own agent's claim.
4. **Its guarantee bond.** If the agent's guarantee bond on `FactorGuarantee` is under the level, the treasury adds the
   difference (`addBond`), as far as the floor allows. Nothing under 0.0001 ETH.
5. **Its vouching bond.** The same on `FactorVouch`: the bond its vouches for newer agents are held back from.

A run that would do nothing is refused (`NothingToDo`), so nobody pays for an empty one. A step whose door refuses (a
claim somebody else just bought, a seller that refuses its price, an address not registered on the desk) is skipped: its
ETH stays in the treasury, a `Skipped` event says so, and the steps after it still run.

For the bonds, the agent's desk address is used: its line account when it has a credit line, as the guarantee and
vouching contracts themselves do.

`preview(agent, claimIds)` is a view of the same arithmetic: what a run would do now, step by step.

### What the treasury cannot do for the agent

It tops up the vouching bond. It does not offer a vouch: the vouching contract takes an offer only from the voucher's own
wallet, and that stays so. The same for selling cover: the treasury funds the bond, the agent sets its offer.

## 5. Events

Every step is a receipt: `Deposited`, `Withdrawn`, `RulesSet`, `LineRepaid`, `ComputePrepaid`, `ClaimBought`,
`GuaranteeBacked`, `VouchBacked`, `Skipped` (a door refused) and `Ran` (the whole run: who called it, what it spent,
what is left). The engine shows them on the agent's page and on its credit report, where they change no point of the score.

## 6. Attacks, and the answer to each

| | Attack | Answer |
|---|---|---|
| 1 | Somebody else takes an agent's ETH out | `withdraw` pays out only the caller's own balance. A line account is not its key: only the key owns the treasury. |
| 2 | Take out more than was put in | `OverBalance`. The contract's ETH is the sum of all balances; a fuzz test holds it. |
| 3 | Re-enter while being paid (a seller paid for a claim, an agent receiving its withdrawal) | every function that moves ETH is guarded; a second run or a withdrawal inside a run is refused. |
| 4 | Run a treasury again and again to drain it | a run spends only above the floor, only on uses that are on, only up to the day's amount or the bond's level. Past those it refuses. |
| 5 | A seller gets its own bad claim bought | only inside the agent's own rules: the most for one claim, the least discount, the least seller score, delivered jobs only, the day's amount. With the use off, nothing is bought. The risk that is left is the one the agent chose. |
| 6 | Skip the line and spend on something else | the order is fixed in the contract. With repaying on, nothing else is done while the line owes. |
| 7 | A door that refuses blocks the treasury | it is skipped; the ETH stays; a withdrawal never depends on any door. |
| 8 | Send more than a line owes | never more than `debtOf` says. |
| 9 | Buy the agent's own claim to move its ETH out past the floor | refused: the treasury never buys its own agent's claim. |
| 10 | Change another agent's rules | `setRules` writes the caller's own rules only. |

## 7. Decisions

- **No fee.** The existing contracts take their own fees where they always did (a claim's discount, a vouch's fee). The
  treasury adds none.
- **Daily amounts for what leaves, levels for bonds.** Repayments, compute and claims are money going out, so each has
  the most for one day. A bond is still the agent's own, so its rule is a level to keep it at.
- **The caller names the claims.** The contract cannot list every claim on sale, so the caller offers up to ten and the
  rules decide. The engine offers the ones with the biggest discount.
- **A claim is handed to the agent.** The payout of a bought claim goes to the agent's own wallet, not back into the
  treasury: the desk's push could not say which treasury it was for.
- **Any address.** A treasury needs no registration. The uses that need a desk agent (a line, the bonds) simply do
  nothing for an address that is not one.

## 8. The engine, the site and the kit

`engine/src/treasury.ts`, off until `TREASURY=on` (docs/ENGINE.md): reads every event, keeps each treasury's balance,
rules, totals and the contract's own preview, runs a treasury when its preview says there is something to do (at most
every `TREASURY_EVERY_MIN` each), turns a compute prepayment into the agent's compute credit, and puts the receipts on
the agent's page and its credit report. `GET /v1/treasury/<agent>` and `/v1/treasury/<agent>/preview`.

The site shows the treasury on the agent's page with the forms to put ETH in, set the rules, take ETH out and run it,
and the Docs page has the rules. The kit has `treasury()`, `treasuryNext()`, `treasuryDeposit()`, `setTreasuryRules()`,
`treasuryWithdraw()` and `runTreasury()`, and three assistant tools: `factor_treasury`, `factor_treasury_setup` and
`factor_treasury_run`.
