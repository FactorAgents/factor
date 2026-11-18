// The agent treasury in the kit: the treasury contract's refusals in words, the rules as the kit takes them and as the
// contract takes them, the reads in the engine's shapes, every write refused before anything is sent while the treasury is
// off; the three tools, which of them act on the chain, and what they say.
import { ContractFunctionRevertedError, encodeErrorResult, type Abi } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { factorTreasuryAbi } from "../src/abi/FactorTreasury.js";
import { Factor, Refusal, TREASURY_WORDS, treasuryNextText, treasuryRulesText, treasuryRulesWei, treasuryWordsOf } from "../src/index.js";
import { runTool, TOOLS } from "../src/tools.js";
import { KEY, stub, type Stub } from "./stub.js";

const ABI = factorTreasuryAbi as Abi;
let s: Stub;
beforeAll(async () => { s = await stub(); });
afterAll(async () => { await s.close(); });
const connect = (over: Record<string, unknown> = {}) => Factor.connect({ api: s.api, rpcUrl: s.rpc, ...over });
const refusal = async (p: Promise<unknown>): Promise<Refusal> => { try { await p; } catch (e) { if (e instanceof Refusal) return e; throw e; } throw new Error("it was not refused"); };
const sent = () => s.node.calls.filter((c) => c === "eth_sendRawTransaction").length;
const words = (errorName: string, args: unknown[] = []) => treasuryWordsOf(new ContractFunctionRevertedError({ abi: ABI, functionName: "run", data: encodeErrorResult({ abi: ABI, errorName, args } as never) }));

const E = 10n ** 18n;
const AGENT = "0x00000000000000000000000000000000000000b2";
const ABOUT = { enabled: true, contract: "0x0000000000000000000000000000000000007ea5", chainId: 4663, rules: { minStep: "100000000000000", maxClaims: 10, day: 86400, order: ["repay", "compute", "claims", "guarantee", "vouch"] }, totals: { treasuries: 1, held: E.toString(), runs: 1, repaid: "0", compute: "0", claims: "0", guarantee: "0", vouch: "0", factorOwn: 0 } };
const RULES = { floor: (E / 2n).toString(), repay: { on: true, daily: E.toString() }, compute: { on: true, daily: (E / 50n).toString() }, claims: { on: true, daily: (E / 20n).toString(), maxPrice: (E / 100n).toString(), minDiscountBps: 300, minScore: 200, deliveredOnly: true }, guarantee: { on: false, upTo: "0" }, vouch: { on: true, upTo: (E / 25n).toString() } };
const NEXT = { claims: [{ id: 7, price: "9400000000000000" }, { id: 8, price: "0" }], repay: "0", compute: (E / 50n).toString(), buy: "9400000000000000", guarantee: "0", vouch: (E / 25n).toString(), total: (E / 50n + 9400000000000000n + E / 25n).toString(), lineFirst: false, readAt: "2026-11-18T09:00:00.000Z" };
const RUN = { tx: "0xabc", at: "2026-11-18T08:00:00.000Z", by: "0x00000000000000000000000000000000000000b0", spent: (E / 100n).toString(), spentEth: 0.01, skipped: 0, steps: [{ kind: "repay", text: "Repaid 0.0100 ETH of its credit line: the line owes nothing", amount: (E / 100n).toString(), amountEth: 0.01, at: "2026-11-18T08:00:00.000Z", tx: "0xabc" }] };
const ONE = { agent: AGENT, name: "quill-02", named: true, balance: E.toString(), balanceEth: 1, spendable: (E / 2n).toString(), rules: RULES, totals: null, runs: [RUN], next: NEXT, openedAt: "2026-11-18T07:00:00.000Z", factorOwn: false };

beforeEach(() => { s.site.treasury = null; s.node.calls.length = 0; });
const on = () => {
  s.site.treasury = (path) => {
    if (path === "/treasury/about") return { status: 200, body: ABOUT };
    if (path === "/treasury/quill-02") return { status: 200, body: { treasury: ONE } };
    if (path === "/treasury/quill-02/preview") return { status: 200, body: { agent: AGENT, next: NEXT, order: ABOUT.rules.order } };
    return null;
  };
};

describe("the words and the rules", () => {
  it("says every refusal of the treasury contract in words", () => {
    expect(words("OverBalance", [0n])).toBe("This treasury holds nothing.");
    expect(words("OverBalance", [E / 4n])).toBe("This treasury holds 0.25 ETH: no more than that can come out.");
    expect(words("NothingToDo")).toMatch(/^There is nothing for a run to do now/);
    expect(words("TooMany")).toBe("A run takes ten claims at most.");
    const errors = ABI.filter((x) => x.type === "error").map((x) => (x as { name: string }).name);
    for (const e of errors.filter((e) => !["ZeroAddress", "WrongDesk", "ReentrancyGuardReentrantCall"].includes(e))) expect(TREASURY_WORDS[e], e).toBeTypeOf("function");
  });

  it("turns the kit's rules into the contract's, a use left out off", () => {
    const r = treasuryRulesWei({ floorEth: "0.5", repay: { dailyEth: "1" }, claims: { dailyEth: "0.05", maxPriceEth: "0.01", minDiscountPct: 3.5, minScore: 200, deliveredOnly: true }, vouch: { upToEth: "0.04" } });
    expect(r).toEqual({ floor: E / 2n, repay: true, repayDaily: E, compute: false, computeDaily: 0n, claims: true, claimsDaily: E / 20n, claimMaxPrice: E / 100n, claimMinDiscountBps: 350, claimMinScore: 200, claimDeliveredOnly: true, guarantee: false, guaranteeUpTo: 0n, vouch: true, vouchUpTo: E / 25n });
    expect(treasuryRulesWei({})).toMatchObject({ floor: 0n, repay: false, compute: false, claims: false, guarantee: false, vouch: false });
    expect(() => treasuryRulesWei({ floorEth: "half" })).toThrow(/The floor is ETH as text/);
    expect(() => treasuryRulesWei({ claims: { dailyEth: "1", maxPriceEth: "1", minDiscountPct: 101 } })).toThrow(/0 to 100 percent/);
    expect(() => treasuryRulesWei({ claims: { dailyEth: "1", maxPriceEth: "1", minScore: 1001 } })).toThrow(/0 to 1000/);
    // the struct's fields, in the contract's own order
    const struct = (ABI.find((x) => x.type === "function" && (x as { name: string }).name === "setRules") as unknown as { inputs: { components: { name: string }[] }[] }).inputs[0]!.components.map((c) => c.name);
    expect(Object.keys(r)).toEqual(struct);
  });

  it("says rules and the next run in words, in the order a run does them", () => {
    expect(treasuryRulesText(null)).toBe("No rules set: a run does nothing.");
    expect(treasuryRulesText(RULES)).toBe("Floor 0.5 ETH, never spent by a run. In order: 1 repay its credit line first, up to 1 ETH a day; 2 prepay compute, up to 0.02 ETH a day; 3 buy locked pay, up to 0.05 ETH a day and 0.01 ETH a claim, at least 3% under its face, from a seller scoring 200 or more, delivered jobs only; 5 keep its vouching bond at 0.04 ETH.");
    expect(treasuryNextText(NEXT)).toBe("The next run would prepay 0.02 ETH of compute, then buy claim 7 for 0.0094 ETH, then add 0.04 ETH to the vouching bond: 0.0694 ETH in all.");
    expect(treasuryNextText({ ...NEXT, total: "0" })).toBe("A run would do nothing now.");
  });
});

describe("the reads", () => {
  it("off: the order as it would be, and nobody's treasury", async () => {
    const f = await connect();
    expect(await f.treasuryAbout()).toMatchObject({ enabled: false, totals: null, rules: { maxClaims: 10, order: ["repay", "compute", "claims", "guarantee", "vouch"] } });
    expect(await f.treasury("quill-02")).toBeNull();
    expect(await f.treasuryNext("quill-02")).toBeNull();
    expect((await runTool(f, "factor_treasury", { agent: "quill-02" }, null)).text).toBe("The agent treasury is not switched on yet.");
  });

  it("on: one treasury with its rules, runs and next run, and the tool says it", async () => {
    on();
    const f = await connect();
    expect((await f.treasuryAbout()).enabled).toBe(true);
    expect(await f.treasury("quill-02")).toMatchObject({ agent: AGENT, balanceEth: 1, rules: { repay: { on: true } } });
    expect((await f.treasuryNext("quill-02"))?.total).toBe(NEXT.total);
    const said = (await runTool(f, "factor_treasury", { agent: "quill-02" }, null)).text;
    expect(said).toMatch(/^quill-02's treasury holds 1 ETH, 0.5 ETH above its floor\. Only quill-02 can take it out, at any time\./);
    expect(said).toMatch(/The next run would prepay 0.02 ETH of compute/);
    expect(said).toMatch(/Run 2026-11-18 08:00 UTC, 0.01 ETH: Repaid 0.0100 ETH of its credit line: the line owes nothing\./);
    expect((await runTool(f, "factor_treasury", { agent: "nobody" }, null)).text).toBe("No agent by that name or address.");
  });
});

describe("the writes", () => {
  it("are refused while the treasury is off, and nothing is sent", async () => {
    const f = await connect({ privateKey: KEY });
    const calls = [() => f.treasuryDeposit("0.01"), () => f.treasuryWithdraw(), () => f.setTreasuryRules({ floorEth: "0.1" }), () => f.runTreasury()];
    for (const c of calls) expect((await refusal(c())).message).toBe("The agent treasury is not switched on yet.");
    expect(sent()).toBe(0);
  });

  it("bad rules are refused before anything is sent, and a key-less Factor can only read", async () => {
    on();
    const f = await connect({ privateKey: KEY });
    expect((await refusal(f.setTreasuryRules({ floorEth: "lots" }))).code).toBe("bad_rules");
    expect((await refusal(f.runTreasury(undefined, new Array(11).fill(1)))).code).toBe("too_many");
    expect((await refusal(f.treasuryDeposit("0.01", "quill-02"))).code).toBe("bad_address");
    expect(sent()).toBe(0);
    const reader = await connect();
    expect((await refusal(reader.treasuryDeposit("0.01"))).message).toMatch(/without a key/);
  });
});

describe("the tools", () => {
  it("three: one read, two that act on the chain", () => {
    const mine = TOOLS.filter((t) => t.name.startsWith("factor_treasury"));
    expect(mine.map((t) => t.name).sort()).toEqual(["factor_treasury", "factor_treasury_run", "factor_treasury_setup"]);
    expect(mine.filter((t) => t.readOnly).map((t) => t.name)).toEqual(["factor_treasury"]);
    // nothing they say names a share of the token's fees, or an em dash
    expect(JSON.stringify(mine.map((t) => t.description))).not.toMatch(/70%|30%|—/);
  });

  it("the setup tool asks for the most for one claim before it sets rules that buy locked pay", async () => {
    on();
    const f = await connect({ privateKey: KEY });
    expect((await runTool(f, "factor_treasury_setup", { rules: { claimsDailyEth: "0.05" } }, null)).text).toBe("To buy locked pay, say the most for one claim too (claimMaxPriceEth).");
    expect((await runTool(f, "factor_treasury_setup", {}, null)).text).toBe("Say what to put in, the rules, or what to take out.");
    expect(sent()).toBe(0);
  });
});
