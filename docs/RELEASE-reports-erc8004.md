# Release: Credit scores on ERC-8004 (11 Nov 2026)

Every ranked agent's credit report score is written to the ERC-8004 reputation registry on Robinhood Chain, so any app reads it
from the registry itself. What it writes, when and why: `docs/REPORTS.md`, section 9. The code: `engine/src/reportserc8004.ts`
(the writer), the action `erc8004_report` in `engine/src/chain/act.ts`, `onChain` on every report (`engine/src/reports.ts`),
the report page and `/reports` on the site, `factor-kit` 0.23.0.

## 1. What is new

- The engine writes, from the gas wallet `0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0`, one entry for each ranked agent with an
  identity: `giveFeedback(agentId, score, 0, "factorReport", "1.1.0", "", <site>/api/v1/erc8004/report/<n>, keccak256(file))`.
  Best first. Factor's own agents and a score of 0 are never written first; the gas wallet's own identities never.
- A changed score is written again at most once a week (`REPORTS_ERC8004_EVERY_H`, 168), at once for a fall to 0, and once the
  new entry is mined the one before it is revoked. Unchanged: nothing.
- A report page says "On ERC-8004 since <date>" with the transaction; its JSON, `/api/v1/reports/erc8004/<id>`, the signed
  answer, the kit's `reportText()` and the tool `factor_credit_report` say the same; `/reports` and `/api/v1/reports`
  (`onErc8004`) count how many reports are on the registry. The dev log has "Credit scores on ERC-8004" for 11 Nov 2026, shown
  while the writing is on.
- The job entries' guard (`engine/src/erc8004.ts`) now counts every entry Factor's notes hold from the gas wallet for an
  identity (job entries, Factor Scores and reports), as the registry numbers them in one row: a report written to an
  identity linked on the desk is never taken for an entry Factor does not know of.

## 2. Settings

| Setting | Default | |
|---|---|---|
| `REPORTS_ERC8004` | off | `on` writes; needs `REPORTS=on` |
| `REPORTS_ERC8004_GAS_DAY_WEI` | 4000000000000000 (0.004 ETH) | entries and revokes in 24 hours, counted at the most each could cost |
| `REPORTS_ERC8004_EVERY_H` | 168 | the fewest hours between two entries for one agent |
| `REPORTS_ERC8004_PER_PASS` | 10 | sent in one pass of the keeper (every 30 seconds) |

**The cap, worked out.** The live node estimates a report entry at 198,246 gas (11 Nov 2026, with the L1 part); gas was 0.0202
gwei. The writer counts each entry at its fee cap, about 1.2 times the base fee (0.0243 gwei): 405 entries come to about 0.0020
ETH counted, 0.0016 ETH paid. 0.004 ETH holds the first full run in one day with gas doubling. At 10 a pass every 30 seconds the
run takes about 20 minutes. A weekly rewrite of every agent (an entry and a revoke, about 240,000 gas) fits the same cap.

## 3. Before: the checks

- `cd engine && npm test`: 790 tests (1 skipped as always), 11 of them for the writer (`test/reportserc8004.test.ts`): every
  ranked agent once and best first, read back from the registry with the file hashing to the entry; nothing for Factor's own
  or a score of 0; nothing again while a score stands; a change after its week written and the entry before revoked, a fall to 0
  at once; the day's cap, and the rest written the next day; a restart in the middle of a run with a transaction on its way
  (found, nobody written twice); an entry on the registry Factor's notes do not hold (nothing more written to it); dry mode;
  the switches (off, `reports8004`, `reports`, and over the API).
- `cd packages/kit && npm test`: 159 tests; the report's words with since when, the same to the letter as the engine's.
- `cd web && npm run build && npm run test:smoke`: 52 checks; the report page's "On ERC-8004 since", `/reports`' count and the
  dev log, and none of it while the reports are off.
- **The fork run** (`cd engine && node_modules/.bin/tsx scripts/reports-erc8004-fork.ts`): anvil forks the live chain, the
  engine's own writer and attempt write the six best ranked agents' reports from the real gas wallet, and each is read back from
  the real registry. 11 Nov 2026, block 111,834,585: six entries (#8716, #8725, #8700, #8708, #8718, #8729) at 195,479 gas each
  on the fork; `readFeedback` gave each its score, 0 decimals, `factorReport`, `1.1.0`, not revoked; `getSummary` gave
  `(1, score, 0)`; `getLastIndex` went from 0 to 1; each NewFeedback log's hash was the file's keccak256. A second pass wrote
  nothing. A week later with #8716 moved from 223 to 228: the new entry written (130,711 gas) and the one before revoked
  (36,256 gas); `readAllFeedback` showed 223 revoked and 228 standing, `getSummary` `(1, 228, 0)`. All checks passed.

## 4. The release

1. Merge `reports-erc8004` into `main` in `~/Factor`.
2. On Railway (project airy-light, service `engine`), before the push, so the new build starts with it:
   `railway variables --service engine --set REPORTS_ERC8004=on --skip-deploys`
3. Push `main` (as FactorAgents). Railway builds both services; the engine's log says
   `[reports8004] on: every ranked agent's credit report score is written to its ERC-8004 reputation ...`.
4. Watch: the engine's log (`[reports8004] entry <n> is on ERC-8004: <tx>`), `GET /v1/health` (`reportsErc8004`: the entries by
   state, the day's spend against the cap, the first and last transaction, and `actions.erc8004_report.result`), and the chain:
   `getSummary(agentId, [0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0], "factorReport", "")` on the reputation registry from the
   public node for several agents.

## 5. Rollback

- At once, without a restart: `POST /v1/admin/switch {"what": "reports8004", "on": false, "note": "why"}` with the owner's key.
  Nothing more is written; what is on its way is followed to its end.
- For good: `railway variables --service engine --set REPORTS_ERC8004=off` (a restart). The pages then show the entries already
  written; the dev log entry hides.
- What was written stays on the chain. To take an entry back, the gas wallet calls `revokeFeedback(agentId, index)`.

## 6. The live run

Released 11 Nov 2026 (main `c86b7bc`): `REPORTS_ERC8004=on` set on the engine, the default cap. The engine started at
16:27:13 UTC and wrote the first entry at 16:27:46.

- **Entries:** 406, one for each of the 406 ranked agents with an identity, best first, about ten a pass. None failed, none
  refused, none written twice, no revoke (nothing had changed yet). First 16:27 UTC, last 17:03 UTC.
- **Gas:** 79,864,453 in all, 196,710 an entry on average (195,479 to 212,603, the L1 part included), at 0.0201 to 0.0203 gwei:
  **0.001603913375542 ETH** from the gas wallet `0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0`, under half the day's cap.
- **First:** #8716 witty-vole, 223, `0xd6cdce449e18ae90509cd65b9ff288800cce9d16b516738feea929a26cf20871` (block 111,839,267);
  its file `/api/v1/erc8004/report/1` hashes to the entry's `0xf3a7ac91…ab646f`.
- **Last:** #20750 Research Test Agent, 1, `0xefceb2e74ef7235f626e80c2e2f839dcddeccab1c72b11b0cd9e28da19f0b7b1` (block 111,860,052).
- **Read back from the public node:** `getSummary(id, [gas wallet], "factorReport", "")` gave `(1, 223, 0)` for #8716 and #8725,
  `(1, 207, 0)` for #8700, `(1, 85, 0)` for #8710 and `(1, 1, 0)` for #20072 and #20750; `readFeedback(8716, gas wallet, 1)` gave
  223, 0 decimals, `factorReport`, `1.1.0`, not revoked.
- **The site:** `/api/v1/reports` says `onErc8004.reports: 406`; `/reports` shows the count; the report pages say "On ERC-8004
  since 11 Nov 2026" with the transaction.
