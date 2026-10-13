<p align="center">
  <img src="docs/banner.jpg" alt="Factor" width="100%">
</p>

<p align="center">
  <b>Advances for AI agents on Robinhood Chain.</b><br>
  An agent draws up to half of a payment its customer has already locked. The job pays it back.
</p>

<p align="center">
  <a href="https://github.com/FactorAgents/factor/actions/workflows/checks.yml"><img src="https://github.com/FactorAgents/factor/actions/workflows/checks.yml/badge.svg" alt="checks"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-black.svg" alt="license: MIT"></a>
  <img src="https://img.shields.io/badge/solidity-0.8.28-black.svg" alt="solidity 0.8.28">
  <img src="https://img.shields.io/badge/chain-Robinhood%20Chain-black.svg" alt="chain: Robinhood Chain">
  <img src="https://img.shields.io/badge/tests-600%2B-black.svg" alt="tests: 600+">
</p>

<p align="center">
  <a href="docs/RULEBOOK.md">Rulebook</a> ·
  <a href="docs/ENGINE.md">Engine</a> ·
  <a href="docs/SECURITY.md">Security</a> ·
  <a href="docs/REHEARSAL.md">Dress rehearsal</a> ·
  <a href="packages/kit">SDK and MCP</a>
</p>

---

Factor is an open protocol on Robinhood Chain that advances AI agents up to half of a payment their customer has
already locked. The job pays it back.

A customer locks the price of a job in a contract. The agent it is for may draw up to half of it before it delivers:
out of the customer's own payment if the customer allows that, or from a pool that trading fees fill. When the job
settles, the advance is repaid out of the payment. The contracts have no owner, no pause and no upgrade: nothing in
them can be changed after they are deployed.

<p align="center">
  <img src="docs/rehearsal/desktop-home-1.png" alt="The site: the ledger printing as it is written" width="88%">
</p>

## How a job goes

```mermaid
sequenceDiagram
    participant C as Customer
    participant D as Desk (contract)
    participant A as Agent
    participant P as Pool
    C->>D: lock the price of the job
    A->>D: draw an advance, up to half
    P-->>A: the advance, less a 1% fee that is burned
    A->>D: deliver (the fingerprint of the work)
    C->>D: accept, or reject within 24 hours
    D-->>P: the advance repaid, and a 2% job fee
    D-->>A: the rest of the payment
```

If the customer rejects the delivery, the job settles at half. If the agent never delivers, the customer is refunded
12 hours after the due time, the agent's bond pays the pool first, and the agent is barred from the pool for good.
There is no judge and no vote: every outcome is a rule, and every rule is in [`docs/RULEBOOK.md`](docs/RULEBOOK.md).

## How it fits together

```mermaid
flowchart LR
    T[Trading of $FACTOR on Pons] -->|fees| S[FactorSplitter]
    S --> B[FactorBurnPot<br/>buys back and burns]
    S --> D[FactorDesk<br/>jobs, advances, the pool]
    D -->|advance fees| B
    AC[FactorAccounts<br/>accounts without a wallet] --> D
    E[Engine] -. "reads, and makes the calls anyone may make, on time" .-> S & B & D
    W[Site] -. reads .-> E
    K[factor-kit] -.-> E
    K -.-> D
```

| Contract | What it does |
|---|---|
| `FactorDesk` | Holds every job's payment. Advances, deliveries, settlements, refunds, the pool, bonds, each agent's public record and score |
| `FactorSplitter` | Collects the token's trading fees from Pons and splits them, to the wei |
| `FactorBurnPot` | Launches the token, then buys it back and burns it, never more than 1% of the market's depth at a time |
| `FactorAccount` | An account for somebody without a wallet: it obeys a passkey (checked natively by the chain) or a key with no ETH, and anyone may pay its gas |

## SDK and MCP

[`factor-kit`](packages/kit) is the SDK: everything an agent or a customer does through Factor, as one small class.
It is published to npm with the launch; until then it builds from this repo.

```js
import { Factor } from "factor-kit";

// an agent whose key holds no ETH: it acts through a Factor account, and its gas is paid for it
const factor = await Factor.connect({ privateKey: process.env.AGENT_KEY, gasless: true });
await factor.register();

for await (const job of factor.jobsForMe()) {              // every job locked for this agent, as it appears
  const { fromPool } = await factor.canDraw(job.n);        // what the desk will advance on it right now
  if (fromPool !== "0") await factor.draw(job.n, fromPool, "pool");
  await factor.deliver(job.n, await doTheWork(job.title)); // only the work's fingerprint goes on the chain
}
```

```js
// a customer
const { jobId } = await factor.hire({ agent: "plain-reader", price: "0.002", title: "A lease", brief: theLeaseAsText });
await factor.waitFor(jobId, ["delivered"]);
await factor.accept(jobId);                                // or reject: the job settles at half
```

The same package is an **MCP server** with 19 tools, so an AI assistant can hire agents and work as one. Two limits
sit in front of it, kept by the server and not by the assistant: the most one job may cost, and the most that may
leave the wallet in a day.

```json
{
  "mcpServers": {
    "factor": {
      "command": "npx",
      "args": ["-y", "factor-kit"],
      "env": { "FACTOR_PRIVATE_KEY": "a wallet made for this", "FACTOR_MAX_JOB_ETH": "0.05", "FACTOR_MAX_DAY_ETH": "0.2" }
    }
  }
}
```

Without a key the assistant can read Factor (agents, jobs, the ledger) and nothing else. The whole of it is in
[`packages/kit/README.md`](packages/kit/README.md).

## The numbers

| | |
|---|---|
| Most of a job that can be advanced | 50% |
| Fee on an advance | 1%, burned |
| Fee on a job | 2%, to the pool |
| An agent's limit with the pool | its bond plus the fees its jobs have paid |
| Most of the pool that can be out at once | 80% |
| Grace after the due time | 12 hours |
| Time to accept or reject a delivery | 24 hours |
| A rejected job | settles at half |

## What is here

| Folder | What it is |
|---|---|
| [`contracts`](contracts) | The four contracts (Solidity 0.8.28, Foundry) and their tests |
| [`engine`](engine) | One process and one SQLite file. It reads the contracts, keeps the ledger, and makes the few calls somebody has to make on time: sweeps, burns, settlements, refunds, and the gas of accounts without a wallet |
| [`web`](web) | The site (Next.js). The browser talks only to the site's own API |
| [`packages/kit`](packages/kit) | `factor-kit`: the SDK, and an MCP server with 19 tools for AI assistants, behind spending limits |
| [`docs`](docs) | The rulebook, the engine, the security pass and the dress rehearsal |
| [`design`](design) | The design system the site is built from |

## How it is tested

| | |
|---|---|
| Contracts | 192 tests: every rule one by one, twelve attacks carried out against the desk, random sequences of every move with the books checked after each step, and the whole of it against the real Pons on a copy of the chain. The tests themselves are tested: the contracts are broken on purpose and each break must be noticed |
| Engine | 211 tests on a made-up chain (reorgs, a node that turns requests away, stuck transactions), 88 checks end to end on a copy of the chain, and a dress rehearsal of a whole day with every wei accounted for at the end |
| Site | 19 checks of every page, and 68 more driven through a real browser with a wallet, a passkey and a phone |
| SDK and MCP | 26 tests, and 66 checks end to end |

    cd contracts && forge test
    cd engine && npm ci && npm test
    cd engine && npm run e2e           # against the real contracts on a local copy of the chain
    cd engine && npm run rehearsal     # a whole day, about 50 minutes
    cd packages/kit && npm ci && npm test
    cd web && npm ci && npm run build && npm run test:smoke

No test touches the real chain, and none calls a model.

Every push runs four sets of checks on GitHub (CI): the contracts, the engine, the SDK and the site. The badge at
the top says how the last run went.

## Reading it

- [`docs/RULEBOOK.md`](docs/RULEBOOK.md): every rule of the desk, with examples to the wei, the ways it can be attacked and the answer to each.
- [`docs/ENGINE.md`](docs/ENGINE.md): what the engine does, how it reads the chain, and how it is run.
- [`docs/SECURITY.md`](docs/SECURITY.md): what holds money, who can touch it, what can be stopped, and every limit in one place.
- [`docs/REHEARSAL.md`](docs/REHEARSAL.md): a whole day of it on a copy of the chain, and what that found.

## Security

The code has had no outside audit. To report something, see [`SECURITY.md`](SECURITY.md).

## Use it at your own risk

Factor is an experiment in open contracts that nobody can change. $FACTOR can lose all of its value. Nothing here is
financial advice.

## License

[MIT](LICENSE)
