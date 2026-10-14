import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { DeskMind, keepsToFacts, plainText, allowedNumbers, ethOf, type Writer } from "../src/deskmind.js";
import { EngineApi, type EngineView } from "../src/api.js";

const FILE = { agent: "page-smith", barred: false, settled: 12, customers: 9, onTime: 11, late: 1, half: 0, notDelivered: 0, repaid: 4, notRepaid: 0, bondEth: "0.05", feesEth: "0.0312", limitEth: "0.0812", canDrawEth: "0.0612", score: 412 };

const said = (text: string, input = 900, output = 120): Writer => async () => ({ text, input, output });

describe("the Desk: keeping to its facts", () => {
  it("writes every kind of note plainly from its facts alone", () => {
    expect(plainText("file", FILE)).toBe("page-smith: 12 jobs settled for 9 customers, 11 on time and 1 late; 4 advances repaid. Bond 0.05 ETH, fees paid in 0.0312 ETH, so it may draw up to 0.0812 ETH from the pool; 0.0612 ETH is free now. Score 412 of 1000.");
    expect(plainText("opening", { agent: "red-pen", does: "proofreads a text", fromEth: "0.001" })).toMatch(/^red-pen: proofreads a text\. No record yet, so/);
    expect(plainText("reason", { agent: "red-pen", job: 418, kind: "pool", amountEth: "0.2", jobEth: "0.4", limitEth: "0.5" })).toMatch(/drew 0\.2 ETH from the pool on job 418: within half of the 0\.4 ETH locked, and within its limit of 0\.5 ETH/);
    expect(plainText("letter", { launched: false, day: "2026-10-14", firstBlock: "88,100,000", lastBlock: "88,445,600", gwei: 0.02 })).toMatch(/from block 88,100,000 to block 88,445,600, gas at 0\.02 gwei/);
    expect(plainText("file", { ...FILE, barred: true })).toMatch(/is barred/);
  });

  it("lets a worded note through only when every number in it is one of its facts", () => {
    expect(keepsToFacts("page-smith has settled 12 jobs for 9 customers and repaid all 4 advances, so it may draw up to 0.0812 ETH.", FILE)).toBe(true);
    expect(keepsToFacts("page-smith has settled 13 jobs.", FILE)).toBe(false); // a number that is not in its facts
    expect(keepsToFacts("page-smith's score of 412 puts it in the top 10%.", FILE)).toBe(false);
    expect(keepsToFacts("It can draw up to half a job; its record shows 12 jobs settled.", FILE)).toBe(true);
    expect(keepsToFacts("A fine investment: 12 jobs settled.", FILE)).toBe(false); // a word the site never uses
    expect(keepsToFacts("12 jobs settled — all on time.", FILE)).toBe(false); // no em dashes
    expect(allowedNumbers(FILE).has("0.0812")).toBe(true);
    expect(ethOf(123_456_789_000_000_000n)).toBe("0.1234");
  });
});

describe("the Desk: writing", () => {
  it("keeps a worded note that keeps to its facts, with what it cost", async () => {
    const d = new DeskMind(new Database(":memory:"), { writer: said("page-smith has settled 12 jobs for 9 customers; it may draw up to 0.0812 ETH from the pool.") });
    const n = await d.write("file", "0xabc", FILE);
    expect(n.model).toBe("claude-haiku-4-5-20251001");
    expect(n.text).toMatch(/^page-smith has settled 12 jobs/);
    expect(n.costUsd).toBeCloseTo((900 * 1 + 120 * 5) / 1e6, 9);
    expect(d.latest("file", "0xabc")?.id).toBe(n.id);
  });

  it("writes the plain version when the model makes a number up, fails, or there is no key", async () => {
    const made = await new DeskMind(new Database(":memory:"), { writer: said("page-smith settled 40 jobs.") }).write("file", "0xabc", FILE);
    expect(made).toMatchObject({ model: null, text: plainText("file", FILE) });
    const failing: Writer = async () => { throw new Error("down"); };
    expect((await new DeskMind(new Database(":memory:"), { writer: failing }).write("file", "0xabc", FILE)).model).toBeNull();
    expect((await new DeskMind(new Database(":memory:")).write("file", "0xabc", FILE)).text).toBe(plainText("file", FILE));
  });

  it("stops asking the model once the day's ceiling is reached, and goes on writing plainly", async () => {
    let asked = 0;
    const writer: Writer = async () => { asked++; return { text: "page-smith has settled 12 jobs.", input: 1_000_000, output: 0 }; }; // a dollar a note
    const d = new DeskMind(new Database(":memory:"), { writer, dailyUsd: 2 });
    for (let i = 0; i < 4; i++) await d.write("file", `0x${i}`, FILE);
    expect(asked).toBe(2);
    expect(d.recent(10).filter((n) => n.model === null)).toHaveLength(2);
  });
});

describe("the Desk: what is due", () => {
  /** A view of an engine that reads no chain: the Desk, and a pulse with a whole day read. */
  const view = (d: DeskMind, now: number, yesterday: unknown = null): EngineView => ({ deskMind: d, pulse: { yesterday: () => yesterday, latest: () => [] }, now: () => now, state: "off", ctx: null, config: {} } as unknown as EngineView);

  it("writes an opening file for each of Factor's own agents, a few each pass, and never twice", async () => {
    const d = new DeskMind(new Database(":memory:"));
    const api = new EngineApi(() => view(d, Date.UTC(2026, 9, 14, 3)));
    expect(await api.deskPass(view(d, Date.UTC(2026, 9, 14, 3)))).toBe(3);
    for (let i = 0; i < 10; i++) await api.deskPass(view(d, Date.UTC(2026, 9, 14, 3)));
    expect(d.recent(100, ["opening"])).toHaveLength(15);
    expect(await api.deskPass(view(d, Date.UTC(2026, 9, 14, 3)))).toBe(0);
    const json = api.deskJson(view(d, Date.UTC(2026, 9, 14, 3)));
    expect(json).toMatchObject({ on: true, writing: false, letter: null });
    expect(json.latest).toHaveLength(8);
  });

  it("writes the letter on the day before soon after midnight, from the blocks it read, once", async () => {
    const d = new DeskMind(new Database(":memory:"));
    for (let i = 0; i < 5; i++) await new EngineApi(() => view(d, 0)).deskPass(view(d, Date.UTC(2026, 9, 14, 3))); // the openings first
    const y = { day: "2026-10-14", firstBlock: 88_100_000, lastBlock: 88_445_600, reads: 14_000, gwei: 0.02 };
    const api = new EngineApi(() => view(d, 0));
    expect(await api.deskPass(view(d, Date.UTC(2026, 9, 15, 0, 2), y))).toBe(0); // not before five past midnight
    expect(await api.deskPass(view(d, Date.UTC(2026, 9, 15, 0, 6), y))).toBe(1);
    expect(d.latest("letter", "2026-10-14")?.text).toMatch(/from block 88,100,000 to block 88,445,600/);
    expect(await api.deskPass(view(d, Date.UTC(2026, 9, 15, 6), y))).toBe(0);
  });
});
