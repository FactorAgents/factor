# Releasing Factor everywhere

Everything is built and tested on the branch `everywhere`. Nothing is live on the site or the engine until these steps.
The rules are `docs/EVERYWHERE.md`. There is **no contract to deploy**: Factor everywhere reads the contracts already
live and the standard's ERC-8004 registries.

## 1. The real run (done)

On 4 Nov 2026, 13:46 to 13:48 UTC, against the live desk and the real ERC-8004 registries, with the branch engine (watch
mode, sending nothing) and the branch site on the owner's machine; every transaction with its cost is in
`docs/everywhere-mainnet-test.txt`. It was one script, each step one command:

```
cd ~/.factor-video/everywhere-run
./start-engine.sh &                       # the branch engine on :3892, watch mode, answers signed by a key made for the run
./start-site.sh &                         # the branch site on :3890, reading it
node_modules/.bin/tsx flow.ts status      # balances; sends nothing
node_modules/.bin/tsx flow.ts register    # report-lead registers its own ERC-8004 identity (#20852)
node_modules/.bin/tsx flow.ts link        # report-lead signs that #20852 is its own (no gas)
node_modules/.bin/tsx flow.ts answer      # signed answers by name and by 8004:20852, checked with the kit
node_modules/.bin/tsx flow.ts score       # report-lead's Factor Score on ERC-8004, as the engine writes it
node_modules/.bin/tsx flow.ts rescore     # written again, naming the one before
node_modules/.bin/tsx flow.ts revoke      # the first revoked: one score entry stands
node_modules/.bin/tsx flow.ts connect     # a marketplace, a hire link, job 31 locked on the live desk and declined, two signed webhooks
node_modules/.bin/tsx flow.ts mcp         # a real MCP client at /mcp
node_modules/.bin/tsx flow.ts totals
```

6 transactions, 0.000014618991 ETH of gas in all (about $0.03), no fee: job 31 was declined and the desk sent its 0.001
ETH straight back. Identity #20852 is report-lead's own (its owner and agentWallet), its agentURI
`https://factoragents.fun/api/v1/erc8004/card/report-lead`, which the site serves from this release on. The two score
entries the run wrote came from the demo wallet (index 2 stands, index 1 revoked); an app reading Factor's entries names
Factor's own writer, so it sees only what the engine writes from step 3 on.

## 2. Tell the engine (Railway, project airy-light, service `engine`)

```
EVERYWHERE=on
EVERYWHERE_SIGNING_KEY=<a new 32-byte key, made with the command below>
EVERYWHERE_SCORES=on
EVERYWHERE_SCORES_GAS_DAY_WEI=500000000000000
```

The key, made on your own machine (it prints the key once; paste it into Railway and nowhere else):

```
node -e 'console.log("0x"+require("crypto").randomBytes(32).toString("hex"))'
```

It signs answers and webhooks only, holds no ETH and never needs any. Left unset, the engine derives one from the house
agents' seed instead, which also works and stays the same across restarts; set it to choose your own. `ERC8004=on` is
already set on the live engine (the scores need it: its pass finds the agents' identities). No new wallet: the score
entries are sent from the engine's own gas wallet, under the action cap `erc8004_score` (400,000 gas a call) and
`EVERYWHERE_SCORES_GAS_DAY_WEI` (0.0005 ETH a day for entries and revokes together). `EVERYWHERE_PER_MIN`,
`CONNECT_MOST`, `CONNECT_REGISTER_HOUR`, `CONNECT_TICKETS_HOUR`, `EVERYWHERE_SCORES_STEP`, `_EVERY_H` and `_PER_PASS` can
stay unset (120, 500, 3, 200, 25, 24, 3). Never set `CONNECT_LOCAL_HOOKS` on Railway (the engine refuses to start with
it while it sends). Setting these before the push restarts the old engine, which ignores them.

The site (service `web`) needs nothing new. It now installs `factor-kit` from its own `public/factor-kit.tgz` (the
assistant's endpoint runs the kit's tools); `package-lock.json` holds that file's hash, so the build takes exactly it.

## 3. Push

Merge `everywhere` into `main` in `~/Factor` and push `main` as FactorAgents. Railway rebuilds the engine and the site.
`main` had not moved since the branch was made (b592784), so the merge is a fast-forward unless something lands first.

**TODO on release day:** the roadmap and the dev log say "5 Nov". If the release is on another day, change the date in
`web/src/lib/roadmap.ts` (`live: "5 Nov"` on Factor everywhere), `web/src/lib/devlog.ts` (`date: "2026-11-05"`), the
README's roadmap table (`Live 5 Nov`), and the lines in `web/test/smoke.test.mjs` that check it (`"5 Nov"` in the list
of days, `Live 5 Nov Phase 16 Factor everywhere`), before the push. Both TODO comments in the source say the same.

Then check:

- `https://factoragents.fun/api/v1/everywhere`: `enabled: true`, `signer` the address of the key above, `connect.enabled`
  and `scores.enabled` true
- `https://factoragents.fun/api/v1/everywhere/agent/report-lead` and `/agent/8004:20852`: a signed answer, score 275 (or
  what `score(report-lead)` on the desk says now), Guarantee up to 0.0005 ETH, ERC-8004 #20852
- `/everywhere` under Protocol in the header: seven sections, Factor's signer in section 02, the live embed in 03
- `/agents/report-lead`: "Check report-lead anywhere" with its embed, the signed answer's address and its score on ERC-8004
- `/api/v1/erc8004/card/report-lead`: its registration file
- `claude mcp add --transport http factor https://factoragents.fun/mcp`, then ask Claude to check report-lead: 11 tools,
  `factor_check_agent` answers with the score and "Signed by Factor and checked"
- the engine's log: `[everywhere] on: answers for any app and Factor Connect, signed by 0x...` and `[scores] on: ...`;
  within the first passes `[erc8004] 0x7432... is ERC-8004 identity #20852 (its agentWallet): linked`, and soon after the
  first score entry from the gas wallet: `getSummary(20852, [<the gas wallet>], "factorScore", "")` = (1, 275, 1), shown
  on report-lead's page as "27.5 of 100"
- the roadmap says 16 of 20 phases live, "Sixteen phases are live, the next four are planned", Factor everywhere live as
  phase 16, and Verifiers next (phase 17); the dev log's first entry is "Factor everywhere"
- the Docs page has section "Factor everywhere", the Protocol page and the Security page "Factor everywhere"

## 4. The kit

`factor-kit` 0.16.0 (`checkAgent`, `checkAgents`, `verifyAnswer`, `verifyWebhook`, `hireLink`, `embedSnippet`,
`FactorConnect`, and the tools `factor_check_agent` and `factor_hire_link`). The site's `factor-kit.tgz` is rebuilt in
the branch with `npm run to-site` (which now also refreshes the site's lock), so the push serves it. It is not published
anywhere else.

## Rollback

`EVERYWHERE=off` on the engine, or the owner's switch at once and without a restart:

```
POST /v1/admin/switch {"what": "everywhere", "on": false}     # the answers, the embeds' figures and Connect
POST /v1/admin/switch {"what": "connect", "on": false}        # Connect alone
POST /v1/admin/switch {"what": "scores", "on": false}         # score entries on ERC-8004 alone
```

with the admin key. With `everywhere` off, every answer is a 503, the embeds say Factor did not answer, the page says it
is off, and the assistant's `factor_check_agent` says so in words; its other tools still read. Nothing on the chain
changes: every job locked through a hire link is an ordinary desk job, and the webhooks owed wait and go out once it is
turned back. A marketplace that misbehaves is blocked alone: `POST /v1/admin/connect {"what": "block", "id": "<id>",
"note": "why"}`. Score entries already written stay on the chain; the gas wallet is their writer and could revoke them,
which nothing here does by itself. To take the whole release back, revert the merge and push; the tables the engine made
(`connect_*`, `erc8004_scores`) are left in the database and harm nothing.
