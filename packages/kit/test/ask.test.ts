// Ask Factor in the kit, against a made-up site that answers with the engine's own Ask (engine/src/ask.ts) reading by
// its plain rules: the sentence and the person's time zone are what is sent, the answer is the engine's to the letter,
// a refusal comes back in words with its code, and the tool an assistant gets says the job, the price and where it came
// from, each agent with its reasons and its link, and that nothing is paid by asking.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Ask as EngineAsk, plainRead, readAsk, type AskData } from "../../../engine/src/ask.js";
import { open } from "../../../engine/src/chain/db.js";
import { ask, askedText, Factor, Refusal, type Asked } from "../src/index.js";
import { runTool, TOOLS } from "../src/tools.js";
import { stub, type Stub } from "./stub.js";

let s: Stub;
beforeAll(async () => { s = await stub(); });
afterAll(async () => { await s.close(); });
const PAGE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const data: AskData = {
  candidates: [{ kind: "agent", name: "page-maker", address: PAGE, does: "Builds a landing page from a short brief", fromWei: 3n * 10n ** 15n, score: 412, settled: 6, settledAtHalf: 0, customers: 4, onTime: 6, late: 0, house: true, guarantee: { upToEth: 0.002, sharePct: 50 }, verified: null }],
  settled: [{ id: 21, agent: PAGE, priceWei: 4n * 10n ** 15n, title: "A landing page for a bakery" }, { id: 22, agent: PAGE, priceWei: 5n * 10n ** 15n, title: "A landing page for a band" }, { id: 23, agent: PAGE, priceWei: 6n * 10n ** 15n, title: "A landing page" }],
  ethUsd8: "250000000000", stages: true, covers: true, nowS: 1_793_836_800 + 10 * 3600,
};
// the engine's own answer to a sentence, read by its plain rules
const engine = new EngineAsk(open(":memory:"), readAsk({ ASK: "on" }), { model: null });
const answerTo = (text: string, tz = 0) => engine.build(text, plainRead(text), "plain", tz, data);
beforeEach(() => {
  s.site.ask = (b) => (typeof b.text === "string" && b.text.length >= 8 ? { status: 200, body: answerTo(b.text, typeof b.tz === "number" ? b.tz : 0) } : { status: 400, body: { error: "say a little more: what you want done, and anything it must have" } });
});

describe("ask", () => {
  it("sends the sentence and the time zone, and hands back the engine's answer as it is", async () => {
    const sentence = "A landing page for my coin by Friday, under 0.02 ETH, with a guarantee";
    const a = await ask(`  ${sentence}  `, { api: s.api, tz: 60 });
    expect(s.posts.at(-1)).toMatchObject({ path: "/ask", body: { text: sentence, tz: 60 } });
    expect(a).toEqual(JSON.parse(JSON.stringify(answerTo(sentence, 60))));
    expect(a.job).toMatchObject({ title: "A landing page for my coin", priceEth: "0.005", cover: true });
    expect(a.price).toMatchObject({ basis: "similar", similar: 3, medianEth: "0.005", budgetEth: "0.02" });
    expect(a.agents[0]).toMatchObject({ name: "page-maker", priceEth: "0.005", coverEth: "0.002" });
    const hire = new URL(a.agents[0]!.hire);
    expect(Object.fromEntries(hire.searchParams)).toMatchObject({ agent: "page-maker", price: "0.005", cover: "1", via: "ask" });
    // a time zone that is not one is not sent
    await ask(sentence, { api: s.api, tz: 9999 });
    expect(s.posts.at(-1)!.body).toEqual({ text: sentence });
  });

  it("says no in words, with a code an app can act on", async () => {
    const before = s.posts.length;
    await expect(ask("hi", { api: s.api })).rejects.toMatchObject({ code: "bad_ask" });
    expect(s.posts.length).toBe(before); // nothing was sent for "hi"
    s.site.ask = () => ({ status: 429, body: { error: "too many asks: try again in a minute" } });
    await expect(ask("A landing page for my coin", { api: s.api })).rejects.toThrow(new Refusal("Too many asks: try again in a minute.", "rate"));
    s.site.ask = null;
    await expect(ask("A landing page for my coin", { api: s.api })).rejects.toMatchObject({ code: "ask_off", message: "Ask Factor is resting just now: pick an agent from the list and hire it from the form." });
    await expect(ask("A landing page for my coin", { api: "http://127.0.0.1:9" })).rejects.toMatchObject({ code: "no_site" });
  });

  it("the tool: the job, the price and where it came from, each agent with its reasons and its link; it reads, and pays nothing", async () => {
    const f = await Factor.connect({ api: s.api, rpcUrl: s.rpc });
    expect((await f.ask("A landing page for my coin by Friday")).agents[0]!.name).toBe("page-maker");
    const tool = TOOLS.find((t) => t.name === "factor_ask")!;
    expect(tool.readOnly).toBe(true);
    const { text, isError } = await runTool(f, "factor_ask", { need: "A landing page for my coin by Friday, under 0.02 ETH", tz_minutes: 60 }, null);
    expect(isError).toBe(false);
    expect(s.posts.at(-1)!.body).toEqual({ text: "A landing page for my coin by Friday, under 0.02 ETH", tz: 60 });
    const a = answerTo("A landing page for my coin by Friday, under 0.02 ETH", 60) as unknown as Asked;
    expect(text).toBe(askedText(JSON.parse(JSON.stringify(a))));
    expect(text).toContain("Title: A landing page for my coin");
    expect(text).toContain("Price: 0.005 ETH. 3 jobs like it were paid in full on the desk, from 0.004 to 0.006 ETH; the middle of them is 0.005 ETH.");
    expect(text).toContain("1. page-maker, Factor Score 412, 0.005 ETH, cover up to 0.002 ETH.");
    expect(text).toContain("6 jobs paid in full for 4 customers, every one on time.");
    expect(text).toContain(`   Hire it: ${a.agents[0]!.hire}`);
    expect(text).toMatch(/Nothing is paid by asking or by opening the link\.$/);
    expect((await runTool(f, "factor_ask", { need: "hi" }, null)).isError).toBe(true);
  });
});
