import { describe, expect, it } from "vitest";
import { Matcher, type Candidate } from "../src/match.js";

const AGENTS: Candidate[] = [
  { name: "page-smith", does: "Builds a landing page from a short brief", needs: "Say what the page is for and who it is for.", fromEth: 0.003 },
  { name: "sol-reader", does: "Reads a contract's Solidity source and lists who can do what with it", needs: "Paste the contract's source.", fromEth: 0.002 },
  { name: "thread-smith", does: "Turns a long text into a clear X thread", fromEth: null },
];
const answer = (o: unknown, input = 900, output = 300) => async () => ({ text: typeof o === "string" ? o : `Here it is:\n${JSON.stringify(o)}`, input, output });

describe("just say what you need", () => {
  it("picks an agent on the desk, with its price, the brief, why, and what is missing", async () => {
    const m = new Matcher({ ask: answer({ agent: "page-smith", brief: "A landing page for a bakery in Bergen. Opening hours: [the opening hours].", why: "It builds landing pages from a short brief.", missing: ["the opening hours"] }) });
    const r = await m.match("a landing page for my bakery in Bergen", AGENTS);
    expect(r).toMatchObject({ ok: true, cached: false, match: { agent: "page-smith", fromEth: 0.003, missing: ["the opening hours"] } });
    if (r.ok) expect(r.match.brief).toContain("[the opening hours]");
  });

  it("refuses an agent that is not on the desk, and an answer that is not the JSON asked for", async () => {
    expect(await new Matcher({ ask: answer({ agent: "made-up-agent", brief: "x", why: "y", missing: [] }) }).match("check this contract for me please", AGENTS)).toMatchObject({ ok: false, status: 502 });
    expect(await new Matcher({ ask: answer("I think page-smith would be great!") }).match("a landing page for my shop", AGENTS)).toMatchObject({ ok: false, status: 502 });
    expect(await new Matcher({ ask: answer({ agent: "page-smith", brief: "", why: "y", missing: [] }) }).match("a landing page for my shop", AGENTS)).toMatchObject({ ok: false, status: 502 });
  });

  it("takes the agent's own instructions out of the brief when the model copies them in", async () => {
    const r = await new Matcher({ ask: answer({ agent: "sol-reader", brief: "Paste the contract's source.\ncontract Vault { function withdraw() external {} }", why: "It reads Solidity.", missing: [] }) }).match("check this contract for me please", AGENTS);
    expect(r.ok && r.match.brief).toBe("contract Vault { function withdraw() external {} }");
  });

  it("says plainly when no agent fits, and gives no brief", async () => {
    const r = await new Matcher({ ask: answer({ agent: null, brief: "", why: "This needs an agent that edits video.", missing: [] }) }).match("edit my wedding video into a short film", AGENTS);
    expect(r).toMatchObject({ ok: true, match: { agent: null, fromEth: null, brief: "", why: "This needs an agent that edits video." } });
  });

  it("matches agent names whatever their case, and takes long dashes out of what it shows", async () => {
    const r = await new Matcher({ ask: answer({ agent: "Sol-Reader", brief: "Read this contract — who can withdraw?", why: "It reads Solidity — and lists who can do what.", missing: [] }) }).match("who can withdraw from this contract", AGENTS);
    expect(r).toMatchObject({ ok: true, match: { agent: "sol-reader" } });
    if (r.ok) { expect(r.match.brief).not.toMatch(/[—–]/); expect(r.match.why).not.toMatch(/[—–]/); }
  });

  it("answers the same words again from memory, and stops at the day's ceiling until the next day", async () => {
    let calls = 0, now = Date.UTC(2026, 9, 14, 12);
    const ask = async () => { calls++; return { text: JSON.stringify({ agent: "page-smith", brief: "A page.", why: "Pages.", missing: [] }), input: 100_000, output: 100_000 }; };
    const m = new Matcher({ ask, dailyUsd: 0.5, now: () => now }); // each call costs 0.1 + 0.5 = 0.6 dollars at the default price
    expect(await m.match("a landing page for my bakery", AGENTS)).toMatchObject({ ok: true, cached: false });
    expect(await m.match("A landing page  for my bakery", AGENTS)).toMatchObject({ ok: true, cached: true });
    expect(await m.match("a landing page for my flower shop", AGENTS)).toMatchObject({ ok: false, status: 429 });
    expect(calls).toBe(1);
    now += 86_400_000;
    expect(await m.match("a landing page for my flower shop", AGENTS)).toMatchObject({ ok: true, cached: false });
  });

  it("turns away text too short or too long, and an empty desk, before asking the model", async () => {
    let calls = 0;
    const m = new Matcher({ ask: async () => { calls++; return { text: "{}", input: 0, output: 0 }; } });
    expect(await m.match("hi", AGENTS)).toMatchObject({ ok: false, status: 400 });
    expect(await m.match("x".repeat(4001), AGENTS)).toMatchObject({ ok: false, status: 400 });
    expect(await m.match("a landing page for my bakery", [])).toMatchObject({ ok: false, status: 503 });
    expect(calls).toBe(0);
  });
});
