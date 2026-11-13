# Releasing Selling locked pay

Everything is built and tested on the branch `locked-pay` (made from `main` at b4c718a). Nothing is live on the site or
the engine until these steps; nothing was pushed, nothing on Railway was touched, and nothing was published to npm. The
rules are `docs/LOCKED-PAY.md`; the contract `contracts/src/FactorClaims.sol`.

## 1. The contract: already deployed, nothing to do

The claims contract has no owner, no admin and no upgrade, so whoever deploys it holds no power over it: the copy
deployed for the real run on Robinhood Chain IS the production contract (as with the vouching contract on 12 Nov). It was
deployed from Factor's demo wallet with the final code of this branch, given the live desk, and read back wired to it:

```
FACTOR_CLAIMS=0xd2a678430BaDBB738789DA8e88Fd1c5F476A52Ba
FACTOR_CLAIMS_BLOCK=113580785
```

It was deployed in block 113580802 (transaction `0x6ef6127085227e885bb37de9a8a2e7e070ec9af2b2453b73f889f22ff0f5e2c4`,
3,460,961 gas, 0.000069689910696 ETH); 113580785 is a block just before, where the engine starts reading. The code every
pay account runs is at `0x72F92f029A43BEB7b483010321f9590236505fdE` (made by the same transaction).
`docs/locked-pay-mainnet-test.txt` has every transaction of the run.

To check it at any time, with no key:

```
cd ~/Factor/contracts
FACTOR_CLAIMS=0xd2a678430BaDBB738789DA8e88Fd1c5F476A52Ba zsh -c '. ./lib.sh; load_deployment; forge script script/DeployClaims.s.sol --sig "check()" --rpc-url $RPC'
```

It says `OK: the claims contract is wired to the desk.` Were a new copy ever wanted, `contracts/deploy-claims.sh <wallet>`
deploys one (with `FACTOR_DRY=1` first for the dry run); it would be a second contract beside this one.

What each call cost on the real run (gas at about 0.02 gwei): opening a pay account 139,209 gas, a listing 252,218, a
purchase 158,469, a delivery through the pay account 79,393, a settle that pays the holder 137,443: each well under a cent.

## 2. Tell the engine (Railway, project airy-light, service `engine`)

```
LOCKED_PAY=on
FACTOR_CLAIMS=0xd2a678430BaDBB738789DA8e88Fd1c5F476A52Ba
FACTOR_CLAIMS_BLOCK=113580785
```

`LOCKED_PAY_PER_PASS` can stay unset (5). No new secret and no new wallet: the keeper's sweeps are sent from the gas wallet
under the action cap `claims` (1,500,000 gas). Setting these before the push restarts the old engine, which ignores them.

## 3. Push

```
cd ~/Factor
git merge locked-pay          # main had not moved since b4c718a, so this is a fast-forward unless it moved since
git push origin main          # as FactorAgents
```

Railway rebuilds the engine and the site.

**The last commit on the branch** ("Selling locked pay live on the roadmap") marks phase 19 live with the date **13 Nov**
in `web/src/lib/roadmap.ts`, the README and the smoke test. Keep it if the release is today. If it is another day, change
the date there and the dev log's date in `web/src/lib/devlog.ts` (`date: "2026-11-13"`) before the push; if it is not
released, drop that commit (`git reset --hard HEAD~1` on the branch before the merge) and the roadmap still says "Next".

## 4. Checks after the release

- `https://factoragents.fun/api/v1/claims/about`: `enabled: true` and the contract above
- `/locked-pay` (in the header's Agents group): what it is, how a sale goes, the numbers, claims for sale, the latest
  sales and the sell form
- `/api/v1/claims/1`: claim 1 of the real run, paid, held by the demo wallet, marked as Factor's own
- job 35's page: its claim, paid to the holder; report-lead's page: its pay account `0x51594E3795e389A66830524F04ea72D5448B0805`
  and the claim it sold
- the Docs page has "Selling locked pay", the Security and Protocol pages the claims contract, the dev log's first entry
  "Selling locked pay"
- the roadmap says Selling locked pay live 13 Nov as phase 19
- the engine's log says `[lockedpay] on: claims are read from 0xd2a6...`; `GET /v1/health` (admin) has `lockedpay`

## 5. What was run before release (13 Nov 2026)

- `cd contracts && forge test`: every contract test, with 37 for the claims contract (`test/claims/Claims.t.sol`: the
  rules, a fuzz of what a holder is paid and owed, and the attacks: a double sale, a sale after the job settled, a fake or
  someone else's job, decline and draw on a sold job, the key taking a sold payout, re-entry on the seller's and the
  holder's payment, a holder and a seller that refuse ETH, and the refund and at-half paths with the debt and the bond).
- `cd engine && npm test`, `cd web && npm run build && npm run test:smoke`.
- The real run (section 6).

Not done for this release, by decision: the kit's functions and assistant tools for claims, the long end-to-end run on a
local fork, and the full set of pictures (a few screen views of the new pages were checked).

## 6. The real run

From Factor's own two test wallets, as in the earlier real runs: the demo wallet `0x50A9Bf50C3337d5db03efdF89DEB0F5A0B908f17`
(the deployer, the customer and the buyer) and report-lead `0x74325C9644973d9C7A293BDFc970a573A38419e1` (the seller). Run
with `~/.factor-video/lockedpay-run/real.ts`, its keys read inside the process from the same files as the earlier runs and
never printed, under a cap of 0.002 ETH out of the two wallets.

| UTC | | Gas (ETH) |
|---|---|---|
| 18:58:15 | the deploy (block 113580802, 3,460,961 gas) | 0.000069689910696 |
| 18:58:32 | 0.00004 ETH from the demo wallet to report-lead, gas money (it came back) | 0.000000422044436 |
| 18:58:39 | report-lead opens its pay account `0x5159...0805` | 0.000002786128926 |
| 18:58:45 | the demo wallet locks job 35, 0.001 ETH, for the pay account | 0.000002503978204 |
| 18:58:52 | report-lead lists claim 1 on job 35: face 0.00098, price 0.00095 (3.1% under) | 0.000005063528568 |
| 18:59:16 | the demo wallet buys it: 0.00095 ETH straight to report-lead; holder: the demo wallet | 0.000003177937326 |
| 18:59:28 | report-lead delivers job 35 through the claims contract | 0.000001591512078 |
| 18:59:35 | the demo wallet accepts: the desk pays the pay account 0.00098 | 0.000002983516584 |
| 18:59:41 | claim 1 settled: 0.00098 ETH to its holder, the demo wallet | 0.000002758206124 |
| 19:00:00 | report-lead sends 0.000979377156428 ETH back to the demo wallet | 0.000000422970988 |

Ten transactions, 0.00009139973393 ETH of gas. Out of the two wallets in all 0.00011139973393 ETH: the gas and the desk's
0.00002 job fee on job 35, which went to the desk's pool. Nothing stays in the claims contract or the pay account. Read
back from the chain afterwards: claim 1 paid, holder the demo wallet, paid 0.00098, owing 0.

## 7. The tests, counted

Run on the branch on 13 Nov 2026, after the last code change:

| Suite | Command | Result |
|---|---|---|
| Contracts | `cd contracts && forge test` | 798 tests in 42 suites, all passed; 37 of them for the claims contract |
| Engine | `cd engine && npm test` | 807 passed, 1 skipped (as always), 7 of them for selling locked pay |
| Site | `cd web && npm run build && npm run test:smoke` | the build, and 54 of 54 checks |

## Rollback

`LOCKED_PAY=off` on the engine (or the owner's switch, at once and without a restart:
`POST /v1/admin/switch {"what": "lockedpay", "on": false}` with the admin key). Every claim disappears from the site, the
Selling locked pay page answers 404 and leaves the header, and the keeper stops sweeping. Nothing on the chain changes: the
contract has no switch, and anyone can still open, list, buy, give, settle, sweep and withdraw by calling it directly.
Turned back on, everything shows again; the chain was read all along. To take the roadmap back, revert the last commit
("Selling locked pay live on the roadmap").
