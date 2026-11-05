# Tests for your fork

All on-chain cases run against the **live desk's bytecode** on a fork of Robinhood Chain (chain id 4663). Nothing is
sent to the real chain. They need no Factor source: the Foundry test talks to the desk through an interface written
from `abi/FactorDesk.abi.json`, and the cast script uses only `cast`.

## How to run

```
# 1. a local fork of the live chain (keep it running in another shell; stop it when done)
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8545

# 2. the Foundry tests
cd tests/foundry
forge install foundry-rs/forge-std --no-git     # once (the tests were run with forge-std 1.16.2)
forge test --fork-url http://127.0.0.1:8545 -vv

# 3. the cast script: the whole happy path, with the gas of every call
cd tests/cast
RPC=http://127.0.0.1:8545 ./happy-path.sh

# 4. the three engine signatures, built and checked locally (no network)
./sign-examples.sh
```

Run soon after starting anvil. The public node keeps old state only for a short time, so a fork that sits idle
for long can fail to load state it has not read yet; restart anvil if that happens. `happy-path.sh` refuses to run
unless the node is anvil on chain 4663 with the desk's known code hash, and it mines one block first (on a fresh fork
of this chain, anvil refuses `eth_call` with "Excess blob gas not set" until it has mined a block of its own).

## Results (run on 2026-11-05)

| Run | Where | Result | Output |
|---|---|---|---|
| `forge test` | anvil fork of block 106,731,902 | **16 passed, 0 failed** | `tests/output/forge-test.txt` |
| `happy-path.sh` | anvil fork of block 106,731,902 (+1 mined) | **ALL STEPS PASSED** | `tests/output/cast-happy-path.txt` |
| `sign-examples.sh` | local only | 3 of 3 signatures recover to the signer | `tests/output/sign-examples.txt` |
| `verify.sh` | live public RPC, block 106,729,898 | **All checks passed** | `tests/output/verify.txt` |

The messages `sign-examples.sh` builds were also compared byte for byte with the kit's own `profileMessage`,
`payLinkMessage` and `applyMessage` (factor-kit 0.16.0, run with Node from the kit's `dist`): identical, and the
pay link token decodes with the kit's `readPayLink` to the same link.

## The cases

Notation: `C` = customer, `A` = agent, `S` = any other wallet. Prices in ETH; on chain they are wei.

### Happy path

| # | Setup | Call | Expected | Foundry / cast |
|---|---|---|---|---|
| T01 | A not registered; C funded | A `register()`; C `lock(A, now+24h, false)` 0.01; A `addBond()` 0.002; A `draw(id, 0.002, Pool)`; A `deliver(id, keccak(work))`; C `accept(id)` | id = jobCount; `canDrawOn` is (0, 0) before the bond and (0, 0.002) after; A gets 0.00198, burn pot 0.00002; states 1, 2, 3, 4; A gets 0.0078 on accept (0.01 - 0.002 - 0.0002); `advancedNow` 0, `settled` 1, `feesPaid` 0.0002 | `test_T01`, cast steps 1 to 5 |
| T02 | A registered | C `lock(A, now+2h, true)` 0.004; A `draw(id, 0.002, Early)`; A `deliver`; S `settle(id)` at once; warp 24 h; S `settle(id)` | `canDrawOn` early = 0.002; the first settle reverts `TooSoon(deliveredAt + 86400)`; the second settles; A gets 0.00192 | `test_T02`, cast step 6 |
| T03 | A registered | C `lock` 0.01; A `deliver`; C `reject(id)` | C gets 0.005, A gets 0.0049 (half less 2% of the half); state 5; `settledAtHalf` 1 | `test_T03` |
| T04 | A registered | C `lock` 0.003; A `decline(id)` | C gets 0.003 back; state 6; `unanswered` and `notDelivered` stay 0 | `test_T04`, cast step 7 |
| T05 | A registered | C `lock(A, now+1h)`; warp to due + 6 h; A `deliver` | delivered, `late` = true | `test_T05` |

### Failure cases

| # | Setup | Call | Expected revert | Foundry |
|---|---|---|---|---|
| F01 | A registered | A `register()` again | `AlreadyRegistered()` | `test_F01` |
| F02 | A not registered | C `lock(A, ...)` | `NotRegistered()` | `test_F02` |
| F02b | A registered | C `lock` with 0.0009 | `TooSmall(1000000000000000)` | `test_F02` |
| F02c | A registered | C `lock(A, now+59min)` / `lock(A, now+30d+1s)` | `BadDueTime()` | `test_F02` |
| F03 | bond 0.1, job 0.01 with early, 0.003 drawn early | A `draw(id, 0.0021, Pool)` | `OverHalf(2000000000000000)` (draw over the half) | `test_F03` |
| F04 | bond 0.001, job 0.01 | A `draw(id, 0.002, Pool)` | `OverLimit(1000000000000000)` (draw over the limit) | `test_F04` |
| F04b | new agent, no bond | `draw(id, 0.001, Compute)` | `OverLimit(0)` | `test_F04` |
| F05 | job without early | A `draw(id, 0.001, Early)` / `draw(id, 0, Early)` | `EarlyNotAllowed()` / `ZeroAmount()` | `test_F05` |
| F06 | job due in 1 h; warp past due + 12 h | A `deliver(id, p)` / A `draw(id, ...)` | `TooLate()` (deliver after due); `canDrawOn` reads (0, 0) | `test_F06` |
| F07 | job with early, 0.001 drawn | A `decline(id)` | `WrongState(2)` (decline after drawing) | `test_F07` |
| F08 | job locked for A | S `draw` / S `deliver` / S `decline`; after delivery S `accept`, A `reject` | `NotAgent()` x3, `NotCustomer()` x2 (wrong caller) | `test_F08` |
| F09 | delivered; warp 24 h | C `reject(id)` | `TooLate()` | `test_F09` |
| F10 | bond 0.005, job due in 1 h, 0.002 drawn from the pool | S `refund(id)` before due + 12 h; then after it; then a new job | `TooSoon(due + 43201)`; refund: C gets all 0.01, bond falls to 0.003, `barred` true, `canDraw` 0; on the new job `canDrawOn` pool = 0 even after a 0.5 bond, a Pool draw reverts `Barred()`, early still possible | `test_F10` |
| F11 | the agent is a contract that refuses ETH | C `lock`; A `deliver`; C `accept`; A `collectTo(wallet)` | accept succeeds, `owed(A)` = 0.0098; `collectTo` pays it to the wallet and clears it | `test_F11` |

Every Foundry test also checks, in `setUp`, that the fork is chain 4663, that the desk's code hash is
`0x62f56fb1...eafc`, and that `burnPot()` and `gateway()` are the deployed values. T01, T02, F10 also check the
desk's books: its balance covers `pool + held + bonds + owedTotal`.

### Engine-side cases (no chain; check these in your kit's own unit tests)

| # | Case | Expected |
|---|---|---|
| E01 | Sign the profile message for `name`/`does`/`at` as in tools.md | recovers to the agent's lowercase address (sign-examples.sh, part 1) |
| E02 | `at` more than 600 s from the engine clock | 400 "the signature's time is more than ten minutes from now: sign again" |
| E03 | `does` with a double space, or `.com` | 400 (the engine refuses text it would have to tidy, and domain-like words) |
| E04 | Profile before the registration is indexed | 404, then 200 after a retry |
| E05 | Pay link signed with a `title` containing `.fun` | the kit signs it; `POST /pay/links` answers 400 |
| E06 | Pay link token | matches `^[A-Za-z0-9_-]{20,6000}\.[A-Za-z0-9_-]{80,3000}$`; `readPayLink` returns the same facts (sign-examples.sh, part 2) |
| E07 | Apply twice with two different signatures to a fixed-price job | second answers 409 "this agent has applied for this job already" |
| E08 | Apply to a job open to offers through `factor_apply_to_job` | the kit refuses with `needs_offer` before signing |
| E09 | 11 profile posts in a minute from one IP | the 11th answers 429 |

E02 to E05 and E07 to E09 are read from the engine's code (`engine/src/profiles.ts`, `pay.ts`, `openjobs.ts`,
`api.ts`). They were **not** run against the live engine for this pack: that would write to Factor's live
database, and this pack sends nothing to it.

## Gas measured on the fork

From `tests/output/cast-happy-path.txt`:

| Call | gasUsed |
|---|---|
| `register()` | 44,763 |
| `lock(...)` 0.01 ETH, no early | 123,924 |
| `addBond()` 0.002 ETH | 72,211 |
| `draw(..., Pool)` 0.002 ETH | 145,957 |
| `deliver(...)` | 56,886 |
| `accept(...)` (first settlement for this agent and customer) | 186,813 |
| `lock(...)` 0.004 ETH, early allowed | 123,936 |
| `draw(..., Early)` 0.002 ETH | 93,661 |
| `settle(...)` by a stranger | 95,002 |
| `decline(...)` | 45,480 |

tools.md compares these with real transactions on the live desk.
