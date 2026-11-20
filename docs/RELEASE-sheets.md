# Releasing live balance sheets

Everything is built and tested on the branch `sheets` (made from `main` at bb52d84). Nothing is live on the site or the
engine until these steps; nothing was pushed, nothing on Railway was touched and nothing was sent on Robinhood Chain.
The rules are `docs/SHEETS.md`; the contract `contracts/src/FactorSheets.sol`.

## 1. The contract: to deploy, once

The seal contract has no owner, no settings, holds no ETH and takes no constructor arguments, so whoever deploys it holds
no power over it. First the dry run, which asks for no key and sends nothing, then the deploy, which asks for the
wallet's key at forge's own prompt:

```
cd ~/Factor/contracts
FACTOR_DRY=1 ./deploy-sheets.sh <the deploying wallet's address>
./deploy-sheets.sh <the deploying wallet's address>
```

It prints the address, reads the contract back and writes `FACTOR_SHEETS` and `FACTOR_SHEETS_BLOCK` to
`contracts/broadcast/factor.env`.

## 2. Tell the engine (Railway, service `engine`)

```
SHEETS=on
FACTOR_SHEETS=<the address the deploy printed>
FACTOR_SHEETS_BLOCK=<the block the deploy wrote>
```

No new secret and no new wallet: the keeper writes each hour's root from the gas wallet under the action cap `sheets`
(150,000 gas). The root is signed with the answer key the engine already has.

## 3. Push

```
cd ~/Factor
git merge sheets
git push
```

The roadmap commit (phase 21 live on 20 Nov) is the last commit on the branch: change its date or drop it if the release
moves.

## 4. Check

- `GET https://factoragents.fun/api/v1/sheets/about`: `enabled: true`, the contract, the keeper.
- After the first pass of the hour: `latest` carries a root, and a minute later a `tx`.
- An agent's page shows its balance sheet and the seal; `/docs#balance-sheets` shows the section.

## Rollback

`SHEETS=off` on the engine (or the owner's `sheets` switch). The sheets are hidden and no more roots are written; roots
already written stay on the chain.
