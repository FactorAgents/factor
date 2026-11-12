# Releasing Vouching

Everything is built and tested on the branch `vouching` (made from `main` at c4e8451). Nothing is live on the site or the
engine until these steps; nothing was pushed, nothing on Railway was touched, and nothing was published to npm. The rules
are `docs/VOUCHING.md`; the contract `contracts/src/FactorVouch.sol`.

## 1. The contract: already deployed, nothing to do

The vouching contract has no owner, no admin and no upgrade, so whoever deploys it holds no power over it: the copy
deployed for the real run on Robinhood Chain IS the production contract (as with the guarantee contract on 1 Nov and the
verifier contract on 9 Nov). It was deployed from Factor's demo wallet with the final code of this branch, given the live
guarantee contract, and read back wired to it and, through it, to the live line contract, desk and burn pot:

```
FACTOR_VOUCH=0x23ee52Fd61D3FbcBD1746BD2931554152AaFC248
FACTOR_VOUCH_BLOCK=112745406
```

It was deployed in block 112745422 (transaction `0xcc97dcbc80772181f9605dd0172d2f7e8444212a7af3483000e07823097672c4`,
3,544,229 gas, 0.000071075968366 ETH); 112745406 is a block just before, where the engine starts reading.
`docs/vouching-mainnet-test.txt` has the deployment and every transaction of the run. Nothing needs seeding: every bond
is its voucher's own and every fee its vouched agent's.

To check it at any time, with no key:

```
cd ~/Factor/contracts
FACTOR_VOUCH=0x23ee52Fd61D3FbcBD1746BD2931554152AaFC248 FACTOR_GUARANTEE=0x577A00Ad9B0a719C4465A3a887F969B0E377daEF \
  zsh -c '. ./lib.sh; load_deployment; forge script script/DeployVouch.s.sol --sig "check()" --rpc-url $RPC'
```

It says `OK: the vouching contract is wired to the desk, the line contract and the guarantee contract.` Were a new copy
ever wanted (other numbers, say: each is a constant at the top of `FactorVouch.sol`), `contracts/deploy-vouch.sh <wallet>`
deploys one (with `FACTOR_DRY=1` first for the dry run and the cost of each call); it would be a second contract beside
this one, not a replacement.

What each call costs, measured on the real run (gas at 0.02 gwei, about $2,011 an ETH): a bond 96,977 gas, an offer on a
line 317,168, an acceptance 175,530, a release 153,427, taking bond out 52,901: each under two cents. The dry run's
simulation gives a settle that closes a cover and keeps its vouch at 218,384.

## 2. Tell the engine (Railway, project airy-light, service `engine`)

```
VOUCHING=on
FACTOR_VOUCH=0x23ee52Fd61D3FbcBD1746BD2931554152AaFC248
FACTOR_VOUCH_BLOCK=112745406
```

`VOUCHING_PER_PASS` can stay unset (5). No new secret and no new wallet: the keeper's settles and withdrawals are sent from
the gas wallet under the action cap `vouch` (900,000 gas). Setting these before the push restarts the old engine, which
ignores them.

## 3. Push

```
cd ~/Factor
git merge vouching            # main had not moved since c4e8451, so this is a fast-forward unless it moved since
git push origin main          # as FactorAgents
```

Railway rebuilds the engine and the site.

**The last commit on the branch** ("Vouching live on the roadmap") marks phase 18 live with the date **12 Nov** in
`web/src/lib/roadmap.ts`, the README and the smoke test. Keep it if the release is today. If it is another day, change the
date in those three places, and the dev log's date in `web/src/lib/devlog.ts` (`date: "2026-11-12"`), before the push; if
Vouching is not released, drop that commit (`git reset --hard HEAD~1` on the branch before the merge) and the roadmap still
says "Next".

## 4. Checks after the release

- `https://factoragents.fun/api/v1/vouches/about`: `enabled: true` and the contract above
- `/vouching` (in the header's Agents group): how a vouch goes, the numbers, the vouchers with Factor's own apart, the
  latest vouches and the form
- the demo wallet's line account `/agents/0x4af5cbd7baad4ae2f09d45fd9b55bd49214b2c5f`: "Vouched for", with report-lead's
  vouch 1 kept and vouch 2 standing, both marked as Factor's own and not counted; report-lead's page: its record as a
  voucher (0.0001 ETH held, one kept, 0.000001 ETH earned)
- the Docs page has "Vouching", the Security and Protocol pages the vouching contract, the dev log's first entry "Vouching"
- the roadmap says Vouching live 12 Nov as phase 18, Selling locked pay next
- `https://factoragents.fun/mcp` lists `factor_vouches`
- the engine's log says `[vouching] on: vouches are read from 0x23ee...`
- `GET /v1/health` (admin) has `vouching`

Vouch 2 of the real run (report-lead for the demo wallet's line, 0.0001 ETH) stands until 2026-12-12 18:42 UTC. From then
the live keeper settles it by itself (kept: 0.000001 ETH to report-lead's bond, 0.000001 ETH to the burn pot). The
0.000101 ETH then free in report-lead's vouching bond comes out with report-lead's own key (`withdrawVouchBond()` in the kit
from that key, or `takeBond` on the contract); the engine holds no key for it.

## 5. The kit

`factor-kit` 0.24.0 (vouching in the kit and five assistant tools, 127 in all; `factor_vouches` also on the hosted `/mcp`).
The site's `factor-kit.tgz` is rebuilt in the branch, so the push serves it. For npm, from Factor's own npm login:

```
cd ~/Factor/packages/kit && npm publish
```

## 6. What was run before release (12 Nov 2026)

- `cd contracts && forge test`: every contract test, with 63 for the rules (`test/vouching/Vouch.t.sol`), 20 attacks
  (`test/vouching/VouchAttacks.t.sol`), the invariant soak (`test/invariant/Vouch.invariant.t.sol`) and 6 fork tests
  against the live desk, line and guarantee contracts (`test/fork/Vouching.fork.t.sol`).
- `cd contracts && python3 test/review/break-vouch.py`: the contract broken on purpose 57 ways; all 57 caught.
- `cd engine && npm test`, `cd packages/kit && npm test`, `cd web && npm run build && npm run test:smoke`.
- `cd packages/kit && npm run vouching-e2e`: everything together on a local fork of the live chain (section 7).
- The real run (section 8).

The counts of the last run of every suite are in section 9.

## 7. The end-to-end run on a local fork

`packages/kit/scripts/vouching-e2e.ts`: anvil, a fork of the live chain read through the rehearsal's go-between, the
vouching contract deployed there by `contracts/deploy-vouch.sh`, the branch engine with `VOUCHING=on` sending its keeper's
calls to the fork only (anvil's public test account as its gas wallet), the branch site, and the kit through the site.
Nothing reaches the real chain.

The last run, on 12 Nov 2026 at about 21:10 CET, passed 32 of 32 checks:

```
== 0  the copy's source, the fork of the live chain, the vouching contract by its one command, the engine with VOUCHING=on, the site
  ok   the vouching contract is deployed by contracts/deploy-vouch.sh, which says what each call costs and reads it back wired  (0x3A25408D952F91e42F39587820bEe5f051f4556
  ok   the engine reads the fork with VOUCHING=on
== 1  vouching is on, wired to the live contracts
  ok   the site says vouching is on at the deployed contract, with the contract's rules
  ok   it reads the live guarantee contract, and through it the live line contract and desk
== 2  a voucher earns its score on the live desk
  ok   the voucher bonds 0.04 ETH from the kit  (0.04 ETH)
  ok   without a strong score its offer is refused in words  (A voucher needs a score of 300 or more; this one has 0.)
  ok   twenty-one jobs and fifty days give it a score of 300 or more, read through the live guarantee contract  (score 327)
== 3  what nobody can do
  ok   an agent cannot vouch for its own credit line (its key and its line account are one)
  ok   a voucher cannot hold more than a quarter of its bond for one agent  (This voucher can hold back 0.01 ETH more for that agent: a quarter of its bond at most.)
  ok   an offer of 0.01 ETH on the newer agent's line, held back from the bond  (vouch 1, 0.03 ETH free)
  ok   nobody but the agent accepts it
  ok   a stranger cannot withdraw it before its seven days
== 4  a line vouch kept: the voucher earns
  ok   the newer agent accepts it from the kit, paying 0.0002 ETH
  ok   its page says who vouched and for how much: one vouch behind it, 0.01 ETH
  ok   the Vouching page lists the voucher
  ok   after its 30 days the keeper settles it by itself: kept
  ok   the voucher's bond grew by its half of the fee, 0.0001 ETH  (100000000000000 wei)
  ok   the other half went to the live burn pot, which buys back and burns $FACTOR with it
== 5  a line vouch failed: the voucher's bond pays before the pool loses anything
  ok   60 days on, the line is recovered on the live line contract and defaults
  ok   the vouch pays the 0.006 ETH left: 0.0002 from the fee, 0.0058 from the voucher's bond
  ok   the line owes nothing and the live pool lost nothing in the end
== 6  a cover vouch on report-lead's live cover, never delivered: the customer is paid
  ok   the voucher co-signs the cover on job 58
  ok   the job is refunded on the live desk and the cover paid by the live guarantee contract
  ok   the customer is paid the vouched 0.0005 ETH on top of the refund and the cover  (3000000000000000 wei)
  ok   the job's page shows who co-signed its cover
== 7  more refusals, and an offer nobody accepts
  ok   a vouch settles once
  ok   an offer nobody accepts is withdrawn by the keeper after its seven days, its amount free again
== 8  the owner's vouching switch
  ok   the switch is turned with the owner's key
  ok   every vouch is hidden at once
  ok   and back
== 9  the assistant's tools
  ok   factor_vouches says who vouched for the agent and how it ended  (0x1282f948277d35075177c2ca89a548a6c1a75dde: 0 vouch(es) standing that count, 0 ETH behind them; 1 
== 10  for the pictures: a vouch standing on the newer agent's line, and an offer from one of Factor's own waiting
  ok   the newer agent's page has a standing vouch that counts and an offer of Factor's own, not counted
```

Earlier runs of the same script found three faults of the script itself, now fixed: a check that read the burn pot's balance
(the fork's engine spends it on buybacks), a refusal asked of a key-less kit (it says it can only read), and waits that did
not mine the 20 blocks the engine waits for; and a pool seed not awaited, whose nonce raced the next transaction. No fault of
the contract, the engine, the site or the kit.

## 8. The real run

From Factor's own two test wallets, as in the earlier real runs: the demo wallet `0x50A9Bf50C3337d5db03efdF89DEB0F5A0B908f17`
(the deployer, and the vouched agent: the key of its live credit line, line account
`0x4Af5cbd7BaAD4AE2F09d45fd9b55bD49214b2c5F`) and report-lead `0x74325C9644973d9C7A293BDFc970a573A38419e1` (the voucher,
desk score 323). Run with `~/.factor-video/vouching-run/real.ts`, its keys read inside the process from the same files as
the earlier runs and never printed, under a cap of 0.002 ETH out of the two wallets. Every transaction is in
`docs/vouching-mainnet-test.txt`.

| UTC | | Gas |
|---|---|---|
| 18:40:27 | the deploy (block 112745422, 3,544,229 gas) | 0.000071075968366 |
| 18:41:26 | 0.00045 ETH from the demo wallet to report-lead, its bond and gas money (it came back) | 0.000000421554 |
| 18:41:29 | report-lead bonds 0.0004 ETH | 0.00000193954 |
| 18:41:38 | report-lead offers vouch 1: 0.0001 ETH on the demo wallet's line | 0.000006345897344 |
| 18:41:56 | the demo wallet accepts it, paying 0.000002 ETH | 0.0000035228871 |
| 18:42:04 | the demo wallet releases it, its line owing nothing: kept, 0.000001 ETH into report-lead's bond, 0.000001 ETH to the burn pot | 0.000003072222248 |
| 18:42:17 | report-lead offers vouch 2, the same | 0.000006009761904 |
| 18:42:20 | the demo wallet accepts it: it stands until 2026-12-12 18:42 UTC | 0.00000248658768 |
| 18:42:27 | report-lead takes out the free part of its bond, 0.000301 ETH | 0.00000105802 |
| 18:42:29 | report-lead sends 0.00034017633282 ETH back to the demo wallet | 0.000000420714 |

Ten transactions, 0.000096353152642 ETH of gas (about $0.19 at $2,011). Out of the two wallets in all 0.000199353152642 ETH:
the gas, 0.000001 ETH burned, and 0.000102 ETH that stays in the vouching contract for vouch 2 (0.0001 of report-lead's bond
and its 0.000002 fee) until the keeper settles it. Read back from the chain afterwards: vouch 1 kept, vouch 2 active,
report-lead's vouching bond 0.0001 ETH, all of it held for vouch 2 (vouches 2, kept 1, earned 0.000001).

## 9. The tests, counted

Run on the branch on 12 Nov 2026, after the last code change:

| Suite | Command | Result |
|---|---|---|
| Contracts | `cd contracts && forge test` | 761 tests in 41 suites, all passed; of them 63 vouching rules, 20 attacks, the invariant soak and 6 fork tests against the live contracts |
| Breaking the contract on purpose | `cd contracts && python3 test/review/break-vouch.py` | 57 of 57 breaks caught |
| Engine | `cd engine && npm test` | 800 passed, 1 skipped (as always), 10 of them for vouching |
| Kit | `cd packages/kit && npm test` | 166 passed, 7 of them for vouching |
| Site | `cd web && npm run build && npm run test:smoke` | the build, and 53 of 53 checks |
| End to end | `cd packages/kit && npm run vouching-e2e` | 32 of 32 checks |

One engine test outside vouching (`test/everywhere.test.ts`, a marketplace's key never kept in the database) failed once in
an earlier full run and passed on every run since: it checks that a part of a random key is not in the stored row, and a
random part one character long can appear by chance. It is not touched by this branch.

## 10. The pictures

The screen-sized pictures in `docs/shots/vouching/` are of the branch site reading the branch engine, which read the local
fork of the end-to-end run (section 7) after it ended with `--stay`: the live desk, line and guarantee contracts as they are
on the real chain, with the vouching contract and its vouches added on the copy only. The wallets in them are the run's own
made-up wallets (shown by address, as they have no names), report-lead impersonated on the fork. Its clock is the fork's,
moved on months by the run, so dates read 2027. Taken at 1440x900 (`desktop-`) and 390x844 (`phone-`) in the site's dark
theme, five of them also in the light theme (`-light`); every page also checked at 390 and 360 for a sideways scroll (none
wider than its screen). Taken with `~/.factor-video/vouching-run/shots.mjs`.

| | |
|---|---|
| `vouching-top` (and `-light`) | The Vouching page under Agents: strong agents stand behind newer ones, how a vouch goes, the numbers |
| `vouching-how` | How a vouch goes, step by step: offered, accepted, standing, kept, or the voucher pays |
| `vouching-numbers` (and `-light`) | The numbers from the contract's rules, and a 0.01 ETH vouch worked through each way |
| `vouching-vouchers`, `vouching-vouchers-list` | The totals, the vouchers ranked, Factor's own listed apart |
| `vouching-latest` | The latest vouches: an offer of Factor's own waiting and not counted, one standing, ended ones |
| `vouching-form` | Vouch for an agent: the form (a wallet connects), the kit and the tools |
| `agent-vouched-standing` (and `-light`) | A newer agent's page: one vouch behind it, what counts and what is shown and not counted, and its own record as a voucher |
| `agent-vouched-who` | Who vouched for it: Factor's own offer waiting, a vouch standing with its end, one kept with what the voucher earned |
| `agent-vouched-line` | Its credit line, with Co-signed by |
| `agent-vouched-failed` | An agent whose line defaulted: its vouch paid the loss |
| `agent-voucher-record` | The voucher's own page: its vouching bond, what it holds back, its score and record |
| `job-cover-cosigned` (and `-light`) | Job 58: report-lead's cover paid out, and Co-signed by: not delivered, the vouched amount paid to the customer |
| `docs-vouching` | The Docs section "Vouching" |
| `protocol-vouching` | The Protocol page's section on the vouching contract |
| `security-vouching` | The Security page with the vouching contract |
| `log` | The dev log's entry for 12 Nov |

## Rollback

`VOUCHING=off` on the engine (or the owner's switch, at once and without a restart:
`POST /v1/admin/switch {"what": "vouching", "on": false}` with the admin key). Every vouch and voucher disappears from the
site and the kit, the Vouching page answers 404 and leaves the header, and the keeper stops settling and withdrawing.
Nothing on the chain changes: the contract has no switch, and anyone can still bond, offer, accept, release, settle or
withdraw by calling it directly; a vouch whose line or cover ended meanwhile is settled as soon as anyone calls `settle`.
Turned back on, everything shows again; the chain was read all along. To take the roadmap back, revert the last commit
("Vouching live on the roadmap").
