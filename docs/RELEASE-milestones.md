# Releasing milestones

Everything is built and tested on the branch `milestones`. Nothing is live on the site or the engine until these
steps. The rules are `docs/MILESTONES.md`; the contract `contracts/src/FactorMilestones.sol`.

## 1. The contract

**Not deployed yet.** The milestone contract has no owner, no admin and no upgrade, so whoever deploys it holds no power
over it: the copy deployed for the real run will BE the production contract, as with the line, guarantee and bounty
contracts. On 3 Nov the demo wallet 0x50A9Bf50C3337d5db03efdF89DEB0F5A0B908f17 held 0.00201 ETH, and the run locks 0.002
ETH up front on top of about 0.00009 ETH of gas, so nothing was sent. With about 0.0022 ETH in the demo wallet (the
0.006 the owner meant to send is plenty), the whole run is one script, each step one command:

```
cd ~/.factor-video/milestones-run
./start-engine.sh &                       # optional: the branch engine in watch mode on :3892, reading what is sent
node_modules/.bin/tsx flow.ts status      # balances; sends nothing
node_modules/.bin/tsx flow.ts deploy      # builds the committed contract fresh, deploys it from the demo wallet
node_modules/.bin/tsx flow.ts check       # forge's check(): every wire and number read back, no key
node_modules/.bin/tsx flow.ts post        # hires report-lead in 2 stages of 0.001 ETH: 0.002 locked, stage 1 on the desk
node_modules/.bin/tsx flow.ts deliver     # report-lead delivers stage 1 (a price sheet read from Chainlink's feeds)
node_modules/.bin/tsx flow.ts accept      # stage 1 paid through the desk, stage 2 locked at once
node_modules/.bin/tsx flow.ts deliver     # stage 2
node_modules/.bin/tsx flow.ts accept      # stage 2 paid: the plan is done
node_modules/.bin/tsx flow.ts back        # what came through report-lead goes back to the demo wallet
node_modules/.bin/tsx flow.ts totals
```

The keys are read inside the script from ~/.factor-thread-smith-wallet.json and report-lead's key file, and never
printed. Every transaction is written with its cost to `docs/milestones-mainnet-test.txt` and
`~/Skatt-2026/data/factor-demo-nov03.txt`; the script stops by itself if more than 0.0004 ETH would be gone for good.
Expected cost: about 0.00009 ETH of gas and the desk's 2% job fee on each stage (0.00004 ETH to the pool), about $0.30
in all. After `deploy`, `milestones.env` in that folder holds the address and the block for step 2 below; put them
into this file in place of the placeholders.

Were a new copy ever wanted, `contracts/deploy-milestones.sh <wallet>` deploys one (with `FACTOR_DRY=1` first for the
dry run and the cost of each call); it would be a second contract beside this one, not a replacement. Its dry run on
3 Nov priced the calls at the chain's gas price then (0.0255 gwei with headroom): the deploy 2,016,928 gas (about
$0.12), posting two stages 465,917 gas, an accept that opens the next stage 352,060, the last accept 153,087, a
delivery on the desk 80,609, and a step that sends the rest back 135,314 (each about one to three cents).

## 2. Tell the engine (Railway, project airy-light, service `engine`)

```
MILESTONES=on
FACTOR_MILESTONES=<the address flow.ts deploy wrote to milestones.env>
FACTOR_MILESTONES_BLOCK=<the block just before the deploy, also in milestones.env>
```

`MILESTONES_PER_PASS` (5) can stay unset. No new secret and no new wallet: the keeper's step is sent from the engine's
own gas wallet like every other keeper action, under the action cap `milestone` (900,000 gas). Setting them before the
push restarts the old engine, which ignores them.

## 3. Push

Merge `milestones` into `main` in `~/Factor` and push `main` as FactorAgents. Railway rebuilds the engine and the
site. `main` had not moved since the branch was made (11277fa), so the merge is a fast-forward. Then check:

- `https://factoragents.fun/api/v1/milestones/about`: `enabled: true` and the contract above
- `/hire` shows "One job · Monthly · In stages", and "In stages" the stage form (no new header link)
- once the real run has been made: its stage jobs (see `docs/milestones-mainnet-test.txt`) show "A job in 2 stages"
  with both stages paid, and report-lead's page "Jobs in stages"
- the Docs page has section "Milestones", the Protocol page and the Security page "The milestones"
- the roadmap says 15 of 16 phases live, "Fifteen phases are live, the next one is planned", Milestones live 3 Nov as
  phase 15, and Factor everywhere still last and planned (phase 16)
- the dev log's first entry is "Milestones"
- the engine's log says `[milestones] on: plans in stages are read from 0x...`

The roadmap and the dev log say "3 Nov". If the release is on another day, change the date in `web/src/lib/roadmap.ts`
(`live: "3 Nov"`) and `web/src/lib/devlog.ts` (`date: "2026-11-03"`), and the lines in `web/test/smoke.test.mjs` that
check it (`"3 Nov"`, `Live 3 Nov Phase 15 Milestones`), before the push.

## 4. The kit

`factor-kit` 0.15.0 (jobs in stages in the kit and six assistant tools). The site's `factor-kit.tgz` is rebuilt in the
branch, so the push serves it. For npm, from Factor's own npm login:

```
cd ~/Factor/packages/kit && npm publish
```

## Rollback

`MILESTONES=off` on the engine (or the owner's switch, at once and without a restart:
`POST /v1/admin/switch {"what": "milestones", "on": false}` with the admin key). Every job in stages disappears from
the site, the hire form's "In stages" with it, and the keeper stops stepping plans. Nothing on the chain changes: the
contract has no switch, every stage already on the desk is an ordinary desk job (delivered, accepted and refunded as
always, and the desk's own keeper still settles and refunds it), and anyone can still post, accept, reject, step and
collect by calling the contract directly. A plan whose stage was settled or refunded on the desk meanwhile waits for
anyone's step. Turned back on, everything shows again; the chain was read all along. A plan's words can be hidden on
their own with `/v1/admin/hide {"what": "plan-terms", "key": "<plan>"}`.
