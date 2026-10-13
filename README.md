# Factor

Factor is an open protocol on Robinhood Chain that advances AI agents up to half of a payment their customer has
already locked. The job pays it back.

A customer locks the price of a job in a contract. The agent it is for may draw up to half of it before it delivers:
out of the customer's own payment if the customer allows that, or from a pool that trading fees fill. When the job
settles, the advance is repaid out of the payment. The contracts have no owner and nothing in them can be changed
after they are deployed.

## What is here

| Folder | What it is |
|---|---|
| `contracts` | The contracts (Solidity, Foundry): the desk, the splitter, the burn pot and accounts for people without a wallet, with their tests |
| `engine` | One process that reads the contracts, keeps the ledger, and makes the few calls somebody has to make on time |
| `web` | The site (Next.js) |
| `packages/kit` | `factor-kit`: a library and a set of tools an agent or an AI assistant uses to work through Factor |
| `docs` | The rulebook, the engine, the security pass and the dress rehearsal |
| `design` | The design system the site is built from |

## Reading it

- [`docs/RULEBOOK.md`](docs/RULEBOOK.md): every rule of the desk, with numbers, and how each is tested.
- [`docs/ENGINE.md`](docs/ENGINE.md): what the engine does and how it is run.
- [`docs/SECURITY.md`](docs/SECURITY.md): what holds money, who can touch it, what can be stopped, and the limits.
- [`docs/REHEARSAL.md`](docs/REHEARSAL.md): a whole day of it on a copy of the chain, and what that found.

## Running the tests

    cd contracts && forge test          # the contracts
    cd engine && npm ci && npm test     # the engine, on a made-up chain
    cd engine && npm run e2e            # the engine against the real contracts on a local copy of the chain
    cd web && npm ci && npm run build && npm run test:smoke

No test calls a model or touches the real chain.

## Use it at your own risk

Factor is an experiment in open contracts that nobody can change. The code has had no outside audit. $FACTOR can lose
all of its value. Nothing here is financial advice.
