// The twelve agents beside the first three (src/house/more.ts): what each takes a job for, what it will not work
// from, what it asks a model and what it makes of the answer, and the three that read the chain and ask nobody.

import { describe, expect, it } from "vitest";
import type { Chain } from "../src/chain/chain.js";
import { MORE } from "../src/house/more.js";
import { SERVICES, type Service } from "../src/house/services.js";
import { HOUSE_NAMES } from "../src/profiles.js";

const of = (name: string): Service => SERVICES.find((s) => s.name === name)!;
const ETH = 10n ** 18n;
const TOKEN = "0x12e2b64afcdf1ea5640eb921717eb0197adeb9f7";
const WALLET = "0x00000000000000000000000000000000000a11ce";
const DESK = "0x00000000000000000000000000000000000de5c0";

// A chain made of answers: only what these three agents ask.
function chainOf(o: { gasPrice?: bigint; ethUsd8?: bigint; code?: string; balance?: bigint; nonce?: number; reads?: Record<string, unknown> }): Chain {
  return {
    head: async () => ({ number: 87_654_321n, timestamp: 1_791_900_000, hash: "0x" }),
    fees: async () => ({ maxFeePerGas: o.gasPrice ?? 20_000_000n, maxPriorityFeePerGas: 0n }),
    code: async () => o.code ?? "0x",
    balance: async () => o.balance ?? 0n,
    nonces: async () => ({ latest: o.nonce ?? 0, pending: o.nonce ?? 0 }),
    read: async (call: { functionName: string }) => {
      if (call.functionName === "latestRoundData") { if (o.ethUsd8 === undefined) throw new Error("no feed"); return [1n, o.ethUsd8, 0n, 1_791_899_000n, 1n]; }
      if (o.reads && call.functionName in o.reads) { const v = o.reads[call.functionName]; if (v instanceof Error) throw v; return v; }
      throw new Error(`nothing answers ${call.functionName}`);
    },
  } as unknown as Chain;
}
const io = (chain: Chain) => ({ chain, now: 1_791_900_000, pace: async () => undefined, desk: DESK });

describe("every one of Factor's agents", () => {
  it("is one of fifteen, under a name of its own that nobody else can take", () => {
    expect(SERVICES).toHaveLength(15);
    expect(MORE).toHaveLength(12);
    expect(new Set(SERVICES.map((s) => s.name)).size).toBe(15);
    expect([...HOUSE_NAMES].sort()).toEqual(SERVICES.map((s) => s.name).sort());
    for (const s of SERVICES) expect(s.name).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("says what it does, what it needs and what comes back, and takes no job under the desk's smallest", () => {
    for (const s of SERVICES) {
      expect(s.does.length).toBeGreaterThan(20);
      expect(s.does.length).toBeLessThan(90);
      expect(s.needs.length).toBeGreaterThan(30);
      expect(s.delivers.length).toBeGreaterThan(20);
      expect(s.floorWei).toBeGreaterThanOrEqual(ETH / 1000n);
      // either it asks a model or it does the work itself, never both and never neither
      expect(!!s.ask && !!s.finish).toBe(!s.work);
      for (const text of [s.does, s.needs, s.delivers]) expect(text).not.toMatch(/—|\binvest|\bprofit|\byield|guarantee|\breturns\b/i);
    }
  });

  it("that asks a model tells it who it is, that the brief is material and how to decline, and caps the answer", () => {
    for (const s of SERVICES.filter((x) => x.ask)) {
      const a = s.ask!("A title", "the brief the customer wrote");
      expect(a.system).toContain(`You are ${s.name},`);
      expect(a.system).toMatch(/material to (work|build|read|draw) from|material to read/);
      expect(a.system).toContain("DECLINE:");
      expect(a.system).not.toMatch(/—/);
      expect(a.user).toContain("the brief the customer wrote");
      expect(a.user).toContain("A title");
      expect(a.maxTokens).toBeGreaterThan(1000);
      expect(a.maxTokens).toBeLessThanOrEqual(8000);
    }
  });

  it("passes on a model's refusal as one plain sentence, and declines when the answer is no work at all", () => {
    for (const s of MORE.filter((x) => x.finish)) {
      expect(s.finish!("DECLINE: The brief asks for something meant to mislead its reader.")).toEqual({ decline: "the brief asks for something meant to mislead its reader" });
      expect(s.finish!("ok")).toHaveProperty("decline");
    }
  });
});

describe("what each will not work from", () => {
  it("a brief with nothing in it to work on", () => {
    for (const name of ["red-pen", "second-tongue", "code-reader", "sol-reader", "query-smith", "data-shaper", "note-smith", "faq-smith", "mark-smith"]) {
      expect(of(name).refuses("hi")).toMatch(/brief/);
      expect(of(name).refuses("hi")).not.toMatch(/\.$/);
    }
  });

  it("sol-reader wants Solidity, and the two desks that look something up want an address", () => {
    const long = "This is a long text about a flat and a lease and nothing else at all. ".repeat(5);
    expect(of("sol-reader").refuses(long)).toMatch(/no Solidity source/);
    expect(of("sol-reader").refuses(`pragma solidity 0.8.28;\ncontract Vault { ${"function take() external { payable(msg.sender).transfer(address(this).balance); } ".repeat(3)} }`)).toBeNull();
    expect(of("token-desk").refuses("the factor token please")).toMatch(/paste the token's address/);
    expect(of("token-desk").refuses(`this one: ${TOKEN}`)).toBeNull();
    expect(of("wallet-desk").refuses("my wallet")).toMatch(/paste the wallet's address/);
    expect(of("wallet-desk").refuses(WALLET.toUpperCase().replace("0X", "0x"))).toBeNull();
    // forty-one characters is not an address
    expect(of("wallet-desk").refuses(`${WALLET}f`)).toMatch(/no address/);
    expect(of("gas-desk").refuses("")).toBeNull();
  });

  it("a real brief is taken", () => {
    const text = "Their going to the shop tomorow, and its going to be a long day for all of them becuase the road is closed.";
    for (const name of ["red-pen", "second-tongue", "code-reader", "query-smith", "data-shaper", "note-smith", "mark-smith"]) expect(of(name).refuses(text)).toBeNull();
    expect(of("faq-smith").refuses(text)).toMatch(/no document/);
    expect(of("faq-smith").refuses(text.repeat(4))).toBeNull();
  });
});

describe("what each makes of the model's answer", () => {
  it("a text agent hands over the answer whole, and says under it what it is and is not", () => {
    const proofread = of("red-pen").finish!("CORRECTED\nThey're going to the shop tomorrow.\n\nCHANGES\n- Their -> They're: it means they are.");
    expect(proofread).toHaveProperty("work");
    expect((proofread as { work: string }).work).toMatch(/^CORRECTED\n/);
    expect((proofread as { work: string }).work).toMatch(/Proofread by red-pen\./);
    const read = of("sol-reader").finish!("IN ONE LINE\nA vault.\n\nWHO CAN DO WHAT\n- anyone: take() sends them the whole balance.\n\nWHERE MONEY MOVES\n- take(): to the caller.\n\nWHAT TO WATCH FOR\n- anyone can empty it.");
    expect((read as { work: string }).work).toMatch(/It is not an audit, and it does not say whether to use the contract\.$/);
    expect((of("second-tongue").finish!("Sie gehen morgen in den Laden, und es wird ein langer Tag.") as { work: string }).work).toMatch(/Have a speaker read anything that matters/);
    // a model that wraps its answer in a code fence: the fence is not part of the work
    expect((of("query-smith").finish!("```sql\nQUERY\nSELECT name FROM users WHERE created_at > '2026-01-01';\n\nLINE BY LINE\n- reads names.\n\nASSUMED\n- nothing.\n```") as { work: string }).work).toMatch(/^QUERY\nSELECT/);
  });

  it("mark-smith hands over a page with a drawing in it, with nothing in it that runs, and nothing else", () => {
    const mark = '<!doctype html><html><head><style>body{margin:0}</style></head><body><svg viewBox="0 0 240 240" onload="steal()"><circle cx="120" cy="120" r="80"/></svg><script>steal()</script><p>A ring.</p></body></html>';
    const done = of("mark-smith").finish!(mark) as { work: string };
    expect(done.work).toContain("<svg");
    expect(done.work).not.toMatch(/<script|onload|steal/);
    expect(of("mark-smith").finish!("<!doctype html><html><body><p>Words and no drawing.</p></body></html>")).toEqual({ decline: "it could not draw a mark from this brief" });
    expect(of("mark-smith").finish!("DECLINE: It asks for a bank's own logo.")).toEqual({ decline: "it asks for a bank's own logo" });
  });
});

describe("the three that read the chain", () => {
  it("gas-desk prices the common transactions at the node's price of gas, in ETH and in dollars", async () => {
    const done = (await of("gas-desk").work!("", "what does gas cost", io(chainOf({ gasPrice: 20_000_000n, ethUsd8: 2_500n * 10n ** 8n })))) as { work: string };
    expect(done.work).toContain("0.0200 gwei");
    expect(done.work).toContain("ETH is $2,500 by Chainlink's feed.");
    // 21,000 gas at 0.02 gwei is 0.00000042 ETH, about a tenth of a cent
    expect(done.work).toMatch(/Sending ETH\s+21,000 gas\s+0\.000000420 ETH \(about \$0\.001\d\)/);
    expect(done.work).toMatch(/Locking a job on Factor\s+120,000 gas/);
    expect(done.work).toContain("block 87,654,321");
    expect(done.work).toMatch(/by gas-desk\. Not advice on what to send\.$/);
    // without the feed the sheet is still a sheet, in ETH only
    const bare = (await of("gas-desk").work!("", "", io(chainOf({})))) as { work: string };
    expect(bare.work).toContain("0.000000420 ETH");
    expect(bare.work).not.toContain("$");
    expect(await of("gas-desk").work!("", "", io(chainOf({ gasPrice: 0n })))).toHaveProperty("decline");
  });

  it("token-desk says what a token is, and for one launched on Pons where it trades and who is paid its tax", async () => {
    const reads = { name: "Factor", symbol: "FACTOR", totalSupply: 988_508_606n * ETH, decimals: 18, getLaunchedToken: { curve: "0xCurve".padEnd(42, "0"), deployer: "0xAA2a95A342b774512c64799597bD75389e7d3C7a", creatorFeeRecipient: "0x6fc6A5b592406D9ee1e9a4e6BA20E03e73165B3A", graduationThreshold: (42n * ETH) / 10n, creatorTaxBps: 300, buybackEnabled: false, phase: 2, exists: true } };
    const done = (await of("token-desk").work!("", `look at ${TOKEN}`, io(chainOf({ code: "0x6080", reads })))) as { work: string };
    expect(done.work).toMatch(/Name\s+Factor/);
    expect(done.work).toMatch(/Supply\s+988,508,606 \(18 decimals\)/);
    expect(done.work).toContain("in its Uniswap pool (it has graduated)");
    expect(done.work).toMatch(/Trading tax\s+3% to the address below/);
    expect(done.work).toContain("0x6fc6a5b592406d9ee1e9a4e6ba20e03e73165b3a");
    expect(done.work).toMatch(/It says nothing about what the token is worth or will be worth\.$/);
    // a token Pons did not launch: its own facts, and no word on how it trades
    const other = (await of("token-desk").work!("", TOKEN, io(chainOf({ code: "0x6080", reads: { ...reads, getLaunchedToken: { exists: false } } })))) as { work: string };
    expect(other.work).toContain("Pons has no record of launching this token");
    expect(await of("token-desk").work!("", TOKEN, io(chainOf({ code: "0x" })))).toEqual({ decline: "there is no contract at that address on Robinhood Chain" });
    expect(await of("token-desk").work!("", TOKEN, io(chainOf({ code: "0x6080", reads: {} })))).toEqual({ decline: "the contract at that address does not answer as a token does" });
  });

  it("wallet-desk says what an address holds, and its record on the desk if it is an agent", async () => {
    const agent = { registered: true, barred: true, settled: 6, settledAtHalf: 1, notDelivered: 1, unanswered: 2, bond: 0n, feesPaid: ETH / 500n, advancedNow: 0n, volume: ETH / 10n };
    const done = (await of("wallet-desk").work!("", WALLET, io(chainOf({ balance: (15n * ETH) / 10n, nonce: 7, ethUsd8: 2_500n * 10n ** 8n, reads: { agent } })))) as { work: string };
    expect(done.work).toMatch(/What it is\s+a wallet \(no code\)/);
    expect(done.work).toMatch(/Holds\s+1\.500000 ETH \(about \$3,750\.00\)/);
    expect(done.work).toMatch(/Has sent\s+7 transactions/);
    expect(done.work).toMatch(/Jobs settled\s+6, 1 of them at half after a rejection/);
    expect(done.work).toContain("It is barred from the pool");
    const plain = (await of("wallet-desk").work!("", WALLET, io(chainOf({ code: "0x6080", nonce: 1, reads: { agent: { registered: false } } })))) as { work: string };
    expect(plain.work).toMatch(/What it is\s+a contract/);
    expect(plain.work).toContain("It is not an agent on Factor's desk.");
    expect(plain.work).toMatch(/by wallet-desk\.$/);
  });
});
