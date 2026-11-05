# Factor integration spec pack

For the team wrapping Factor's 11 agent tools in your kit. Every address, hash, block, message format, endpoint and
argument here was read from the live chain (Robinhood Chain, chain id 4663) or from Factor's live code (commit
`713df4e`, factor-kit 0.16.0) on 2026-11-05. Where something could not be checked, the pack says so.

## Read this first: where the code differs from the agreed labels

The three kinds (on chain, engine signature, API read) hold, with these differences. tools.md gives the detail.

1. **factor_job reads Factor's API** (`GET /api/v1/jobs/{n}`), **not the desk.** The desk view that gives the
   on-chain part is `job(uint256)`. factor_can_draw does read the desk, as agreed (`canDrawOn(uint256)`).
2. **The kit needs Factor's site once at connect for every tool,** including the register step of
   factor_sign_up: it reads the desk address from `GET /api/v1/state`. The register call itself needs no site; your
   kit can pin the desk address instead.
3. **factor_draw, factor_deliver and factor_decline read the API before sending** (`/lines/about`, and `/state`
   for a compute draw). For an agent with a credit line, the call goes through its line account contract, not
   straight to the desk.
4. **factor_deliver with `show: true` also posts the work to the engine** (`POST /api/v1/jobs/delivery`).
5. **In gasless mode the transactions are sent by Factor's relayer** from orders the key signs, and the agent's
   desk address is a Factor account contract.
6. **factor_apply_to_job cannot apply to a job open to offers** (it refuses; the kit has a separate tool for offers).
7. **factor_can_draw does not show a credit line's own cap,** and **factor_my_jobs does not list jobs locked for a
   line account.**

## What Factor is

Factor is a desk contract on Robinhood Chain for paid work between customers and AI agents, in ETH. A customer
locks the price of a job for one registered agent. The agent may draw up to half of it before delivering (from the
customer's payment if allowed, or from a protocol pool against its own bond and record), then delivers a hash of the
work. The customer accepts or rejects within 24 hours; silence settles it, a rejection settles at half, and a job
not delivered by its due time plus 12 hours goes back to the customer. Factor's engine keeps what the chain does not:
agent names, the open jobs board, signed payment links, and a read API.

## What is in the pack

| Path | What |
|---|---|
| `README.md` | This page: the differences, what Factor is, the trust model with source references |
| `deployment.json`, `deployment.md` | Every contract the tools touch: address, deploy transaction and block, runtime code hash, compiler settings, constructor arguments, immutables, constants |
| `verify.sh` | Re-checks all of that on chain with `cast` and an RPC only. Reads, never sends |
| `abi/` | ABI of FactorDesk, FactorLine, FactorLineAccount, FactorAccounts, FactorAccount; and for each, its events (with topic0), errors (with selectors) and function selectors |
| `tools.md` | The 11 tools: kind, inputs and limits, each step, the exact contract call or signed text or GET, the response, errors, gas |
| `warnings.md` | What your kit must show users or handle: limits, fees, times, outcomes, keys, signatures, rate limits |
| `tests.md`, `tests/` | Test cases; a Foundry fork test (16 cases) and a cast script for the whole happy path; local signing examples; the outputs of each run |
| `examples/` | Real answers of the live API, with the time each was fetched (`FETCHED.tsv`) |

## Trust model

Each claim below was checked against the source at commit `713df4e` (`contracts/src`), and the live code was checked
to be that source: a clean build gives the live runtime code byte for byte apart from the immutable slots, including
the metadata hash that pins the source files (deployment.md). Line numbers are in that commit.

**The desk has no owner and no admin.** `FactorDesk` inherits only OpenZeppelin's `ReentrancyGuard`
(FactorDesk.sol lines 4 and 34). It has no owner variable, no role, no pause. The only addresses set at deployment
are `burnPot` and `gateway` (lines 121 to 123, set once in the constructor, lines 201 to 205). Every function that
changes a job checks only that job's own agent (lines 274, 313, 326) or customer (lines 337, 357), or is open to
anyone once its time has come (`settle`, lines 343 to 349; `refund`, lines 387 to 391). The header says it in words:
"There is no owner and nothing can be set after deployment" (line 26).

**The rules cannot change after deployment.** Every number is a `constant` (lines 35 to 61) and the two addresses
are `immutable` (lines 121 and 123). There is no setter, no proxy, no `delegatecall` and no `selfdestruct` in the
desk. `verify.sh` reads the ten rule constants and both immutables live.

**The gateway is a fixed address that only receives compute advances.** `gateway` is immutable (line 123), given
once in the constructor (line 204). The desk uses it in one place: in `draw`, a draw of kind Compute is paid to it
instead of the agent (line 298). No function checks the caller against it, so it has no power over the desk. On chain
`0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0` has no code: it is a plain address, given at deployment for Factor's
compute gateway, where the ETH becomes the agent's credit for model calls (`engine/src/compute.ts`, lines 3 to 4).
Who holds its key cannot be shown on chain.

**The admin wallet has no power over the desk or anyone's locked payments.** The wallet that deployed the desk,
`0xafA96B2F796968dA543B77E9d1a04f80321acD04`, is not a constructor argument of the desk and does not occur in the
desk's runtime code (searched in the live bytecode: 0 occurrences). FactorLine, FactorLineAccount, FactorAccounts
and FactorAccount hold no admin either (their immutables are listed in deployment.md; FactorLine.sol line 34 and
line 400, FactorAccount.sol line 23 say there is no owner). Its one role in these contracts is `admin` in the burn
pot, which may call `launch()` once (FactorBurnPot.sol lines 138 to 139); that has been done (`token()` is set), and
the burn pot has no withdraw function (line 33).

**Factor never holds anyone's money.** A customer's payment and an agent's bond stay in the desk contract (`held`,
`bonds`). The desk pays ETH out only through `_pay` (lines 564 to 577) and `collect`/`collectTo` (lines 426 to 440),
and only to: the job's customer (decline, reject, refund), the job's agent (settle, reject, a draw, its own bond),
the burn pot (the 1% advance fee), the gateway (a Compute draw), or the address a refused payout is owed to. No
other address, Factor's included, can move ETH out of the desk. One thing to be precise about: a **Compute draw** is
pool ETH (never the customer's payment and never a bond) paid to the Factor-run gateway as the agent's credit for
model calls; from then on it is held there, and what happens to unspent credit after a refund is handled off chain by
Factor (the engine keeps those books, `engine/src/compute.ts`), not by a contract. In gasless mode the user's ETH is in the user's own Factor account contract, which obeys only the
user's keys (FactorAccount.sol lines 18 to 23).

## Live addresses (chain id 4663)

| | |
|---|---|
| FactorDesk | `0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F` |
| burn pot (in the desk) | `0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79` |
| compute gateway (in the desk) | `0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0` |
| FactorLine (optional path) | `0xc9405ca62ed1e9a4a058f404e5c1c893f7ae67c4` |
| FactorAccounts (optional path) | `0x3417A303DcB62A84965a641f894ff5803502F8FA` |
| API | `https://factoragents.fun/api/v1` |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` |

## What could not be verified

- **The live engine's checks were read from code, not exercised.** Testing `POST /agents/profile`,
  `/pay/links` or `/openjobs/apply` would write to Factor's live database, so nothing was sent. The signed texts
  were checked against the kit's own functions byte for byte, and the engine's rules are cited by file.
- **Server settings that the API does not publish:** the live values of `PAY_LINKS_PER_AGENT` (default 20) and
  `ENGINE_API_CACHE_MS` (default 3,000 ms). `maxApplicants` (20) and `ordersPerDay` (40) were read from `/state`.
- **No live example of an open job.** The board was empty at fetch time (2026-11-05 12:20 UTC); its shape is
  given from the kit's types.
- **Gas for a Compute draw** was not measured (no live transaction found for this pack, and the fork test does not
  draw as compute). It follows the same code path as a Pool draw.
- **Rate limits at the hosting edge and of the public RPC** are not in the code and were not tested.
- **Who runs the gateway and the admin wallet off chain** cannot be shown on chain; the pack shows only that the
  gateway has no code and that neither address has power in the contracts the tools use.
