// Verifiers in the kit (spec-pack/verifiers): the words of a verified job and a verifier's reasons hashed as the spec says,
// a panelist's seal worked out as the contract's commitOf, the salt made again the same, every refusal in words, the
// reads in the spec's shapes, and every write refused before anything is sent: while verifiers are off, on bad input,
// through a Factor account, over the assistant's caps, and when a sealed verdict is not what the wallet sealed.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concat, ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult, encodeFunctionData, keccak256, numberToHex, pad, stringToBytes, type Hex } from "viem";
import { checkReceipt, readReceipt, receiptBlock, receiptHashes, VALIDATION_REGISTRY, VERIFIERS_ABI, withReceipt } from "../src/verifiers.js";
import { erc8004ValidationAbi } from "../src/abi/Erc8004Validation.js";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { factorVerifiersAbi } from "../src/abi/FactorVerifiers.js";
import { checkReason, checkVerifierTerms, commitOf, Factor, keepVerdict, readVerdict, reasonHashOf, Refusal, saltOf, sealMessage, sendVerifierText, toWei, VERIFIER_WORDS, verifierTermsHash, verifierTermsText, verifierWordsOf } from "../src/index.js";
import { runTool, Spending, TOOLS, VERIFIER_WRITE_TOOLS } from "../src/tools.js";
import { AGENTS, DESK, KEY, state, stub, VERIFIERS, VERIFIERS_OFF, type ChainCase, type Stub } from "./stub.js";

let s: Stub;
const dir = mkdtempSync(join(tmpdir(), "factor-verdicts-"));
beforeAll(async () => { s = await stub(); process.env.FACTOR_VERDICTS_DIR = dir; });
afterAll(async () => { await s.close(); delete process.env.FACTOR_VERDICTS_DIR; rmSync(dir, { recursive: true, force: true }); });
const connect = (over: Record<string, unknown> = {}) => Factor.connect({ api: s.api, rpcUrl: s.rpc, ...over });
const refusal = async (p: Promise<unknown>): Promise<Refusal> => { try { await p; } catch (e) { if (e instanceof Refusal) return e; throw e; } throw new Error("it was not refused"); };
const sent = () => s.node.calls.filter((c) => c === "eth_sendRawTransaction").length;

const ME = privateKeyToAccount(KEY).address.toLowerCase();
const CUSTOMER = "0x00000000000000000000000000000000000000c1";
const ON = { ...VERIFIERS_OFF, enabled: true, contract: VERIFIERS, totals: { cases: 3, open: 1, disputed: 1, panels: 1, verifiers: 2, bondedEth: 0.05, feesPaidEth: 0.0006, slashedEth: 0.001 }, house: [{ address: "0x00000000000000000000000000000000000000f1", maker: 1, makerName: "Anthropic", model: "anthropic/claude-sonnet-5-5", joined: true }] };
const VERIFIER = { address: ME, name: null, maker: 2, makerName: "Google", house: false, standing: true, since: "2026-11-09T08:00:00.000Z", joinedAt: "2026-11-09T08:00:00.000Z", freeEth: 0.05, freeWei: "50000000000000000", lockedEth: 0.002, lockedWei: "2000000000000000", open: 1, checks: 3, panels: 1, right: 4, wrong: 0, hidden: 0, struck: 0, earnedEth: 0.0012, lostEth: 0, rightPct: 100 };
const soon = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const CASE = {
  id: 7, job: { n: 41, id: "0041", state: "delivered" }, customer: CUSTOMER, agent: { address: AGENTS[0]!.address, name: "lumen-07" },
  priceEth: 0.01, priceWei: "10000000000000000", feeEth: 0.0003, feeWei: "300000000000000", stakeEth: 0.002, stakeWei: "2000000000000000", disputeBondEth: 0.001, disputeBondWei: "1000000000000000",
  termsHash: `0x${"ab".repeat(32)}`, title: "Price check of three stocks", brief: "Compare each price with the feed on the chain.", work: { kind: "text", text: "TSLA 251.20, AAPL 231.05, NVDA 140.10", at: "2026-11-09T09:00:00.000Z" },
  state: "working", how: null, hiredAt: "2026-11-09T08:30:00.000Z", tx: "0xabc", deliveredAt: "2026-11-09T09:00:00.000Z",
  deadlines: { checkBy: soon(3), disputeBy: null, seatBy: soon(13), revealBy: soon(17), reviewBy: soon(23) }, next: "check", nextAt: null, forYou: { can: true },
};
const DISPUTED = {
  ...CASE, state: "disputed", next: "seats",
  first: { verifier: { address: "0x00000000000000000000000000000000000000f1", name: "factor-check", maker: 1, makerName: "Anthropic", house: true }, accept: true, at: "2026-11-09T09:30:00.000Z", reasonHash: `0x${"cd".repeat(32)}`, reason: "Verdict: accept\nTests:\n- pass: three prices within 1% of the feed", tx: "0xdef" },
  dispute: { by: "customer", address: CUSTOMER, at: "2026-11-09T10:00:00.000Z", bondEth: 0.001, tx: "0x123" },
  seats: [{ seat: 0, verifier: { address: "0x00000000000000000000000000000000000000f2", name: null, maker: 3, makerName: "OpenAI", house: false }, maker: 3, makerName: "OpenAI", since: "2026-11-01T00:00:00.000Z", vote: null, reasonHash: null, reason: null, ties: ["the same wallet paid the agent on the desk"] }],
  struck: [],
};
const chainCase = (over: Partial<ChainCase> = {}): ChainCase => ({ customer: CUSTOMER, job: 41n, state: 3, how: 0, firstAccept: true, customerStruck: false, agentStruck: false, agent: AGENTS[0]!.address, checkedAt: 1, disputedAt: 2, checker: "0x00000000000000000000000000000000000000f1", disputer: CUSTOMER, price: 10n ** 16n, fee: 3n * 10n ** 14n, stake: 2n * 10n ** 15n, disputeBond: 10n ** 15n, terms: `0x${"ab".repeat(32)}`, reason: `0x${"cd".repeat(32)}`, ...over });

const reset = () => {
  s.site.verifiers = { about: VERIFIERS_OFF, items: [], page: null, cases: [], case: null, post: null };
  s.site.state = state();
  s.node.cases.clear(); s.node.seats.clear(); s.node.verifierRefuse = {}; s.node.badCommit = false; s.node.verifierFree = 0n; s.node.verifierDesk = DESK;
  s.posts.length = 0;
};
beforeEach(reset);

describe("the words, the reasons and the seal", () => {
  it("writes a job's words as compact JSON, title then brief, and hashes their UTF-8 bytes", () => {
    const text = verifierTermsText({ title: "Price check", brief: "Line one.\nLine two: \"quoted\", 5 €." });
    expect(text).toBe('{"title":"Price check","brief":"Line one.\\nLine two: \\"quoted\\", 5 €."}');
    expect(verifierTermsHash(text)).toBe(keccak256(new TextEncoder().encode(text)));
    // what the kit sends is the tidy form: one line of title, the brief's line ends as \n
    const t = checkVerifierTerms({ title: "  Price   check ", brief: "Line one.\r\nLine two.  " });
    expect(t.terms).toBe('{"title":"Price check","brief":"Line one.\\nLine two."}');
    expect(() => checkVerifierTerms({ title: "x", brief: "b" })).toThrow(/3 to 80 characters/);
    expect(() => checkVerifierTerms({ title: "see prices.com", brief: "b" })).toThrow(/without links/);
    expect(() => checkVerifierTerms({ title: "Price check", brief: "  " })).toThrow(/1 to 12,000/);
    expect(() => checkVerifierTerms({ title: "Price check", brief: "x".repeat(12_001) })).toThrow(Refusal);
  });

  it("hashes the reasons exactly as given", () => {
    const reason = "Verdict: accept\nTests:\n- pass: TSLA within 1% of the feed\nReasons: all three match. Ünïcode too.";
    expect(reasonHashOf(reason)).toBe(keccak256(stringToBytes(reason)));
    expect(reasonHashOf(reason)).not.toBe(reasonHashOf(`${reason} `));
    expect(checkReason(reason)).toBe(reason);
    for (const bad of ["", "   ", "x".repeat(4001), "a\u0000b", 7]) expect(() => checkReason(bad), String(bad).slice(0, 5)).toThrow(/1 to 4,000 characters/);
  });

  it("seals a verdict as the contract's commitOf: keccak256 of abi.encode of five 32-byte words", () => {
    const salt = `0x${"5a".repeat(32)}` as Hex, reasonHash = reasonHashOf("the reasons");
    const words = concat([pad(numberToHex(7n)), pad(ME as Hex), pad(numberToHex(1)), reasonHash, salt]);
    expect(commitOf(7, ME, true, reasonHash, salt)).toBe(keccak256(words));
    expect(commitOf(7n, ME, true, reasonHash, salt)).toBe(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "bool" }, { type: "bytes32" }, { type: "bytes32" }], [7n, ME as Hex, true, reasonHash, salt])));
    expect(commitOf(7, ME, false, reasonHash, salt)).not.toBe(commitOf(7, ME, true, reasonHash, salt));
    expect(commitOf(8, ME, true, reasonHash, salt)).not.toBe(commitOf(7, ME, true, reasonHash, salt));
  });

  it("makes the same salt again from the same wallet, case and words, and another for another case", async () => {
    const account = privateKeyToAccount(KEY);
    expect(sealMessage(7, account.address)).toBe(`Factor verifier seal\ncase: 7\nverifier: ${ME}`);
    const a = saltOf(await account.signMessage({ message: sealMessage(7, account.address) }));
    const b = saltOf(await account.signMessage({ message: sealMessage(7, ME) }));
    const c = saltOf(await account.signMessage({ message: sealMessage(8, ME) }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("keeps a sealed verdict in a file only this user reads, and reads it back", async () => {
    const v = { chainId: 4663, contract: VERIFIERS, case: 7, verifier: ME, accept: false, reason: "Two prices off the feed.", reasonHash: reasonHashOf("Two prices off the feed."), salt: `0x${"11".repeat(32)}` as Hex, commit: `0x${"22".repeat(32)}` as Hex, seat: 1, tx: `0x${"33".repeat(32)}` as Hex, revealFrom: soon(13), revealBy: soon(17) };
    const file = await keepVerdict(v);
    expect(file).toBe(join(dir, `4663-${VERIFIERS}-7.json`));
    expect(statSync(file!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file!, "utf8")).reason).toBe("Two prices off the feed.");
    expect(await readVerdict(4663, VERIFIERS, 7)).toEqual(v);
    expect(await readVerdict(4663, VERIFIERS, 8)).toBeNull();
    rmSync(file!);
  });

  it("has plain words for every refusal of the verifier contract, and says the desk's own through a hire", () => {
    const errors = (factorVerifiersAbi as readonly { type: string; name?: string }[]).filter((x) => x.type === "error").map((x) => x.name!);
    expect(errors.length).toBe(36);
    for (const name of errors) expect(VERIFIER_WORDS[name], name).toBeTypeOf("function");
    for (const say of Object.values(VERIFIER_WORDS)) expect(say([0n, 0n])).not.toContain(String.fromCharCode(0x2014));
    expect(VERIFIER_WORDS.TooSmall!([10n ** 16n])).toBe("A verifier's bond is at least 0.01 ETH.");
    expect(VERIFIER_WORDS.BondShort!([2n * 10n ** 15n])).toBe("A verdict on this case stakes 0.002 ETH, and less than that of this verifier's bond is free. Add to the bond first.");
    expect(VERIFIER_WORDS.WrongState!([2])).toBe("This case is checked: its first verdict is in.");
    expect(VERIFIER_WORDS.OverFree!([0n])).toBe("Nothing in the bond is free: all of it is staked on cases that have not ended.");
    expect(verifierWordsOf(new Refusal("as it is"))).toBe("as it is");
    expect(verifierWordsOf(new ContractFunctionRevertedError({ abi: VERIFIERS_ABI, functionName: "hire", data: encodeErrorResult({ abi: VERIFIERS_ABI, errorName: "TooSmall", args: [10n ** 15n] }) }), "hire")).toBe("The smallest job is 0.001 ETH.");
    expect(verifierWordsOf(new ContractFunctionRevertedError({ abi: VERIFIERS_ABI, functionName: "join", data: encodeErrorResult({ abi: VERIFIERS_ABI, errorName: "TooSmall", args: [10n ** 16n] }) }), "join")).toBe("A verifier's bond is at least 0.01 ETH.");
    expect(verifierWordsOf(new ContractFunctionRevertedError({ abi: VERIFIERS_ABI, functionName: "reject", data: encodeErrorResult({ abi: VERIFIERS_ABI, errorName: "TooLate" }) }), "reject")).toMatch(/^The desk's 24 hours after the delivery are over/);
    expect(verifierWordsOf(new ContractFunctionRevertedError({ abi: VERIFIERS_ABI, functionName: "accept", data: encodeErrorResult({ abi: VERIFIERS_ABI, errorName: "WrongState", args: [5] }) }), "accept")).toBe("This case is over: accepted.");
    expect(verifierWordsOf(new ContractFunctionRevertedError({ abi: VERIFIERS_ABI, functionName: "accept", data: encodeErrorResult({ abi: VERIFIERS_ABI, errorName: "WrongState", args: [1] }) }), "accept")).toMatch(/^The desk does not take it/);
    expect(verifierWordsOf(new ContractFunctionRevertedError({ abi: VERIFIERS_ABI, functionName: "dispute", data: encodeErrorResult({ abi: VERIFIERS_ABI, errorName: "NotYourSide" }) }), "dispute")).toBe("Only the side the verdict goes against may dispute it: the customer a verdict of accept, the agent a verdict of reject.");
  });
});

describe("reading", () => {
  it("reads the rules, the verifiers, one verifier, the cases and one case in the spec's shapes", async () => {
    const f = await connect({ privateKey: KEY });
    expect((await f.verifiersAbout()).enabled).toBe(false);
    s.site.verifiers = { about: ON, items: [VERIFIER], page: { verifier: VERIFIER, cases: [CASE] }, cases: [CASE], case: CASE, post: null };
    const about = await f.verifiersAbout();
    expect([about.enabled, about.contract, about.rules.stakePct, about.makers[1]!.name, about.house[0]!.makerName]).toEqual([true, VERIFIERS, 20, "Google", "Anthropic"]);
    expect((await f.verifiers({ maker: 2 })).items.map((v) => v.makerName)).toEqual(["Google"]);
    expect((await f.verifier("me")).verifier!.address).toBe(ME);
    expect((await f.verifier(VERIFIER.address)).cases[0]!.id).toBe(7);
    expect((await f.verifierCases({ show: "check", verifier: "me" }))[0]!.forYou).toEqual({ can: true });
    expect((await f.verifierCase(7))!.deadlines!.checkBy).toBe(CASE.deadlines.checkBy);
    expect((await f.verifierCaseOfJob(41))!.job.n).toBe(41);
    await expect(f.verifierCase(0)).rejects.toThrow(/whole number, like 7/);
    await expect(f.verifiers({ maker: 256 })).rejects.toThrow(/1 to 255/);
    await expect(f.verifierCases({ show: "mine" as never })).rejects.toThrow(/Show "check"/);
    await expect(f.verifier("0x12")).rejects.toThrow(/"me" for this wallet/);
    expect(sent()).toBe(0);
  });

  it("the five read tools say it in words, and say when verifiers are off", async () => {
    const f = await connect();
    const off = "Verifiers are not switched on on Factor yet: the verifier tools are not available.";
    expect((await runTool(f, "factor_verifiers_about", {}, null)).text).toContain(off);
    for (const [name, args] of [["factor_verifiers", {}], ["factor_verifier", { address: VERIFIER.address }], ["factor_verifier_cases", {}], ["factor_verifier_case", { case: 7 }]] as const) expect((await runTool(f, name, args, null)).text, name).toBe(off);
    s.site.verifiers = { about: ON, items: [VERIFIER], page: { verifier: VERIFIER, cases: [CASE] }, cases: [CASE], case: DISPUTED, post: null };
    const about = (await runTool(f, "factor_verifiers_about", {}, null)).text;
    expect(about).toContain(`Verifiers are on: the contract ${VERIFIERS}, on Robinhood Chain.`);
    expect(about).toContain("3 cases (1 open, 1 disputed, 1 panel), 2 verifiers with 0.05 ETH bonded");
    expect(about).toContain("1 Anthropic (Claude), 2 Google (Gemini), 3 OpenAI (GPT); 16 to 255 another maker");
    expect((await runTool(f, "factor_verifiers", {}, null)).text).toBe(`${ME} (Google): standing since 2026-11-09T08:00:00.000Z, 0.05 ETH free and 0.002 ETH staked on 1 open case. 3 first checks, 1 panel; 4 right and 0 wrong (100% right), 0 seats never revealed, struck 0 times. Earned 0.0012 ETH, lost 0 ETH. Address ${ME}.`);
    expect((await runTool(f, "factor_verifier", { address: VERIFIER.address }, null)).text).toContain("Its latest cases:\nCase 7, job 41");
    expect((await runTool(f, "factor_verifier_cases", { show: "check" }, null)).text).toBe(`Case 7, job 41 "Price check of three stocks": 0.01 ETH for lumen-07, fee 0.0003 ETH, a verdict stakes 0.002 ETH, a dispute costs 0.001 ETH. Waiting for its first check; waiting for a verifier's first check. This wallet may check or sit now.`);
    const one = (await runTool(f, "factor_verifier_case", { job: 41 }, null)).text;
    expect(one).toContain("The brief:\nCompare each price with the feed on the chain.");
    expect(one).toContain("The delivered work (text, 2026-11-09T09:00:00.000Z):\nTSLA 251.20");
    expect(one).toContain("First verdict: accept, by factor-check (Anthropic)");
    expect(one).toContain("Disputed by the customer");
    expect(one).toContain("Seat 0: 0x00000000000000000000000000000000000000f2 (OpenAI), sealed, not revealed. What Factor's records tie it to a side by: the same wallet paid the agent on the desk.");
    expect((await runTool(f, "factor_verifier_case", {}, null)).text).toMatch(/one of the two/);
    s.site.verifiers.case = null;
    expect((await runTool(f, "factor_verifier_case", { case: 9 }, null)).text).toBe("There is no case 9 on Factor.");
    s.site.verifiers.page = null;
    expect((await runTool(f, "factor_verifier", { address: VERIFIER.address }, null)).text).toBe(`${VERIFIER.address} has not joined as a verifier.`);
  });
});

describe("before anything is sent", () => {
  it("every write is refused while verifiers are off", async () => {
    const f = await connect({ privateKey: KEY });
    const calls = [
      f.joinAsVerifier(2, "0.02"), f.addVerifierBond("0.01"), f.withdrawVerifierBond("all"), f.checkWork(7, true, "ok"), f.sitOnPanel(7, true, "ok"), f.revealVerdict(7),
      f.hireWithVerifier({ agent: "lumen-07", price: "0.01", fee: "0.0003", title: "Price check", brief: "Compare." }),
      f.acceptVerified(7), f.rejectVerified(7), f.concedeVerified(7), f.disputeVerified(7), f.strikePanelist(7, AGENTS[1]!.address), f.stepVerified(7),
    ];
    for (const p of calls) expect((await refusal(p)).code).toBe("verifiers_off");
    for (const name of VERIFIER_WRITE_TOOLS) {
      const args = { factor_verifier_join: { maker: 2, bond: "0.02" }, factor_verifier_add_bond: { amount: "0.01" }, factor_verifier_withdraw: { amount: "all" }, factor_verifier_check: { case: 7, accept: true, reason: "ok" }, factor_verifier_sit: { case: 7, accept: true, reason: "ok" }, factor_verifier_reveal: { case: 7 }, factor_hire_with_verifier: { agent: "lumen-07", price: "0.01", fee: "0.0003", title: "Price check", brief: "Compare." }, factor_verified_strike: { case: 7, verifier: AGENTS[1]!.address } }[name as string] ?? { case: 7 };
      const r = await runTool(f, name, args, null);
      expect([name, r.isError, r.text]).toEqual([name, true, "Verifiers are not switched on on Factor yet: the verifier tools are not available."]);
    }
    expect(sent()).toBe(0);
    expect(s.posts).toEqual([]);
  });

  it("refuses bad input before it reads or sends anything", async () => {
    s.site.verifiers.about = ON;
    const f = await connect({ privateKey: KEY });
    const before = s.node.calls.length;
    const code = async (p: Promise<unknown>) => (await refusal(p)).code;
    expect(await code(f.joinAsVerifier(0, "0.02"))).toBe("bad_maker");
    expect(await code(f.joinAsVerifier(256, "0.02"))).toBe("bad_maker");
    expect(await code(f.joinAsVerifier(2, "0.009"))).toBe("bad_amount");
    expect(await code(f.joinAsVerifier(2, 0.02 as never))).toBe("bad_amount");
    expect(await code(f.addVerifierBond("0"))).toBe("bad_amount");
    expect(await code(f.withdrawVerifierBond("0"))).toBe("bad_amount");
    expect(await code(f.checkWork(0, true, "ok"))).toBe("bad_case");
    expect(await code(f.checkWork(7, "yes" as never, "ok"))).toBe("bad_verdict");
    expect(await code(f.checkWork(7, true, " "))).toBe("bad_reason");
    expect(await code(f.sitOnPanel(7, true, "x".repeat(4001)))).toBe("bad_reason");
    expect(await code(f.revealVerdict(7, { accept: true }))).toBe("bad_verdict");
    expect(await code(f.revealVerdict(1.5))).toBe("bad_case");
    const hire = { agent: "lumen-07", price: "0.01", fee: "0.0003", title: "Price check", brief: "Compare each price." };
    expect(await code(f.hireWithVerifier({ ...hire, price: "0.0009" }))).toBe("bad_amount");
    expect(await code(f.hireWithVerifier({ ...hire, fee: "0.00009" }))).toBe("bad_fee");
    expect(await code(f.hireWithVerifier({ ...hire, fee: "0.02" }))).toBe("bad_fee");
    expect(await code(f.hireWithVerifier({ ...hire, hours: 0 }))).toBe("bad_due");
    expect(await code(f.hireWithVerifier({ ...hire, hours: 721 }))).toBe("bad_due");
    expect(await code(f.hireWithVerifier({ ...hire, title: "https://x.example" }))).toBe("bad_title");
    expect(await code(f.hireWithVerifier({ ...hire, brief: "" }))).toBe("bad_brief");
    expect((await refusal(f.hireWithVerifier({ ...hire, maxEth: "0.01" }))).message).toBe("The price and the fee come to 0.0103 ETH, over the 0.01 ETH allowed.");
    expect(await code(f.disputeVerified(-1))).toBe("bad_case");
    expect(await code(f.strikePanelist(7, "someone"))).toBe("bad_address");
    expect(await code(f.stepVerified(0))).toBe("bad_case");
    expect(s.node.calls.slice(before)).toEqual([]);
    expect(s.posts).toEqual([]);
    // the tools' own limits, before the kit's
    for (const [name, args] of [["factor_verifier_join", { maker: 0, bond: "0.02" }], ["factor_verifier_withdraw", { amount: "most" }], ["factor_verifier_check", { case: 7, accept: true, reason: "" }], ["factor_hire_with_verifier", { ...hire, hours: 1.5 }], ["factor_verified_strike", { case: 7, verifier: "0x12" }], ["factor_verified_step", { case: "7" }]] as const) {
      const r = await runTool(f, name, args, null);
      expect([name, r.isError, r.text.startsWith(`That is not what ${name} takes`)]).toEqual([name, true, true]);
    }
    expect(sent()).toBe(0);
  });

  it("is not offered through a Factor account, and needs a key", async () => {
    s.site.verifiers.about = ON;
    const f = await connect({ privateKey: KEY });
    Object.defineProperty(f, "via", { value: "0x00000000000000000000000000000000000acc07" });
    expect(f.gasless).toBe(true);
    for (const p of [f.joinAsVerifier(2, "0.02"), f.checkWork(7, true, "ok"), f.hireWithVerifier({ agent: "lumen-07", price: "0.01", fee: "0.0003", title: "Price check", brief: "Compare." }), f.disputeVerified(7), f.stepVerified(7)]) expect((await refusal(p)).code).toBe("gasless");
    const r = await runTool(f, "factor_verified_step", { case: 7 }, null);
    expect(r).toEqual({ isError: true, text: "The verifier tools act from a plain wallet that pays its own gas: they are not offered through a Factor account whose gas Factor pays (gasless). Connect without gasless, with a wallet that holds a little ETH." });
    const reader = await connect();
    for (const p of [reader.joinAsVerifier(2, "0.02"), reader.acceptVerified(7)]) expect((await refusal(p)).code).toBe("read_only");
    expect(sent()).toBe(0);
  });

  it("holds a hire, a bond and a dispute bond to the assistant's caps", async () => {
    s.site.verifiers = { about: ON, items: [], page: null, cases: [], case: CASE, post: null };
    const f = await connect({ privateKey: KEY });
    const caps = mkdtempSync(join(tmpdir(), "factor-kit-"));
    try {
      const spending = new Spending({ perJob: toWei("0.01"), perDay: toWei("0.0105"), dir: caps }, f.address!);
      const hire = await runTool(f, "factor_hire_with_verifier", { agent: "lumen-07", price: "0.01", fee: "0.0003", title: "Price check", brief: "Compare." }, spending);
      expect(hire.text).toBe("0.0103 ETH is over this assistant's cap of 0.01 ETH for one job. The wallet's owner sets that cap (FACTOR_MAX_JOB_ETH).");
      expect((await runTool(f, "factor_verifier_join", { maker: 2, bond: "0.02" }, spending)).text).toMatch(/over this assistant's cap of 0.0105 ETH a day/);
      expect((await runTool(f, "factor_verifier_add_bond", { amount: "0.011" }, spending)).text).toMatch(/over this assistant's cap of 0.0105 ETH a day/);
      spending.add(toWei("0.01"));
      expect((await runTool(f, "factor_verified_dispute", { case: 7 }, spending)).text).toMatch(/0.011 ETH, over this assistant's cap/);
      expect(spending.today()).toBe(toWei("0.01"));
    } finally {
      rmSync(caps, { recursive: true, force: true });
    }
    expect(sent()).toBe(0);
  });

  it("checks the contract the site names: on the chain, with the same desk", async () => {
    s.site.verifiers.about = { ...ON, chainId: 1 };
    const f = await connect({ privateKey: KEY });
    expect((await refusal(f.stepVerified(7))).code).toBe("wrong_chain");
    s.site.verifiers.about = ON;
    s.node.verifierDesk = "0x00000000000000000000000000000000000dead0";
    expect((await refusal(f.stepVerified(7))).code).toBe("wrong_desk");
    s.node.verifierDesk = DESK;
    s.node.code = "0x";
    try {
      expect((await refusal(f.stepVerified(7))).code).toBe("no_contract");
    } finally {
      s.node.code = "0x6080";
    }
    expect((await refusal(f.stepVerified(7))).code).toBe("no_case");
    expect(sent()).toBe(0);
  });

  it("checks a case's state, its clock and the caller's side before it signs or sends", async () => {
    s.site.verifiers = { about: ON, items: [], page: null, cases: [], case: { ...CASE, state: "checked" }, post: null };
    const f = await connect({ privateKey: KEY });
    expect((await refusal(f.checkWork(7, true, "ok"))).message).toBe("Case 7 cannot be checked: it is checked: its first verdict is in. The first verdict given is the one.");
    s.site.verifiers.case = { ...CASE, deliveredAt: undefined, deadlines: undefined };
    expect((await refusal(f.checkWork(7, true, "ok"))).code).toBe("not_delivered");
    s.site.verifiers.case = { ...CASE, deadlines: { ...CASE.deadlines, checkBy: soon(-1) } };
    expect((await refusal(f.checkWork(7, true, "ok"))).code).toBe("too_late");
    s.site.verifiers.case = { ...DISPUTED, forYou: { can: false, why: "this wallet is struck from this case" } };
    expect((await refusal(f.sitOnPanel(7, true, "ok"))).message).toBe("This wallet cannot sit on case 7's panel: this wallet is struck from this case.");
    s.node.cases.set(7, chainCase());
    expect((await refusal(f.acceptVerified(7))).code).toBe("not_customer");
    expect((await refusal(f.concedeVerified(7))).code).toBe("not_agent");
    expect((await refusal(f.disputeVerified(7))).code).toBe("wrong_state");
    expect((await refusal(f.strikePanelist(7, AGENTS[1]!.address))).code).toBe("not_your_side");
    s.node.cases.set(7, chainCase({ state: 2, firstAccept: false }));
    expect((await refusal(f.disputeVerified(7))).message).toBe("Only the agent of case 7 may dispute its verdict of reject. This wallet is not that one.");
    s.node.cases.set(7, chainCase({ state: 2, firstAccept: true, customer: ME }));
    expect((await refusal(f.disputeVerified(7, { maxBondEth: "0.0009" }))).code).toBe("over_cap");
    expect(sent()).toBe(0);
  });
});

describe("a sealed verdict", () => {
  it("is sealed as the contract seals it, and a contract that works it out otherwise is refused", async () => {
    s.site.verifiers = { about: ON, items: [], page: null, cases: [], case: DISPUTED, post: null };
    const f = await connect({ privateKey: KEY });
    s.node.badCommit = true;
    expect((await refusal(f.sitOnPanel(7, false, "Two prices off the feed."))).code).toBe("commit_mismatch");
    s.node.badCommit = false;
    // the seal matches: the contract's own refusal of the seat comes back in words, and nothing is sent or kept
    s.node.verifierRefuse.sit = { error: "MakerTaken", args: [] };
    expect((await refusal(f.sitOnPanel(7, false, "Two prices off the feed."))).message).toBe("A verifier on the same model maker with an older standing holds that seat.");
    expect(await readVerdict(4663, VERIFIERS, 7)).toBeNull();
    expect(sent()).toBe(0);
  });

  it("is revealed only when it is what this wallet sealed, from the verdict given or the one kept", async () => {
    s.site.verifiers.about = ON;
    const f = await connect({ privateKey: KEY });
    const reason = "Verdict: reject\nTests:\n- fail: AAPL is 3% off the feed";
    const salt = saltOf(await privateKeyToAccount(KEY).signMessage({ message: sealMessage(7, ME) }));
    const commit = commitOf(7, ME, false, reasonHashOf(reason), salt);
    s.node.cases.set(7, chainCase());
    s.node.seats.set(7, [{ verifier: "0x00000000000000000000000000000000000000f2", since: 1, maker: 3, vote: 0, commit: `0x${"99".repeat(32)}` }, { verifier: ME, since: 2, maker: 2, vote: 0, commit }]);
    expect((await refusal(f.revealVerdict(7))).code).toBe("no_verdict");
    expect((await refusal(f.revealVerdict(7, { accept: true, reason }))).message).toBe("That is not what this wallet sealed: the verdict or the reasons differ from the ones given at the seat. Nothing was sent.");
    expect((await refusal(f.revealVerdict(7, { accept: false, reason: `${reason}.` }))).code).toBe("bad_reveal");
    // what was sealed: the contract's clock says not yet, in words
    const at = Math.floor(Date.now() / 1000) + 3600;
    s.node.verifierRefuse.reveal = { error: "TooSoon", args: [BigInt(at)] };
    expect((await refusal(f.revealVerdict(7, { accept: false, reason }))).message).toBe(`Not before ${new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.`);
    // and from the verdict this kit kept at the seat
    await keepVerdict({ chainId: 4663, contract: VERIFIERS, case: 7, verifier: ME, accept: false, reason, reasonHash: reasonHashOf(reason), salt, commit, seat: 1, tx: `0x${"33".repeat(32)}`, revealFrom: null, revealBy: null });
    expect((await refusal(f.revealVerdict(7))).code).toBe("verifiers_refused");
    s.node.seats.set(7, [{ verifier: ME, since: 2, maker: 2, vote: 2, commit }]);
    expect((await refusal(f.revealVerdict(7))).code).toBe("revealed");
    s.node.seats.set(7, []);
    expect((await refusal(f.revealVerdict(7))).code).toBe("not_seated");
    expect(sent()).toBe(0);
    rmSync(join(dir, `4663-${VERIFIERS}-7.json`));
  });

  it("a hire the desk refuses is said as the desk's", async () => {
    s.site.verifiers.about = ON;
    const f = await connect({ privateKey: KEY });
    s.node.verifierRefuse.hire = { error: "TooSmall", args: [10n ** 15n] };
    expect((await refusal(f.hireWithVerifier({ agent: "lumen-07", price: "0.01", fee: "0.0003", title: "Price check", brief: "Compare." }))).message).toBe("The smallest job is 0.001 ETH.");
    s.node.verifierRefuse.hire = { error: "NotRegistered", args: [] };
    expect((await refusal(f.hireWithVerifier({ agent: AGENTS[0]!.address, price: "0.01", fee: "0.0003", title: "Price check", brief: "Compare." }))).message).toBe("That wallet has not registered as an agent.");
    expect((await refusal(f.hireWithVerifier({ agent: "nobody-here", price: "0.01", fee: "0.0003", title: "Price check", brief: "Compare." }))).code).toBe("no_agent");
    expect(sent()).toBe(0);
  });
});

describe("the texts handed to Factor", () => {
  it("tries again every 2 seconds on a 404 or a 409 while the engine catches up, up to 20 times", async () => {
    let n = 0;
    s.site.verifiers.post = () => (++n < 3 ? { status: n === 1 ? 404 : 409, body: { error: "not on the engine yet" } } : { status: 200, body: { ok: true, id: 7 } });
    expect(await sendVerifierText(s.api.replace(/$/, "/api/v1"), "/verifiers/terms", { id: 7, terms: "{}" }, { everyMs: 5 })).toEqual({ ok: true });
    expect(n).toBe(3);
    n = 0;
    s.site.verifiers.post = () => { n++; return { status: 409, body: { error: "the hash is not the one on the chain" } }; };
    expect(await sendVerifierText(`${s.api}/api/v1`, "/verifiers/reason", { id: 7, verifier: ME, reason: "x" }, { everyMs: 1 })).toEqual({ ok: false, note: "The hash is not the one on the chain." });
    expect(n).toBe(20);
    n = 0;
    s.site.verifiers.post = () => { n++; return { status: 400, body: { error: "the reasons are 4000 characters at most" } }; };
    expect((await sendVerifierText(`${s.api}/api/v1`, "/verifiers/reason", { id: 7 }, { everyMs: 1 })).ok).toBe(false);
    expect(n).toBe(1);
    expect(s.posts.map((p) => p.path)).toEqual([...Array(3).fill("/verifiers/terms"), ...Array(21).fill("/verifiers/reason")]);
  });
});

describe("model receipts", () => {
  const RECEIPT = { provider: "openrouter", generationId: "gen-1731150000-abc", model: "anthropic/claude-sonnet-5-5", requestHash: `0x${"AB".repeat(32)}`, outputHash: `0x${"cd".repeat(32)}` };
  const BASE = "Verdict: reject\nTests:\n- fail: AAPL is 3% off the feed";

  it("adds the receipt's lines at the end of the reasons, before they are hashed, and reads them back", () => {
    const block = `Receipt:\n- provider: openrouter\n- generation: gen-1731150000-abc\n- model: anthropic/claude-sonnet-5-5\n- request-hash: 0x${"ab".repeat(32)}\n- output-hash: 0x${"cd".repeat(32)}`;
    expect(receiptBlock(checkReceipt(RECEIPT))).toBe(block);
    expect(withReceipt(`${BASE}\n\n  `, RECEIPT)).toBe(`${BASE}\n${block}`);
    expect(withReceipt(BASE)).toBe(BASE);
    expect(reasonHashOf(withReceipt(BASE, RECEIPT))).toBe(keccak256(stringToBytes(`${BASE}\n${block}`)));
    expect(readReceipt(withReceipt(BASE, RECEIPT))).toEqual({ ...checkReceipt(RECEIPT), more: {} });
    // Factor's own verifiers add lines of their own after the five
    expect(readReceipt(`${BASE}\n${block}\n- reported-model: anthropic/claude-sonnet-5-5-20261101\n- tokens: 1200 in, 340 out`)!.more).toEqual({ "reported-model": "anthropic/claude-sonnet-5-5-20261101", tokens: "1200 in, 340 out" });
    expect(readReceipt(BASE)).toBeNull();
    expect(receiptHashes('{"model":"x"}', "the answer")).toEqual({ requestHash: keccak256(stringToBytes('{"model":"x"}')), outputHash: keccak256(stringToBytes("the answer")) });
  });

  it("refuses a receipt that does not fit its lines, before anything is sent", () => {
    for (const bad of [{ ...RECEIPT, requestHash: "0x12" }, { ...RECEIPT, generationId: "two words" }, { ...RECEIPT, provider: "" }, { ...RECEIPT, model: "a\nb" }, null]) expect(() => checkReceipt(bad), JSON.stringify(bad)).toThrow(Refusal);
    expect(() => withReceipt(`${BASE}\nReceipt:\n- provider: x`, RECEIPT)).toThrow(/Receipt: line already/);
    expect(() => withReceipt("x".repeat(3800), RECEIPT)).toThrow(/1 to 4,000 characters/);
  });

  it("a reveal makes the same reasons again from the receipt given at the seat, or from the verdict kept", async () => {
    s.site.verifiers.about = ON;
    const f = await connect({ privateKey: KEY });
    const reason = withReceipt(BASE, RECEIPT);
    const salt = saltOf(await privateKeyToAccount(KEY).signMessage({ message: sealMessage(7, ME) }));
    const commit = commitOf(7, ME, false, reasonHashOf(reason), salt);
    s.node.cases.set(7, chainCase());
    s.node.seats.set(7, [{ verifier: ME, since: 2, maker: 2, vote: 0, commit }]);
    s.node.verifierRefuse.reveal = { error: "TooSoon", args: [BigInt(Math.floor(Date.now() / 1000) + 3600)] };
    // the reasons without their receipt are not what was sealed
    expect((await refusal(f.revealVerdict(7, { accept: false, reason: BASE }))).code).toBe("bad_reveal");
    expect((await refusal(f.revealVerdict(7, { receipt: RECEIPT }))).code).toBe("bad_verdict");
    // with it, they are: the contract's clock is what refuses
    expect((await refusal(f.revealVerdict(7, { accept: false, reason: BASE, receipt: RECEIPT }))).message).toMatch(/^Not before /);
    const r = await runTool(f, "factor_verifier_reveal", { case: 7, accept: false, reason: BASE, receipt: { provider: "openrouter", generation_id: RECEIPT.generationId, model: RECEIPT.model, request_hash: RECEIPT.requestHash, output_hash: RECEIPT.outputHash } }, null);
    expect(r.text).toMatch(/^Not before /);
    await keepVerdict({ chainId: 4663, contract: VERIFIERS, case: 7, verifier: ME, accept: false, reason, reasonHash: reasonHashOf(reason), salt, commit, seat: 0, tx: `0x${"33".repeat(32)}`, revealFrom: null, revealBy: null });
    expect((await refusal(f.revealVerdict(7))).message).toMatch(/^Not before /);
    rmSync(join(dir, `4663-${VERIFIERS}-7.json`));
    expect((await runTool(f, "factor_verifier_check", { case: 7, accept: true, reason: "ok", receipt: { provider: "openrouter" } }, null)).text).toMatch(/^That is not what factor_verifier_check takes/);
    expect(sent()).toBe(0);
  });

  it("a case says each verdict's model: a receipt checked by Factor, or declared; and a verdict's receipt is read with its texts", async () => {
    const checked = { mark: "checked", maker: 1, makerName: "Anthropic", receipt: { by: "factor", provider: "openrouter", generationId: "gen-1", modelAsked: "anthropic/claude-sonnet-5-5", modelReported: "anthropic/claude-sonnet-5-5", providerName: "Anthropic", tokensIn: 1200, tokensOut: 340, createdAt: "2026-11-09T09:20:00.000Z", requestHash: keccak256(stringToBytes("the request")), outputHash: keccak256(stringToBytes("the answer")), checkedAt: "2026-11-09T09:31:00.000Z", matches: true, why: null, url: "https://factoragents.fun/verifiers/receipt/7/0xf1" } };
    const declared = { mark: "declared", maker: 3, makerName: "OpenAI", receipt: null };
    s.site.verifiers = { about: ON, items: [], page: null, cases: [], case: { ...DISPUTED, first: { ...DISPUTED.first, model: checked }, seats: [{ ...DISPUTED.seats[0], model: declared }] }, post: null, receipt: { receipt: checked.receipt, request: "the request", output: "the answer!", providerRecord: { id: "gen-1" } } };
    const f = await connect();
    const text = (await runTool(f, "factor_verifier_case", { case: 7 }, null)).text;
    expect(text).toContain("Its model: model receipt checked by Factor (Anthropic); receipt from openrouter, call gen-1, anthropic/claude-sonnet-5-5 asked, https://factoragents.fun/verifiers/receipt/7/0xf1.");
    expect(text).toContain("Seat 0: 0x00000000000000000000000000000000000000f2 (OpenAI), sealed, not revealed. Its model: model declared (OpenAI).");
    const r = await f.verdictReceipt(7, "0x00000000000000000000000000000000000000f1");
    expect(r.hashesMatch).toEqual({ request: true, output: false });
    expect((await runTool(f, "factor_verifiers", {}, null)).text).toBe("No verifier has joined yet.");
    s.site.verifiers.items = [{ ...VERIFIER, receipts: { checked: 2, declared: 1 } }];
    expect((await runTool(f, "factor_verifiers", {}, null)).text).toContain("Model receipts: 2 checked by Factor, 1 declared.");
  });
});

describe("ERC-8004 validations", () => {
  const FILE = '{"case":7,"verdict":"accept"}';
  const FILE_HASH = keccak256(stringToBytes(FILE));
  const VALIDATOR = "0x00000000000000000000000000000000000000f1";
  const E = (over: Record<string, unknown> = {}) => ({
    registry: VALIDATION_REGISTRY.toLowerCase(), tag: "factorVerify", agentId: "42", state: "prepared", validator: VALIDATOR, response: 100, file: "https://factoragents.fun/api/v1/verifiers/file/7", fileHash: FILE_HASH,
    requestCall: { to: VALIDATION_REGISTRY.toLowerCase(), data: encodeFunctionData({ abi: erc8004ValidationAbi, functionName: "validationRequest", args: [VALIDATOR, 42n, "https://factoragents.fun/api/v1/verifiers/file/7", FILE_HASH] }) },
    responseCall: { to: VALIDATION_REGISTRY.toLowerCase(), data: encodeFunctionData({ abi: erc8004ValidationAbi, functionName: "validationResponse", args: [FILE_HASH, 100, "https://factoragents.fun/api/v1/verifiers/file/7", FILE_HASH, "factorVerify"] }) },
    requestedAt: null, answeredAt: null, ...over,
  });
  beforeEach(() => { s.node.registryRefuse = null; s.node.registryCalls = []; });

  it("reads a case's validation and an agent's, and says them in words", async () => {
    s.site.verifiers = { about: ON, items: [], page: null, cases: [], case: { ...CASE, erc8004: E({ state: "answered", answeredAt: "2026-11-10T10:00:00.000Z" }) }, post: null, erc8004: E() };
    const f = await connect();
    expect((await f.verifiedErc8004(7))!.state).toBe("prepared");
    expect((await runTool(f, "factor_verified_erc8004", { case: 7 }, null)).text).toContain(`ERC-8004 validation: prepared. The owner of identity #42 asks the verifier ${VALIDATOR} to validate the case file with factor_verified_8004_request`);
    expect((await runTool(f, "factor_verifier_case", { case: 7 }, null)).text).toContain(`On ERC-8004: the verifier ${VALIDATOR} answered 100 (accept) 2026-11-10T10:00:00.000Z for identity #42, tag factorVerify`);
    expect((await runTool(f, "factor_verified_erc8004", {}, null)).text).toMatch(/one of the two/);
    expect((await runTool(f, "factor_verified_erc8004", { agent: "lumen-07" }, null)).text).toBe("lumen-07 has no job hired with a verifier.");
    s.site.state = state({ agents: [{ ...AGENTS[0]!, verified: { jobs: 3, accepted: 2, rejected: 1, disputed: 1, onErc8004: { count: 2, avgResponse: 50, registry: VALIDATION_REGISTRY, tag: "factorVerify" } } }, AGENTS[1]!] });
    expect((await runTool(f, "factor_verified_erc8004", { agent: "lumen-07" }, null)).text).toBe(`lumen-07: 3 jobs hired with a verifier, 2 accepted, 1 rejected, 1 disputed. On the ERC-8004 Validation Registry (${VALIDATION_REGISTRY}, tag factorVerify): 2 validations, 50 of 100 on average.`);
    expect((await f.verifiedCaseFile(7).catch((e: Refusal) => e.code))).toBe("no_file");
    s.site.verifiers.file = FILE;
    expect(await f.verifiedCaseFile(7)).toEqual({ text: FILE, hash: FILE_HASH });
  });

  it("asks for a validation only as Factor prepared it, to the registry, for that verifier, identity and file", async () => {
    s.site.verifiers = { about: ON, items: [], page: null, cases: [], case: null, post: null, erc8004: E({ state: "requested" }), file: FILE };
    const f = await connect({ privateKey: KEY });
    expect((await refusal(f.requestErc8004Validation(7))).code).toBe("wrong_state");
    s.site.verifiers.erc8004 = E({ state: "off", why: "validations are switched off" });
    expect((await refusal(f.requestErc8004Validation(7))).code).toBe("erc8004_off");
    s.site.verifiers.erc8004 = E({ registry: "0x00000000000000000000000000000000000dead0" });
    expect((await refusal(f.requestErc8004Validation(7))).code).toBe("wrong_registry");
    s.site.verifiers.erc8004 = E({ requestCall: { ...E().requestCall, to: "0x00000000000000000000000000000000000dead0" } });
    expect((await refusal(f.requestErc8004Validation(7))).code).toBe("wrong_registry");
    s.site.verifiers.erc8004 = E({ requestCall: { to: VALIDATION_REGISTRY, data: encodeFunctionData({ abi: erc8004ValidationAbi, functionName: "validationRequest", args: [ME as Hex, 42n, "https://factoragents.fun/api/v1/verifiers/file/7", FILE_HASH] }) } });
    expect((await refusal(f.requestErc8004Validation(7))).code).toBe("bad_answer");
    s.site.verifiers.erc8004 = E();
    s.site.verifiers.file = `${FILE} `;
    expect((await refusal(f.requestErc8004Validation(7))).code).toBe("bad_file");
    s.site.verifiers.file = FILE;
    expect(s.node.registryCalls).toEqual([]);
    // as prepared: tried on the registry, which says who may ask
    s.node.registryRefuse = "Not authorized";
    expect((await refusal(f.requestErc8004Validation(7))).message).toBe("Only the owner of the agent's ERC-8004 identity, or an operator it approved, can ask for this validation.");
    expect(s.node.registryCalls).toEqual(["validationRequest"]);
    expect((await runTool(f, "factor_verified_8004_request", { case: 7 }, null)).text).toBe("Only the owner of the agent's ERC-8004 identity, or an operator it approved, can ask for this validation.");
    expect(sent()).toBe(0);
  });

  it("answers a validation only from the verifier it names, with the verdict carried out", async () => {
    s.site.verifiers = { about: ON, items: [], page: null, cases: [], case: null, post: null, erc8004: E({ state: "requested" }), file: FILE };
    const f = await connect({ privateKey: KEY });
    expect((await refusal(f.answerErc8004Validation(7))).code).toBe("not_validator");
    const responseCall = { to: VALIDATION_REGISTRY, data: encodeFunctionData({ abi: erc8004ValidationAbi, functionName: "validationResponse", args: [FILE_HASH, 100, "https://factoragents.fun/api/v1/verifiers/file/7", FILE_HASH, "factorVerify"] }) };
    s.site.verifiers.erc8004 = E({ state: "requested", validator: ME, responseCall });
    s.node.registryRefuse = "unknown";
    expect((await refusal(f.answerErc8004Validation(7))).message).toBe("The registry has no such request: the owner of the agent's ERC-8004 identity has not asked for this validation yet.");
    // a call that says another answer than the verdict carried out is not sent
    s.site.verifiers.erc8004 = E({ state: "requested", validator: ME, response: 0, responseCall });
    expect((await refusal(f.answerErc8004Validation(7))).code).toBe("bad_answer");
    s.site.verifiers.erc8004 = E({ state: "prepared", validator: ME });
    expect((await refusal(f.answerErc8004Validation(7))).code).toBe("wrong_state");
    Object.defineProperty(f, "via", { value: "0x00000000000000000000000000000000000acc07" });
    expect((await runTool(f, "factor_verifier_8004_respond", { case: 7 }, null)).text).toMatch(/not offered through a Factor account/);
    expect(s.node.registryCalls).toEqual(["validationResponse"]);
    expect(sent()).toBe(0);
  });
});

describe("the tools", () => {
  const NAMES =["factor_verifiers_about", "factor_verifiers", "factor_verifier", "factor_verifier_cases", "factor_verifier_case", "factor_verifier_join", "factor_verifier_add_bond", "factor_verifier_withdraw", "factor_verifier_check", "factor_verifier_sit", "factor_verifier_reveal", "factor_hire_with_verifier", "factor_verified_accept", "factor_verified_reject", "factor_verified_concede", "factor_verified_dispute", "factor_verified_strike", "factor_verified_step", "factor_verified_erc8004", "factor_verified_8004_request", "factor_verifier_8004_respond"];
  const READS = [...NAMES.slice(0, 5), "factor_verified_erc8004"];
  const WRITES = NAMES.filter((x) => !READS.includes(x));

  it("are the spec's 21, six of them reads, and 122 tools in all", () => {
    const mine = TOOLS.filter((t) => NAMES.includes(t.name));
    expect(mine.map((t) => t.name)).toEqual(NAMES);
    expect(mine.filter((t) => t.readOnly).map((t) => t.name)).toEqual(READS);
    expect([...VERIFIER_WRITE_TOOLS]).toEqual(WRITES);
    expect(TOOLS.length).toBe(122);
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const name of ["factor_verifier_join", "factor_verifier_add_bond", "factor_hire_with_verifier", "factor_verified_dispute"]) expect(TOOLS.find((t) => t.name === name)!.description, name).toMatch(/SPENDS ETH/);
    for (const name of ["factor_verified_reject", "factor_verified_concede"]) expect(TOOLS.find((t) => t.name === name)!.description, name).toMatch(/SETTLES AT HALF/);
    expect(TOOLS.find((t) => t.name === "factor_verifier_sit")!.description).toMatch(/A SEAT NEVER REVEALED LOSES ALL OF IT/);
    for (const t of mine) expect(t.description, t.name).not.toContain(String.fromCharCode(0x2014));
  });

  it("the six reads are on the hosted /mcp, and none of the writes", () => {
    const route = readFileSync(join(__dirname, "../../../web/src/app/mcp/route.ts"), "utf8");
    const hosted = JSON.parse(`[${/const HOSTED = \[([^\]]*)\]/.exec(route)![1]}]`) as string[];
    for (const name of READS) expect(hosted, name).toContain(name);
    for (const name of WRITES) expect(hosted, name).not.toContain(name);
    for (const name of hosted) expect(TOOLS.find((t) => t.name === name)?.readOnly, name).toBe(true);
  });
});
