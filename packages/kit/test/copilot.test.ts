// Factor Copilot in the kit, against a made-up site that answers with the engine's own Copilot (engine/src/copilot.ts)
// reading by its plain rules on a desk made by hand: the message, the conversation, the wallet and the time zone are what
// is sent, the answer is the engine's to the letter, a refusal comes back in words with its code, and the tool an
// assistant gets says the reply, the prepared card with its calls and the link where the person signs, and nothing else.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Copilot as EngineCopilot, readCopilot, type CopilotData } from "../../../engine/src/copilot.js";
import { open } from "../../../engine/src/chain/db.js";
import { copilot, copilotText, Factor, Refusal, type Copiloted } from "../src/index.js";
import { runTool, TOOLS } from "../src/tools.js";
import { stub, type Stub } from "./stub.js";

let s: Stub;
beforeAll(async () => { s = await stub(); });
afterAll(async () => { await s.close(); });
const LEAD = "0x74325c9644973d9c7a293bdfc970a573a38419e1";
const DESK = "0x487eb282e9aa56ae871c15a16c5b061b9d2faa6f";
const NOW = 1_793_836_800;
const data: CopilotData = {
  candidates: [{ kind: "agent", name: "report-lead", address: LEAD, does: "Writes short market notes and price sheets", fromWei: null, score: 287, settled: 18, settledAtHalf: 0, customers: 3, onTime: 18, late: 0, house: false, guarantee: null, verified: null }],
  settled: [30, 31, 32].map((id) => ({ id, agent: LEAD, priceWei: 10n ** 15n, title: "A price sheet of ETH" })),
  ethUsd8: "241883000000", stages: false, covers: false, nowS: NOW, chainId: 4663,
  contracts: { desk: DESK, guarantee: null, bounty: null, milestones: null }, bountyMinWei: 5n * 10n ** 15n, paused: null,
  job: () => null, jobsOf: () => [], agent: () => null,
};
const engine = new EngineCopilot(open(":memory:"), readCopilot({ COPILOT: "on" }), { model: null, now: () => NOW * 1000 });
beforeEach(() => {
  s.site.copilot = async (b) => { const r = await engine.message(b, "1.1.1.1", data); return r.ok ? { status: 200, body: JSON.parse(JSON.stringify(r.answer)) } : { status: r.status, body: { error: r.error } }; };
});

describe("copilot", () => {
  it("sends the message, the conversation, the wallet and the time zone, and hands back the engine's answer", async () => {
    const a = await copilot("  I need a price sheet of ETH by tomorrow  ", { api: s.api, tz: 60, address: "0x50A9Bf50C3337d5db03efdF89DEB0F5A0B908f17" });
    expect(s.posts.at(-1)).toMatchObject({ path: "/copilot", body: { text: "I need a price sheet of ETH by tomorrow", tz: 60, address: "0x50a9bf50c3337d5db03efdf89deb0f5a0b908f17" } });
    expect(a.reply).toMatchObject({ kind: "question" });
    expect(a.reply.text).toMatch(/How much at most/);
    const b = await copilot("0.002 ETH at most", { api: s.api, conversation: a.conversation });
    expect(s.posts.at(-1)!.body).toMatchObject({ conversation: a.conversation });
    expect(b.reply.action).toMatchObject({ kind: "hire", totalWei: "1000000000000000", agent: { name: "report-lead", address: LEAD } });
    expect(b.reply.action!.calls[0]).toMatchObject({ to: DESK, contract: "desk", fn: "lock", value: "1000000000000000" });
    // a conversation that is not one is not sent
    await copilot("hello", { api: s.api, conversation: "nope" });
    expect(s.posts.at(-1)!.body).toEqual({ text: "hello" });
  });

  it("says no in words, with a code an app can act on", async () => {
    const before = s.posts.length;
    await expect(copilot("   ", { api: s.api })).rejects.toMatchObject({ code: "bad_copilot" });
    expect(s.posts.length).toBe(before);
    s.site.copilot = async () => ({ status: 429, body: { error: "too many messages: try again in a minute" } });
    await expect(copilot("hello", { api: s.api })).rejects.toThrow(new Refusal("Too many messages: try again in a minute.", "rate"));
    s.site.copilot = null;
    await expect(copilot("hello", { api: s.api })).rejects.toMatchObject({ code: "copilot_off" });
    await expect(copilot("hello", { api: "http://127.0.0.1:9" })).rejects.toMatchObject({ code: "no_site" });
  });

  it("the tool: the reply, the card with its calls, and the link where the person signs; it signs and pays nothing", async () => {
    const f = await Factor.connect({ api: s.api, rpcUrl: s.rpc });
    const tool = TOOLS.find((t) => t.name === "factor_copilot")!;
    expect(tool.readOnly).toBe(true);
    const first = await runTool(f, "factor_copilot", { message: "I need a price sheet of ETH by tomorrow", tz_minutes: 60 }, null);
    expect(first.isError).toBe(false);
    const id = /Conversation: ([0-9a-f]{32})/.exec(first.text)![1]!;
    const { text } = await runTool(f, "factor_copilot", { message: "0.002 ETH", conversation: id }, null);
    expect(text).toContain("Prepared, not signed: Lock 0.001 ETH for report-lead");
    expect(text).toContain(`Call 1: lock on ${DESK} (desk), value 0.001 ETH.`);
    expect(text).toContain(`/copilot?c=${id} and press Sign in wallet`);
    expect(text).toMatch(/Nothing is paid until they do\./);
    const again = await copilot("hello", { api: s.api });
    expect(copilotText(again as Copiloted)).toMatch(/I never sign or send anything/);
  });
});
