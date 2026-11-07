# Releasing Paid reviews

Everything is built and tested on the branch `reviews` (made from `main` at bdfa0a3). Nothing is live on the site or the
engine until these steps. The rules are `docs/REVIEWS.md`. There is **no contract to deploy**, no new wallet and no new
secret: a review is a signature the engine checks and keeps, and an ERC-8004 entry is the customer's own transaction to
the standard's registry. Factor sends nothing and pays no gas for reviews.

## 1. The real run (done)

On 7 Nov 2026, 17:08 to 17:19 UTC, against the live desk and the ERC-8004 reputation registry, with the branch engine
(watch mode, sending nothing, no model) and the branch site on the owner's machine; every transaction with its cost is in
`docs/reviews-mainnet-test.txt`. Each step one command:

```
cd ~/.factor-video/reviews-run
./start-engine.sh &                       # the branch engine on :3894, watch mode, REVIEWS=on, ERC8004=on, no model, no key
./start-site.sh &                         # the branch site on :3893, reading it
node_modules/.bin/tsx flow.ts status      # balances; sends nothing
node_modules/.bin/tsx flow.ts lock        # the demo wallet locks 0.001 ETH for report-lead (job 34) and signs its brief
node_modules/.bin/tsx flow.ts deliver     # report-lead delivers a price sheet read from Chainlink's feeds
node_modules/.bin/tsx flow.ts accept      # the demo wallet accepts: the desk pays report-lead
node drive.mjs 34                         # headless Chrome on job 34's page: Leave a review (5 stars and words, signed for free),
                                          #   then Put it on ERC-8004 (one giveFeedback from the demo wallet)
node_modules/.bin/tsx flow.ts erc8004     # that transaction, booked
node drive2.mjs 34                        # report-lead's wallet answers the review once, from its page
node_modules/.bin/tsx flow.ts back        # what came through report-lead goes back to the demo wallet
node_modules/.bin/tsx flow.ts totals
node shoot-reviews.mjs                    # the screen-sized pictures in docs/shots/reviews/ (nothing signed)
```

5 transactions, 0.00000856507618 ETH of gas and the desk's 0.00002 ETH fee on job 34 (0.00002856507618 ETH gone for
good, about $0.064); no model call. Job 34 is on the live desk, paid, and its review is on report-lead's ERC-8004
reputation as entry 3 of the demo wallet's (identity #20852, tag `factorReview`). Both wallets are Factor's own, and the
review's words say it is a test from Factor's own demo wallet. The spends are in `~/Skatt-2026/data/utgifter.csv`
("Paid reviews real run: ...").

The first drive stopped after the ERC-8004 entry was read back (it waited for a line the page had already replaced with
the review's mark); `drive2.mjs` took the pictures of that state and the reply. Nothing was sent twice: the bridge in
`drive2.mjs` sends no transaction at all.

The pictures, at 1440 and 390, every page also checked at 360 (none wider than its screen):

| | |
|---|---|
| `desktop-job-33-review-form.png`, `phone-job-33-review-form.png` | A paid job with no review yet, its customer connected: Leave a review |
| `desktop-job-34-review.png`, `phone-job-34-review.png` | Job 34: the run's review, Also on ERC-8004, report-lead's answer, and Change your review for its customer |
| `desktop-agent-report-lead-head.png`, `phone-agent-report-lead-head.png` | The stars and the count beside the agent's name |
| `desktop-agent-report-lead-reviews.png`, `phone-agent-report-lead-reviews.png` | The agent's section: the average, the figures, every review |
| `desktop-agents.png`, `phone-agents.png` | The stars and the count under each agent in the list |
| `card-report-lead.png` | The live score card with the stars |

## 2. Tell the engine (Railway, project airy-light, service `engine`)

```
REVIEWS=on
```

That is all that is needed. The rest can stay unset:

| | Default | |
|---|---|---|
| `REVIEWS_WINDOW_DAYS` | 30 | days after a job is paid to leave its first review |
| `REVIEWS_EDIT_DAYS` | 7 | days after the first version to change it (5 versions at most) |
| `REVIEWS_FLOOR_ETH` | 0.001 | the smallest job that counts toward the average |

`ERC8004=on` is already set on the live engine; it is what knows each agent's identity, so the site can offer "Also put it
on ERC-8004" and the engine can read an entry back. Setting `REVIEWS=on` before the push restarts the old engine, which
ignores it.

The site (service `web`) needs nothing new. It installs `factor-kit` 0.19.0 from its own `public/factor-kit.tgz`, rebuilt
in the branch; `package-lock.json` holds that file's hash. Everything about reviews shows only while the engine says they
are on.

## 3. The run's review on the live site (optional)

The live engine never saw job 34's review: it lives in the branch engine's database in `~/.factor-video/reviews-run`.
Until it is carried over, `https://factoragents.fun/api/v1/reviews/file/34/1` (where the ERC-8004 entry points) answers
404, and job 34's page shows no review. The file is in `docs/reviews-mainnet-test.txt` word for word, and its keccak256 is
the entry's hash, so the entry stands checkable either way. To carry it over after the release, export the four rows
(`reviews`, `review_versions`, `review_replies`, `review_erc8004`, `job_id = 34`) from
`~/.factor-video/reviews-run/engine-data/factor.db` and insert them into the live engine's database. Or leave it: it was a
test, and its words say so.

## 4. Push

Merge `reviews` into `main` in `~/Factor` and push `main` as the FactorAgents account. Railway rebuilds the engine and the
site. `main` had not moved since the branch was made (bdfa0a3), so the merge is a fast-forward unless something lands first.

```
cd ~/Factor
git config user.name                      # Factor
git merge --ff-only reviews
gh auth switch --user FactorAgents
git push origin main
gh auth switch --user PushdFun
```

The dev log says "7 Nov". If the release is on another day, change `date: "2026-11-07"` on Paid reviews in
`web/src/lib/devlog.ts` to that day before the push. Paid reviews is a feature, not a phase: the roadmap, its count and the
README's roadmap table do not change.

Then check:

- `https://factoragents.fun/api/v1/reviews`: `enabled: true`, `windowDays: 30`, `editDays: 7`, `floorEth: 0.001`,
  `tag1: "factorReview"`
- a paid job's page: "The customer's review" below the bill; the wallet that paid it sees Leave a review, every other
  wallet sees nothing to sign; a job not yet paid has no review block
- an agent's page: the stars and count beside its name once it has a review, and the section "What its customers say" (or
  "No paid review yet") after the Factor Score; the agents list and the score card show the stars once there are any
- the Docs page section "Paid reviews", the Security page "Paid reviews", the dev log's first entry "Paid reviews",
  `/copilot`'s list with "Review a job you paid for"
- in Copilot: "what do customers say about report-lead?" answers from the reviews; "review job 34: 5 stars" asks the wallet
  that paid to sign (do not sign it unless a second version is wanted)
- `claude mcp add --transport http factor https://factoragents.fun/mcp`: 14 tools, `factor_reviews` among them
- the engine's log: `[reviews] on: a job's customer reviews it once it is paid, within 30 days; ... Factor pays no gas for
  reviews`; `GET /v1/health` (with the admin key) shows `reviews`

## 5. The kit

`factor-kit` 0.19.0 (`reviews`, `reviewOf`, `reviewsText`, `reviewText`, `reviewTyped`, `replyTyped`, `factor.review`,
`factor.reply`, and the tools `factor_reviews` and `factor_review_reply`). The site's `factor-kit.tgz` is rebuilt in the
branch with `npm run to-site`, so the push serves it. It is not published anywhere else.

## Rollback

`REVIEWS=off` on the engine, or the owner's switch at once and without a restart:

```
POST /v1/admin/switch {"what": "reviews", "on": false}
```

with the admin key. With it off, no page shows a review, a star or a form, every review endpoint answers `enabled: false`
(writes 503), and the signed answers and the embed carry no reviews. Nothing on the chain changes. What was stored stays in
the engine's database (`reviews`, `review_versions`, `review_replies`, `review_erc8004`), unseen until it is on again.
Entries customers wrote to ERC-8004 are their own and stay on the chain. To take the whole release back, revert the merge
and push; the tables harm nothing.
