# Releasing credit lines

Everything is built and tested on the branch `credit-lines`. Nothing is live until these steps. The rules are
`docs/CREDIT-LINES.md`; the contracts `contracts/src/FactorLine.sol`.

Order matters: the roadmap and the dev log on the site say credit lines are live as soon as the code is pushed, so the
contract is deployed, the pool seeded and the engine told before the push.

## 1. Deploy the line contract (the admin wallet, about $0.20 of gas)

```
cd ~/Factor && git merge credit-lines
FACTOR_DRY=1 contracts/deploy-lines.sh 0xafA96B2F796968dA543B77E9d1a04f80321acD04
contracts/deploy-lines.sh 0xafA96B2F796968dA543B77E9d1a04f80321acD04
```

The first line is a dry run: it sends nothing, asks for no key, and prints what the deploy and each line call cost.
The second asks for the admin wallet's key at forge's own prompt (nothing shows as it is pasted), deploys, reads the
contract back from the chain and writes `FACTOR_LINE` and `FACTOR_LINE_BLOCK` into `contracts/broadcast/factor.env`.
Any wallet could deploy it: the contract has no owner and gives its deployer no power.

Simulated against the live chain on 2026-10-30: 3,521,552 gas for the deploy, about $0.20 at the base fee plus 25%
(forge asks the wallet to hold up to 0.00017 ETH). Opening a line about 224,000 gas, a draw about 263,000, a sweep
about 120,000, a repayment about 80,000: each under two cents.

## 2. Seed the line pool (the admin wallet, from the owner's share)

```
contracts/seed-lines.sh 0.05 0xafA96B2F796968dA543B77E9d1a04f80321acD04
```

Say how much in ETH (0.05 is an example). It shows the pool before, says once more that the ETH can never be taken
back out, waits for `yes`, then asks for the key at cast's prompt and sends it. Nobody can take a seed back, the owner
included: it leaves the pool only as a draw and comes back as a repayment. 1% of every draw adds to it. The pool lends
at most 80% of itself at a time, so a 0.05 ETH pool lends up to 0.04 ETH at once. It can be seeded again at any time
with the same command.

## 3. Tell the engine (Railway, project airy-light, service `engine`)

```
LINES=on
FACTOR_LINE=<from contracts/broadcast/factor.env>
FACTOR_LINE_BLOCK=<from contracts/broadcast/factor.env>
```

No new secret and no new wallet. Setting them before the push restarts the old engine, which ignores them.

## 4. Push

Push `main` as FactorAgents. Railway rebuilds the engine and the site. Then check:

- `https://factoragents.fun/api/v1/lines/about`: `enabled: true`, the contract, and the pool as seeded
- an agent's page shows "Credit line" (an agent with no line: "No line yet" and the button to open one)
- the Docs page has section "Credit lines", the Protocol page has the contract, the work page has "Open a credit line"
- the engine's log says `[lines] on: credit lines are read from 0x...`

The roadmap and the dev log say "30 Oct". If the release is on another day, change the date in
`web/src/lib/roadmap.ts` (`live: "30 Oct"`) and `web/src/lib/devlog.ts` (`date: "2026-10-30"`), and the line in
`web/test/smoke.test.mjs` that checks it, before the push.

## 5. The kit

`factor-kit` 0.12.0 (credit lines in the kit and five assistant tools):

```
cd ~/Factor/packages/kit && npm publish
```

from Factor's own npm login. 0.12.0 includes every earlier version that was not published yet.

## Rollback

`LINES=off` on the engine (or the owner's switch, at once and without a restart:
`POST /v1/admin/switch {"what": "lines", "on": false}` with the admin key). Every line disappears from the site and
the kit, and the keeper stops sweeping and recovering. Nothing on the chain changes: the contracts have no switch, and
anyone can still open, draw, repay, sweep or recover by calling them directly. Turned back on, everything shows again;
the chain was read all along.
