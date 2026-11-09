# Verifiers: warnings

What your kit must show its users, or handle in code. Each point is what `contracts/src/FactorVerifiers.sol` or the
engine enforces, with where.

## For a verifier

**1. A verdict puts part of the bond at risk.** Each verdict stakes 20% of the job's price (at least 0.001 ETH) from the
free bond (`stakeOf(price)`). A wrong call loses half of it; a panel seat never revealed loses all of it. Show the stake
(`stakeEth` in the case) before every check and every seat. (`_wrong`, `_hidden`, `WRONG_BPS`)

**2. A seat must be revealed in its window.** From D + 14 h to D + 18 h. Before it, `TooSoon`; after it, `TooLate`, and
the stake is gone. A kit that seals a verdict must keep `accept` and `reason` (and the salt if it is not made from a
deterministic signature) and remind the user when the window opens. (`reveal`)

**3. The salt must be made again exactly.** `salt = keccak256(personal_sign("Factor verifier seal\ncase: <id>\nverifier:
<lowercase address>"))`. A wallet's signature is deterministic; a smart account's may not be, so a kit acting for one
must store the salt. A reveal whose commit does not match is refused (`BadReveal`). (`commitOf`)

**4. Earnings are not sent: they are added to the free bond.** Withdraw them with `withdraw`. Only the free bond comes
out; a stake on an open case stays until the case ends (`OverFree`). (`_credit`, `withdraw`)

**5. A bond under 0.01 ETH has no standing.** It cannot check or sit (`NoStanding`). Withdrawing below 0.01 ETH, or a
loss that takes it below, ends the standing; topping it up starts a new one, from that moment. A newer standing loses
seats to older ones. (`_unstand`, `_restand`)

**6. Changing the declared maker starts the standing again,** and is refused while the verifier holds a seat
(`HasOpenSeats`). (`setMaker`)

**7. A seat can be lost before seating closes.** A verifier of an older standing takes the seat of the same maker, or
the newest seat of a full panel, until D + 14 h; the customer and the agent may each strike one panelist. Either way
the stake comes back whole, and the kit should say the seat was lost (`Displaced`, `Struck`). A struck verifier cannot
sit on that case again (`StruckOff`). (`sit`, `strike`)

**8. Only the first check is paid when nobody disputes.** The first verdict given is the one; a second check of the same
case is refused (`WrongState(2)`). Checking takes a model call; check `forYou` and the case's state just before
spending on one. (`check`)

**9. A verifier tied to a side cannot check or sit.** The customer, the agent, and a line account's key on either side
are refused on the chain (`Related`). Ties the chain cannot show (the same owner behind two wallets) are shown as
`ties` and are for the sides to strike; a kit should not offer to check a case where its own wallet shows ties.
(`related`)

## For a customer or an agent

**10. The fee is paid on top of the price,** at least 0.0001 ETH and at most the price. It comes back if nobody checks
by D + 4 h, or if the customer accepts before any check. (`hire`, `_noCheck`)

**11. The customer cannot reject on its own while a verifier can still decide.** It may accept at any time after the
delivery (except while a panel sits); it may reject only when nobody checked in time, when no panelist revealed, or to
carry out a verdict of reject. (`accept`, `reject`)

**12. A dispute costs a bond,** 10% of the price, at least 0.0005 ETH, sent exactly (`WrongValue`). Lost if the panel
agrees with the first verdict, back if it does not; with no panel at all it goes to the first verifier. Only the side the
verdict goes against may dispute, within 2 hours of it. (`dispute`, `_decide`)

**13. Each side has one strike,** until D + 14 h. (`strike`)

**14. Everything ends inside the desk's 24 hours.** The agent is never paid later than on an ordinary desk job. A verdict
of reject that nobody carries out before D + 24 h is overtaken by the desk's own clock: anyone settles the job as
accepted, and the verifiers are paid as the verdict said. Factor's engine steps every case on time; a kit should step
one itself when its `next` is `step` and nobody has. (`step`, `_rejectOrClock`)

**15. A refused payout is kept, not lost.** Customers and agents are paid with 50,000 gas; a wallet that refuses it has
it in `owed(address)`, collected with `collect(who)` or `collectTo(to)`.

## Amounts and reading

**16. Amounts are wei.** Never compute with the API's `...Eth` numbers; use the `...Wei` fields or the chain.

**17. The engine is a guide, the contract decides.** `forYou`, `next` and `ties` are read from the engine's copy of the
chain, a few seconds behind. Simulate every call before sending it.

**18. Rate limits.** The engine answers 429 to more than 600 reads a minute and 30 writes a minute from one address.
