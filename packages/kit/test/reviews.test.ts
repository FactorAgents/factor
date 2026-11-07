// Paid reviews in the kit, against a made-up site: reading an agent's reviews and a job's, in data and in words; a
// customer's review and an agent's reply signed with the key as EIP-712 typed data that the engine's own code
// (engine/src/reviews.ts) recovers to that key; the words put in the same plain form as the engine and the site put
// them; refusals before anything is signed; and the two tools an assistant gets.
import { hashTypedData, recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { replyTyped as engineReplyTyped, reviewText as engineReviewText, reviewTyped as engineReviewTyped } from "../../../engine/src/reviews.js";
import { Factor, reviewOf, reviews, reviewsText, reviewText, reviewTyped, type AgentReviews, type Review } from "../src/index.js";
import { runTool, TOOLS } from "../src/tools.js";
import { AGENTS, DESK, KEY, stub, type Stub } from "./stub.js";

let s: Stub;
beforeAll(async () => { s = await stub(); });
afterAll(async () => { await s.close(); });
const ME = privateKeyToAccount(KEY).address.toLowerCase();
const AGENT = AGENTS[0].address;
const review = (over: Partial<Review> = {}): Review => ({
  job: 12, jobId: "0012", agent: AGENT, reviewer: ME, stars: 4, text: "Every clause, with its page.", hidden: false, priceEth: 0.04, priceWei: "40000000000000000", outcome: "paid in full", kind: "job",
  paidAt: "2026-10-13T10:00:00.000Z", at: "2026-10-13T11:00:00.000Z", firstAt: "2026-10-13T11:00:00.000Z", version: 1, notCounted: null, self: null, history: [], reply: null, erc8004: null,
  digest: `0x${"ab".repeat(32)}`, signature: `0x${"5e".repeat(65)}`, ...over,
});
const standing = (over: Record<string, unknown> = {}) => ({ reviewer: ME, kind: "job", open: true, why: null, until: "2026-11-12T10:00:00.000Z", editUntil: null, versionsLeft: 5, replyUntil: null, repliers: [AGENT], identity: null, ...over });
let jobAnswer: Record<string, unknown>;
beforeEach(() => {
  jobAnswer = { enabled: true, job: 12, agent: AGENT, review: null, standing: standing() };
  s.site.reviews = async (method, path, body) => {
    if (method === "GET" && path.startsWith("/reviews/agent/")) return { status: 200, body: { enabled: true, agent: AGENT, name: "lumen-07", average: 4.5, count: 2, notCounted: 1, items: [review(), review({ job: 11, jobId: "0011", stars: 5, text: "", reply: { by: AGENT, text: "Thank you.", hidden: false, at: "2026-10-12T12:00:00.000Z", version: 1, toEarlier: false } }), review({ job: 10, jobId: "0010", stars: 5, notCounted: "self-dealing", self: "the agent's own wallet" })], repliers: [AGENT] } satisfies AgentReviews };
    if (method === "GET" && path === "/reviews/job/12") return { status: 200, body: jobAnswer };
    if (method === "POST" && (path === "/reviews" || path === "/reviews/reply")) return { status: 200, body: { ok: true, review: review({ stars: Number((body as { stars?: number }).stars ?? 4) }) } };
    return { status: 404, body: { error: "no such job" } };
  };
});

describe("reading", () => {
  it("an agent's reviews and a job's, in data and in words; off is said with its code", async () => {
    const r = await reviews("lumen-07", { api: s.api });
    expect(r).toMatchObject({ average: 4.5, count: 2, notCounted: 1 });
    const t = reviewsText(r, { api: s.api });
    expect(t).toMatch(/^lumen-07: 4\.5 of 5 from 2 paid reviews, weighted by what each job paid; 1 more left out/);
    expect(t).toContain('The customer wrote: "Every clause, with its page."');
    expect(t).toContain('lumen-07 answered: "Thank you."');
    expect(t).toContain("(not counted: self-dealing, the agent's own wallet)");
    expect(t).toContain("Reviews never change the Factor Score.");
    expect((await reviewOf(12, { api: s.api })).standing.reviewer).toBe(ME);
    s.site.reviews = async () => ({ status: 200, body: { enabled: false } });
    await expect(reviews("lumen-07", { api: s.api })).rejects.toMatchObject({ code: "reviews_off" });
    expect(() => reviews("not an agent!", { api: s.api })).toThrow(/Name the agent/);
  });

  it("puts words in the same plain form as the engine, and builds the same typed data", () => {
    for (const w of ["Great \u{1F680} work\u{200B}", "a\r\n\r\n\r\nb\tc", "x".repeat(500), "x".repeat(501), "left \u{2190} right \u{2192} up \u{2191}"]) expect(reviewText(w)).toBe(engineReviewText(w));
    const o = { chainId: 4663, desk: DESK, job: 12, agent: AGENT, reviewer: ME, stars: 4, text: "ok", at: 1_800_000_000 };
    expect(hashTypedData(reviewTyped(o))).toBe(hashTypedData(engineReviewTyped(o)));
  });
});

describe("signing", () => {
  it("a review: signed with the key, as the engine checks it, and handed to the site", async () => {
    const f = await Factor.connect({ api: s.api, rpcUrl: s.rpc, privateKey: KEY });
    const r = await f.review(12, 4, "Every clause,   with its page. \u{1F680}");
    expect(r.stars).toBe(4);
    const sent = s.posts.at(-1)!;
    expect(sent.path).toBe("/reviews");
    const b = sent.body as { job: number; stars: number; text: string; at: number; reviewer: string; signature: Hex };
    expect(b).toMatchObject({ job: 12, stars: 4, text: "Every clause, with its page.", reviewer: ME });
    const who = await recoverTypedDataAddress({ ...engineReviewTyped({ chainId: 4663, desk: DESK, job: 12, agent: AGENT, reviewer: ME, stars: 4, text: b.text, at: b.at }), signature: b.signature });
    expect(who.toLowerCase()).toBe(ME);
  });

  it("refuses before signing: no key, stars out of range, another wallet's job, a job closed to reviews", async () => {
    const before = s.posts.length;
    const reader = await Factor.connect({ api: s.api, rpcUrl: s.rpc });
    await expect(reader.review(12, 5)).rejects.toMatchObject({ code: "read_only" });
    const f = await Factor.connect({ api: s.api, rpcUrl: s.rpc, privateKey: KEY });
    await expect(f.review(12, 6)).rejects.toMatchObject({ code: "bad_stars" });
    await expect(f.review(12, 5, "x".repeat(501))).rejects.toMatchObject({ code: "bad_text" });
    jobAnswer = { ...jobAnswer, standing: standing({ reviewer: AGENTS[1].address }) };
    await expect(f.review(12, 5)).rejects.toMatchObject({ code: "not_yours" });
    jobAnswer = { ...jobAnswer, standing: standing({ open: false, why: "the 30 days to review this job are over" }) };
    await expect(f.review(12, 5)).rejects.toThrow(/30 days to review this job are over/);
    expect(s.posts.length).toBe(before);
  });

  it("an agent's one reply: to the review's digest, signed as the engine checks it; never twice", async () => {
    const f = await Factor.connect({ api: s.api, rpcUrl: s.rpc, privateKey: KEY });
    jobAnswer = { ...jobAnswer, review: review(), standing: standing({ repliers: [ME] }) };
    await f.reply(12, "Thank you: the page numbers are there to check.");
    const b = s.posts.at(-1)!.body as { job: number; text: string; at: number; by: string; review: Hex; signature: Hex };
    expect(b).toMatchObject({ job: 12, by: ME, review: `0x${"ab".repeat(32)}` });
    const who = await recoverTypedDataAddress({ ...engineReplyTyped({ chainId: 4663, desk: DESK, job: 12, agent: AGENT, by: ME, review: b.review, text: b.text, at: b.at }), signature: b.signature });
    expect(who.toLowerCase()).toBe(ME);
    jobAnswer = { ...jobAnswer, review: review({ reply: { by: ME, text: "x", hidden: false, at: "", version: 1, toEarlier: false } }) };
    await expect(f.reply(12, "again")).rejects.toMatchObject({ code: "replied" });
    jobAnswer = { ...jobAnswer, review: review(), standing: standing() };
    await expect(f.reply(12, "not mine")).rejects.toMatchObject({ code: "not_yours" });
  });
});

describe("the tools", () => {
  it("factor_reviews reads; factor_review_reply signs a reply and moves nothing", async () => {
    expect(TOOLS.find((t) => t.name === "factor_reviews")!.readOnly).toBe(true);
    expect(TOOLS.find((t) => t.name === "factor_review_reply")!.readOnly).toBe(false);
    const reader = await Factor.connect({ api: s.api, rpcUrl: s.rpc });
    const a = await runTool(reader, "factor_reviews", { agent: "lumen-07" }, null);
    expect(a.isError).toBe(false);
    expect(a.text).toMatch(/4\.5 of 5 from 2 paid reviews/);
    jobAnswer = { ...jobAnswer, review: review() };
    expect((await runTool(reader, "factor_reviews", { agent: "lumen-07", job: 12 }, null)).text).toMatch(/^Job 0012, 0\.04 ETH, paid in full: 4 of 5 from its customer/);
    const f = await Factor.connect({ api: s.api, rpcUrl: s.rpc, privateKey: KEY });
    jobAnswer = { ...jobAnswer, review: review(), standing: standing({ repliers: [ME] }) };
    const b = await runTool(f, "factor_review_reply", { job: 12, words: "Thank you." }, null);
    expect(b).toMatchObject({ isError: false });
    expect(b.text).toMatch(/^Answered\./);
  });
});
