// HEY Research Lab's answers, as HEY gave them on 2026-11-08 for Factor's own project (trimmed: the snapshot keeps the parts a
// builder record reads and, to show they are left out, its market figures and Build Momentum). Read by engine/test/hey.test.ts.
export const FACTOR_CARD = {
 "contract_address": "0x47c5ea4d85c4c1a81f26124580a80b0b7a581cc0",
 "chain_id": 4663,
 "last_activity_at": "2026-11-07T17:27:39.000Z",
 "status": "active",
 "token_verification": "VERIFIED",
 "activity_applies_to_token": true,
 "hey_project_url": "https://heyresearch.xyz/project/factor",
 "repo_url": "https://github.com/FactorAgents/factor",
 "last_commit": null,
 "last_code_activity": {
  "summary": "Code changes, week starting 2026-11-02 (to 2026-11-08)",
  "commits": 59,
  "commits_partial": false,
  "commits_30d": 240,
  "commits_30d_partial": true,
  "window_start": "2026-10-09T15:24:40.233Z",
  "active_days": 6,
  "contributors": 1,
  "repo_url": "https://github.com/factoragents/factor",
  "observed_at": "2026-11-07T17:27:39.000Z"
 },
 "latest_release": null,
 "latest_deployment": {
  "title": "Deployed a new contract: 0x72a4\u2026cdcf",
  "environment": "robinhood-chain-4663",
  "url": "https://robinhoodchain.blockscout.com/address/0x72a4fe4e9b83d5f6608ed1dac92ac0490f54cdcf",
  "timestamp": "2026-10-28T11:06:18.000Z"
 },
 "research_level": "VERIFIED_BUILDER",
 "activity_measured": true,
 "as_of": "2026-11-08T15:17:23.357Z",
 "verified_builder": true,
 "latest_meaningful_ship": {
  "title": "Code changes, week starting 2026-11-02 (to 2026-11-08)",
  "url": "https://github.com/factoragents/factor",
  "timestamp": "2026-11-07T17:27:39.000Z",
  "kind": "CODE_ACTIVITY",
  "evidence_id": "ship:cd88c1d6-1336-4727-80b0-c233e2822aa8",
  "evidence_link": "https://heyresearch.xyz/evidence/ship:cd88c1d6-1336-4727-80b0-c233e2822aa8?utm_source=factor&utm_medium=partner_api&utm_campaign=builder_card"
 },
 "meaningful_ships_30d": 5,
 "latest_change": {
  "id": "ship:cd88c1d6-1336-4727-80b0-c233e2822aa8",
  "type": "build.code_activity",
  "summary": "Code changes, week starting 2026-11-02 (to 2026-11-08)",
  "occurred_at": "2026-11-07T17:27:39.000Z",
  "precision": "WEEK",
  "detected_at": "2026-11-02T14:30:18.750Z",
  "evidence_id": "ship:cd88c1d6-1336-4727-80b0-c233e2822aa8",
  "url": "https://heyresearch.xyz/api/evidence/ship%3Acd88c1d6-1336-4727-80b0-c233e2822aa8",
  "explanation": {
   "version": "change-explain-v1",
   "headline": "Code changes, read from the team\u2019s GitHub \u00b7 not a deployment",
   "stage": "code",
   "reported_by": "team_source",
   "corroboration": "not_corroborated",
   "release_deployment": "not_applicable",
   "activity": "NOT_APPLICABLE",
   "call_success": "not_measured",
   "time_basis": "source_dated",
   "standing": "standing",
   "unknowns": [
    "capability_not_named",
    "deployment_not_observed"
   ],
   "explain_url": "https://heyresearch.xyz/api/projects/factor/explain?fact=build.change&event=ship%3Acd88c1d6-1336-4727-80b0-c233e2822aa8"
  }
 },
 "latest_change_state": "recorded",
 "latest_signal": {
  "id": "0d3aadb5-e63a-4dbd-b36b-48d2edf1c19e",
  "kind": "development_spike",
  "label": "Development spike",
  "headline": "3 meaningful ships in the 7 days to 28 Oct (1 in the 7 days before)",
  "observed_at": "2026-10-28T13:09:56.572Z",
  "evidence_id": "signal:0d3aadb5-e63a-4dbd-b36b-48d2edf1c19e",
  "url": "https://heyresearch.xyz/signals/0d3aadb5-e63a-4dbd-b36b-48d2edf1c19e"
 },
 "market_status": {
  "status": "ACTIVE_MARKET",
  "observed_at": "2026-11-08T15:20:50.171Z",
  "reason": "liquidity_and_volume",
  "label": "Active market"
 },
 "badge_url": "https://heyresearch.xyz/badge/factor.svg",
 "project_link": "https://heyresearch.xyz/project/factor?utm_source=factor&utm_medium=partner_api&utm_campaign=builder_card",
 "uniswap_v4_hooks": null,
 "uniswap_v4_hooks_state": "none_listed",
 "hey_status": "SHIPPING",
 "hey_status_label": "Shipping",
 "hey_status_help": "Shipped something meaningful in the last 7 days.",
 "hey_project_name": "Factor",
 "disclaimer": "HEY reports what a team shipped and how it knows. It is not a rating, not a verdict, and says nothing about what a token will do."
} as const;

export const FACTOR_SNAPSHOT = {
 "summary": {
  "version": "summary-v1",
  "lines": [
   {
    "dimension": "build",
    "label": "Build",
    "tag": "DERIVED",
    "text": "Shipping: 5 counted ships in 30 days; latest ship yesterday.",
    "evidence": [
     {
      "id": "ship:cd88c1d6-1336-4727-80b0-c233e2822aa8",
      "label": "GitHub",
      "url": "https://github.com/factoragents/factor",
      "receiptUrl": "https://heyresearch.xyz/api/evidence/ship%3Acd88c1d6-1336-4727-80b0-c233e2822aa8"
     }
    ],
    "basis": "evidence_record",
    "detailUrl": "https://heyresearch.xyz/api/projects/factor/timeline",
    "observedAt": "2026-11-07T17:27:39.000Z",
    "freshness": "fresh",
    "answer": "Shipping consistently",
    "significance": {
     "text": "One of a run of ships in the 30 days to it: building continued, not a one-off.",
     "about": "ship:cd88c1d6-1336-4727-80b0-c233e2822aa8",
     "receiptUrl": "https://heyresearch.xyz/api/evidence/ship%3Acd88c1d6-1336-4727-80b0-c233e2822aa8"
    }
   }
  ],
  "computedAt": "2026-11-08T15:24:54.998Z"
 },
 "identity": {
  "slug": "factor",
  "name": "Factor",
  "symbol": "FACTOR",
  "projectKind": "OTHER",
  "researchLevel": "VERIFIED_BUILDER",
  "catalogStatus": "VERIFIED_BUILDER",
  "primaryNarrative": {
   "slug": "ai-agents",
   "name": "AI Agents"
  },
  "token": {
   "chainId": 4663,
   "contractAddress": "0x47c5ea4d85c4c1a81f26124580a80b0b7a581cc0"
  },
  "websiteUrl": "https://factoragents.fun/",
  "officialX": {
   "handle": "FactorAgents",
   "url": "https://x.com/FactorAgents",
   "status": "ACTIVE",
   "checkedAt": "2026-11-08T02:21:11.792Z",
   "linkHeld": null,
   "corroboration": "mutual_site_link",
   "corroborationCheckedAt": "2026-11-08T02:21:11.792Z",
   "foundByHey": false
  },
  "firstRecordedByHeyAt": "2026-10-14T14:05:07.566Z",
  "url": "https://heyresearch.xyz/project/factor"
 },
 "build": {
  "activityStatus": "SHIPPING",
  "activityMeasured": true,
  "lastShippedAt": "2026-11-07T17:27:39.000Z",
  "buildMomentum": 53.7,
  "stillBuilding": false,
  "stillBuildingState": "NOT_HELD",
  "discoveryGap": 16.2,
  "underTheRadar": {
   "state": "NOT_HELD",
   "explainUrl": "https://heyresearch.xyz/api/projects/factor/explain?fact=discovery_gap"
  },
  "velocity": {
   "state": "NEW",
   "current": 5,
   "previous": null,
   "windowDays": 30
  },
  "cadence": {
   "state": "INSUFFICIENT_RELEASES"
  },
  "hasBuilderSource": true
 },
 "market": {
  "marketCap": {
   "usd": 77244,
   "source": "dexscreener",
   "kind": "fdv",
   "observedAt": "2026-11-08T15:20:50.171Z"
  },
  "liquidity": {
   "usd": 25908.11,
   "source": "dexscreener",
   "observedAt": "2026-11-08T15:20:50.171Z",
   "kind": "market"
  },
  "volume24h": {
   "usd": 6119.43,
   "source": "dexscreener",
   "observedAt": "2026-11-08T15:20:50.171Z"
  },
  "priceChange24hPct": -9.34,
  "venue": "DEX",
  "tokenMarket": {
   "status": "ACTIVE_MARKET",
   "reason": "liquidity_and_volume",
   "label": "Active market"
  },
  "launchStage": "DEX",
  "url": "https://heyresearch.xyz/api/projects/factor/market"
 },
 "verification": {
  "token": {
   "status": "VERIFIED",
   "reason": "site_names_contract",
   "verifiedAt": "2026-10-15T01:48:32.227Z"
  },
  "ownerVerified": false,
  "submitted": false,
  "sources": {
   "total": 4,
   "own": 4,
   "verified": 1,
   "contextOnly": 0
  }
 },
 "latestChanges": {
  "available": true,
  "items": [
   {
    "id": "ship:cd88c1d6-1336-4727-80b0-c233e2822aa8",
    "revision": 13,
    "op": "upsert",
    "type": "build.code_activity",
    "domain": "build",
    "occurredAt": "2026-11-07T17:27:39.000Z",
    "precision": "WEEK",
    "detectedAt": "2026-11-02T14:30:18.750Z",
    "recordedAt": "2026-11-07T22:30:11.886Z",
    "summary": "Code changes, week of 2026-11-02 \u2013 2026-11-08",
    "summaryCurrent": "Code changes, week starting 2026-11-02 (to 2026-11-08)",
    "evidence": [
     {
      "id": "ship:cd88c1d6-1336-4727-80b0-c233e2822aa8",
      "label": "GitHub",
      "url": "https://github.com/factoragents/factor"
     }
    ],
    "source": "github",
    "countsAsBuilding": true
   },
   {
    "id": "sourcechange:53e7baf5-0605-432f-8b56-f6701e970803",
    "revision": 1,
    "op": "upsert",
    "type": "research.source_changed",
    "domain": "research",
    "occurredAt": null,
    "precision": "OBSERVED",
    "detectedAt": "2026-11-06T14:03:17.938Z",
    "recordedAt": "2026-11-06T14:05:02.984Z",
    "summary": "Official security.txt changed",
    "evidence": [
     {
      "id": "sourcechange:53e7baf5-0605-432f-8b56-f6701e970803",
      "label": "Official site",
      "url": "https://factoragents.fun/.well-known/security.txt"
     }
    ],
    "source": "official_site"
   }
  ],
  "url": "https://heyresearch.xyz/api/changes?project=factor"
 },
 "evidenceSummary": {
  "sources": {
   "total": 4,
   "own": 4,
   "verified": 1,
   "contextOnly": 0
  },
  "meaningfulEvents30d": 5,
  "explainUrl": "https://heyresearch.xyz/api/projects/factor/explain"
 },
 "links": {
  "page": "https://heyresearch.xyz/project/factor",
  "detail": "https://heyresearch.xyz/api/projects/factor",
  "market": "https://heyresearch.xyz/api/projects/factor/market",
  "timeline": "https://heyresearch.xyz/api/projects/factor/timeline",
  "intelligence": "https://heyresearch.xyz/api/projects/factor/intelligence",
  "changes": "https://heyresearch.xyz/api/changes?project=factor",
  "coverage": "https://heyresearch.xyz/api/projects/factor/coverage",
  "explain": "https://heyresearch.xyz/api/projects/factor/explain",
  "contracts": "https://heyresearch.xyz/api/projects/factor/contracts",
  "usage": "https://heyresearch.xyz/api/projects/factor/usage",
  "relationships": "https://heyresearch.xyz/api/projects/factor/relationships"
 },
 "asOf": "2026-11-08T15:24:54.998Z",
 "scoringVersion": "hbm-v33",
 "disclaimer": "Public, source-backed activity HEY recorded. Still Building means counted ships during a market drawdown HEY itself tracked \u2014 it is not a prediction, not a ranking by price, and not investment advice. Few projects meet Still Building or Under the Radar at any time; both are strict by design, and list responses carry the counts."
};
