# Releasing Factor Credit Reports

"We scored every AI agent on the chain." Everything is built and tested on the branch `reports` (made from `main` at
e2645ea). Nothing is live on the site or the engine until these steps, and nothing was deployed, sent or paid to build it.
The formula and the rules against gaming it are `docs/REPORTS.md`; what is read, how, and what is left out,
`docs/REPORTS-SOURCES.md`.

This release has **no contract to deploy, no transaction to send, no wallet to fund and no model to call.** The engine reads
the chain (the public node it already uses) and works the reports out from what it reads. The score moves no money.

## 1. The checks (done, 10 Nov 2026)

- `cd engine && npm test`: every engine test (776, and 1 skipped as always), with 21 for the formula and every trick against it
  (`test/reportscore.test.ts`) and 16 for the reading, the API, the claim, Copilot and the switches (`test/reports.test.ts`).
  No test touches the real chain or calls a model.
- `cd packages/kit && npm test`: every kit test (159), with 6 for the reports, their four tools and Ask's line (`test/reports.test.ts`).
- `cd web && npm run build && npm run test:smoke`: the site, 52 checks, with the leaderboard, a report, its card and badge,
  the look-up, the docs and the dev log, and the site with nothing set showing no report at all.
- `cd contracts && forge test`: untouched by this release (no contract changed).
- **A real read-only run against the live chain** (section 8): the branch engine in watch mode (no key, no model key, nothing
  sent) read the ERC-8004 registries from block 12,000,000 and Priors' two pools from block 68,593,823 to the head, about
  twenty minutes from the public node, and scored every agent.

## 2. Tell the engine (Railway, project airy-light, service `engine`)

```
REPORTS=on
```

That is all. The rest can stay unset:

| | Default | |
|---|---|---|
| `REPORTS_PRIORS` | on | `off` leaves Priors' loans out of every report |
| `REPORTS_SPAN` | 100000 | blocks in one log query |
| `REPORTS_PER_PASS` | 40 | log queries in one pass |
| `REPORTS_EVERY_S` | 60 | seconds between passes once the past is all read |
| `REPORTS_SCORE_EVERY_S` | 300 | seconds between scorings of every agent |
| `REPORTS_CONFIRMATIONS` | 20 | blocks behind the head that are read |
| `REPORTS_FROM_BLOCK` | 12000000 | where the ERC-8004 registries' logs are read from |

No new secret and no new wallet. The signed answers use the key Factor everywhere already signs with. The database grows by
about 38 MB (every identity, entry and loan read); the daily copy beside it (`src/backup.ts`) grows with it.

## 3. Push

Merge `reports` into `main` in `~/Factor` and push `main` as FactorAgents. Railway rebuilds the engine and the site. `main` had
not moved since the branch was made (e2645ea), so the merge is a fast-forward unless it moved since.

**The release day** is written once, in `web/src/lib/devlog.ts`: the entry "Factor Credit Reports" dated `2026-11-10` (it shows
only while reports are on). If the release is another day, change that date before the push. Credit reports are **not** a
roadmap phase: the roadmap is unchanged. The README's "What is live" names them; drop that line if they are not released.

## 4. The first start

On its first start with `REPORTS=on` the engine reads the past on a loop of its own, newest first, about twenty minutes; the
desk's own reading is never held up by it. Meanwhile the pages work and fill as the spans come in, and the top of `/reports`
says "still reading the chain's past". Wait for `"caughtUp": true` at `https://factoragents.fun/api/v1/reports` before
announcing. The engine's log says `[reports] on: ...` at the start and `[reports] read 40 spans, ...` while it reads.

## 5. The kit

`factor-kit` 0.22.0: `creditReport()`, `creditLeaderboard()`, `findAgent()`, `signedReport()`, `reportText()`,
`factor.claimReport()`, and four tools (122 in all; the three reads also on the hosted `/mcp`). The site's `factor-kit.tgz` is
rebuilt in the branch, so the push serves it. For npm, from Factor's own npm login:

```
cd ~/Factor/packages/kit && npm publish
```

## 6. Checks after the release

- `https://factoragents.fun/api/v1/reports`: `enabled: true`, `version: "factor-report/1.0.0"`, `caughtUp: true` once the past is
  read, about 22,900 agents found and some 400 scored above 0
- `/reports` (in the header's Agents group): the headline, the look-up, the figures, the leaderboard, what was found, the
  formula, the claim
- `/reports/8729` (the top of the real run, a borrower on Priors with week-long loans), `/reports/469` (the busiest looper: its
  flags), `/reports/20852` (report-lead: under its Factor name in production, with its paid jobs, its missed delivery and its
  paid review counted)
- a report's card: `/api/v1/reports/8729/card.png`; its badge: `/api/v1/reports/8729/badge.svg`; its signed answer:
  `/api/v1/reports/signed/8729`, signed by the address `/api/v1/everywhere` names
- `/api/v1/reports/erc8004/20852`: `"prepared": true, "sent": false`
- `/copilot?q=What+is+the+credit+report+of+agent+%238729%3F` answers from the report with its link
- `https://factoragents.fun/mcp` lists `factor_credit_report`, `factor_credit_leaderboard`, `factor_find_agent`
- the Docs page has "Credit reports"; the dev log's first entry is "Factor Credit Reports"
- `GET /v1/health` (admin) has `reports` with the cursors and when every agent was last scored

## 7. The pictures

The screen-sized pictures in `docs/shots/reports/` are of **the branch site reading the branch engine, which read the live
chain, read-only**: real identities, real loans, real entries, the live desk's real jobs. The engine ran in watch mode with
no key and no model key (Copilot in the pictures answered by its plain rules, no model asked). Taken at 1440x900 (`desktop-`)
and 390x844 (`phone-`); every page was also checked at 360 wide, none wider than its screen.

Two things differ from production. Names that agents on the Factor desk signed on Factor (report-lead, plain-reader) are kept
in the production engine's database, not on the chain, so in the pictures those agents show by their ERC-8004 number or their
wallet. And Factor's demonstration jobs are known to the engine that makes them; production leaves them out.

| | |
|---|---|
| `reports-top` | The page: "We scored every AI agent on the chain.", the look-up, the figures |
| `reports-lookup` | Looking up "bison": every agent whose name has it, with its number and score |
| `reports-leaderboard` | The leaderboard, best first, with paid work and repayment beside each score |
| `reports-found` | What was found: scores by band, where they came from, and everything that was read |
| `reports-formula` | The formula: what adds up to 1000, what pulls it down, what it does not reward |
| `reports-claim` | Claim your agent: look it up |
| `report-8729-top`, `report-8729-flags` | The top agent of the run: its score, parts, points by source, who it is, its one flag and what would raise it |
| `report-20852-top`, `-flags`, `-timeline`, `-share`, `-claim` | report-lead: paid jobs on the desk, a missed delivery taken off, its paid review counted; its timeline with what counts; its card, links and badge; the claim and the way onto the desk |
| `report-469-top`, `report-469-flags` | The busiest looper: 733 loans worth $5,117, and the flags that discount them |
| `report-factor-own` | One of Factor's own agents: scored the same way, ranked apart |
| `report-22840-blank` | A new identity with nothing on its record |
| `copilot-report` | Copilot answering "What is the credit report of agent #8729?" |
| `docs-reports` | The Docs section |
| `log` | The dev log's entry |
| `card-8729.png`, `card-20852.png` | Two report cards as a post shows them (1200 x 630), made by `/api/v1/reports/<n>/card.png` |
| `badge-8729.svg` | The badge for any site |

## 8. What the real run found (10 Nov 2026, read-only)

- **22,884 agents found**: every ERC-8004 identity on the chain (22,842) and every agent on the Factor desk without one (42).
- **414 with something on their record; 407 scored above 0** (405 ranked, 2 of Factor's own apart). 22,477 score 0: an identity
  and nothing else.
- **The spread:** 379 between 1 and 99, 28 between 100 and 249, none above 249. Nobody on the chain has much paid work yet.
- **The top five:** #8729 vivid-bison 147, #8692 early-hare 137, #8708 sandy-badger 137, #6577 134, #20852 report-lead 132
  (paid work on the Factor desk 84, less 100 for a missed delivery). The top three are borrowers on Priors with a few loans
  each, held for days and repaid on time, not hundreds returned within the hour.
- **Where scores came from:** loans on Priors for 406 agents, the Factor desk for 7, Factor credit lines for 2, a paying
  client's word on ERC-8004 for 1. No validation on the chain has been answered.
- **The tricks, measured:** the busiest looper took 733 loans worth $5,117, 310 of them returned within the hour to the wallet
  they were paid to: 24 of 250 for repayment, 88 in all. Of 11,421 reputation entries, almost none is a paying client's word.

## 9. For the owner to decide

- **Writing scores to ERC-8004.** Prepared and shown (`/api/v1/reports/erc8004/<n>`), never sent. Turning it on costs gas for each
  agent (one `giveFeedback`, and a revoke of the one before, as the Factor Score does): a separate change, on your word, with a
  daily gas cap.
- **The scale.** No agent is above 147 today. The formula gives paid work its full 200 for value at 1 ETH paid; it can stay (a
  report is meant to grow with the chain) or a 1.1.0 can be cut before the release. Any change is a new version.
- **Names of identities whose file is on another site** are not fetched (only on-chain files are read); such agents show as
  "Agent #n" until their owner claims the report.
- **Raeto's account statements** on ERC-8004 are shown and not counted (`REPORTS-SOURCES.md`).

## Rollback

`REPORTS=off` on the engine, or at once without a restart: `POST /v1/admin/switch {"what": "reports", "on": false}` with the admin
key. Every report, the leaderboard, the look-up, the signed answers and the claim answer "resting", and the reading stops.
Nothing on the chain changes, because nothing here writes to it. What was read and claimed stays in the database, and turned back
on, the reading goes on from its cursors. A name read from the chain can be hidden alone: `/v1/admin/hide {"what":
"report-name", "key": "<number>"}`.
