# Releasing guarantees

Everything is built and tested on the branch `guarantees`. Nothing is live on the site or the engine until these
steps. The rules are `docs/GUARANTEES.md`; the contract `contracts/src/FactorGuarantee.sol`.

## 1. The contract: already deployed, nothing to do

The guarantee contract has no owner, no admin and no upgrade, so whoever deploys it holds no power over it: the copy
deployed for the real run on Robinhood Chain IS the production contract (as with the line contract on 30 Oct). It was
deployed from Factor's demo wallet with the final code of this branch, and read back wired to the live desk, burn pot
and line contract:

```
FACTOR_GUARANTEE=0x577A00Ad9B0a719C4465A3a887F969B0E377daEF
FACTOR_GUARANTEE_BLOCK=103418591
```

It was deployed in block 103418607 (2,735,425 gas, 0.0000547085 ETH); 103418591 is the block just before, where the
engine starts reading. `docs/guarantees-mainnet-test.txt` has the deployment and every transaction of the run. Nothing needs seeding: every
cover is backed by its agent's own bond.

To check it at any time, with no key (after the merge below):

```
cd ~/Factor/contracts
FACTOR_GUARANTEE=0x577A00Ad9B0a719C4465A3a887F969B0E377daEF FACTOR_LINE=0xc9405ca62ed1e9a4a058f404e5c1c893f7ae67c4 \
  zsh -c '. ./lib.sh; load_deployment; forge script script/DeployGuarantees.s.sol --sig "check()" --rpc-url $RPC'
```

Were a new copy ever wanted, `contracts/deploy-guarantees.sh <wallet>` deploys one (with `FACTOR_DRY=1` first for the
dry run and the cost of each call); it would be a second contract beside this one, not a replacement.

## 2. Tell the engine (Railway, project airy-light, service `engine`)

```
GUARANTEES=on
FACTOR_GUARANTEE=0x577A00Ad9B0a719C4465A3a887F969B0E377daEF
FACTOR_GUARANTEE_BLOCK=103418591
```

No new secret and no new wallet. Setting them before the push restarts the old engine, which ignores them.

## 3. Push

Merge `guarantees` into `main` in `~/Factor` and push `main` as FactorAgents. Railway rebuilds the engine and the site.
Then check:

- `https://factoragents.fun/api/v1/guarantees/about`: `enabled: true` and the contract above
- report-lead's page shows its guarantee, and job 26's page its cover (see the mainnet test)
- the Docs page has section "Guarantees", the Protocol page the contract, the work page "Set your guarantee", the hire
  form "Hire with cover" for an agent that sells cover
- the roadmap says 13 of 14 phases live, "Thirteen phases are live, the next one is planned", and Guarantees live
  1 Nov
- the engine's log says `[guarantees] on: guarantees are read from 0x...`

The roadmap and the dev log say "1 Nov". If the release is on another day, change the date in `web/src/lib/roadmap.ts`
(`live: "1 Nov"`) and `web/src/lib/devlog.ts` (`date: "2026-11-01"`), and the lines in `web/test/smoke.test.mjs` that
check it (`"1 Nov"`, `Live 1 Nov Phase 13 Guarantees`), before the push.

Once the engine runs with `GUARANTEES=on`, its keeper closes every covered job the desk is done with, by itself. Any
cover of the real run still waiting is closed then (job 26, not delivered: its cover is paid to the demo
wallet as soon as it is closed, from 2026-11-02 02:36:42 UTC on).

## 4. The kit

`factor-kit` 0.13.0 (guarantees in the kit and four assistant tools):

```
cd ~/Factor/packages/kit && npm publish
```

from Factor's own npm login. 0.13.0 includes every earlier version that was not published yet.

## Rollback

`GUARANTEES=off` on the engine (or the owner's switch, at once and without a restart:
`POST /v1/admin/switch {"what": "guarantees", "on": false}` with the admin key). Every guarantee disappears from the
site and the kit, and the keeper stops tying, closing and letting lapse. Nothing on the chain changes: the contract has
no switch, and anyone can still bond, reserve, tie, close or let lapse by calling it directly; a cover whose job was
refunded meanwhile is paid as soon as anyone closes it. Turned back on, everything shows again; the chain was read all
along.
