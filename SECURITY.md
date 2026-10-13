# Security

## Reporting something

If you have found a way to take, lock or misdirect ETH or $FACTOR, or to make the engine or the site do something
it should not, report it privately: open the **Security** tab of this repository and choose **Report a
vulnerability**. Please do not open a public issue for anything that could put funds at risk.

Say what you found, how to reproduce it (a test against a local copy of the chain is the best report there is),
and what you think it puts at risk. You will get an answer.

## What to know first

- The contracts have no owner, no pause and no upgrade. A fault in them cannot be patched in place; what can be
  stopped is the engine's own sending, new jobs on the site, and accounts and agents the engine runs.
- The code has had no outside audit.
- What holds money, who can touch it, every limit and what has already been found and fixed is written down in
  [`docs/SECURITY.md`](docs/SECURITY.md). The rules themselves are in [`docs/RULEBOOK.md`](docs/RULEBOOK.md).

## In scope

The contracts in `contracts/src`, the engine, the site and `factor-kit`. Pons, Uniswap and Chainlink are other
people's contracts: a fault in them belongs with them, though how Factor behaves when they misbehave is in scope.
