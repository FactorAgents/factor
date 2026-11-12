// Vouching in the kit: the vouching contract's refusals in words, the fee as the contract takes it, the reads in the
// engine's shapes, and every write refused before anything is sent while vouching is off; the five tools, which of them
// act on the chain, and what they say.
import { ContractFunctionRevertedError, encodeErrorResult, type Abi } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { factorVouchAbi } from "../src/abi/FactorVouch.js";
import { Factor, Refusal, VOUCH_WORDS, vouchFee, vouchWordsOf } from "../src/index.js";
import { runTool, TOOLS } from "../src/tools.js";
import { KEY, stub, type Stub } from "./stub.js";

const VOUCH = factorVouchAbi as Abi;
let s: Stub;
beforeAll(async () => { s = await stub(); });
afterAll(async () => { await s.close(); });
const connect = (over: Record<string, unknown> = {}) => Factor.connect({ api: s.api, rpcUrl: s.rpc, ...over });
const refusal = async (p: Promise<unknown>): Promise<Refusal> => { try { await p; } catch (e) { if (e instanceof Refusal) return e; throw e; } throw new Error("it was not refused"); };
const sent = () => s.node.calls.filter((c) => c === "eth_sendRawTransaction").length;
const words = (errorName: string, args: unknown[] = []) => vouchWordsOf(new ContractFunctionRevertedError({ abi: VOUCH, functionName: "offerLine", data: encodeErrorResult({ abi: VOUCH, errorName, args } as never) }));

const ABOUT = { enabled: true, contract: "0x0000000000000000000000000000000000000c0c", chainId: 4663, rules: { minScore: 300, maxSharePct: 25, feePct: 2, voucherPctOfFee: 50, minVouchEth: 0.0001, lineTermDays: 30, offerDays: 7 }, totals: { bondsEth: 0.04, heldEth: 0.01, vouchedEth: 0.01, paidEth: 0, earnedEth: 0, burnedEth: 0, vouches: 1, standing: 1 } };
const VOUCH_ONE = {
  id: 1, kind: "line", state: "active", voucher: "0x00000000000000000000000000000000000000a1", voucherName: "lumen-07", voucherNamed: true, agent: "0x00000000000000000000000000000000000000b2", agentName: "quill-02", agentNamed: true, agentKey: "0x00000000000000000000000000000000000000b1",
  amountEth: 0.01, amountWei: "10000000000000000", feeEth: 0.0002, feeWei: "200000000000000", offeredAt: "2026-11-12T08:00:00.000Z", expiresAt: "2026-11-19T08:00:00.000Z", tx: "0xabc", startedAt: "2026-11-12T09:00:00.000Z", acceptedTx: "0xdef", endsAt: "2026-12-12T09:00:00.000Z",
  line: { account: "0x00000000000000000000000000000000000000b2", owesEth: 0, defaulted: false, owedAtOfferEth: 0 }, next: { what: "ends", at: "2026-12-12T09:00:00.000Z" }, ties: [], factorOwn: false, counts: true,
};
const OWN = { ...VOUCH_ONE, id: 2, voucher: "0x00000000000000000000000000000000000000f1", voucherName: "page-smith", factorOwn: true, counts: false };
const VOUCHER = { voucher: VOUCH_ONE.voucher, name: "lumen-07", named: true, factorOwn: false, bondEth: 0.04, heldEth: 0.01, freeEth: 0.03, freeWei: "30000000000000000", perAgentEth: 0.01, score: 624, strong: true, vouches: 1, kept: 0, failed: 0, returned: 0, standing: 1, vouchedEth: 0.01, lostEth: 0, earnedEth: 0 };

beforeEach(() => { s.site.vouching = null; s.node.calls.length = 0; });

describe("the words and the fee", () => {
  it("says every refusal of the vouching contract in words", () => {
    expect(words("ScoreTooLow", [200n, 300n])).toBe("A voucher needs a score of 300 or more; this one has 200.");
    expect(words("OverShare", [0n])).toMatch(/a quarter of its bond for that agent/);
    expect(words("OverShare", [10n ** 15n])).toBe("This voucher can hold back 0.001 ETH more for that agent: a quarter of its bond at most.");
    expect(words("Related")).toMatch(/cannot vouch for itself/);
    expect(words("DebtGrew", [5n * 10n ** 15n])).toMatch(/^The line owes 0.005 ETH now/);
    expect(words("WrongFee", [2n * 10n ** 14n])).toBe("The fee for this vouch is 0.0002 ETH.");
    expect(words("WrongState", [3])).toBe("This vouch is kept.");
    // every error the contract has, said
    const errors = VOUCH.filter((x) => x.type === "error").map((x) => (x as { name: string }).name);
    for (const e of errors.filter((e) => !["ZeroAddress", "NoLineContract", "PushFailed", "ReentrancyGuardReentrantCall"].includes(e))) expect(VOUCH_WORDS[e], e).toBeTypeOf("function");
  });

  it("takes the fee as the contract does: 2%, half to the voucher rounded down, the rest burned", () => {
    expect(vouchFee(10n ** 16n)).toEqual({ fee: 2n * 10n ** 14n, toVoucher: 10n ** 14n, burned: 10n ** 14n });
    expect(vouchFee(10n ** 14n)).toEqual({ fee: 2n * 10n ** 12n, toVoucher: 10n ** 12n, burned: 10n ** 12n });
    const odd = vouchFee(149n);
    expect(odd.toVoucher + odd.burned).toBe(odd.fee);
  });
});

describe("the reads", () => {
  it("off: the rules as they would be, nothing listed, nobody's vouches", async () => {
    const f = await connect();
    const v = await f.vouching();
    expect(v).toMatchObject({ enabled: false, rules: { minScore: 300, feePct: 2 }, vouchers: [], items: [] });
    expect(await f.vouchesOf("quill-02")).toBeNull();
    expect(await f.vouchOf(1)).toBeNull();
  });

  it("on: the vouchers with Factor's own apart, one vouch, an agent's vouches", async () => {
    s.site.vouching = (path) => {
      if (path === "/vouches/about") return { status: 200, body: ABOUT };
      if (path.startsWith("/vouches?") || path === "/vouches") return { status: 200, body: { ...ABOUT, vouchers: [VOUCHER], factorOwn: [{ ...VOUCHER, voucher: OWN.voucher, name: "page-smith", factorOwn: true }], items: [VOUCH_ONE, OWN] } };
      if (path === "/vouches/1") return { status: 200, body: { vouch: VOUCH_ONE } };
      if (path === "/vouches/agent/quill-02") return { status: 200, body: { agent: { agent: VOUCH_ONE.agent, received: [VOUCH_ONE, OWN], standing: 1, backedEth: 0.01, kept: 0, failed: 0, notCounted: 1, voucher: null } } };
      return null;
    };
    const f = await connect();
    const v = await f.vouching();
    expect(v.vouchers.map((x) => x.name)).toEqual(["lumen-07"]);
    expect(v.factorOwn.map((x) => x.name)).toEqual(["page-smith"]);
    expect((await f.vouchOf(1))?.amountEth).toBe(0.01);
    expect(await f.vouchesOf("quill-02")).toMatchObject({ standing: 1, notCounted: 1 });
    const said = (await runTool(f, "factor_vouches", { agent: "quill-02" })).text;
    expect(said).toMatch(/1 vouch\(es\) standing that count, 0.01 ETH behind them/);
    expect(said).toMatch(/Vouch 2: page-smith .*Factor's own: not counted/);
    expect((await runTool(f, "factor_vouches", {})).text).toMatch(/A voucher needs a score of 300\. It holds at most 25% of its bond for one agent\./);
    expect((await runTool(f, "factor_vouches", { vouch: 1 })).text).toMatch(/^Vouch 1: lumen-07 for quill-02's credit line, 0.01 ETH \(fee 0.0002 ETH\), standing, until 2026-12-12\.$/);
  });
});

describe("the writes", () => {
  it("are refused while vouching is off, and nothing is sent", async () => {
    const f = await connect({ privateKey: KEY });
    const calls = [() => f.addVouchBond("0.01"), () => f.withdrawVouchBond(), () => f.vouchForLine("0x00000000000000000000000000000000000000b2", "0.001"), () => f.vouchForCover(12, "0.001"), () => f.acceptVouch(1), () => f.releaseVouch(1), () => f.withdrawVouchOffer(1), () => f.settleVouch(1)];
    for (const c of calls) expect((await refusal(c())).message).toBe("Vouching is not switched on yet.");
    expect(sent()).toBe(0);
    expect((await runTool(f, "factor_vouches", {})).text).toBe("Vouching is not switched on yet.");
  });

  it("a key-less Factor can only read", async () => {
    const f = await connect();
    expect((await refusal(f.addVouchBond("0.01"))).message).toMatch(/without a key|Vouching is not switched on/);
  });
});

describe("the tools", () => {
  it("five: one read, four that act on the chain", () => {
    const mine = TOOLS.filter((t) => t.name.startsWith("factor_vouch"));
    expect(mine.map((t) => t.name).sort()).toEqual(["factor_vouch_answer", "factor_vouch_bond", "factor_vouch_for", "factor_vouch_settle", "factor_vouches"]);
    expect(mine.filter((t) => t.readOnly).map((t) => t.name)).toEqual(["factor_vouches"]);
    // nothing they say names a share of the token's fees, or an em dash
    expect(JSON.stringify(mine.map((t) => t.description))).not.toMatch(/70%|30%|—/);
  });
});
