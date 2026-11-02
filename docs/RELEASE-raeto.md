# Releasing raeto/auto

Everything is built and tested on the branch `raeto`. Nothing is live on the site or the engine until these steps, and
the steps wait for Raeto's reply. It needs no contract and no deployment on the chain.

What it is: an agent with compute credit names `raeto/auto` (or a variant) with the key it already has, at the same
address. Raeto picks the model. The credit pays what Raeto charged and Factor's margin. Code: `engine/src/raeto.ts`, and
`raetoChat` in `engine/src/compute.ts`.

## 1. By hand at raeto.cc/console (mostly done on 2 Nov)

Already done by the owner:

- Signed in, project named **Factor**, its public listing **off**.
- An "API key for agents" named **factor**, with a spending cap of **$5**. It is in `~/.factor-raeto-key` (600) and has
  never been printed or committed.
- **$5** funded. Testing has used a fraction of a cent of it (`~/Skatt-2026/data/factor-demo-nov02.txt`).
- Save mode **off**: it routes through a third party. It is an option in the console if that is ever wanted; nothing here
  depends on it, and the real check would have to be run again after turning it on.

Still to do there at release:

1. Turn the project's **public listing on**, if it is wanted. It shows calls over seven days, and no addresses or spend.
2. Look at the key's settings for **Allowed models**. The screen at creation did not offer it. The API says the key has
   none (`key.models: null`). If the key's settings offer it, list the nine: `raeto/auto`, `raeto/auto:cheap`, `:fast`,
   `:code`, `:reason`, `:vision`, `:tools`, `:json`, `:long`. Then a key that leaked could not call a dear named model.
3. Look under the project for the **per-agent view** of `X-Raeto-Agent` and of tasks. The API has no read of it for this
   key, so the real check can only prove the tag was sent. A test agent's address is
   `0xfac7000000000000000000000000000000000001`; it should be listed there, with `factor-coin-...` as a task.
4. **Fund for the first week.** $5 is right to start: the most an agent may spend in a day is $2 by default, the cap and
   the balance both stop a mistake at $5, and credits at Raeto never expire. But no call is sent once less than $1 is
   left there (`RAETO_FLOAT_FLOOR_USD`), so $4 of it is usable. Top up in the console's Billing tab with USDG from a
   wallet on Robinhood Chain: no fee but gas, about a minute. A card costs 2.9% + $0.30. **Raise the key's cap whenever
   you add money**: it counts what the key has spent in all, and `key_limit_reached` stops calls exactly as an empty
   balance does.

## 2. How the key goes in

You paste nothing and show nothing. The key goes straight from the file to the engine's secret settings, in the hidden
box in chat if the file is ever replaced; the assistant runs it and it never appears in the output:

```
cd ~/Factor && railway variables --service engine --set "RAETO_API_KEY=$(cat ~/.factor-raeto-key)" --skip-deploys
```

## 3. Engine settings (Railway, project airy-light, service `engine`)

```
RAETO=on
```

That and the key are all. `COMPUTE_MODE=on` is already there. Defaults that can be changed later without a release:

| Setting | Default | What it does |
|---|---|---|
| `RAETO_MAX_IN_USD`, `RAETO_MAX_OUT_USD` | 5, 25 | The dearest input and output the hold assumes, per million tokens, before Raeto's fee. The dearest model Raeto picked in testing was `anthropic/claude-sonnet-5.5` at $2 and $10 |
| `RAETO_FLOAT_FLOOR_USD` | 1 | Below this at Raeto no call is sent |
| `HOUSE_RAETO` | off | Factor's own agents ask `raeto/auto` too, under `HOUSE_DAILY_USD`. If Raeto fails, their usual model answers |

Leave `HOUSE_RAETO` off for the release. Turned on, the owner pays for those calls from the Raeto balance. Setting these
before the push restarts the old engine, which ignores them.

## 4. The real check

One command, on this machine, before the push. Three short real calls through the gateway's own code, on a database in
memory, with no chain:

```
cd ~/Factor && scripts/raeto-real-check
```

**Cost:** about $0.0002 from the Raeto balance (three runs on 2 Nov cost $0.000135, $0.000113 and the same again). It
stops past 5 cents, and refuses to run without a key. It must end `Every check passed`. It checks that Raeto says what
each call cost on a whole answer and on a stream, that the credit paid exactly that and the margin, that the tag and the
task went along, and that the balance at Raeto dropped by what the calls said. Write what it prints as the cost in
`~/Skatt-2026/data/utgifter.csv`, as for every other test.

## 5. Merge and push

Merge `raeto` into `main` in `~/Factor` and push `main` as FactorAgents (check the author first: Factor). Railway rebuilds
the engine and the site.

**The order with `bounties`:** whichever is ready first; they share no logic. If both are ready, Bounties first, since it
carries a contract and a rehearsal against today's `main`, and then `git merge main` into `raeto`. The conflicts to expect
are small: the list and the comment in `engine/src/switches.ts`, the top of `web/src/lib/devlog.ts`, and the `before()`
line of `web/test/smoke.test.mjs`. Keep both sides of each. Then, before the push, run `npm test` in `engine` and
`npm run build && npm run test:smoke` in `web`.

**The date:** the dev log entry says `2026-11-02`. Change `date:` in `web/src/lib/devlog.ts` to the day of the release. The
entry only shows while the switch is on, so it can sit there.

**The kit** stays as it is: any OpenAI client works with the model's name, and the kit's update comes later.

## 6. Live checks, and the rollback

- `https://factoragents.fun/api/v1/compute/models`: `raeto` is there, with nine models, `feePct: 8`, `holdInUsd: 5.67`,
  `holdOutUsd: 28.35`
- `https://factoragents.fun/api/v1/compute/v1/models`: the nine are first in the list
- the engine's log says `[compute] raeto/auto is on`, and no `NOT ON`
- the Work page has the block "raeto/auto", the Docs page has it under Compute credit, and the Dev log has its entry
- one real call with a real agent's key: a job's page then has "Compute it spent" with the model and the figure
- `/v1/health` (with the admin key) has `compute.raetoFloatUsd` near what the console shows

**To stop it:** the owner's switch, at once and without a restart:

```
POST /v1/admin/switch {"what": "raeto", "on": false}     (with the admin key)
```

or `RAETO=off` on the engine. Either way `raeto/auto` is no longer listed or served, the block and the log entry leave the
site, and "Compute it spent" leaves the pages. Credit is kept and the other models go on as before. What was spent stays
in the books and shows again if it is turned back on. If the key itself is the worry, pause it in the console: every call
then gets a plain "cannot reach the models" and nothing is charged.

## What it costs, and who pays

**The agent's credit pays, not the owner.** For a model that costs P:

```
Raeto takes:        P + 8% + a routing fee
The credit pays:    what Raeto took + 5%  (COMPUTE_MARKUP_BPS, rounded up to the millionth of a dollar)
```

Factor's markup does not have to cover Raeto's 8%, because the 8% is already inside what Raeto took: the margin goes on
top of it. So an agent on this route pays Raeto's fee and Factor's 5%. What the 5% is for is the same as on every route:
holding the ETH and turning it into dollars. Real calls on 2 Nov, with 6 to 16 tokens out:

| Asked | Answered by | At Raeto | Off the credit |
|---|---|---|---|
| `raeto/auto:cheap` | mistral-small-3.2 (fast) | $0.000026 to $0.000063 | $0.000028 to $0.000067 |
| `raeto/auto` | mistral-small-3.2 (fast) | $0.000033 to $0.000036 | $0.000035 to $0.000038 |
| `raeto/auto:fast` | gemini-2.5-flash-lite (fast) | $0.000011 | $0.000012 |
| `raeto/auto:reason` | claude-sonnet-5.5 (top) | $0.000117 | $0.000123 |

**The routing fee is not flat.** The docs say $0.0002 at most, "never more than that call's model cost". In practice, on these
short calls, it was $0 to $0.00003 and often several times the model's own cost, and $0 at the top tier. It is included in
`x-raeto-cost`, so it needs nothing here, but on very short calls it is most of the price.

**What the owner does pay:**

- a call that was charged at Raeto and never finished: a stream that broke off before its last chunk, which the agent is
  not charged for. It goes in the log
- anything over the hold, if Raeto ever charged past the ceilings. It is counted in `unpaidMicro` and in the log
- Factor's own agents, if `HOUSE_RAETO` is ever turned on

**The agent's request goes to Raeto and on to the model it picks.** Factor keeps which model, how many tokens and what it
cost, as on the other routes, and never what was asked or answered.

## How the money reaches the Raeto balance

**By hand, as on today's route.** An advance drawn as compute arrives as ETH in the gateway wallet, which is the gas wallet.
Nothing moves it to Raeto by itself. Today's OpenRouter balance is topped up by hand in the same way, and this adds a second
balance to watch, no new kind of step:

1. **Which ETH is free.** Spent credit is the owner's to move. Unspent credit on open jobs is not: it may have to go back to
   the pool if a job is refunded. `ENGINE_SKIM_TO` already sends on only what is over 0.02 ETH of gas and over that backing,
   once an hour, so what reaches that wallet is safe to use. `/v1/health` has `compute.spentMicro` and `compute.outstandingMicro`.
2. **ETH to USDG.** Swap it on Robinhood Chain, from that wallet, to USDG.
3. **USDG to Raeto.** Console, Billing, top up with USDG from that wallet. No fee but gas, about a minute.
4. **Raise the key's cap** by the same amount.

**Before any of that, the first $5 is already paid for by the owner.** A call draws on Raeto's balance immediately, while the ETH
that pays for it sits in the gas wallet until moved. ETH's price can fall between the draw and the swap; the 5% is what stands
against that. When the balance falls under $1, calls stop plainly, nothing is charged, and the log says so. The credit is kept.

## What was decided, and why

- **One key for every model (idea 3): built.** As above.
- **Advances that pay for AI (idea 1): built as far as it can go without a third party holding the money.** The advance stays
  credit at Factor's gateway, and goes straight to the models. Every call has the agent's address on it, and the job whose credit pays
  as `X-Raeto-Task`, with that job's whole credit as `X-Raeto-Task-Budget` as a second brake at Raeto. Under 30% of a job's budget left,
  Raeto moves to cheaper models by itself. Raeto's **agent wallets are not used**. Each is a Raeto account with its own balance,
  funded from the owner's: money would sit with Raeto per agent, a pool that lost on a job could only take back credits, not ETH, and an
  agent holding its own key could spend outside Factor's hold. It is an option if the owner wants it, not something to build without asking.
- **Jobs paid through Raeto Pay (idea 2): not built.** A Factor job is ETH locked in a contract with no owner, and the contract itself
  repays the pool and pays the agent. Raeto Pay is a balance in USDG that Raeto holds, with a 1% fee, and each payout is reviewed by its
  team (at least $10, at most $500 a day). Settling a job there would put a company between the customer and the agent, and the contract
  could not repay the pool out of it. That is the one promise Factor rests on. An agent can of course sell through Raeto Pay on its own.
