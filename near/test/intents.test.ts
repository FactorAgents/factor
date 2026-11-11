import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ASSETS, checkLock, creditedJob, fundingQuote, lockMsg, noteOf, phaseOf } from "../intents/fund.ts";
import { OneClick, OneClickError } from "../intents/oneclick.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../intents/fixtures/${name}`, import.meta.url), "utf8"));
const BRIEF = "9f2b5c0e3d7a41f6b8c2e5a9d0f3b6c1e4a7d0b3c6f9e2a5d8b1c4f7a0d3e6b9";
const NOW = 1_800_000_000_000;
const RULES = { min_duration_ms: "300000", tokens: [{ token: "tusd.factor-desk.testnet", min_amount: "1000000" }] };

const msg = (o: Partial<{ customer: string; agent: string | null; dueMs: number; brief: string }> = {}) =>
  lockMsg({ customer: "factor-client.testnet", agent: "factor-scout.testnet", dueMs: NOW + 3_600_000, allowAdvance: true, brief: BRIEF, ref: "3f9a1c7e5b2d8f40", ...o });

test("the lock message has exactly the fields the desk reads", () => {
  const m = JSON.parse(msg());
  assert.deepEqual(Object.keys(m).sort(), ["agent", "allow_advance", "brief", "customer", "due_ms", "note"]);
  assert.equal(typeof m.due_ms, "string", "U64 travels as a string");
  assert.equal(m.note, noteOf("3f9a1c7e5b2d8f40"));
});

test("a message the desk would refuse is caught before any quote", () => {
  assert.deepEqual(checkLock(msg(), 25_000_000n, "tusd.factor-desk.testnet", RULES, NOW, 30), []);
  assert.match(checkLock(msg(), 25_000_000n, "usdc.fake", RULES, NOW, 30)[0], /does not take/);
  assert.match(checkLock(msg(), 999_999n, "tusd.factor-desk.testnet", RULES, NOW, 30)[0], /below the smallest job/);
  assert.match(checkLock(msg({ dueMs: NOW + 20 * 60_000 }), 25_000_000n, "tusd.factor-desk.testnet", RULES, NOW, 30)[0], /too soon for the swap/);
  assert.match(checkLock(msg({ brief: "hello" }), 25_000_000n, "tusd.factor-desk.testnet", RULES, NOW, 30)[0], /sha256/);
  assert.match(checkLock(msg({ customer: "Not An Account" }), 25_000_000n, "tusd.factor-desk.testnet", RULES, NOW, 30)[0], /not a NEAR account/);
  assert.match(checkLock(msg({ agent: "factor-client.testnet" }), 25_000_000n, "tusd.factor-desk.testnet", RULES, NOW, 30)[0], /cannot hire itself/);
});

test("the funding quote asks for exactly the price, delivered to the desk with the message, refunds to the origin chain", () => {
  const q = fundingQuote({ from: "base-usdc", refundTo: "0xabc", desk: "factor-desk.near", destinationAsset: ASSETS["near-usdc"], amount: 25_000_000n, msg: msg(), dry: true, nowMs: NOW });
  assert.equal(q.swapType, "EXACT_OUTPUT");
  assert.equal(q.amount, "25000000");
  assert.equal(q.recipient, "factor-desk.near");
  assert.equal(q.recipientType, "DESTINATION_CHAIN");
  assert.equal(q.refundType, "ORIGIN_CHAIN");
  assert.equal(q.customRecipientMsg, msg());
  assert.equal(q.deadline, new Date(NOW + 30 * 60_000).toISOString());
});

test("the request matches what the live 1Click API accepted in a recorded dry quote", () => {
  const live = fixture("quote-dry-live.json");
  const q = fundingQuote({ from: "base-usdc", refundTo: live.quoteRequest.refundTo, desk: live.quoteRequest.recipient, destinationAsset: ASSETS["near-usdc"], amount: 25_000_000n, msg: live.quoteRequest.customRecipientMsg, dry: true, nowMs: NOW });
  for (const k of ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "customRecipientMsg"] as const)
    assert.deepEqual(q[k], live.quoteRequest[k], k);
  assert.equal(live.quote.amountOut, "25000000", "EXACT_OUTPUT lands the exact price");
  assert.equal(live.quote.depositAddress, undefined, "a dry quote has no deposit address");
});

test("every 1Click status says what it means for the job", () => {
  assert.equal(phaseOf(null).phase, "unknown");
  assert.equal(phaseOf(fixture("status-pending.json")).phase, "waiting-for-deposit");
  assert.equal(phaseOf(fixture("status-processing.json")).phase, "swapping");
  const ok = phaseOf(fixture("status-success.json"));
  assert.deepEqual([ok.phase, ok.done], ["landed", true]);
  assert.match(ok.words, /25.0/);
  const back = phaseOf(fixture("status-refunded.json"));
  assert.deepEqual([back.phase, back.done], ["refunded", true]);
  assert.match(back.words, /DEADLINE_EXCEEDED/);
  assert.equal(phaseOf(fixture("status-incomplete.json")).phase, "short-deposit");
  assert.equal(phaseOf({ ...fixture("status-pending.json"), status: "FAILED" }).phase, "failed");
});

test("the credited job is found by the quote's reference, amount and token", () => {
  const jobs = [
    { id: 1, note: noteOf("aaaa"), price: "25000000", token: "tusd.factor-desk.testnet" },
    { id: 2, note: noteOf("3f9a1c7e5b2d8f40"), price: "24000000", token: "tusd.factor-desk.testnet" },
    { id: 3, note: noteOf("3f9a1c7e5b2d8f40"), price: "25000000", token: "tusd.factor-desk.testnet" },
  ];
  assert.equal(creditedJob(jobs, "3f9a1c7e5b2d8f40", 25_000_000n, "tusd.factor-desk.testnet")?.id, 3);
  assert.equal(creditedJob(jobs, "ffff", 25_000_000n, "tusd.factor-desk.testnet"), undefined);
});

function fakeFetch(status: number, body: unknown, seen: { url?: string; headers?: Record<string, string> } = {}): typeof fetch {
  return (async (url: string, init: any) => {
    seen.url = url;
    seen.headers = init?.headers;
    return new Response(JSON.stringify(body), { status });
  }) as any;
}

test("the client sends the JWT when there is one, and none otherwise", async () => {
  const seen: any = {};
  await new OneClick({ base: "https://x", jwt: "token", fetchImpl: fakeFetch(200, [], seen) }).tokens();
  assert.equal(seen.headers.authorization, "Bearer token");
  const seen2: any = {};
  await new OneClick({ base: "https://x", jwt: "", fetchImpl: fakeFetch(200, [], seen2) }).tokens();
  assert.equal(seen2.headers.authorization, undefined);
});

test("an unknown deposit address is null, a bad request is an error with 1Click's words", async () => {
  const live404 = fixture("status-404-live.json");
  assert.equal(await new OneClick({ base: "https://x", fetchImpl: fakeFetch(404, live404) }).status("0xabc"), null);
  await assert.rejects(new OneClick({ base: "https://x", fetchImpl: fakeFetch(400, { message: "refundTo is not valid" }) }).quote({} as any), (e: any) => e instanceof OneClickError && /refundTo is not valid/.test(e.message));
});

test("the status request carries the deposit memo when there is one", async () => {
  const seen: any = {};
  await new OneClick({ base: "https://x", fetchImpl: fakeFetch(200, fixture("status-pending.json"), seen) }).status("addr", "123");
  assert.equal(seen.url, "https://x/v0/status?depositAddress=addr&depositMemo=123");
});
