# HEY builder records

HEY Research Lab (heyresearch.xyz) is the public record of building on Robinhood Chain: what each team shipped, with its
source. Factor shows HEY's builder record of a project where it helps someone decide: HEY's badge for Factor itself in the
site's footer, the record of an agent's maker's project on the agent's page, and an answer to "is the team behind X
shipping?" in Copilot, Ask Factor, the kit and any assistant through `factor_builder_record`.

There is **no new contract**, nothing on the chain, and no money moves. HEY's API needs no key and costs nothing.

| | |
|---|---|
| `engine/src/hey.ts` | The client for HEY's API, a builder record put together from HEY's answers, an agent's link to a project, the switch |
| `engine/src/api.ts` | `GET /v1/hey`, `/v1/hey/record?q=`, `/v1/hey/agent/<id>`, `POST /v1/hey/link`; `hey` in `/v1/state` and the owner's health answer; Ask's builder line |
| `engine/src/copilot.ts` | The `builder` intent: "is the team behind X shipping?", answered by code from HEY's record, with the source |
| `web/src/components/Hey.tsx` | The section on an agent's page, and the owner's link form |
| `web/src/components/Footer.tsx` | HEY's badge for Factor: "This team ships" |
| `web/src/lib/hey.ts` | The words an owner signs, the same as the engine checks |
| `packages/kit/src/hey.ts` | `builderRecord`, `agentBuilder`, `builderRecordText`, `factor.linkHey`, and the tool `factor_builder_record` |
| `engine/scripts/hey-live.ts` | A read-only check against HEY's real API (`npm run hey-live` in `engine/`) |

## 1. What HEY agreed, and how the code holds to it

| HEY's rule | In the code |
|---|---|
| Factor may show HEY's Verified Builder badge, worded as "this team ships", never as HEY rating agents | The footer shows HEY's own badge image for Factor, from `https://heyresearch.xyz/api/badge/factor` (the dark one in the dark theme, HEY's default in the light one), linked to `https://heyresearch.xyz/project/factor?utm_source=badge&utm_medium=html`, exactly as HEY's badge page gives it, beside the words "This team ships." On an agent's page the words are "Builder record on HEY" and "The team behind it ships", only when HEY marks the linked project a Verified Builder; nothing says HEY rated the agent. |
| Factor's MCP, Copilot and Ask Factor may call HEY's API and cite the builder record | Every record carries `sourceUrl` (the project's page on HEY), and every answer in words ends with "Source: <that page>". Copilot's reply carries `source: { name: "HEY Research Lab", url, readAt }` and the site links it. |
| Every call to HEY sends `x-hey-integration: factor/<version>` | The one client that calls HEY (`HeyClient` in `engine/src/hey.ts`) sets it on every request: `factor/` and the engine's own version from `engine/package.json` (`factor/0.1.0` today). The kit and the site never call HEY's API: they read Factor's API, and the engine asks HEY. The tests check the header on every one of their requests, and `npm run hey-live` prints it for each real one. |
| HEY never shows scores or third-party ratings; Factor must not turn HEY data into a score, must not change the Factor Score with it, and presents it as HEY's builder record with a link to the source | A record carries HEY's facts under HEY's own names (`verified_builder`, `hey_status`, `meaningful_ships_30d`, ...), values unchanged. No market figure (price, valuation, liquidity, volume, market status) and none of HEY's computed figures (Build Momentum, Discovery Gap, rank, signals) is read into a record. Nothing in `factorscore.ts`, `score.ts` or any limit reads a record or a link; a test checks an agent's score, record and limit are the same before and after a link. Ask adds the builder line after the agents are picked, and a test checks the order and the reasons do not move. |

## 2. Reading HEY

Base `https://heyresearch.xyz/api` (`HEY_API_URL`). A builder record for one project is put together from up to three of
HEY's answers:

1. Which project. A 0x contract: `GET /api/contracts/4663/<address>`, whose `associatedProject` names it (a contract HEY
   holds no record of, or ties to no project, is "not on HEY"). A HEY page (`heyresearch.xyz/project/<slug>`): the slug.
   Words or a `$TICKER`: `GET /api/search/suggest?q=`, and the one project whose name, symbol or slug is exactly the
   words; several of one name are "say which" with the candidates, none is "not on HEY" with HEY's suggestions.
2. `GET /api/projects/<slug>/snapshot`: the project's identity and, for a project with no token, its facts.
3. For a project with a token on Robinhood Chain, HEY's builder card `GET /api/v1/builder?chain=4663&token=<token>`,
   whose fields are the record's facts word for word.

| Fact (HEY's name) | From the builder card | From the snapshot (no token) |
|---|---|---|
| `verified_builder` | `verified_builder` | `identity.researchLevel === "VERIFIED_BUILDER"` |
| `research_level` | `research_level` | `identity.researchLevel` |
| `hey_status`, `hey_status_label`, `hey_status_help` | the same | `build.activityStatus`; the label as HEY's pages say it (Shipping, Active, Resumed, Quiet, Dormant, Unknown); no help |
| `last_activity_at` | the same | `build.lastShippedAt` |
| `meaningful_ships_30d` | the same | `evidenceSummary.meaningfulEvents30d` |
| `latest_meaningful_ship` | the same | the newest of `latestChanges.items` that `countsAsBuilding` |
| `latest_change` | its summary, time, precision, evidence id and link | the newest of `latestChanges.items` |
| `latest_release`, `latest_deployment`, `repo_url`, `token_verification`, `as_of` | the same | none of the first three; `verification.token.status`; `asOf` |
| `disclaimer` | HEY's, word for word | none: the snapshot's own is about figures a record does not carry |

**Politely.** An answer is kept `HEY_CACHE_S` (600 s; HEY caches 60 s on its side); a not-found or a refusal for two
minutes, so a project HEY publishes later shows soon. The same request asked twice at once is one call. The engine makes
`HEY_PER_MIN` (60) calls a minute at most, half of HEY's 120 for a caller without a key. A 429 is waited out for as long
as its `retry-after` says (30 s when it says nothing, five minutes at most). A call is dropped after `HEY_TIMEOUT_S` (8 s).

**When HEY is down.** A 5xx, a timeout, a refusal to connect, or the limit: the last answer kept, if it is under a day old,
is given and marked `stale: true` with its time ("an earlier reading: HEY could not be reached just now"). With none, the
answer is `{ found: false, away: true, why }`. Nothing else on Factor waits for HEY: the agent page's record is read when
the page is, and an answer kept from before is given at once.

**A key.** `HEY_API_KEY`, when set, is sent as `authorization: Bearer <key>` (HEY's free key "names you" and carries a
monthly allowance). It is optional: everything works without one. It is read when a call is made and never logged, stored
or returned (the health answer says only `keyed: true`).

## 3. An agent's link to its maker's project

The owner of an agent, the same wallets that sign its auto-apply rules and verify its owner (the agent's own wallet; the
maker of an agent made on the site; Factor's admin wallet for Factor's own agents; an account through one of its keys),
signs:

```
Factor: link an agent to its maker's project on HEY
agent: <the agent's address>
project: <a HEY slug, a 0x contract, or none>
at: <seconds>
```

and sends it to `POST /v1/hey/link { agent, by, project, at, signature }`. The engine checks the switch, that the agent is
on the desk, that `by` runs it, the time (ten minutes either way), the signature (a wallet's, or an account's through
ERC-1271), that it is newer than the last one taken for the agent, and then asks HEY: only a project HEY has published can
be linked (a contract must be one HEY ties to a project). It keeps the slug, the name, the contract it was named by (when it
was named by one), who signed, and when. `none` unlinks. Writes from one address: six a minute.

The link is the owner's word that this is its maker's project: the page says who linked it and when. What HEY says of
the project is HEY's; a link says nothing about who owns that project on HEY.

## 4. The API

```
GET  /api/v1/hey                   { enabled, source, site, project, badge, integration, keptS, words }
GET  /api/v1/hey/record?q=<words>  a builder record: { found: true, sourceUrl, badgeUrl, project, facts, disclaimer, read,
                                   readAt, stale, from, integration } or { found: false, why, away?, candidates? }
GET  /api/v1/hey/agent/<id>        { enabled, agent, link, record, owners }
POST /api/v1/hey/link              { agent, by, project, at, signature }
```

`/v1/state` carries `hey: { enabled, project, badge }`. With `HEY=off` (or the switch), every read answers
`{ enabled: false }`, the link answers 503, HEY is asked nothing, and the site shows nothing of HEY anywhere.

## 5. Where it is

- **The footer**, on every page: HEY's badge for Factor and "This team ships. HEY Research Lab, the public record of
  building on Robinhood Chain, keeps Factor's builder record: every ship with its source." It is the one image a page
  loads from another site; the content policy allows `img-src https://heyresearch.xyz` and nothing else of HEY's.
- **An agent's page**: when its owner linked a project, "Builder record on HEY" (and the mark beside its name when HEY
  marks the project a Verified Builder): the project, HEY's status, the meaningful ships in 30 days, the latest ship with
  its evidence, the code as HEY has it, when it was read, HEY's disclaimer, the link to the record on HEY, and who linked
  it. For the wallet that runs it, the form to link, change or unlink. Anybody else sees nothing while there is no link.
- **Factor Copilot**: "is the team behind X shipping?", "who builds $TICKER?", "builder record of 0x...", "what does HEY say
  about X?", or the same about an agent on the desk (its linked project). Answered by code from HEY's record, never by a
  model's words, with the source. With no name it asks which.
- **Ask Factor**: a picked agent with a link carries `builder: { project, status, verifiedBuilder, sourceUrl }`, shown on
  its card with the link to HEY. It is added after the picks and never changes the order.
- **The kit** (factor-kit 0.20.0): `builderRecord(q)`, `agentBuilder(agent)`, `builderRecordText(r)`,
  `factor.linkHey(project)`, and the tool `factor_builder_record`, also on `/mcp`.
- **The docs page** "HEY builder records", the Security page, and the dev log.

## 6. What HEY's API could not give

- **No "builder record by name" in one call.** HEY's partner card (`/api/v1/builder`) is keyed by a token contract. A name
  or a ticker is found through `search/suggest` first, and a project with no token is read from its snapshot, whose facts
  have no `hey_status_label` or `hey_status_help` (the label is HEY's own wording of the status code), no release,
  deployment or repository line.
- **A contract that is not a token.** The partner card refuses it (400, "not a token identity"); `contracts/4663/<address>`
  names its project when HEY ties one to it, and the record is then read by that project's slug.
- **Who owns a project on HEY.** HEY does not say which wallet runs a project, so Factor cannot check that an agent's owner
  is the team behind the project it links. The link is shown as the owner's word, with who signed it and when.
- **The badge for an agent.** HEY's badges are for a project's own site. An agent's page shows HEY's facts as text with
  the link, not HEY's badge for another project.
- **Webhooks** need a key; nothing here needs to be pushed (records are read when asked and kept ten minutes).

## 7. What the owner can change

| | |
|---|---|
| `HEY=on` | Builder records are read and shown. Off unless it is said |
| `HEY_API_KEY` | HEY's free key, sent as a bearer token. Optional |
| `HEY_CACHE_S` | How long an answer is kept (600; 60 to 86,400) |
| `HEY_PER_MIN` | The most calls to HEY a minute (60; 1 to 120) |
| `HEY_TIMEOUT_S` | How long one call may take (8) |
| `HEY_API_URL` | HEY's API, for a test against a stand-in (`https://heyresearch.xyz/api`) |
| The owner's switch `hey` | `POST /v1/admin/switch {"what": "hey", "on": false}`: stops at once without a restart; HEY is asked nothing and nothing shows |

Rollback: `HEY=off` or the switch. The links stay in the engine's database (`hey_links`), unseen until it is on again.
