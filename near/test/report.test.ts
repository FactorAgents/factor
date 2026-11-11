import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreReport, ownMoney, FORMULA, type DeskJob, type ScoreInput } from "../report/score.ts";
import { sameHandFrom, parentOf, type AccountFacts } from "../report/read.ts";

const NEAR = 10n ** 24n;
const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
let nextId = 0;

function job(o: Partial<DeskJob> & { agent: string; customer: string }): DeskJob {
  const id = o.id ?? nextId++;
  return {
    id,
    payer: o.customer,
    token: null,
    price: (2n * NEAR).toString(),
    advanced: "0",
    reserved: "0",
    parent: null,
    status: "Paid",
    created_ms: String(T0),
    due_ms: String(T0 + 3_600_000),
    delivered_ms: String(T0 + 1_800_000),
    closed_ms: String(T0 + 1_900_000),
    note: null,
    ...o,
  } as DeskJob;
}

function facts(entries: Record<string, Partial<AccountFacts>>): Map<string, AccountFacts> {
  return new Map(Object.entries(entries).map(([k, v]) => [k, { keys: [], creatorRead: true, ...v }]));
}

function input(agent: string, jobs: DeskJob[], f = facts({}), extra: Partial<ScoreInput> = {}): ScoreInput {
  return { agent, jobs, sameHand: sameHandFrom(f), own: new Set(["desk.testnet", "fees.desk.testnet"]), carriers: new Set(["intents.near"]), nearPerUnit: { "tusd.testnet": 1e-6 / 4 }, nowMs: T0 + 100 * DAY, ...extra };
}

const part = (r: ReturnType<typeof scoreReport>, k: string) => r.parts.find((p) => p.key === k)!.points;

test("a job paid by an unrelated customer counts in every part it touches", () => {
  const r = scoreReport(input("scout.testnet", [job({ agent: "scout.testnet", customer: "acme.testnet", advanced: (NEAR / 2n).toString() })]));
  assert.equal(r.totals.counted, 1);
  assert.ok(part(r, "paidWork") > 0);
  assert.ok(part(r, "repayment") > 0);
  assert.ok(part(r, "reliability") > 0);
  assert.equal(r.flags.length, 0);
});

test("paying yourself through a sub-account counts for nothing", () => {
  const r = scoreReport(input("scout.testnet", [job({ agent: "scout.testnet", customer: "client.scout.testnet" })]));
  assert.equal(r.totals.counted, 0);
  assert.equal(r.score, 0);
  assert.match(r.flags[0].words, /sub-account of scout.testnet/);
});

test("the maker's other accounts, a shared key and a shared private creator are the same hand", () => {
  const f = facts({
    "scout.testnet": { keys: ["ed25519:A"], creator: "maker.testnet" },
    "twin.testnet": { keys: ["ed25519:A"], creator: "testnet" },
    "sibling.testnet": { keys: ["ed25519:B"], creator: "maker.testnet" },
    "maker.testnet": { keys: ["ed25519:C"], creator: "testnet" },
    "stranger.testnet": { keys: ["ed25519:D"], creator: "testnet" },
  });
  const same = sameHandFrom(f);
  assert.match(same("scout.testnet", "twin.testnet")!, /share an access key/);
  assert.match(same("scout.testnet", "sibling.testnet")!, /both created by maker.testnet/);
  assert.match(same("scout.testnet", "maker.testnet")!, /maker.testnet created scout.testnet/);
  assert.equal(same("scout.testnet", "stranger.testnet"), null, "the faucet made both: no link");
  assert.match(same("a.team.testnet", "b.team.testnet")!, /both sub-accounts of team.testnet/);
  assert.equal(parentOf("factor-scout.testnet"), null, "a top-level account has no parent");
});

test("Factor's own accounts are never a paying client", () => {
  const r = scoreReport(input("scout.testnet", [job({ agent: "scout.testnet", customer: "fees.desk.testnet" })]));
  assert.equal(r.totals.counted, 0);
  assert.match(r.flags[0].words, /Factor's own/);
});

test("a NEAR Intents carrier is not the customer: the customer it names is", () => {
  const ok = scoreReport(input("scout.testnet", [job({ agent: "scout.testnet", customer: "acme.testnet", payer: "intents.near" })]));
  assert.equal(ok.totals.counted, 1);
  const own = scoreReport(input("scout.testnet", [job({ agent: "scout.testnet", customer: "client.scout.testnet", payer: "intents.near" })]));
  assert.equal(own.totals.counted, 0, "naming your own account as the customer through Intents still does not count");
});

test("a sub-job whose money traces back to the sub-agent's own hand does not count for it", () => {
  // the checker's own account pays the scout, the scout hires the checker: the money went in a circle
  const parent = job({ id: 100, agent: "scout.testnet", customer: "client.checker.testnet" });
  const sub = job({ id: 101, agent: "checker.testnet", customer: "scout.testnet", parent: 100 });
  const byId = new Map([parent, sub].map((j) => [j.id, j]));
  const x = input("checker.testnet", [parent, sub]);
  assert.match(ownMoney("checker.testnet", sub, byId, x)!, /sub-account of checker.testnet/);
  assert.equal(scoreReport(x).totals.counted, 0);
});

test("an honest sub-job counts for the sub-agent and for the agent that hired and paid it", () => {
  const parent = job({ id: 200, agent: "scout.testnet", customer: "acme.testnet", reserved: (NEAR / 2n).toString() });
  const sub = job({ id: 201, agent: "checker.testnet", customer: "scout.testnet", parent: 200, price: (NEAR / 2n).toString() });
  const checker = scoreReport(input("checker.testnet", [parent, sub]));
  assert.equal(checker.totals.counted, 1);
  const scout = scoreReport(input("scout.testnet", [parent, sub]));
  assert.equal(part(scout, "hiring"), FORMULA.hiring.perAgent);
});

test("hiring your own hand earns nothing for hiring", () => {
  const parent = job({ id: 300, agent: "scout.testnet", customer: "acme.testnet" });
  const sub = job({ id: 301, agent: "helper.scout.testnet", customer: "scout.testnet", parent: 300 });
  assert.equal(part(scoreReport(input("scout.testnet", [parent, sub])), "hiring"), 0);
});

test("defaults, misses and halves pull the score whoever the customer was", () => {
  const jobs = [
    job({ agent: "scout.testnet", customer: "acme.testnet" }),
    job({ agent: "scout.testnet", customer: "acme.testnet", status: "Refunded", advanced: NEAR.toString(), delivered_ms: null }),
    job({ agent: "scout.testnet", customer: "client.scout.testnet", status: "Refunded", delivered_ms: null }),
    job({ agent: "scout.testnet", customer: "acme.testnet", status: "Half" }),
  ];
  const r = scoreReport(input("scout.testnet", jobs));
  const pulls = Object.fromEntries(r.pulls.map((p) => [p.key, p.count]));
  assert.deepEqual(pulls, { default: 1, missed: 1, half: 1 });
  assert.ok(r.score >= 0);
});

test("a rejected job counts half its value", () => {
  const full = scoreReport(input("scout.testnet", [job({ agent: "scout.testnet", customer: "acme.testnet", status: "Paid" })]));
  const half = scoreReport(input("scout.testnet", [job({ agent: "scout.testnet", customer: "acme.testnet", status: "Half" })]));
  assert.ok(half.totals.earnedNear === full.totals.earnedNear / 2);
});

test("many small repayments in one month are worth less than the same spread over months", () => {
  const burst = Array.from({ length: 6 }, (_, k) => job({ agent: "a.testnet", customer: `c${k}.testnet`, advanced: (NEAR / 2n).toString(), closed_ms: String(T0 + k * 1000) }));
  const spread = Array.from({ length: 6 }, (_, k) => job({ agent: "a.testnet", customer: `c${k}.testnet`, advanced: (NEAR / 2n).toString(), closed_ms: String(T0 + k * 31 * DAY) }));
  assert.ok(part(scoreReport(input("a.testnet", burst)), "repayment") < part(scoreReport(input("a.testnet", spread)), "repayment"));
});

test("token jobs are valued at the token's price, and without a price they are flagged, not guessed", () => {
  const j = job({ agent: "scout.testnet", customer: "acme.testnet", token: "tusd.testnet", price: "20000000" });
  const valued = scoreReport(input("scout.testnet", [j]));
  assert.equal(valued.totals.earnedNear, 5, "20 test dollars at $4 a NEAR");
  const unpriced = scoreReport(input("scout.testnet", [j], facts({}), { nearPerUnit: {} }));
  assert.equal(unpriced.totals.earnedNear, 0);
  assert.ok(unpriced.flags.some((f) => f.key === "no-price"));
});

test("every part stays within its maximum and the score within 0 and 1000", () => {
  const jobs = Array.from({ length: 40 }, (_, k) =>
    job({ agent: "big.testnet", customer: `c${k % 9}.testnet`, price: (10n * NEAR).toString(), advanced: NEAR.toString(), closed_ms: String(T0 + k * 5 * DAY) }),
  );
  const r = scoreReport(input("big.testnet", jobs));
  for (const p of r.parts) assert.ok(p.points <= p.max && p.points >= 0, p.key);
  assert.ok(r.score <= 1000);
});

test("a new account is flagged fresh", () => {
  const r = scoreReport(input("scout.testnet", [], facts({}), { createdMs: T0 + 99 * DAY }));
  assert.ok(r.flags.some((f) => f.key === "fresh"));
});

test("the same input always gives the same report", () => {
  const jobs = [job({ id: 900, agent: "scout.testnet", customer: "acme.testnet", advanced: NEAR.toString() })];
  assert.deepEqual(scoreReport(input("scout.testnet", jobs)), scoreReport(input("scout.testnet", jobs)));
});
