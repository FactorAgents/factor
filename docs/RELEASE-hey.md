# Releasing HEY builder records

Everything is built and tested on the branch `hey` (made from `main` at fff3e41). Nothing is live on the site or the
engine until these steps. The rules are `docs/HEY.md`. There is **no contract to deploy**, no new wallet, no secret that
must be set, and nothing costs anything: HEY's API is free and needs no key.

## 1. The checks (done)

On 8 Nov 2026, on the owner's machine:

- `cd engine && npm test`: every engine test, with 26 for HEY in `test/hey.test.ts` against a stand-in built from HEY's
  own answers (`test/hey-fixtures.ts`): the header on every request, the free key, answers kept and shared, the limit a
  minute, a 429 waited out, a slow and a down HEY, records by name, $TICKER, HEY page and contract, no market figure or
  score in a record, the endpoints, an owner's signed link, the switch, the Factor Score untouched, Copilot and Ask.
- `cd packages/kit && npm test`: every kit test, with 5 for HEY in `test/hey.test.ts` (the kit reads Factor's site and
  never HEY, the owner's link signed in the engine's words, the tool `factor_builder_record`, Ask's builder line).
- `cd web && npm run build && npm run test:smoke`: the site, with HEY's badge in the footer, the docs, the Security page,
  the dev log, the door's reads and the link, and nothing of HEY with no engine.
- `cd engine && npm run hey-live`: a read-only check against HEY's real API. Factor by name, by `$FACTOR`, by its HEY page
  and by its token; a name and a contract HEY does not have. 7 requests, every one with `x-hey-integration: factor/0.1.0`.
- The branch engine (watch mode, reading the live desk, sending nothing, no model) and the branch site on the owner's
  machine, HEY read from its real API, from `~/.factor-video/hey-run`:

```
cd ~/.factor-video/hey-run
./start-engine.sh &          # the branch engine on :3896, watch mode, HEY=on, COPILOT=on and ASK=on with no model, no key
./start-site.sh &            # the branch site on :3895, reading it
node link.mjs none           # report-lead's own wallet unlinks it (a signature: nothing is sent to the chain)
node shoot-hey.mjs before    # the owner's link form
node link.mjs factor         # report-lead's own wallet links it to Factor's project on HEY
node shoot-hey.mjs after     # every other picture
```

report-lead is Factor's own agent, made by Factor's team, so Factor's project on HEY is its maker's project. The link
lives in the run's own database only: the live engine has never seen it (section 4).

The pictures, in `docs/shots/hey/`, at 1440x900 and 390x844, every page also checked at 360 (none wider than its screen):

| | |
|---|---|
| `desktop-footer-badge.png`, `phone-footer-badge.png` | HEY's badge for Factor in the footer, "This team ships", linked to Factor's page on HEY |
| `desktop-agent-report-lead-head.png`, `phone-agent-report-lead-head.png` | "Builder record on HEY" beside the agent's name |
| `desktop-agent-report-lead-builder.png`, `phone-agent-report-lead-builder.png` | The section: HEY's facts about the linked project, the link to HEY, who linked it and when |
| `desktop-agent-report-lead-owner-link-form.png`, `phone-agent-report-lead-owner-link-form.png` | The wallet that runs the agent, before any link: the form |
| `desktop-agent-report-lead-owner.png`, `phone-agent-report-lead-owner.png` | The same wallet after the link: change it or unlink it |
| `desktop-copilot-builder.png`, `phone-copilot-builder.png` | Copilot: "Is the team behind report-lead shipping?", HEY's facts and the link to the record |
| `desktop-ask-builder.png`, `phone-ask-builder.png` | Ask Factor: the builder line on a linked agent's card, the order unchanged |
| `desktop-docs-hey.png`, `phone-docs-hey.png` | The Docs section "HEY builder records" |
| `desktop-security-hey.png`, `phone-security-hey.png` | The Security page: the one request a browser makes to HEY, and a link as the owner's word |
| `desktop-log.png`, `phone-log.png` | The dev log's entry for 8 Nov |

The wallet in the owner pictures is a stand-in with report-lead's address that signs and sends nothing.

## 2. Tell the engine (Railway, project airy-light, service `engine`)

```
HEY=on
```

That is all that is needed. The rest can stay unset:

| | Default | |
|---|---|---|
| `HEY_API_KEY` | none | HEY's free key ("a free key names you"), from an account on heyresearch.xyz; sent as a bearer token. Optional |
| `HEY_CACHE_S` | 600 | seconds an answer is kept |
| `HEY_PER_MIN` | 60 | the most calls to HEY a minute (HEY allows 120 without a key) |
| `HEY_TIMEOUT_S` | 8 | seconds a call may take |

Setting `HEY=on` before the push restarts the old engine, which ignores it.

The site (service `web`) needs nothing new. It installs `factor-kit` 0.20.0 from its own `public/factor-kit.tgz`, rebuilt
in the branch; `package-lock.json` holds that file's hash. Its content policy now lets a page load images from
`https://heyresearch.xyz` (HEY's badge) and nothing else of HEY's. Everything about HEY shows only while the engine says
it is on.

## 3. Push

Merge `hey` into `main` in `~/Factor` and push `main` as the FactorAgents account. Railway rebuilds the engine and the
site. `main` had not moved since the branch was made (fff3e41), so the merge is a fast-forward unless something lands first.

```
cd ~/Factor
git config user.name                      # Factor
git merge --ff-only hey
gh auth switch --user FactorAgents
git push origin main
gh auth switch --user PushdFun
```

The dev log says "8 Nov". If the release is on another day, change `date: "2026-11-08"` on HEY builder records in
`web/src/lib/devlog.ts` to that day before the push. HEY builder records is a feature, not a phase: the roadmap, its count
and the README's roadmap table do not change.

Then check:

- `https://factoragents.fun/api/v1/hey`: `enabled: true`, `integration: "factor/0.1.0"`, `project:
  "https://heyresearch.xyz/project/factor"`
- `https://factoragents.fun/api/v1/hey/record?q=%24FACTOR`: `found: true`, `sourceUrl:
  "https://heyresearch.xyz/project/factor"`, `facts.verified_builder: true` (as long as HEY says so)
- the footer of any page: HEY's badge for Factor and "This team ships", the link opening Factor's page on HEY; in the
  light theme the light badge
- an agent's page: nothing about HEY for a visitor while no link is set; connected as its owner, "Link its maker's
  project on HEY"
- the Docs page section "HEY builder records", the Security page "HEY builder records", the dev log's first entry,
  `/copilot`'s list with "Is the team shipping?"
- in Copilot: "is the team behind $FACTOR shipping?" answers from HEY's record with the link to it
- `claude mcp add --transport http factor https://factoragents.fun/mcp`: 15 tools, `factor_builder_record` among them
- the engine's log: `[hey] on: builder records are read from https://heyresearch.xyz with x-hey-integration: factor/0.1.0,
  kept 600 s, 60 calls a minute at most; shown as HEY's, never in the Factor Score`; `GET /v1/health` (with the admin key)
  shows `hey` with its calls and no error
- on HEY: its badge page `https://heyresearch.xyz/badges` lists the projects whose badge it finds on their own site, read
  about every six hours. HEY's API also says, in its `x-hey-notice` header, that a product naming itself in
  `x-hey-integration` can be listed on its "Built with HEY" page by writing to the address on that page.

## 4. The run's link on the live site (optional)

The live engine never saw report-lead's link: it lives in the run's database in `~/.factor-video/hey-run`. To show it on
the live site, report-lead's own wallet signs the link again once HEY is on there (`node link.mjs factor` with the site's
address in place of the local one), or its owner does it from the agent's page. Or leave it: any owner can link their
agent once the release is live.

## 5. The kit

`factor-kit` 0.20.0 (`builderRecord`, `agentBuilder`, `builderRecordText`, `heyLinkMessage`, `factor.builderRecord`,
`factor.agentBuilder`, `factor.linkHey`, and the tool `factor_builder_record`). The site's `factor-kit.tgz` is rebuilt in
the branch with `npm run to-site`, so the push serves it. It is not published anywhere else.

## Rollback

`HEY=off` on the engine, or the owner's switch at once and without a restart:

```
POST /v1/admin/switch {"what": "hey", "on": false}
```

with the admin key. With it off, HEY is asked nothing, no page shows a badge, a record or a link form, every HEY endpoint
answers `enabled: false` (the link 503), Copilot says builder records are not open, and Ask's cards carry no builder line.
Nothing on the chain changes. The agents' links stay in the engine's database (`hey_links`), unseen until it is on again.
To take the whole release back, revert the merge and push; the table harms nothing.
