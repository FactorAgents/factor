# Releasing the Agent treasury

Everything is built and tested on the branch `treasury` (made from `main` at 3a8b8b8). Nothing is live on the site or the
engine until these steps; nothing was pushed, nothing on Railway was touched, nothing was sent on Robinhood Chain and
nothing was published to npm. The rules are `docs/TREASURY.md`; the contract `contracts/src/FactorTreasury.sol`.

## 1. The contract: to deploy, once

The treasury contract has no owner, no admin, no fee and no upgrade, so whoever deploys it holds no power over it. It is
given the live vouching contract and the live claims contract, and reads the desk, the line contract, the guarantee
contract and the compute gateway from them:

| | |
|---|---|
| vouching | `0x23ee52Fd61D3FbcBD1746BD2931554152AaFC248` |
| claims | `0xd2a678430BaDBB738789DA8e88Fd1c5F476A52Ba` |
| desk (read) | `0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F` |
| line (read) | `0xc9405ca62eD1e9a4a058F404e5c1C893F7ae67c4` |
| guarantee (read) | `0x577A00Ad9B0a719C4465A3a887F969B0E377daEF` |
| compute gateway (read) | `0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0` |

The script needs `contracts/broadcast/factor.env` (the file `deploy.sh` wrote; it is not in git). First the dry run, which
asks for no key and sends nothing, then the deploy, which asks for the wallet's key at forge's own prompt:

```
cd ~/Factor/contracts
FACTOR_DRY=1 ./deploy-treasury.sh <the deploying wallet's address>
./deploy-treasury.sh <the deploying wallet's address>
```

It prints the address, reads the contract back from the chain, checks every wire and writes `FACTOR_TREASURY` and
`FACTOR_TREASURY_BLOCK` to `contracts/broadcast/factor.env`. On a local fork of the chain (18 Nov) the dry run said about
3,713,422 gas at most, 0.00013 ETH (about $0.23). The forge script alone, `script/DeployTreasury.s.sol`, sends nothing
without `--broadcast`. To check a deployed copy at any time, with no key:

```
FACTOR_TREASURY=<address> FACTOR_VOUCH=0x23ee52Fd61D3FbcBD1746BD2931554152AaFC248 FACTOR_CLAIMS=0xd2a678430BaDBB738789DA8e88Fd1c5F476A52Ba zsh -c '. ./lib.sh; load_deployment; forge script script/DeployTreasury.s.sol --sig "check()" --rpc-url $RPC'
```

What each call cost on the fork: putting ETH in 90,884 gas, setting the rules 238,016, a run with three steps 357,787, a
withdrawal 54,772.

## 2. Tell the engine (Railway, service `engine`)

```
TREASURY=on
FACTOR_TREASURY=<the address the deploy printed>
FACTOR_TREASURY_BLOCK=<the block the deploy wrote>
```

`TREASURY_PER_PASS` (5) and `TREASURY_EVERY_MIN` (30) can stay unset. No new secret and no new wallet: the keeper's runs
are sent from the gas wallet under the action cap `treasury` (2,500,000 gas). Selling locked pay must be on
(`LOCKED_PAY=on`) for the keeper to offer a treasury the claims on sale; without it the other four uses still run.
Setting these before the push restarts the old engine, which ignores them.

## 3. Push

```
cd ~/Factor
git merge treasury            # main had not moved since 3a8b8b8, so this is a fast-forward unless it moved since
git push origin main          # as FactorAgents
```

**The last commit on the branch** ("Agent treasury live on the roadmap") marks phase 20 live with the date **18 Nov** in
`web/src/lib/roadmap.ts`, the README and the smoke test. Keep it if the release is today. If it is another day, change
the date there and the dev log's date in `web/src/lib/devlog.ts` (`date: "2026-11-18"`) before the push; if it is not
released, drop that commit and the roadmap still says "Next".

## 4. Checks after the release

- `https://factoragents.fun/api/v1/treasury/about`: `enabled: true` and the contract
- an agent's page: "No treasury yet" with the way in for an agent that never used it; once its wallet puts ETH in and sets
  rules, what it holds, its rules in the order of a run, the next run and its runs
- `/api/v1/treasury/<agent>` and `/api/v1/treasury/<agent>/preview`
- the Docs page has "Agent treasury", the Security and Protocol pages the treasury contract, the dev log's first entry
  "Agent treasury"
- the roadmap says Agent treasury live 18 Nov as phase 20, 20 of 29 phases live, Live balance sheets next
- the engine's log says `[treasury] on: treasuries are read from 0x...`; `GET /v1/health` (admin) has `treasury`

## 5. What was run before release (18 Nov 2026)

- `cd contracts && forge test`: every contract test, with 48 for the treasury (`test/treasury/Treasury.t.sol`: the rules
  one by one, the order, the floor, the daily amounts and levels, withdrawal whatever the rules and the line say, and the
  attacks: a seller re-entering while it is paid, an agent re-entering its own withdrawal, overdraw, the wrong caller, a
  refusing gateway and a refusing seller; three fuzzes) and 6 on a fork of Robinhood Chain against the live line, claims,
  guarantee and vouching contracts (`test/fork/Treasury.fork.t.sol`).
- The one-command deploy on a local fork of the chain, dry and for real on the fork, with the read-back check, and a run
  there from the demo wallet's address (unlocked on the fork only): 0.01 ETH in, rules set, a run by a stranger that
  prepaid 0.001 ETH to the gateway and added 0.001 and 0.002 ETH to the guarantee and vouching bonds, a second run
  refused, and the remaining 0.006 ETH taken out.
- `cd engine && npm test`, `cd packages/kit && npm test`, `cd web && npm run lint && npm run build && npm run test:smoke`.
- The new sections looked at in a browser at 1440x900 and 390x844: an agent's treasury with runs, one with no rules, the
  empty one, the owner's forms, the Docs and Protocol sections and the roadmap.

Not done for this release, by decision: no real run on Robinhood Chain (no transaction was sent), no long end-to-end
run of the engine and site against a fork, and nothing published to npm (`factor-kit` 0.25.0 is in the branch and in the
site's `factor-kit.tgz`).

## 6. The tests, counted

Run on the branch on 18 Nov 2026, after the last code change:

| Suite | Command | Result |
|---|---|---|
| Contracts | `cd contracts && forge test` | 852 tests in 44 suites, all passed; 54 of them for the treasury |
| Engine | `cd engine && npm test` | 846 passed, 2 skipped (as always), 13 of them for the treasury |
| SDK and MCP | `cd packages/kit && npm test` | 175 passed, 9 of them for the treasury |
| Site | `cd web && npm run build && npm run test:smoke` | the build, and 56 of 56 checks |

The largest page, the Docs with every section on, is now a little over 300,000 bytes; the smoke test's ceiling for a page
went from 300,000 to 320,000.

## Rollback

`TREASURY=off` on the engine (or the owner's switch, at once and without a restart:
`POST /v1/admin/switch {"what": "treasury", "on": false}` with the admin key). Every treasury disappears from the site and
the keeper stops running them. Nothing on the chain changes: the contract has no switch, anyone can still run a treasury
by calling it directly, and every agent can still take its ETH out. Compute prepayments are still read, so no credit is
missed. Turned back on, everything shows again. To take the roadmap back, revert the last commit ("Agent treasury live
on the roadmap").
