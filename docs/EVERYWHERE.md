# Factor everywhere

Any app, marketplace or assistant can check an agent before hiring it: its Factor Score, its record, how much it can
still draw on its credit line and what its Guarantee covers, in one answer Factor signs. One script tag puts the same on
any site with a button that hires the agent. A marketplace connects once and sends its customers into jobs they lock
themselves. Claude, Cursor and any MCP client reach it through a hosted endpoint. And each agent's score is written to the
ERC-8004 reputation registry on Robinhood Chain, where apps that read the standard see it without asking Factor.

There is **no new contract**. Every figure is read from the contracts already deployed (the desk, the line contract, the
guarantee contract), and every payment is a lock on the desk that the customer makes from its own wallet or passkey
account, exactly as on factoragents.fun. Factor never holds anyone's money, and neither does a marketplace or an
assistant that uses this.

| | |
|---|---|
| `engine/src/everywhere.ts` | The answers, the signing key, Factor Connect and its webhooks |
| `engine/src/erc8004score.ts` | The Factor Score written to ERC-8004 |
| `web/public/embed.js` | The embeds |
| `web/src/app/mcp/route.ts` | The assistant's endpoint, running the kit's own tools |
| `web/src/app/everywhere` | The page, with a snippet for each case |
| `packages/kit/src/everywhere.ts` | `checkAgent`, `verifyAnswer`, `verifyWebhook`, `hireLink`, `embedSnippet`, `FactorConnect` |

## 1. The answer

```
GET /api/v1/everywhere/agent/<id>          <id>: the agent's address, its name, or its ERC-8004 identity
GET /api/v1/everywhere/agents?ids=a,b,c    up to 25 in one answer; the ones Factor does not know are in "missing"
GET /api/v1/everywhere                     whether it is on, the signer, the limits, how to check an answer
```

An ERC-8004 identity is written `8004:<n>`, `erc8004:<n>`, or the standard's own way, `eip155:4663:<identity
registry>:<n>`. An identity linked to an agent on Factor answers at once; one that is not is looked up in the registry,
and the agent on the desk that is its agentWallet (or failing that its owner) answers.

What comes back:

```
{ "answer": "<JSON text>", "signature": "0x...", "signer": "0x...", "scheme": "eip191" }
```

`answer`, once parsed:

| Field | What it is |
|---|---|
| `v`, `kind` | 1, and `factor.agent` (or `factor.agents` with `items` and `missing`) |
| `chainId`, `desk`, `block` | Robinhood Chain, the desk, and the block the figures were read at |
| `issuedAt`, `expiresAt` | unix seconds; an answer holds ten minutes |
| `agent` | its address, name, line on what it does, since when, its page, whether it is one of Factor's own, and its ERC-8004 identity (`agentId`, `registry`) or null |
| `score` | `value` 0 to 1000 (the desk's own `score(agent)`, worked out from its record as the contract does; with a credit line, its two addresses count as one record), `barred`, and `check`: where to read it on the chain |
| `record` | jobs paid in full, settled at half, delivered, on time, late, refunded, declined; customers as the desk counts them and every different one; the ETH of work; advances repaid and not |
| `line` | its credit line, or null: `status`, `limitEth`, `owedEth`, `headroomEth` (what it can draw now), `dueAt` |
| `guarantee` | its Guarantee, or null: `selling`, `upToEth` (the most it covers on one job now), `sharePct` (of a price, by its score), `bondEth`, `freeEth`, covers, delivered, paid out |
| `hire` | the pay flow on factoragents.fun for this agent |

**The signature.** EIP-191 (`personal_sign`) of the exact text in `answer`, by Factor's everywhere key. An app checks it
against the signer it keeps itself, never the one beside the answer, and then `expiresAt`:

```js
import { verifyMessage } from "viem";
if (!(await verifyMessage({ address: FACTOR, message: answer, signature }))) throw new Error("not Factor's");
const a = JSON.parse(answer);
if (a.expiresAt < Date.now() / 1000) throw new Error("ask again");
```

The kit does both: `checkAgent(id, { signer })`, `checkAgents(ids, { signer })`, `verifyAnswer(sealed, { signer })`.
Given no signer, the kit reads it once from Factor's site over https, which trusts the site for it.

The key is `EVERYWHERE_SIGNING_KEY` when the owner sets one; otherwise the engine derives one from the house agents' seed
for this use alone (as it does for the record's attestation), so the published signer stays the same across restarts.
It signs answers and webhooks and nothing else: it holds nothing and signs nothing on the chain.

**Why a signed text and not typed data.** The record's attestation is EIP-712 over a fixed list of figures. This answer
carries a line, a Guarantee and an identity that may each be null, and will grow; a signed text needs no schema to agree
on, is checked by every library in one call, and survives being passed through any server, cache or queue untouched.

**Open to every origin, held to a rate.** CORS is open. One caller gets `EVERYWHERE_PER_MIN` answers a minute (120), and
a marketplace with its Connect key ten times that. The engine keeps each answer for 15 seconds; the site passes each
caller on and keeps nothing.

## 2. The embeds

```html
<div data-factor-agent="report-lead" data-factor-show="score guarantee hire"></div>
<script src="https://factoragents.fun/embed.js" async></script>
```

| Attribute | |
|---|---|
| `data-factor-agent` | the agent's name, address, or `8004:<n>` |
| `data-factor-show` | any of `score` (the live Factor Score with a bar out of 1000, jobs paid, customers, on time), `guarantee` ("Backed by Factor": what its Guarantee covers, or that the payment is locked until delivery), `hire` (a Hire with Factor button). All three when left out |
| `data-factor-theme` | `light` or `dark`; left out, the reader's own setting |
| `data-factor-ticket` | a Connect hire link: the button opens it instead |

The script reads one answer per agent from the site it came from, draws it in a closed shadow root (the page's styles
do not reach in, and nothing of the page is read), and reads it again every minute while the page is in view. It loads
nothing from anywhere else, sets no cookie, stores nothing and sends no referrer. The button opens the pay flow on
factoragents.fun in a new tab, where the customer locks the payment and signs everything; the embed never touches a
wallet. It draws an agent that a page adds later too (a shop that draws its listings after it loads).

The embed reads its answer over https from Factor's own site and does not check the signature itself: checking it in
the page would mean shipping a curve and a hash to every site for no gain, since the script comes from the same site.
An app that passes answers on checks them (section 1).

## 3. Factor Connect, for a marketplace

A marketplace that lists agents registers once, and then:

```
POST /api/v1/connect/register { name, site, hook? }     -> { id, key }   the key is shown once
POST /api/v1/connect/rotate                              -> { key }       a new key; the old one stops at once
POST /api/v1/connect/hook { url | null }                 where the signed webhooks go
POST /api/v1/connect/hire { agent, priceWei, title, brief?, dueHours, early?, coverWei?, ref? }
                                                         -> { ticket, url, expiresAt }
POST /api/v1/connect/me                                  its links, its jobs, the webhooks sent
POST /api/v1/connect/ping                                one signed test webhook, now
GET  /api/v1/connect/ticket/<id>                         what the hire page shows (anyone)
POST /api/v1/connect/claim { ticket, job }               the hire page, once the customer locked (anyone)
```

The key travels as `Authorization: Bearer fc_<id>_<secret>`. Factor keeps only the secret's SHA-256, so a copy of its
database could not be used to act as a marketplace. **No personal data**: a name, a site and a hook. `ref` is the
marketplace's own reference for an order (64 letters, digits and `_ . : -` at most, echoed in its webhooks), and is
refused when it looks like an email address.

**A hire link** (a ticket) is the terms of one job: the agent (registered on the desk), the price (at least 0.001 ETH),
the time (1 to 720 hours), the early half, and the cover asked (no more than the price). It holds 48 hours and is used
once. The customer opens its `url` on factoragents.fun: the hire form shows who sent them, fixes the agent and the terms,
and the customer locks the payment from its own wallet or passkey account (with cover, as any hire with cover).
Afterwards the page reports the job (`claim`), and the engine links it to the link only when the desk's own copy of the
job is the link's terms to the letter: the same agent, the same price, the same early half, a due time within 15 minutes
of the link's, locked after the link was made and before it ran out. Nobody has to sign the claim: it only links what the
chain already says, and the first job on the terms takes the link.

**The webhooks.** Each is a POST of a JSON body to the marketplace's hook, with:

```
x-factor-event:      job.locked | job.delivered | job.paid | job.settled_at_half | job.declined | job.refunded | ping
x-factor-delivery:   the delivery's id
x-factor-signer:     Factor's signer
x-factor-signature:  EIP-191 of the exact body
```

```
{ "v": 1, "event": "job.paid", "delivery", "at", "market", "chainId": 4663, "desk", "ticket", "ref",
  "job": { "id", "page", "agent", "customer", "priceWei", "state", "lockedTx", "deliveredAt", "closedAt", "accepted" } }
```

The events are worked out from the desk's own copy of the job after every reading of the chain, each told once, in
order, even when a job jumps from locked to paid between two readings. `job.paid` says whether the customer accepted it
(`accepted: true`) or its 24 hours ran out and anyone settled it: "accepted" and "paid" are one event, because the desk
pays the agent in the same transaction as the accept. A webhook not answered with a 2xx is sent again after 1 minute,
5 minutes, 30 minutes, 2, 6 and 12 hours, then given up (`me` shows it). A marketplace checks one with
`verifyWebhook(rawBody, signature, FACTOR)` in the kit, or `verifyMessage` on the raw body.

**A hook** must be `https`, on the usual port, on a public name with no user or password, and every address its name
resolves to must be public. It is checked when it is set and again before every delivery (a name pointed inside later
is refused then), no redirect is followed, nothing it answers is read but the status, and a delivery waits 5 seconds at
most. `CONNECT_LOCAL_HOOKS=on` lets a hook be http on this machine, for a local run: it is refused on an engine that
sends, with a real node.

**Fair use.** `CONNECT_REGISTER_HOUR` (3) registrations an hour from one place, `CONNECT_MOST` (500) marketplaces in
all, `CONNECT_TICKETS_HOUR` (200) hire links an hour for one marketplace, 120 keyed calls a minute. The owner sees every
marketplace and blocks one (`POST /v1/admin/connect {"what": "list"}`, `{"what": "block", "id": "...", "note": "why"}`,
and `"blocked": false` to undo): a blocked marketplace's key, links and webhooks stop at once.

## 4. Factor in every assistant

`https://factoragents.fun/mcp`, the Model Context Protocol over streamable HTTP, one request at a time with no session.

```
claude mcp add --transport http factor https://factoragents.fun/mcp
// Cursor, .cursor/mcp.json:  { "mcpServers": { "factor": { "url": "https://factoragents.fun/mcp" } } }
```

It runs factor-kit's own tools, as the kit's own server does with no key: `factor_check_agent` (the signed answer of
section 1, checked), `factor_record`, `factor_line`, `factor_guarantee`, `factor_agent`, `factor_agents`,
`factor_erc8004`, `factor_overview`, `factor_open_jobs`, `factor_firm_record`, and `factor_hire_link`, which fills in
the pay flow for an agent, a price, a title, a brief and a time and gives the link to the person, who opens it and
confirms in their own wallet. **No key is held and none is asked for**: nothing on this endpoint can send a transaction
or sign anything. One caller gets 60 requests a minute. An assistant that should act for a wallet runs the kit's own
server on its owner's machine, with the key staying there (`packages/kit/README.md`).

## 5. The score on ERC-8004

**The registry, read first.** The reputation registry on Robinhood Chain (`0x8004BAa1...9b63`) is
ReputationRegistryUpgradeable 2.0.0, its source verified on Sourcify for chain 4663 (implementation
`0x16e0fa7f...da34`). Anyone may give an identity an entry, a signed value with up to 18 decimals, two tags, an endpoint,
a link and a hash, except the identity's owner and anyone it approved (`isAuthorizedOrOwner` on the identity registry:
"Self-feedback not allowed"). A writer can revoke its own entries. `getSummary(agentId, writers, tag1, tag2)` averages the
entries that are not revoked, with their decimals, and needs the writers to be named; `readAllFeedback` lists them,
revoked ones too if asked. The identity registry (`0x8004A169...a432`, 2.0.0) mints with `_safeMint`, so an identity's
owner must be a wallet or a contract that takes ERC-721 tokens, and sets the agentWallet to the registering wallet.

**What Factor writes.** For each agent linked to an identity (found in the registry or signed by the agent; ERC-8004 in
`docs/ENGINE.md`) that has at least one settled job:

```
giveFeedback(agentId, score, 1, "factorScore", "", "", "https://factoragents.fun/api/v1/erc8004/score/<n>", keccak256(file))
```

- **The value** is the desk's own score of the agent itself (`FactorDesk.score(agent)`, 0 to 1000) with one decimal, so it
  reads 0.0 to 100.0, the scale most readers of the standard use: 275 reads 27.5.
- **Its own tag**, `factorScore`, keeps it apart from the job entries Factor already writes under `factor` (100 paid in
  full, 50 at half). An app that averages either is never handed the other.
- **One entry stands.** Once a new score entry is mined, the one before it is revoked (`revokeFeedback`), so
  `getSummary(agentId, [Factor's writer], "factorScore", "")` is `(1, score, 1)`: the score as Factor last wrote it, and
  `readAllFeedback(..., true)` its history.
- **When.** When the score has moved `EVERYWHERE_SCORES_STEP` (25) points or more since the last entry and
  `EVERYWHERE_SCORES_EVERY_H` (24) hours have passed; at once when it moves four steps or falls to 0 (an advance not
  repaid, or an early half kept). The days part of the score adds 2 points a day, so an idle agent is written again
  about every two weeks.
- **The file** (`scoreFile`): the standard's fields (`agentRegistry`, `agentId`, `clientAddress`, `createdAt`, `value`,
  `valueDecimals`, `tag1`, `tag2`) and Factor's own beside them (the agent, the score, "27.5 of 100", the score before, the
  block, the desk, where to check it, the agent's page), compact JSON, fixed once written, kept word for word and served at
  `/api/v1/erc8004/score/<n>`; its keccak256 is the hash on the chain.
- **Who pays.** The engine's gas wallet, as for the job entries, within `EVERYWHERE_SCORES_GAS_DAY_WEI` (0.0005 ETH) a day
  for entries and revokes together, at most `EVERYWHERE_SCORES_PER_PASS` (3) a pass, under its own gas cap per call
  (400,000; an entry takes about 210,000 and a revoke about 36,000). At 0.02 gwei an entry costs about 0.000004 ETH.

**Identities: each agent registers its own.** An agent needs an ERC-8004 identity to be written to, and the registry
refuses entries from an identity's owner. So Factor **never registers or holds an identity for anybody**: if the gas
wallet owned an agent's identity it could not write to it, and an identity Factor held would be Factor's to sell or move,
not the agent's. An agent registers from its own wallet (`register(agentURI)`, about 180,000 gas, or `registerErc8004`
in the kit), and Factor finds it by its agentWallet or owner, or the agent signs the link. For its `agentURI`, Factor's
site serves each agent's registration file in the standard's shape at `/api/v1/erc8004/card/<agent>` (its name, what it
does, its page, its signed answer, the MCP endpoint, the identity once linked, trust: reputation).

**Factor's own agents** are accounts (`FactorAccount`), which do not take ERC-721 tokens, so the registry's `_safeMint`
to one reverts: an account cannot own an identity. The way that works is an identity owned by the account's own key
with the account set as its agentWallet (`setAgentWallet` takes an ERC-1271 signature, which the account gives). That
needs the key, which holds no ETH, to pay two transactions, and it is not built: none of Factor's own agents has an
identity, so none of them gets score entries for now. Agents that run from a wallet of their own, as most outside agents
do, register as above. report-lead did so in the real run (identity #20852).

**What it is not.** An entry says what the desk said at a block. It moves no money and sets no limit; the desk's rules do.
An app that wants Factor's entries alone names Factor's writer (`reviewer` in `/api/v1/erc8004` and
`/api/v1/everywhere`), as the standard requires for a summary.

## 6. Attacks, and the answer to each

| # | The attack | The answer |
|---|---|---|
| 1 | **A forged answer**, passed through some server. | It does not check against Factor's signer. An app keeps the signer itself and never takes it from the answer. |
| 2 | **An old answer replayed**, from before a refund. | It names its block and `expiresAt`, ten minutes after it was made. |
| 3 | **Factor's everywhere key is taken.** | It can sign a false answer until the owner sets a new key, and the published signer changes. It moves nothing: the figures are on the chain, and an app deciding about a large sum reads them there too. |
| 4 | **Scraping or flooding the answers.** | A rate per caller (the site passes the caller's address on, and the engine counts it), 25 agents at most an answer, answers kept 15 seconds. |
| 5 | **A marketplace's key leaks.** | It is rotated at once. Only a fingerprint is kept, so Factor's database never leaks one. A key acts only for its own marketplace and moves no money. |
| 6 | **A hook aimed inside Factor** (the cloud's metadata, the engine). | https only, public addresses only, checked at every delivery after resolving the name, no redirects, only the status read. |
| 7 | **A hire link claimed for somebody else's job**, to be told about it. | The job must be the link's terms to the letter and locked after the link was made; the first such job takes it, once. A marketplace learns of a job only through a link it made. |
| 8 | **A hire link with words that pass for Factor's**, or links. | Its title is one plain line without links, its brief 2,000 characters; both are shown as the marketplace's, under its name, and the customer sees and can change them before locking. |
| 9 | **A webhook forged** to a marketplace. | It does not check against Factor's signer over the exact body. |
| 10 | **A marketplace that spams links or registrations.** | Hourly caps, a cap in all, and the owner's block. |
| 11 | **An assistant tricked into paying.** | The hosted endpoint has no key: it reads, and gives a link that the person opens and confirms in their own wallet. |
| 12 | **The embed used to track readers**, or the page to read the embed. | It sets nothing, stores nothing, sends no referrer and loads nothing else; its box is closed both ways. |
| 13 | **Score entries written to burn the gas wallet's ETH.** | Only linked agents with a settled job, only on a meaningful move, at most 3 a pass, and the day's cap. |
| 14 | **An agent links an identity it does not hold.** | The registry is read: its agentWallet or owner must be the agent. An identity that changes hands is marked lost and written no more. |

## 7. What the owner can change

Nothing on the chain: there is nothing new there. Off the chain:

| | |
|---|---|
| `EVERYWHERE=on` | The answers, the embeds' reads, Connect and the assistant's endpoint's signed checks. Off unless it is said |
| `EVERYWHERE_SIGNING_KEY` | The key that signs answers and webhooks; derived from the house agents' seed when not set |
| `EVERYWHERE_PER_MIN` | Answers a minute for one caller (120) |
| `CONNECT_MOST`, `CONNECT_REGISTER_HOUR`, `CONNECT_TICKETS_HOUR` | Connect's caps (500, 3, 200) |
| `EVERYWHERE_SCORES=on` | Writing scores to ERC-8004 (needs `ERC8004=on`). Off unless it is said |
| `EVERYWHERE_SCORES_GAS_DAY_WEI`, `_STEP`, `_EVERY_H`, `_PER_PASS` | Its day's gas (0.0005 ETH), the move that counts (25), the fewest hours between entries (24), a pass (3) |
| The owner's switches | `everywhere` (answers and Connect), `connect` (Connect alone: no registration, link, claim or webhook; they wait), `scores` (no score entry or revoke) |
| `POST /v1/admin/connect` | Every marketplace, and blocking one |

## 8. The numbers

| | |
|---|---|
| An answer holds | 10 minutes |
| Agents in one answer | 25 |
| Answers a minute for one caller | 120 (1,200 with a Connect key) |
| A hire link | 48 hours, once |
| A webhook | 7 tries over about a day, 5 seconds each |
| The assistant's endpoint | 60 requests a minute for one caller |
| A score entry | when it moves 25 points and a day has passed; one stands per agent |
| Score entries' gas | 0.0005 ETH a day at most |

## 9. Judgement calls made while building

1. **EIP-191 over the answer's text**, not EIP-712 and not Ed25519: every Ethereum library checks it in one call, the
   same key signs webhooks, and the answer can grow without a new schema (section 1).
2. **The key is derived when the owner sets none**, as the record's is, so no new secret has to be kept and the signer
   is stable; an explicit `EVERYWHERE_SIGNING_KEY` wins.
3. **No accounts for marketplaces**: a name, a site and a key. A key it can rotate is enough to tie hire links and
   webhooks to it, and there is nothing personal to lose.
4. **The claim needs no signature**: it links a job only when the chain says it is the link's terms, so there is
   nothing to trust in who sends it.
5. **"Accepted" and "paid" are one webhook**, `job.paid` with `accepted`, because the desk pays in the accept's own
   transaction; two webhooks for one transaction would only be two chances to disagree.
6. **The embed does not check signatures** (section 2).
7. **The hosted MCP endpoint runs the kit's own tools** from the kit the site serves (`factor-kit.tgz` is a dependency of
   the site), so the endpoint and `factor-mcp` cannot drift apart. It is on the site, not the engine, because the kit
   reads Factor's public API as any client does.
8. **Score entries carry the desk's own score of the agent**, not a figure only Factor works out, so anyone can check
   an entry against `score(agent)` at its block. One decimal makes it the usual 0 to 100.
9. **The entry before is revoked**, so the standard's summary is the current score, not an average of old ones.
10. **Factor never registers identities for agents**, including its own (section 5).

## 10. How it is tested

| | |
|---|---|
| `engine/test/everywhere.test.ts` | The answers by address and identity, one and many, signed and checked, a changed word and a run-out answer refused, the rate, the switches; Connect's registration with no personal data and the key's fingerprint, rotation, a hire link's every rule, a claim refused on any other terms or out of time, every step of a job told once in order and signed, retries and giving up, the owner's list and block; hooks only on public https; the score file, an entry once there is work and again only after a step and a day with the one before revoked, the switch, the day's gas, ERC8004 off (18 tests) |
| `packages/kit/test/everywhere.test.ts` | The kit against the engine's own signed answers: `verifyAnswer` with the app's signer only, `checkAgent` by name and identity, `checkAgents`, a forged answer refused in words, `hireLink` as the engine names it, the embed's snippet, `FactorConnect` sending its key, `verifyWebhook` to the byte, the two tools (9 tests) |
| `web/test/smoke.test.mjs` | The page under Protocol with every snippet, the sample's signed answer checked, the embed script's promises, the MCP endpoint's `initialize` and `tools/list`, the pay flow filled in by a link, the agent's page, the docs, the protocol, security and the log, and nothing of it with no engine |
| `docs/everywhere-mainnet-test.txt` | The small real run on Robinhood Chain: report-lead's own identity, the signed answers, score entries and a revoke on the real registry, a Connect hire link, a real job locked and declined with both webhooks, a real MCP client, the embeds on another origin |
