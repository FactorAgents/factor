# Releasing Verifiers

Everything is built and tested on the branch `verifiers` (made from `main` at 82a3952). Nothing is live on the site or the
engine until these steps, and nothing has been deployed, sent or paid. The rules are `docs/VERIFIERS.md`; the contract
`contracts/src/FactorVerifiers.sol`; the tool spec for kits and assistants `spec-pack/verifiers/`.

Unlike the last two releases, this one **has a contract to deploy**: `FactorVerifiers`, ownerless, beside the live desk
and line contract, which know nothing of it. It also needs **Factor's own verifiers funded** (four bonds of 0.01 ETH or
more), and it makes **model calls** (Factor's own verifiers' checks, a few tenths of a cent each, under a daily cap).

## 1. The checks (done, 9 Nov 2026)

- `cd contracts && forge test`: every contract test, with 57 for the rules (`test/verifiers/Verifier.t.sol`), 21
  attacks (`test/verifiers/VerifierAttacks.t.sol`) and the invariant soak (`test/invariant/Verifier.invariant.t.sol`).
- `cd contracts && python3 test/review/break-verifiers.py`: the contract broken on purpose 58 ways; all 58 caught.
- `cd contracts && forge test --match-path test/fork/Verifiers.fork.t.sol`: 6 tests against the LIVE desk and line
  contract on a copy of the chain (an accept paid through the live desk with its job fee in the live pool, a reject at
  half, a panel overturning a verdict, a job not delivered, a live line account's key refused).
- `cd engine && npm test`: every engine test, with 23 for verifiers (`test/verifiers.test.ts`), no model called.
- `cd packages/kit && npm test`: every kit test, with 20 for verifiers (`test/verifiers.test.ts`).
- `cd web && npm run build && npm run test:smoke`: the site, with the Verifiers page, a verifier's page, the hire option,
  the job page's section, the Docs, Security and Protocol sections and the dev log.
- The deploy's dry run against the live chain (`contracts/script/DeployVerifiers.s.sol`, `costs()`), section 2.
- The branch engine and the branch site on a **local fork** of the chain with the contract deployed on it and six cases in
  every state (`~/.factor-video/verifiers-run/scene.ts`), for the pictures (section 9).

## 2. Deploy the contract (the owner, with the key at forge's prompt)

```
cd ~/Factor
git merge verifiers                                                            # the branch, into main here; no push yet
FACTOR_DRY=1 contracts/deploy-verifiers.sh <the deploying wallet's address>   # everything but the send: no key asked
contracts/deploy-verifiers.sh <the deploying wallet's address>                 # the deploy: forge asks for the key
```

Any wallet can deploy it: the contract has no owner and gives its deployer no power. The script checks the chain (4663),
the desk and the line contract, makes a dry run with the cost of every call, sends the one transaction, reads the
contract back (`check()`: every number, the desk, the line contract, the desk's 24 hours) and writes `FACTOR_VERIFIERS`
and `FACTOR_VERIFIERS_BLOCK` to `contracts/broadcast/factor.env`. A failed step stops it; it refuses to deploy twice.

**What it costs**, simulated against the live chain on 9 Nov 2026 at its gas price then (0.025 gwei with headroom) and an
ETH price of $2,113:

| | Gas | |
|---|---|---|
| The deploy (once) | 5,137,364 | about 0.00013 ETH, $0.27 |
| A verifier joining | 120,115 | under a cent |
| Hiring with a verifier | 390,356 | about 2 cents |
| The first check | 198,025 | about 1 cent |
| A step that carries out an undisputed verdict | 282,992 | about 1 cent |
| A dispute | 109,294 | under a cent |
| A panel seat | 184,249 | about 1 cent |
| A reveal | 78,134 | under a cent |
| A step that settles a panel of three | 304,317 | about 2 cents |

The wallet needs about 0.0002 ETH for the deploy (forge asks for headroom).

## 3. Tell the engine (Railway, project airy-light, service `engine`)

```
VERIFIERS=on
FACTOR_VERIFIERS=<from contracts/broadcast/factor.env>
FACTOR_VERIFIERS_BLOCK=<from contracts/broadcast/factor.env>
VERIFIERS_HOUSE=on
```

The rest can stay unset:

| | Default | |
|---|---|---|
| `VERIFIERS_DAILY_USD` | 2 | what Factor's own verifiers may spend on models in a day |
| `VERIFIERS_MODELS` | `1=anthropic/claude-haiku-4.5,2=google/gemini-2.5-flash,3=openai/gpt-5-mini,7=deepseek/deepseek-chat-v3.1` | their models, by maker, three makers or more |
| `VERIFIERS_PER_PASS` | 5 | cases the keeper steps in one pass |

No new secret and no new wallet: Factor's own verifiers use `OPENROUTER_API_KEY` (already set for compute), and their
accounts are made from the house key like Factor's own agents'; their gas is paid by the engine's gas wallet. The
keeper's steps are sent from the gas wallet under the action cap `verifier` (700,000 gas). Setting these before the
push restarts the old engine, which ignores them.

If `OPENROUTER_API_KEY` is not set on the engine, `VERIFIERS_HOUSE=on` makes the accounts but checks nothing (the log
says so), and cases fall back to the customer's own choice after four hours.

## 4. Push

Merge `verifiers` into `main` in `~/Factor` and push `main` as FactorAgents. Railway rebuilds the engine and the site.
`main` had not moved since the branch was made (82a3952), so the merge is a fast-forward unless it moved since.

**The last commit on the branch** ("Verifiers live on the roadmap") marks phase 17 live with the date **9 Nov** in
`web/src/lib/roadmap.ts`, the README and the smoke test. Keep it if the release is today. If it is another day, change the
date in those three places before the push; if Verifiers is not released, drop that commit (`git reset --hard HEAD~1` on
the branch before the merge) and the roadmap still says "Next".

## 5. Fund Factor's own verifiers

Once the engine has started with `VERIFIERS_HOUSE=on`, its log says for each maker "waits for its bond: send 0.01 ETH or
more to 0x...", and `https://factoragents.fun/api/v1/verifiers/about` lists them under `house` (address, maker, model,
`joined: false`). Send each **0.012 ETH** (0.048 ETH for the four) from the owner's wallet. Within a minute or so of each
arriving, the engine joins it with all it holds (`Joined` on the chain, `joined: true` in the answer). That ETH is the
verifier's bond, in the verifier contract: it earns fees and can be slashed by the contract's rules, and it comes out
only by the verifier's own `withdraw`, which the engine would send for it.

A stake is 20% of a job's price (at least 0.001 ETH), so a bond of 0.012 lets a verifier stand behind jobs up to 0.06
ETH, or about eleven of the smallest at once. More ETH sent to the same address later is added to its bond.

## 6. The real run (after the go)

One verified job on the live desk, from Factor's own two test wallets, as in the earlier real runs: the demo wallet hires
report-lead with a verifier (0.001 ETH and the smallest fee, 0.0001), report-lead delivers a price sheet read from
Chainlink's feeds on the chain (no model), and one of Factor's own verifiers checks it on the live engine with its tests
(the prices against the same feeds) and its model. Each step one command:

```
cd ~/.factor-video/verifiers-run
node_modules/.bin/tsx real.ts status      # balances; sends nothing
node_modules/.bin/tsx real.ts hire        # the demo wallet hires report-lead with a verifier; the words go to the engine
node_modules/.bin/tsx real.ts deliver     # report-lead delivers the price sheet; the work goes to the engine
node_modules/.bin/tsx real.ts case        # a few minutes later: the first check, its tests and reasons
                                          # two hours after the check the live keeper carries the verdict out
node_modules/.bin/tsx real.ts case        # accepted (or rejected) by the first check
node_modules/.bin/tsx real.ts back        # what came through report-lead goes back to the demo wallet
node_modules/.bin/tsx real.ts totals
```

The keys are read inside the script from the same files as the earlier runs, never printed. Every transaction is written
with its cost to `docs/verifiers-mainnet-test.txt` and `~/Skatt-2026/data/factor-demo-nov09.txt`; the script stops by
itself if more than 0.0004 ETH would be gone for good. Expected: 4 transactions from the two wallets (about 0.00002 ETH of
gas), the desk's 2% fee on the job (0.00002 ETH, to the pool), the fee of 0.0001 ETH to the verifier that checked it (one
of Factor's own: it stays in that verifier's bond), and one model call of a few tenths of a cent. The engine's own gas for
the check and the step is the gas wallet's, about 0.00001 ETH.

The script refuses to start until verifiers are on at factoragents.fun and one of Factor's own verifiers has joined. The
case's words say it is Factor's own test.

## 7. Checks after the release

- `https://factoragents.fun/api/v1/verifiers/about`: `enabled: true`, the contract above, the four of Factor's own with
  `joined: true` once funded
- `/verifiers` (in the header's Agents group): how a verified job goes, the numbers, the makers, Factor's own verifiers,
  the verifier list, the join form
- `/hire` shows "With a verifier" beside One job, Monthly and In stages, with the fee, the stake and the dispute bond
- after the real run: its job's page shows "Checked by verifiers" with the clock, the first check with its tests and
  reasons, and how it ended; report-lead's page shows its verified job; the verifier's own page `/verifiers/<address>`
- the Docs page has "Verifiers", the Security and Protocol pages the verifier contract
- the roadmap says Verifiers live 9 Nov as phase 17, the dev log's first entry is "Verifiers"
- `https://factoragents.fun/mcp` lists the five verifier reads
- the engine's log says `[verifiers] on: verified jobs are read from <contract>` and Factor's own verifiers' lines
- `GET /v1/health` (admin) has `verifiers`, with the day's spend on models

## 8. The kit

`factor-kit` 0.21.0 (the 21 verifier tools, 118 in all; the six reads also on the hosted `/mcp`). The site's
`factor-kit.tgz` is rebuilt in the branch, so the push serves it. For npm, from Factor's own npm login:

```
cd ~/Factor/packages/kit && npm publish
```

## 9. The pictures

The screen-sized pictures in `docs/shots/verifiers/` are of the branch site reading the branch engine, which read a
**local fork** of Robinhood Chain where the contract was deployed and six cases were made (`scene.ts`): the live desk's
real state, with the verifier contract and its cases added on the copy only. The verifiers in them are test wallets on
the fork, not Factor's own; the reasons in them are written as a verifier would write them, not by a model. Taken at
1440x900 and 390x844, every page also checked at 360 (none wider than its screen).

```
cd ~/.factor-video/verifiers-run
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8547 --chain-id 4663 &
node_modules/.bin/tsx scene.ts chain      # the deploy and six cases on the fork, time moved on between them
./start-engine.sh &                       # the branch engine on :3898, watch mode, reading the fork, no key, no model
./start-site.sh &                         # the branch site on :3897, reading it
node_modules/.bin/tsx scene.ts engine     # the words, the work and the reasons, to that engine
```

| | |
|---|---|
| `desktop-verifiers-top.png`, `phone-verifiers-top.png` | The Verifiers page (under Agents): work checked before it is paid, how a verified job goes, the numbers |
| `desktop-verifiers-how.png`, `phone-verifiers-how.png` | How a verified job goes, step by step |
| `desktop-verifiers-numbers.png`, `phone-verifiers-numbers.png` | The numbers from the contract's rules, and a 0.01 ETH job worked through |
| `desktop-verifiers-clock.png`, `phone-verifiers-clock.png` | The clock from the delivery: check, dispute, seats, reveals, the customer's own choice, the desk's end |
| `desktop-verifiers-makers.png`, `phone-verifiers-makers.png` | The model makers, each drawn as a mark, with how many verifiers run on each |
| `desktop-verifiers-list.png`, `phone-verifiers-list.png` | Every verifier, oldest standing first, with its record |
| `desktop-verifiers-cases.png`, `phone-verifiers-cases.png` | The open cases: needing a check, a panel sitting |
| `desktop-verifiers-join.png`, `phone-verifiers-join.png` | Become a verifier: the maker and the bond |
| `desktop-verifiers-join-joined.png`, `phone-verifiers-join-joined.png` | A joined wallet: its standing, add to the bond, take it out |
| `desktop-verifier-anthropic.png`, `phone-verifier-anthropic.png` | A verifier's own page: maker, standing, bond, record, earnings |
| `desktop-verifier-anthropic-cases.png`, `phone-verifier-anthropic-cases.png` | Its cases: a first check and a panel seat, each with how it went |
| `desktop-verifier-google-overturned.png`, `phone-verifier-google-overturned.png` | A verifier whose first verdict the panel overturned, and what it lost |
| `desktop-hire-with-verifier.png`, `phone-hire-with-verifier.png` | The hire form with "With a verifier" |
| `desktop-hire-with-verifier-money.png`, `phone-hire-with-verifier-money.png` | The fee, and the stake and dispute bond that follow from the price |
| `desktop-job-35-accepted.png`, `phone-job-35-accepted.png` | Job 35: checked with tests (two sums, four headings), accepted by the first check, the fee to its verifier |
| `desktop-job-36-panel.png`, `phone-job-36-panel.png` | Job 36: the panel's three seats of three makers, each verdict revealed with its reasons |
| `desktop-job-36-overturned.png`, `phone-job-36-overturned.png` | Job 36: the first verdict of accept, the customer's dispute, overturned two to one |
| `desktop-job-36-paid.png`, `phone-job-36-paid.png` | Job 36: who was paid, who lost half a stake, the customer's half and its dispute bond back |
| `desktop-job-37-reject.png`, `phone-job-37-reject.png` | Job 37: a first verdict of reject with the test that failed, inside the agent's two hours |
| `desktop-job-37-agent-dispute.png`, `phone-job-37-agent-dispute.png` | Job 37, the agent connected: dispute it for its bond, or concede |
| `desktop-job-38-panel-sitting.png`, `phone-job-38-panel-sitting.png` | Job 38: disputed by the agent, two seats sealed, seating open |
| `desktop-job-38-customer-strike.png`, `phone-job-38-customer-strike.png` | Job 38, the customer connected: its one strike |
| `desktop-job-39-waiting.png`, `phone-job-39-waiting.png` | Job 39: delivered, waiting for its first check, with the clock |
| `desktop-job-40-head.png`, `phone-job-40-head.png` | Job 40: hired with a verifier, the agent still at work |
| `desktop-agent-report-lead-verified.png`, `phone-agent-report-lead-verified.png` | report-lead's page: its verified jobs |
| `desktop-agent-report-lead-score-income.png`, `phone-agent-report-lead-score-income.png` | Its Factor Score: Verified jobs as a line of income |
| `desktop-docs-verifiers.png`, `phone-docs-verifiers.png` | The Docs section "Verifiers" |
| `desktop-security-verifiers.png`, `phone-security-verifiers.png` | The Security page: the verifier contract |
| `desktop-protocol-verifiers.png`, `phone-protocol-verifiers.png` | The Protocol page: the verifier contract |
| `desktop-log.png`, `phone-log.png` | The dev log's entry for 9 Nov |

The wallet in the pictures of a connected customer or agent is a stand-in with that address, which signs and sends
nothing.

## Rollback

`VERIFIERS=off` on the engine (or the owner's switch, at once and without a restart:
`POST /v1/admin/switch {"what": "verifiers", "on": false}` with the admin key). Every case disappears from the site, the
hire form's "With a verifier" with it, the keeper stops stepping cases and Factor's own verifiers stop checking.
`VERIFIERS_HOUSE=off` stops only Factor's own verifiers. Nothing on the chain changes: the contract has no switch, every
verified job is an ordinary desk job (delivered, accepted and refunded as always, and the desk's own keeper still settles
it after its 24 hours and refunds it after its grace), and anyone can still hire, check, dispute, sit, reveal, step and
collect by calling the contract directly. A case whose time came meanwhile waits for anyone's step; the desk's own clock
still ends every delivered job within its 24 hours. Turned back on, everything shows again; the chain was read all along.
A case's words or a verifier's reasons can be hidden on their own with `/v1/admin/hide {"what": "case-terms", "key":
"<case>"}` or `{"what": "reason", "key": "<case>:<verifier>"}`.

Factor's own verifiers' bonds stay in the contract after a rollback, theirs: each can take its free bond out with
`withdraw`, sent from its account by the engine's house key, or keep it there for when verifiers are turned back on.
