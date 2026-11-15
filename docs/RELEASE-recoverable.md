# Releasing the Recoverable mark (with Upoch)

Everything is built and tested on the branch `recoverable` (made from `main` at 370fffe, which was also `origin/main`).
Nothing is live until these steps: nothing was pushed, nothing on Railway was touched, and no transaction was sent. The
mark only reads Upoch's contract: no key, no gas, no new wallet.

## What it is

Upoch runs agent workflows with checkpoints on Robinhood Chain and a way to restore them. Its Epoch contract is
`0x6179d9123C3C1f9e82f948101a4350cb55Aa8C27`. Factor reads it, read only, and marks an agent **Recoverable** when at
least ONE Upoch workflow linked to it passes all four (the rule agreed with Upoch on 15 Nov):

1. **linked**: the agent's ERC-8004 identity owner or its agentWallet is the workflow's owner or one of its executors
2. **active**: the workflow's status is Active, not Paused
3. **recent**: its head checkpoint (`getCheckpoint(id, headSequence).timestamp`) is at most 7 days old, fixed for every agent
4. **guardian**: at least one guardian and `guardianThreshold >= 1`. A timelock alone does not count; checkpoints alone never count

It changes no score and moves no money. The code: `engine/src/recoverable.ts` (the rule, the reading, the cache),
`web/src/components/Recoverable.tsx` (the mark and the report's Recovery section).

Where it shows:

- the credit report, `/reports/<n>`: the mark beside the name and a **Recovery** section with the evidence (the workflow,
  how it is linked, status, last checkpoint and its age, the number of checkpoints, guardians and threshold, the
  timelock, the four conditions, any other workflow linked to it). An agent linked to a workflow that does not pass
  shows the section with why not, and no mark. An agent with no linked workflow shows nothing.
- a desk agent's page, `/agents/<name>`: the mark, by the ERC-8004 identity the reports tie it to, linking to the evidence
- JSON: `recovery` in `/api/v1/reports/agent/<n>`, `recoverable` in `/api/v1/agents/<name>`, and the list at
  `/api/v1/recoverable`
- the Docs page: a "Recoverable" section with the rule

How it is read: `workflowCount`, then for each workflow `getWorkflow`, `getGuardians`, `getExecutors` and the head
checkpoint, as plain view calls at the head (never logs), four workflows at a time. At the start, then every
`RECOVERABLE_EVERY_S` (600 s), and in the background whenever a report is built from a reading older than that: a page
never waits on the chain. A failed reading keeps the last good one for at most three intervals (30 minutes), then no
mark shows anywhere until the contract answers again. Today the contract holds 8 workflows: 5, 6, 7 and 8 pass, 1 to 3
have old checkpoints, 4 has only a timelock.

## Why agent #25946 answered "not found"

`https://factoragents.fun/api/v1/reports/8004:25946` is not a route: reports are at `/api/v1/reports/agent/<n>`, pages
at `/reports/<n>`. And `/api/v1/reports/agent/8004:25946` was turned away by the site's own API door
(`web/src/app/api/v1/[...path]/route.ts` allowed only digits, a wallet or a name there, not the colon); the engine
itself always took `8004:<n>`. The report was there all along: the reports had read the identity
(`/api/v1/reports/agent/25946` and `/reports/25946` answer, name "Upoch Spend Demo", agentWallet
`0x2aF949c90EdfeB4FfB7094302Ce6Eaf8486E46B1`). This branch lets `8004:<n>` through the door, and `/agents/<n>` for a
number that is no agent on the desk now leads to `/reports/<n>`, the page every agent on the chain has.

## 1. Tell the engine (Railway, project airy-light, service `engine`)

```
RECOVERABLE=on
```

`RECOVERABLE_EVERY_S` can stay unset (600). `REPORTS=on` must stay on (it is): the identities, with their owners and
agentWallets, are the credit reports'. No secret, no wallet, no gas. Setting it before the push restarts the old engine,
which ignores it.

## 2. Push

```
cd ~/Factor
git merge recoverable          # main had not moved since 370fffe, so this is a fast-forward unless it moved since
git push origin main           # as FactorAgents
```

Railway rebuilds the engine and the site. The order does not matter beyond step 1 first: the site shows nothing of the
mark until the engine says it is on.

## 3. Checks after the release

- the engine's log says `[recoverable] on: Upoch's workflows are read from 0x6179...` and then
  `[recoverable] read 8 workflows, 4 recoverable` (or more, as Upoch adds workflows)
- `https://factoragents.fun/api/v1/recoverable`: `enabled: true`, `recoverableWorkflows` holds 5, and `items` holds agent
  25946 with `workflow.id` 5
- `https://factoragents.fun/api/v1/reports/agent/25946`: `recovery.recoverable` true, `recovery.workflow.id` 5,
  `recovery.workflow.link` holds `{ wallet: 0x2af9...46b1, is: "agentWallet", as: "executor" }`
- `https://factoragents.fun/api/v1/reports/agent/8004:25946`: the same report (it was "not found")
- `https://factoragents.fun/reports/25946`: the Recoverable mark beside "Upoch Spend Demo", the line "Recent on-chain
  checkpoints and a guardian who can restore it, on Upoch." on hover or a tap, and the Recovery section with Upoch
  workflow #5, its last checkpoint, 1 guardian, threshold 1
- `https://factoragents.fun/agents/25946`: leads to `/reports/25946`
- `/docs#recoverable`: the section with the rule
- `GET /v1/health` (admin) has `recoverable` with `shown: true`

The links to send Upoch once those pass:

- the agent's page: `https://factoragents.fun/reports/25946` (also reached from `https://factoragents.fun/agents/25946`)
- its credit report as data: `https://factoragents.fun/api/v1/reports/agent/25946`
- every Recoverable agent: `https://factoragents.fun/api/v1/recoverable`

Should workflow 5 go a week without a checkpoint, #25946 shows the Recovery section with "not Recoverable now" and no
mark: that is the rule working.

## 4. Rollback

`RECOVERABLE=off` on the engine (a restart), or at once without a restart, the owner's switch:

```
curl -X POST https://<engine>/v1/admin/switch -H "x-admin-key: $ENGINE_ADMIN_KEY" -H 'content-type: application/json' -d '{"name":"recoverable","on":false}'
```

Either hides every mark, section and list entry and stops the reading. Nothing is stored, so nothing is left behind.

## 5. What was run before release (15 Nov 2026)

| Suite | Command | Result |
|---|---|---|
| Engine | `cd engine && npm test` | 826 passed, 2 skipped (before: 807 passed, 1 skipped); 19 new for the mark |
| Engine, live chain | `cd engine && FACTOR_LIVE_UPOCH=1 npx vitest run test/recoverable.live.test.ts` | passed: 8 workflows read, 4 recoverable; #25946 Recoverable by workflow 5 |
| Engine types | `cd engine && npm run typecheck` | clean |
| Site | `cd web && npm run build && npm run test:smoke` | the build, and 55 of 55 checks (54 on main; one new for the mark). The docs page's size budget in the smoke test went from 290,000 to 300,000 bytes for the new section, as with earlier sections |
| Site lint | `cd web && npm run lint` | no errors (the 6 warnings are in files this branch does not touch) |

The live test is skipped in `npm test` so the suite never needs the network.

Also run: the engine locally in watch mode against the live chain (read only, `RECOVERABLE=on`, `REPORTS=on` from a
recent block), with the site on it: `/reports/25946` showed the mark and the section with workflow #5, the list and the
report JSON held it, and the other pages answered as before.

Not done here, by the brief: no roadmap or dev log entry, no kit function or assistant tool for the mark, no score change.
