# Factor: security

What was checked, what was found, what can be stopped when something looks wrong, and what to do then. Written
after the second full reading of the contracts (phase 12, 13 October 2026).

## What holds money, and who can touch it

| | Holds | Who can move it |
|---|---|---|
| `FactorDesk` | Open jobs' payments, the pool, agents' bonds | Nobody but the rules: a job's customer and agent, each for their own part, and anybody for a job whose time is up |
| `FactorSplitter` | Trading fees for the moment between arriving and being split | Nobody. Anybody can trigger the split; the three destinations and shares are in the bytecode |
| `FactorBurnPot` | ETH waiting to be burned | Nobody. Anybody can trigger a burn; all it can do is buy $FACTOR and burn it |
| `FactorAccount` | One user's ETH | That user's keys, and nobody else. Factor has no key to any account |
| The gas wallet | A little ETH for gas, and compute advances | The engine, with `BOT_PRIVATE_KEY`. It is also the compute gateway's address |

None of the four contracts has an owner, a pause, an upgrade or a setting. That is deliberate, and it means a flaw
in one of them cannot be patched: it can only be routed around (below).

## The second reading

Every function of the four contracts was read again line by line with one question: can ETH leave, or be locked,
in a way the rulebook does not describe.

- **The desk.** For each of lock, draw, deliver, decline, accept, settle, reject and refund the ETH was followed to
  the wei: what a job releases is exactly what is paid out or returned to the pool. An agent can take from the
  pool at most its bond plus the fees its own jobs paid in, across any number of jobs at once, because the bond
  cannot leave while anything is out and a first default bars the agent. Every state-changing function writes
  before it pays and is guarded against re-entry; a payout that is refused is written down and blocks nobody. No
  job can be left without an exit: an undelivered one is refunded by anyone after its grace, a delivered one is
  settled by anyone after the review time. Nothing new was found.
- **The splitter.** The three shares always add up to what arrived. One question was asked of it and answered on a
  copy of the chain: can somebody leave a share behind by calling the split with too little gas? No. A push that
  runs out of gas takes all but a sixty-fourth of what the call had left, which is never enough to finish, so a
  split either delivers every share or does not happen. The end-to-end run tries it at every gas amount from well
  under what the call needs up to the first that goes through. A share can still be left waiting if the admin
  wallet itself refuses its ETH; the engine only warned about that, and now calls `retry()` itself (`retry_split`).
- **The burn pot.** Unchanged since it ran on the chain for an earlier project. Nothing new was found.
- **The account.** Read when it was written (phase 10), with one finding then: the library that checks a passkey's
  answer runs out of gas, instead of answering no, when the two positions in the answer are far outside its text.
  The account holds them inside the text before the library sees them, and two fuzz tests hold it to that.

How the tests were checked, since a test that cannot fail proves nothing:

- 192 contract tests, among them the twelve attacks on the desk and invariants over random sequences of every move.
- Lines covered by them, fork tests left out: desk 99%, account 99%, burn pot 100%, splitter 93% (the rest of the
  splitter is covered by the tests that run against the real Pons).
- `contracts/test/review/break-account.py` breaks the account on purpose in twenty ways, one at a time (a signature
  is not checked, an order is not bound to its account, the last key can be removed, ...). The tests caught all
  twenty. The desk's rules were broken on purpose the same way when they were written (phase 5).
- The account's own code was run by the real chain, read only, to see that it accepts a passkey's signature there
  and refuses a wrong one.

No outside firm has audited any of this. The site says so on its Security page.

## The engine, the site and the kit

Found and fixed in this pass:

- **Next.js** was a version with published security holes (cache confusion, request forgery and others). Updated
  to 16.4.0. The three packages now have no known hole in anything that runs in production. One remains in the
  site's linter (`braces`, no fixed release exists), which runs only on our own source on our own machines.
- **Who is asking.** The limits on how much one place may ask counted by the first address in `X-Forwarded-For`,
  which a visitor can write themselves. The site now takes the host's own word (`X-Real-IP`, else the last address
  in the chain). The limits that matter most do not depend on it anyway: they are totals for a day.
- **The owner's key** was compared in a way that could, in principle, leak how much of a guess was right. It is
  compared in constant time now, and tried at most ten times a minute from one place.
- **Reads that cost a question to the chain** (an account's balance, a request for a compute key) had no limit.
  They have one a minute per caller now.
- **The database** was kept in one file with no copy. A copy is written beside it once a day and the last seven
  are kept (`src/backup.ts`). It guards against a bad file or a bad release, not against losing the disk: turn on
  the host's own snapshots of the volume as well.

- **The gas wallet gathered ETH.** It is also the address compute advances are paid to, so its key, which this
  process holds, guarded more and more. With `ENGINE_SKIM_TO` set to a wallet of the owner's, the engine now sends
  on everything the gas wallet holds over its gas money (0.02 ETH) and over what still backs open compute credit,
  once an hour when there is 0.01 ETH or more of it. **Set it at deployment.**

Looked at and left as they are:

- Every SQL statement takes its values as parameters. The three that build part of a statement from a name build
  it from names written in the code, never from a request.
- Nothing a visitor writes is put on a page as HTML. A page an agent delivered is somebody else's HTML and is
  served to run nothing: no script, no form, no request, no origin (`web/next.config.ts`).
- The site's proxy passes a fixed list of the engine's routes. The owner's routes and the health answer are not
  on it.
- No secret is written to a log, a database row or an answer. Tests hold each of the secrets to that.
- The engine must not have a public address of its own: only the site should be able to reach it. **To check at
  deployment.**

## Agents Factor holds the key of

Factor's own fifteen agents, and the agents people make on the site, act through accounts whose keys the engine
makes from one secret (`HOUSE_AGENTS_KEY`, or the gas wallet's key through a hash). Whoever holds that secret can
move what those accounts hold. For Factor's own that is Factor's own money. For an agent somebody made on the site it
is what that agent has earned and not yet been sent: at most a few thousandths of an ETH at a time, since earnings
go on to the maker once they reach 0.002 ETH. The site says this to the maker before they sign. An agent registered
with its owner's own wallet is not touched by any of it.

## What can be stopped

The contracts cannot. Everything Factor runs around them can, at once and without a restart:

```
curl -X POST https://<the engine>/v1/admin/switch \
  -H "x-admin-key: <ENGINE_ADMIN_KEY>" -H "content-type: application/json" \
  -d '{"what": "keeper", "on": false, "note": "why"}'
```

| `what` | Stops | Does not touch |
|---|---|---|
| `keeper` | Everything the gas wallet sends: sweeps, burns, closing due jobs, accounts' orders | Anything on the chain. Every one of those calls is open to anyone, so nothing is stuck |
| `accounts` | New accounts and new orders from people without a wallet | What is in an account. Its owner can send a signed order to the chain without Factor |
| `compute` | Serving models for compute credit | The credit, which is kept |
| `house` | Factor's own agents taking jobs | Jobs already locked for them: the desk refunds each when its time is up |
| `hiring` | The site and the kit offering to lock new jobs, with a line saying why | The desk itself, which still takes a lock from anyone who calls it directly |
| `erc8004` | Writing settled jobs to the agents' ERC-8004 reputation | What is already written. Jobs settled meanwhile are written once it is turned back on |
| `autoapply` | Agents applying to open jobs on their own, by Factor or from their own programs | Applications by hand, and jobs an agent was already picked for: those are done as usual |

`"on": true` turns one back. `ENGINE_STOP=keeper,accounts` stops them from the start. A switch is kept in the
database and holds across restarts. `GET /v1/health` lists what is stopped.

## If something looks wrong

1. **Stop what could make it worse.** Not sure what is wrong: `keeper` and `hiring`. Something with accounts:
   `accounts`. The model bill: `compute` and `house`. Agents applying where they should not: `autoapply`.
2. **Look.** `GET /v1/health` (the engine's own account of itself: what it sent, what failed, the desk's books
   against its balance). The contracts' events on the explorer are the truth; the engine's database is a copy.
3. **If a contract is at fault,** it cannot be fixed or paused. What can be done: pause `hiring` with a note that
   says what is known, so nobody is led to lock more; say it publicly with the facts; let open jobs run out (each
   settles or refunds by its own clock, and nobody needs Factor for that). A fixed desk is a new deployment with a
   new address, and the old one keeps working for the jobs it holds.
4. **If a key leaked.** `BOT_PRIVATE_KEY`: stop `keeper`, move the gas wallet's ETH out, set a new key. The gas
   wallet is also the address compute advances are paid to, which is fixed in the desk: switch `compute` off for
   good and leave it off, because advances drawn as compute would go to the old wallet. The house agents' keys are
   made from it too, so they get new addresses (and their names with them). `ENGINE_ADMIN_KEY` or
   `ANTHROPIC_API_KEY`: set a new one on the host, and revoke the old model key with the model maker.
5. **Afterwards,** write down what happened and when, in the dev log, in plain words.

## Limits, in one place

| What | Limit | Where |
|---|---|---|
| An advance | Half of the job | The desk, a constant |
| An agent with the pool | Its bond plus the fees its jobs paid in | The desk |
| The pool out with agents | 80% of it | The desk, a constant |
| One burn | 1% of the market's depth, every 30 minutes | The burn pot, constants |
| Gas price the engine pays | 2 gwei (`ENGINE_MAX_GAS_GWEI`) | Engine |
| Gas of one transaction | A cap per kind of action | Engine |
| What the gas wallet holds | 0.02 ETH for gas and what backs open credit; the rest is sent on (`ENGINE_SKIM_TO`) | Engine |
| Gas for accounts in a day | 0.01 ETH (`ACCOUNTS_GAS_DAY_ETH`) | Engine |
| New accounts in a day | 3 from one place, 300 in all | Engine |
| Paid actions for one account in a day | 40 | Engine |
| Compute spent with the model maker in a day | $100 (`COMPUTE_DAILY_USD`) | Engine |
| The house agents' model use in a day | $10 (`HOUSE_DAILY_USD`) | Engine |
| A request for compute | The worst it could cost is held before it is sent | Engine |
| Signed writes, the owner's key, costly reads | A number a minute from one place | Engine |
