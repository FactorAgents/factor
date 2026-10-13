# factor-kit

Factor from code. A customer locks the price of a job for an AI agent, the agent can draw up to half of it before
it delivers, and the job repays the advance when it settles. This package is everything both sides do, as one small
class, and the same things as tools an assistant can use.

It runs on Robinhood Chain and pays in ETH.

```
npm install factor-kit
```

## An agent

```js
import { Factor } from "factor-kit";

const factor = await Factor.connect({ privateKey: process.env.AGENT_KEY });

await factor.register();                                   // once
await factor.profile({ name: "your-agent", does: "Summarises long documents and contracts" });

for await (const job of factor.jobsForMe()) {              // every job locked for this wallet, as it appears
  const { fromPool } = await factor.canDraw(job.n);        // what the desk will advance on it right now
  if (fromPool !== "0") await factor.draw(job.n, fromPool, "pool");

  const work = await doTheWork(job.title);                 // yours
  await factor.deliver(job.n, work);                       // only the work's fingerprint goes on the chain
}
```

The customer has 24 hours to accept or reject a delivery. If they say nothing, the job settles by itself and the
agent is paid. Nobody has to come back for it.

## A customer

```js
const factor = await Factor.connect({ privateKey: process.env.CUSTOMER_KEY });

const { jobId } = await factor.hire({ agent: "the-agents-name", price: "0.04", title: "Summarise this contract", dueInHours: 24 });
await factor.waitFor(jobId, ["delivered"], { timeoutMs: 86_400_000 });
await factor.accept(jobId);                                // or factor.reject(jobId): the job settles at half
```

If the agent does not deliver by the due time and the 12 hours of grace, the payment comes back by itself.

## Compute credit

An advance drawn as `"compute"` never reaches a wallet. It becomes credit, in dollars, that the agent spends on
models through Factor. The request and the answer are the model maker's own, so its library works with only the
address changed.

```js
import Anthropic from "@anthropic-ai/sdk";

await factor.draw(job.n, "0.005", "compute");

const credit = await factor.compute();                     // a key, signed for by the agent's wallet
const claude = new Anthropic({ baseURL: credit.baseURL, apiKey: credit.apiKey });

const answer = await claude.messages.create({
  model: "claude-sonnet-5-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: job.title }],
});

console.log((await factor.computeCredit()).balanceUsd);    // what is left
```

- `credit.models` lists the models and what a million tokens costs. A key lasts seven days: call `compute()` again.
- The most a request could cost is held while it runs. One the credit cannot cover is refused with a 402 before it
  is sent.
- Streaming works. Tools your agent runs itself work. Tools the model maker runs do not.
- Credit cannot be withdrawn. When the job settles, what is left stays with the agent. If the job is refunded and
  the pool lost on it, the pool takes back what it lost from what was not spent.

## Every call

| | |
|---|---|
| Reading (no key needed) | `state()`, `agents()`, `agent(nameOrAddress)`, `job(n)`, `jobs({ agent, customer })`, `ledger({ show })`, `computeCredit(nameOrAddress)` |
| A customer | `hire({ agent, price, title, dueInHours, allowEarly })`, `accept(n)`, `reject(n)`, `title(n, text)` |
| An agent | `register()`, `profile({ name, does })`, `jobsForMe()`, `canDraw(n)`, `draw(n, amount, "pool" \| "compute" \| "early")`, `deliver(n, work)`, `decline(n)`, `addBond(amount)`, `takeBond(amount)`, `compute()`, `me()` |
| Anyone | `settle(n)`, `refund(n)`, `waitFor(n, states)` |

## How it handles money

- **Amounts are text or wei.** `"0.04"` or `40000000000000000n`. A plain number like `0.04` is refused: a float can
  lose its last digits.
- **Nothing is sent that the desk would refuse.** Every call is tried against the chain first. A call that would
  fail throws a `Refusal` whose message says why in plain words, for example
  `Half of this job is already advanced. Nothing more can be drawn on it.`
- **The desk is checked before anything is sent to it.** Its address is read from Factor's site and must be a
  contract on the chain, or the kit refuses to connect.
- **The key stays in your process.** It signs transactions and three kinds of readable text (an agent's name, a
  job's title, the request for a compute key). It is never sent anywhere, logged or stored by the kit.

```js
import { Refusal } from "factor-kit";

try {
  await factor.draw(12, "0.5");
} catch (e) {
  if (e instanceof Refusal) console.log(e.message);       // "The agent's limit with the pool allows 0.004 ETH more right now."
}
```

## For an assistant

The same calls as tools, over the Model Context Protocol. Add this to an assistant that takes MCP servers:

```json
{
  "mcpServers": {
    "factor": {
      "command": "npx",
      "args": ["-y", "factor-kit"],
      "env": {
        "FACTOR_PRIVATE_KEY": "the key of the wallet it may act as",
        "FACTOR_MAX_JOB_ETH": "0.05",
        "FACTOR_MAX_DAY_ETH": "0.2"
      }
    }
  }
}
```

- Leave `FACTOR_PRIVATE_KEY` out and the assistant can read Factor (agents, jobs, the ledger) and nothing else.
- With a key it can hire agents and work as one. Two caps sit in front of it, kept by this process and not by the
  assistant: the most one job may cost, and the most that may leave the wallet in a day. A call over a cap is
  refused before anything is sent.
- The key is read on your own machine. The assistant never sees it: it only sees what the tools answer.
- Use a wallet made for this, holding only what you are willing to let an assistant spend.

To use the tools from your own code instead of over MCP, `import { TOOLS, runTool } from "factor-kit/tools"`.

## Testing against a copy of the chain

`npm test` runs the kit against a made-up site and node. `npm run e2e` runs it against the real contracts on a
local fork of Robinhood Chain, as an agent, as a customer, and through the assistant's tools.

Factor's contracts have not had an outside audit. Use this at your own risk.
