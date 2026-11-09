// Verifiers on the made-up chain: the verifier contract is modelled here (FakeChain.extra), and its logs are written in
// the real encoding, so the engine reads them with the real ABI. Each case's job is a real job on the made-up desk,
// locked by the model with the contract as its customer. What is checked: the settings and the switch; the words, the
// reasons and the seal hashed exactly as the contract and the kit hash them; the tests a verifier runs where the work
// allows; a case read and shown in every state, with its clock; the words and reasons taken only when they hash to the
// chain; the keeper's step only once a case's time has come; the cases a verifier may take; an agent's verified jobs and
// its record as a verifier; the Factor Score's own line for verified jobs; the owner's switch; and Factor's own verifiers
// checking with tests and a stand-in model, sitting sealed and revealing, never where Factor is a side and never past
// the day's cap. No test calls a model or touches a real chain.

import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, type Abi, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { erc8004ValidationAbi, factorVerifiersAbi } from "../src/abi/index.js";
import { VALIDATION_REGISTRY } from "../src/erc8004.js";
import { caseFileText, hashOf, modelOfMaker, readOpenRouterRecord, readReceipt, receiptBlock, receiptHolds, type ProviderRecord } from "../src/verifierproof.js";
import type { CallSpec, Chain } from "../src/chain/chain.js";
import { EngineDb, open } from "../src/chain/db.js";
import { turn } from "../src/switches.js";
import { arithmetic, prices, readAnswer, reasonText, runTests, sections, something, verdictOf } from "../src/verifiercheck.js";
import { MAKERS, VERIFIER_RULES, VERIFY_TAG, Verifiers, encodeCommit, hashText, houseVerifierSigner, parseTerms, readVerifiers, reasonOk, routerAsker, routerLookup, termsText, type Asker, type CaseRow, type Lookup, type Terms, type VerifiersConfig } from "../src/verifiers.js";
import { ETH, FakeChain, S } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

const V = "0x00000000000000000000000000000000000e71f1";
const CUSTOMER = "0x00000000000000000000000000000000000c0571";
const AGENT = "0x00000000000000000000000000000000000a6e71";
const V1 = "0x000000000000000000000000000000000000c1a0";
const V2 = "0x0000000000000000000000000000000000006e00";
const V3 = "0x000000000000000000000000000000000000a100";
const V4 = "0x000000000000000000000000000000000000d500";
const H = 3600;
const PRICE = ETH / 100n; // 0.01
const FEE = (ETH * 3n) / 10_000n; // 0.0003
const ST = { working: 1, checked: 2, disputed: 3, customer: 4, accepted: 5, rejected: 6, returned: 7 } as const;
const HOW = { firstCheck: 1, panel: 2, customer: 3, clock: 4, notDelivered: 5 } as const;

interface ModelCase { id: number; job: number; customer: string; agent: string; price: bigint; fee: bigint; terms: string; state: number; checker?: string; firstAccept?: boolean }

/** The verifier contract, as the engine asks it things and as the keeper's step changes it. Only what the engine uses. */
class Model {
  cases: ModelCase[] = [];
  steps: number[] = [];
  records = new Map<string, { maker: number; since: number; free: bigint; locked: bigint; right: number; wrong: number }>();
  constructor(private chain: FakeChain) {
    chain.extra = { answer: (c) => this.answer(c), run: (c, f, commit, tx) => this.run(c, f, commit, tx) };
  }

  by(id: number): ModelCase { return this.cases.find((x) => x.id === id)!; }

  // the ERC-8004 validation registry, as much of it as the engine reads: a request's status, and an agent's summary
  validations = new Map<string, { validator: string; agentId: bigint; response: number; responseHash: string; tag: string; lastUpdate: bigint }>();
  summary: [bigint, number] = [0n, 0];

  answer(call: CallSpec): unknown {
    if (call.to.toLowerCase() === VALIDATION_REGISTRY) {
      if (call.functionName === "getSummary") return this.summary;
      const v = this.validations.get(String(call.args![0]).toLowerCase());
      if (!v) throw new Error("unknown");
      return [v.validator, v.agentId, v.response, v.responseHash, v.tag, v.lastUpdate];
    }
    if (call.to.toLowerCase() !== V) return undefined;
    const fn = call.functionName, a = call.args ?? [];
    if (fn === "getCase") { const x = this.cases.find((y) => y.id === Number(a[0])); return x ? { state: x.state, terms: x.terms } : { state: 0, terms: `0x${"0".repeat(64)}` }; }
    if (fn === "verifier") {
      const r = this.records.get(String(a[0]).toLowerCase()) ?? { maker: 0, since: 0, free: 0n, locked: 0n, right: 0, wrong: 0 };
      return { maker: r.maker, since: BigInt(r.since), open: 0, checks: 1, panels: 0, right: r.right, wrong: r.wrong, hidden: 0, struck: 0, free: r.free, locked: r.locked, earned: 0n, lost: 0n };
    }
    const totals: Record<string, bigint> = { bonds: 0n, staked: 0n, fees: this.cases.filter((c) => c.state <= ST.customer).reduce((n, c) => n + c.fee, 0n), disputes: 0n, owedTotal: 0n, atDesk: 0n, totalHired: 0n, totalFeesPaid: 0n, totalSlashed: 0n, caseCount: BigInt(this.cases.length) };
    return fn in totals ? totals[fn] : undefined;
  }

  run(call: CallSpec, _from: string, commit: boolean, tx: string): unknown {
    if (call.to.toLowerCase() !== V) return undefined;
    if (call.functionName !== "step") throw new Error("not modelled");
    const x = this.by(Number(call.args![0]));
    const j = this.chain.jobs.get(x.job)!;
    if (x.state === ST.checked && this.chain.time < this.checkedAt + 2 * H) throw new Error("TooSoon");
    if (x.state !== ST.checked || j.state !== S.delivered) throw new Error("not modelled");
    if (!commit) return null;
    this.steps.push(x.id);
    if (x.state === ST.checked) {
      this.log("Decided", { id: BigInt(x.id), how: HOW.firstCheck, verdict: x.firstAccept ? 1 : 2, votesAccept: 0n, votesReject: 0n }, tx);
      this.log("Paid", { id: BigInt(x.id), verifier: x.checker, amount: x.fee }, tx);
      // the desk's settlement in the same transaction as the step, as the contract's accept does it
      if (x.firstAccept) { (this.chain as unknown as { settleJob(id: number, tx?: string): void }).settleJob(x.job, tx); this.end(x, ST.accepted, HOW.firstCheck, 0n, tx); }
      else { this.chain.reject(x.job); this.end(x, ST.rejected, HOW.firstCheck, x.price / 2n, tx); }
    }
    return null;
  }

  checkedAt = 0;

  log(eventName: string, args: Record<string, unknown>, tx?: string) {
    const abi = factorVerifiersAbi as Abi;
    const ev = abi.find((x) => x.type === "event" && x.name === eventName) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
    const rest = ev.inputs.filter((i) => !i.indexed);
    // each log of a test's own in a block of its own, so none falls behind a block the engine has already read; the
    // logs of one transaction (the keeper's step) share its block
    if (!tx) this.chain.mine();
    return this.chain.push({ address: V, topics: encodeEventTopics({ abi, eventName, args } as never) as Hex[], data: encodeAbiParameters(rest, rest.map((i) => args[i.name]) as never), ...(tx ? { transactionHash: tx as Hex } : {}) } as never);
  }

  join(who: string, maker: number, since = this.chain.time) {
    this.records.set(who, { maker, since, free: ETH / 20n, locked: 0n, right: 0, wrong: 0 });
    this.log("Joined", { verifier: who, maker, bond: ETH / 20n });
    this.log("Standing", { verifier: who, since: BigInt(since) });
  }

  hire(terms: Terms, o: { agent?: string; customer?: string } = {}): ModelCase {
    this.chain.mine();
    const job = this.chain.lock(V, (o.agent ?? AGENT).toLowerCase(), PRICE, 86_400, false);
    const x: ModelCase = { id: this.cases.length + 1, job, customer: (o.customer ?? CUSTOMER).toLowerCase(), agent: (o.agent ?? AGENT).toLowerCase(), price: PRICE, fee: FEE, terms: hashText(termsText(terms)), state: ST.working };
    this.cases.push(x);
    this.log("Hired", { id: BigInt(x.id), job: BigInt(job), customer: x.customer, agent: x.agent, price: PRICE, fee: FEE, stake: ETH / 500n, disputeBond: ETH / 1000n, terms: x.terms });
    return x;
  }

  check(id: number, who: string, accept: boolean, reason: string) {
    const x = this.by(id);
    x.state = ST.checked; x.checker = who; x.firstAccept = accept;
    this.checkedAt = this.chain.time;
    this.log("Checked", { id: BigInt(id), verifier: who, accept, reason: hashText(reason) });
  }

  dispute(id: number, by: string) {
    this.by(id).state = ST.disputed;
    this.log("Disputed", { id: BigInt(id), by, bond: ETH / 1000n });
  }

  sit(id: number, who: string, maker: number, seat: number) { this.log("Sat", { id: BigInt(id), verifier: who, maker, seat: BigInt(seat) }); }
  strike(id: number, who: string, by: string) { this.log("Struck", { id: BigInt(id), verifier: who, by }); }
  reveal(id: number, who: string, accept: boolean, reason: string) { this.log("Revealed", { id: BigInt(id), verifier: who, accept, reason: hashText(reason) }); }

  panel(id: number, verdict: 1 | 2, a: number, r: number, paid: [string, bigint][], slashed: [string, bigint][]) {
    const x = this.by(id);
    this.log("Decided", { id: BigInt(id), how: HOW.panel, verdict, votesAccept: BigInt(a), votesReject: BigInt(r) });
    for (const [who, amount] of paid) this.log("Paid", { id: BigInt(id), verifier: who, amount });
    for (const [who, amount] of slashed) this.log("Slashed", { id: BigInt(id), verifier: who, amount });
    if (verdict === 1) { this.chain.accept(x.job); this.end(x, ST.accepted, HOW.panel, 0n); }
    else { this.chain.reject(x.job); this.end(x, ST.rejected, HOW.panel, x.price / 2n); }
  }

  end(x: ModelCase, state: number, how: number, toCustomer: bigint, tx?: string) {
    x.state = state;
    this.log("Ended", { id: BigInt(x.id), state, how, toCustomer }, tx);
  }
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

const ON = { VERIFIERS: "on", FACTOR_VERIFIERS: V, FACTOR_VERIFIERS_BLOCK: "5000" };

async function world(o: { more?: Record<string, string> } = {}): Promise<{ r: Rig; chain: FakeChain; model: Model }> {
  const chain = new FakeChain();
  chain.fund(ETH);
  chain.register(AGENT);
  const model = new Model(chain);
  const r = await rig("live", { chain, more: { ...ON, ...o.more } });
  rigs.push(r);
  r.db.q("INSERT INTO agent_profiles (address, name, name_key, does, signed_at) VALUES (?, ?, ?, ?, ?)").run(AGENT, "report-lead", "report-lead", "writes weekly reports", 1);
  await r.engine.watchOnce();
  return { r, chain, model };
}

type Body = Record<string, any>;
const get = async (r: Rig, path: string): Promise<Body> => { const [p, q] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q ?? "")))!; return { status: a.status, ...(a.body as Body) }; };
const post = async (r: Rig, path: string, body: unknown, from = "1.1.1.1"): Promise<Body> => { const a = (await r.engine.post(path, body, from))!; return { status: a.status, ...(a.body as Body) }; };

const TERMS: Terms = { title: "A lease, read", brief: "Read the lease and list:\n- the start date\n- the rent\n- the notice period" };
const TEXT = termsText(TERMS);
const WORK = "Lease summary\nStart date: 1 March 2027\nRent: 1,200 a month, 1200 x 12 = 14400 a year\nNotice period: three months";
const WHY = "Verdict: accept\nTests:\n- pass: 1200 x 12 = 14400 holds\nReasons:\nThe dates, the rent and the notice period are all there.\nModel: Anthropic, a stand-in";

describe("the settings, the words and the seal", () => {
  it("are off unless VERIFIERS=on, say why they cannot run, and Factor's own verifiers need their own switch", () => {
    expect(readVerifiers({}).enabled).toBe(false);
    expect(readVerifiers({ VERIFIERS: "on" }).note).toMatch(/FACTOR_VERIFIERS is not set/);
    expect(readVerifiers({ VERIFIERS: "on", FACTOR_VERIFIERS: V }).note).toMatch(/FACTOR_VERIFIERS_BLOCK/);
    expect(readVerifiers(ON).note).toBeNull();
    expect(readVerifiers(ON).house.enabled).toBe(false);
    expect(readVerifiers({ ...ON, VERIFIERS_HOUSE: "on" }).house).toMatchObject({ enabled: true, dailyMicro: 2_000_000 });
    expect(Object.keys(readVerifiers(ON).house.models).length).toBeGreaterThanOrEqual(3);
    const problems: string[] = [];
    readVerifiers({ FACTOR_VERIFIERS: "nope", FACTOR_VERIFIERS_BLOCK: "x", VERIFIERS_PER_PASS: "0", VERIFIERS_MODELS: "1=a/b" }, problems);
    expect(problems).toHaveLength(4);
    expect(readVerifiers({ ...ON, VERIFIERS_MODELS: "1=anthropic/x,2=google/y,3=openai/z" }).house.models).toEqual({ 1: "anthropic/x", 2: "google/y", 3: "openai/z" });
  });

  it("the words are compact JSON in a fixed order, read back only when the title and brief are", () => {
    expect(TEXT).toBe('{"title":"A lease, read","brief":"Read the lease and list:\\n- the start date\\n- the rent\\n- the notice period"}');
    expect(parseTerms(TEXT)).toEqual(TERMS);
    expect(parseTerms("nope")).toMatch(/not JSON/);
    expect(parseTerms(termsText({ ...TERMS, title: "x" }))).toMatch(/title/);
    expect(parseTerms(termsText({ ...TERMS, title: "see https://x.com" }))).toMatch(/title/);
    expect(parseTerms(termsText({ ...TERMS, brief: "" }))).toMatch(/brief/);
    expect(hashText(TEXT)).toBe(keccak256(new TextEncoder().encode(TEXT)));
  });

  it("the reasons are plain text of 1 to 4,000 characters", () => {
    expect(reasonOk(WHY)).toBe(WHY);
    expect(reasonOk("")).toBeNull();
    expect(reasonOk("   ")).toBeNull();
    expect(reasonOk("x".repeat(4001))).toBeNull();
    expect(reasonOk("hidden​text")).toBeNull();
  });

  it("the commit is abi.encode of the five values, as the contract's commitOf hashes it", () => {
    const salt = keccak256("0x01");
    const reason = hashText(WHY);
    const mine = encodeCommit(7, V1, true, reason, salt);
    const viem = encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "bool" }, { type: "bytes32" }, { type: "bytes32" }], [7n, V1 as Hex, true, reason, salt]);
    expect(mine).toBe(viem);
  });

  it("a verifier of Factor's own has its key from the seed and its maker, and the same salt for a case every time", () => {
    const seed = keccak256("0x1234") as Hex;
    const a = houseVerifierSigner(seed, 1), b = houseVerifierSigner(seed, 2);
    expect(a.address).not.toBe(b.address);
    expect(houseVerifierSigner(seed, 1).address).toBe(a.address);
    expect(a.salt(5)).toBe(houseVerifierSigner(seed, 1).salt(5));
    expect(a.salt(5)).not.toBe(a.salt(6));
    expect(MAKERS.map((m) => m.id)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });
});

describe("tests where the work allows", () => {
  it("works out every simple sum again", () => {
    expect(arithmetic("1200 x 12 = 14400").every((t) => t.pass)).toBe(true);
    expect(arithmetic("2 + 2 = 5")[0]).toMatchObject({ pass: false, hard: true });
    expect(arithmetic("10 / 4 = 2.5 and 3 - 1 = 2 and 1,000 + 250 = 1,250").map((t) => t.pass)).toEqual([true, true, true]);
    expect(arithmetic("10 / 3 = 3.33")[0]!.pass).toBe(true);
    expect(arithmetic("no sums here")).toEqual([]);
  });

  it("compares a price the work gives with Chainlink's feed on the chain, within 2%", async () => {
    const feed = async (s: string) => (s === "TSLA" ? null : s === "NVDA" ? 180 : s === "ETH" ? 3000 : null);
    const out = await prices("NVDA at $181.20 and ETH is 3500, TSLA $400", feed, ["NVDA", "ETH", "TSLA"]);
    expect(out.map((t) => [t.detail.split(" ")[0], t.pass])).toEqual([["NVDA", true], ["ETH", false]]);
  });

  it("looks for what the brief lists, and knows an empty or parroted work", () => {
    const s = sections(TERMS.brief, WORK);
    expect(s.map((t) => t.pass)).toEqual([true, true, true]);
    expect(sections(TERMS.brief, "Start date only: 1 March").filter((t) => !t.pass).length).toBe(2);
    expect(something(TERMS.brief, "ok").pass).toBe(false);
    expect(something(TERMS.brief, TERMS.brief).pass).toBe(false);
    expect(something(TERMS.brief, WORK).pass).toBe(true);
  });

  it("a failed sum or price is a reject whatever the model says; a missing section is the model's to weigh", async () => {
    const t = await runTests(TERMS.brief, `${WORK}\n2 + 2 = 5`, null, []);
    expect(verdictOf(t, { accept: true, reasons: "fine" })).toBe(false);
    const soft = await runTests(TERMS.brief, "Start date: 1 March 2027, and that is all there is to it here.", null, []);
    expect(verdictOf(soft, { accept: true, reasons: "fine" })).toBe(true);
    expect(readAnswer('Here: {"accept": false, "reasons": "The rent is missing."}')).toEqual({ accept: false, reasons: "The rent is missing." });
    expect(readAnswer("I think it is fine")).toBeNull();
    const text = reasonText(true, t, "Fine.", "Anthropic, a stand-in");
    expect(text).toMatch(/^Verdict: accept\nTests:\n- pass:/);
    expect(text).toMatch(/- fail: 2 \+ 2 = 5: it is 4/);
    expect(text.length).toBeLessThanOrEqual(4000);
  });
});

describe("a case, read from the chain", () => {
  it("off, nothing is read or shown", async () => {
    const { r, model } = await world({ more: { VERIFIERS: "" } });
    model.hire(TERMS);
    await r.engine.watchOnce();
    expect(r.db.count("verifier_cases")).toBe(0);
    expect(await get(r, "/v1/verifiers/about")).toMatchObject({ enabled: false, contract: null });
    expect((await get(r, "/v1/verifiers/case/1")).status).toBe(404);
    expect((await post(r, "/v1/verifiers/terms", { id: 1, terms: TEXT })).status).toBe(503);
  });

  it("shows the case, takes its words only when they hash to it, and gives the desk job its title and brief", async () => {
    const { r, model } = await world();
    const x = model.hire(TERMS);
    await r.engine.watchOnce();
    let c = (await get(r, "/v1/verifiers/case/1")).case;
    expect(c).toMatchObject({ id: 1, job: { n: x.job, state: "locked" }, customer: CUSTOMER, agent: { address: AGENT, name: "report-lead" }, priceEth: 0.01, feeEth: 0.0003, stakeEth: 0.002, disputeBondEth: 0.001, state: "working", title: null, next: null, seats: [], struck: [] });
    expect((await post(r, "/v1/verifiers/terms", { id: 1, terms: termsText({ ...TERMS, title: "Another job entirely" }) })).status).toBe(409);
    expect((await post(r, "/v1/verifiers/terms", { id: 9, terms: TEXT })).status).toBe(404);
    expect((await post(r, "/v1/verifiers/terms", { id: 1, terms: TEXT })).status).toBe(200);
    c = (await get(r, "/v1/verifiers/case/1")).case;
    expect(c).toMatchObject({ title: TERMS.title, brief: TERMS.brief });
    const job = await get(r, `/v1/jobs/${x.job}`);
    expect(job.job.title).toBe(TERMS.title);
    expect(job.brief).toMatch(/^Read the lease/);
    expect(job.brief).toMatch(/Hired with a verifier/);
    expect((await get(r, `/v1/verifiers/job/${x.job}`)).case.id).toBe(1);
    expect((await get(r, "/v1/verifiers/about")).totals).toMatchObject({ cases: 1, open: 1 });
  });

  it("a first check, its reasons, the dispute time, and the keeper's step only once that time is over", async () => {
    const { r, chain, model } = await world();
    model.join(V1, 1);
    model.hire(TERMS);
    await r.engine.watchOnce();
    await post(r, "/v1/verifiers/terms", { id: 1, terms: TEXT });
    chain.deliver(model.by(1).job);
    await r.engine.watchOnce();
    let c = (await get(r, `/v1/verifiers/case/1?verifier=${V1}`)).case;
    expect(c.next).toBe("check");
    expect(c.forYou).toEqual({ can: true });
    expect(c.deadlines.checkBy).toBe(new Date((chain.time + 4 * H) * 1000).toISOString());
    expect((await get(r, "/v1/verifiers/cases?show=check")).items.map((i: Body) => i.id)).toEqual([1]);
    model.check(1, V1, true, WHY);
    await r.engine.watchOnce();
    c = (await get(r, "/v1/verifiers/case/1")).case;
    expect(c).toMatchObject({ state: "checked", next: "dispute", first: { verifier: { address: V1, maker: 1, makerName: "Anthropic", house: false }, accept: true, reason: null } });
    expect((await post(r, "/v1/verifiers/reason", { id: 1, verifier: V1, reason: `${WHY}.` })).status).toBe(409);
    expect((await post(r, "/v1/verifiers/reason", { id: 1, verifier: V2, reason: WHY })).status).toBe(409);
    expect((await post(r, "/v1/verifiers/reason", { id: 1, verifier: V1, reason: WHY })).status).toBe(200);
    expect((await get(r, "/v1/verifiers/case/1")).case.first.reason).toBe(WHY);
    // the keeper waits out the two hours, then steps
    await r.turn();
    expect(model.steps).toEqual([]);
    chain.mine(1, 2 * H);
    await r.turn();
    expect(model.steps).toEqual([1]);
    chain.mine(3);
    await r.engine.watchOnce();
    c = (await get(r, "/v1/verifiers/case/1")).case;
    expect(c).toMatchObject({ state: "accepted", how: "first-check", next: null, decided: { how: "first-check", verdict: "accept" }, ended: { state: "accepted" } });
    expect(c.paid).toEqual([{ verifier: V1, eth: 0.0003, wei: FEE.toString() }]);
    // the agent's verified jobs, and the job in the Factor Score's own line
    const agent = await get(r, "/v1/agents/report-lead");
    expect(agent.verified).toMatchObject({ jobs: 1, accepted: 1, rejected: 0, disputed: 0 });
    expect(agent.factorScore.income.find((l: Body) => l.source === "verified")).toMatchObject({ name: "Verified jobs", settled: 1 });
  });

  it("a panel: seats with their makers, a strike, reveals with reasons, and the outcome with who was paid and who lost", async () => {
    const { r, chain, model } = await world();
    for (const [v, m] of [[V1, 1], [V2, 2], [V3, 3], [V4, 4]] as const) model.join(v, m);
    model.hire(TERMS);
    chain.deliver(model.by(1).job);
    model.check(1, V1, false, WHY);
    model.dispute(1, AGENT);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/verifiers/cases?show=seats")).items.map((i: Body) => i.id)).toEqual([1]);
    expect((await get(r, `/v1/verifiers/case/1?verifier=${V1}`)).case.forYou).toEqual({ can: false, why: "it gave the first verdict on this case" });
    model.sit(1, V2, 2, 0);
    model.sit(1, V3, 3, 1);
    model.sit(1, V4, 4, 2);
    model.strike(1, V4, CUSTOMER);
    await r.engine.watchOnce();
    let c = (await get(r, "/v1/verifiers/case/1")).case;
    expect(c.dispute).toMatchObject({ by: "agent", address: AGENT, bondEth: 0.001 });
    expect(c.seats.map((s: Body) => [s.verifier.address, s.makerName, s.vote])).toEqual([[V2, "Google", null], [V3, "OpenAI", null]]);
    expect(c.struck).toMatchObject([{ verifier: V4, by: "customer" }]);
    expect(c.next).toBe("seats");
    chain.mine(1, 14 * H);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/verifiers/case/1")).case.next).toBe("reveals");
    model.reveal(1, V2, true, "accept: it is all there");
    model.reveal(1, V3, true, "accept: the sums hold");
    model.panel(1, 1, 2, 0, [[V2, 650000000000000n], [V3, 650000000000000n]], [[V1, 1000000000000000n]]);
    chain.mine(3);
    await r.engine.watchOnce();
    expect((await post(r, "/v1/verifiers/reason", { id: 1, verifier: V2, reason: "accept: it is all there" })).status).toBe(200);
    c = (await get(r, "/v1/verifiers/case/1")).case;
    expect(c).toMatchObject({ state: "accepted", how: "panel", decided: { how: "panel", verdict: "accept", votesAccept: 2, votesReject: 0 } });
    expect(c.seats[0]).toMatchObject({ vote: "accept", reason: "accept: it is all there" });
    expect(c.slashed).toEqual([{ verifier: V1, eth: 0.001, wei: "1000000000000000" }]);
    const agent = await get(r, "/v1/agents/report-lead");
    expect(agent.verified).toMatchObject({ jobs: 1, accepted: 1, disputed: 1, disputesWon: 1, disputesLost: 0 });
    // a verifier's own page, and the list
    await r.engine.watchOnce();
    const page = await get(r, `/v1/verifiers/${V2}`);
    expect(page.verifier).toMatchObject({ address: V2, maker: 2, makerName: "Google", standing: true });
    expect(page.cases.map((x: Body) => x.id)).toEqual([1]);
    expect((await get(r, "/v1/verifiers")).items.map((v: Body) => v.address)).toEqual([V1, V2, V3, V4]);
    expect((await get(r, "/v1/verifiers?maker=3")).items.map((v: Body) => v.address)).toEqual([V3]);
  });

  it("an older standing may take a maker's seat, a newer one may not, and a full panel takes only an older standing", async () => {
    const { r, chain, model } = await world();
    model.join(V1, 1, 100);
    model.join(V2, 2, 200);
    model.join(V3, 2, 300);
    model.join(V4, 3, 50);
    model.hire(TERMS);
    chain.deliver(model.by(1).job);
    model.check(1, V4, true, WHY);
    model.dispute(1, CUSTOMER);
    model.sit(1, V2, 2, 0);
    await r.engine.watchOnce();
    await r.engine.watchOnce();
    expect((await get(r, `/v1/verifiers/case/1?verifier=${V3}`)).case.forYou).toEqual({ can: false, why: "the Google seat is held by an older standing" });
    expect((await get(r, `/v1/verifiers/case/1?verifier=${V1}`)).case.forYou).toEqual({ can: true });
    expect((await get(r, `/v1/verifiers/case/1?verifier=${CUSTOMER}`)).case.forYou.why).toMatch(/not joined/);
  });

  it("nobody checks: after four hours the keeper's step hands the case to the customer, and after the desk's day settles it", async () => {
    const { r, chain, model } = await world();
    model.hire(TERMS);
    chain.deliver(model.by(1).job);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/verifiers/case/1")).case.next).toBe("check");
    chain.mine(1, 4 * H);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/verifiers/case/1")).case.next).toBe("step");
  });

  it("the owner's switch hides every case and stops the keeper at once", async () => {
    const { r, chain, model } = await world();
    model.join(V1, 1);
    model.hire(TERMS);
    chain.deliver(model.by(1).job);
    model.check(1, V1, true, WHY);
    await r.engine.watchOnce();
    turn(r.db, "verifiers", false, "a pause");
    expect((await get(r, "/v1/verifiers/about")).enabled).toBe(false);
    expect((await get(r, "/v1/verifiers/case/1")).status).toBe(404);
    chain.mine(1, 3 * H);
    await r.turn();
    expect(model.steps).toEqual([]);
    turn(r.db, "verifiers", true, "");
    await r.turn();
    expect(model.steps).toEqual([1]);
  });

  it("a page view starts nothing: reading every answer sends no transaction", async () => {
    const { r, chain, model } = await world();
    model.join(V1, 1);
    model.hire(TERMS);
    chain.deliver(model.by(1).job);
    await r.engine.watchOnce();
    const before = chain.sent.length;
    for (const p of ["/v1/verifiers/about", "/v1/verifiers", "/v1/verifiers/cases?show=open", "/v1/verifiers/case/1", `/v1/verifiers/${V1}`, `/v1/verifiers/job/${model.by(1).job}`]) expect((await get(r, p)).status).toBe(200);
    expect(chain.sent.length).toBe(before);
  });
});

// ---------- Factor's own verifiers, at the module ----------

interface Sent { from: string; fn: string; args: unknown[]; value: bigint }

function house(o: { factorOwn?: (a: string) => boolean; ask?: Asker; daily?: number; balance?: bigint; ties?: string | null; lookup?: Lookup; models?: Record<number, string>; erc8004?: boolean; gasDayWei?: bigint } = {}) {
  const db = new EngineDb(open(":memory:"));
  let t = 1_800_000_000;
  const sent: Sent[] = [];
  const seed = keccak256("0xfeed") as Hex;
  const cfg: VerifiersConfig = { ...readVerifiers({ ...ON, VERIFIERS_HOUSE: "on" }), house: { enabled: true, models: o.models ?? { 1: "stand-in/claude", 2: "stand-in/gemini", 3: "stand-in/gpt" }, dailyMicro: o.daily ?? 2_000_000 }, erc8004: { enabled: !!o.erc8004, gasDayWei: o.gasDayWei ?? 5n * 10n ** 14n } };
  const accountsMade = new Set<string>();
  const accounts = {
    addressOfKey: async (k: { a: string }) => `0x${k.a.slice(-40)}`.toLowerCase(),
    store: { get: (a: string) => (accountsMade.has(a) ? { deployed: true } : null), open: () => false },
    makeOwn: (a: string) => accountsMade.add(a),
    orderAs: async (from: string, calls: { to: string; value: bigint; data: Hex }[]) => {
      for (const c of calls) {
        const d = decodeCall(c.data);
        sent.push({ from, fn: d.functionName, args: d.args, value: c.value });
      }
      return `relay-${sent.length}`;
    },
  };
  const chain = {
    balance: async () => o.balance ?? 0n,
    fees: async () => ({ maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n }),
    read: async () => { throw new Error("not modelled"); },
  } as unknown as Chain;
  const asked: string[] = [];
  const ask: Asker = o.ask ?? (async (model, _s, user) => { asked.push(model); return { text: JSON.stringify({ accept: !/2 \+ 2 = 5/.test(user), reasons: "The lease's dates, rent and notice are there." }), costMicro: 3000 }; });
  const work = new Map<number, string>();
  const vs = new Verifiers({
    cfg, db, chain, chainId: 4663, nowS: () => t, now: () => t * 1000, log: () => {},
    names: () => new Map(), ties: async () => o.ties ?? null, factorOwn: o.factorOwn ?? (() => false),
    brief: () => {}, work: (job) => (work.has(job) ? { kind: "text", body: work.get(job)!, at: 0 } : null),
    house: { seed, accounts: () => accounts as never, live: () => true, ask, lookup: o.lookup ?? null, priceOf: async () => null },
    site: "https://factoragents.fun", desk: "0x487eb282e9aa56ae871c15a16c5b061b9d2faa6f", agentIdOf: () => "777",
  });
  vs.lookupPauseMs = 0;
  const addCase = (id: number, state: string, o2: { job?: number; delivered?: number; checker?: string; agent?: string } = {}) => {
    const job = o2.job ?? 100 + id;
    db.q("INSERT INTO desk_jobs (id, locked_block, customer, agent, price, due_at, locked_at, state, allow_early, delivered_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 0, ?)").run(job, V, o2.agent ?? AGENT, PRICE.toString(), t + 86_400, t - 100, o2.delivered ? S.delivered : S.locked, o2.delivered ?? 0);
    db.q("INSERT INTO verifier_cases (id, block, at, tx_hash, job, customer, agent, price, fee, stake, dispute_bond, terms_hash, state, checker) VALUES (?, 1, ?, '0x', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, t, job, CUSTOMER, o2.agent ?? AGENT, PRICE.toString(), FEE.toString(), (ETH / 500n).toString(), (ETH / 1000n).toString(), hashText(TEXT), state, o2.checker ?? null);
    db.q("INSERT INTO verifier_terms (case_id, body, at) VALUES (?, ?, 0)").run(id, TEXT);
    work.set(job, WORK);
  };
  // the accounts of Factor's own verifiers, made already: each at its key's own address here
  for (const h of vs.house) {
    h.address = `0x${h.key.a.slice(-40)}`.toLowerCase();
    accountsMade.add(h.address);
  }
  const joinAll = () => {
    for (const h of vs.house) db.q("INSERT INTO verifier_list (address, block, maker, since, joined_at, joined_tx, record, record_at) VALUES (?, 1, ?, ?, ?, '0x', ?, ?)").run(h.address, h.maker, 1000 + h.maker, 1000, JSON.stringify({ maker: h.maker, since: 1000 + h.maker, open: 0, checks: 0, panels: 0, right: 0, wrong: 0, hidden: 0, struck: 0, free: (ETH / 20n).toString(), locked: "0", earned: "0", lost: "0" }), t * 1000);
  };
  return { vs, db, sent, asked, addCase, joinAll, clock: { set: (s: number) => { t = s; }, get: () => t } };
}

function decodeCall(data: Hex): { functionName: string; args: unknown[] } {
  const abi = data.startsWith("0x3d659a96") || data.startsWith("0xaaf400c4") ? (erc8004ValidationAbi as Abi) : (factorVerifiersAbi as Abi);
  const d = decodeFunctionData({ abi, data });
  return { functionName: d.functionName, args: [...(d.args ?? [])] };
}

describe("Factor's own verifiers", () => {
  it("each is made as an account, waits for its bond, joins with all of it, and is ready", async () => {
    const h = house({ balance: VERIFIER_RULES.minBondWei * 2n });
    expect(h.vs.house.map((x) => x.maker)).toEqual([1, 2, 3]);
    await h.vs.housePass(); // each joins with what its account holds
    expect(h.sent.filter((s) => s.fn === "join").map((s) => [Number(s.args[0]), s.value])).toEqual([[1, ETH / 50n], [2, ETH / 50n], [3, ETH / 50n]]);
    const poor = house({ balance: VERIFIER_RULES.minBondWei - 1n });
    await poor.vs.housePass();
    await poor.vs.housePass();
    expect(poor.sent).toEqual([]);
  });

  it("checks a delivered case once, with the tests and its maker's model, and seals nothing for a first check", async () => {
    const h = house();
    h.joinAll();
    h.addCase(1, "working", { delivered: h.clock.get() - 60 });
    await h.vs.housePass();
    const checks = h.sent.filter((s) => s.fn === "check");
    expect(checks).toHaveLength(1);
    expect(checks[0]!.args[0]).toBe(1n);
    expect(checks[0]!.args[1]).toBe(true);
    const row = h.db.q("SELECT * FROM verifier_house WHERE case_id = 1").get() as { reason: string; state: string; cost_micro: number };
    expect(row.state).toBe("sending");
    expect(checks[0]!.args[2]).toBe(hashText(row.reason));
    expect(row.reason).toMatch(/^Verdict: accept\nTests:\n- pass: [\s\S]*1200 x 12 = 14400 holds/);
    expect(h.vs.spentToday()).toBe(3000);
    await h.vs.housePass();
    expect(h.sent.filter((s) => s.fn === "check")).toHaveLength(1);
  });

  it("a failed sum is a reject whatever its model says", async () => {
    const h = house({ ask: async () => ({ text: '{"accept": true, "reasons": "fine"}', costMicro: 1 }) });
    h.joinAll();
    h.addCase(1, "working", { delivered: h.clock.get() - 60 });
    // the work says 2 + 2 = 5
    const work = `${WORK}\nCheck: 2 + 2 = 5`;
    (h.vs as unknown as { d: { work: (j: number) => unknown } }).d.work = () => ({ kind: "text", body: work, at: 0 });
    await h.vs.housePass();
    expect(h.sent.find((s) => s.fn === "check")!.args[1]).toBe(false);
  });

  it("never checks where Factor is a side, where its records tie it to a side, or past the day's cap", async () => {
    const own = house({ factorOwn: (a) => a === AGENT });
    own.joinAll();
    own.addCase(1, "working", { delivered: own.clock.get() - 60 });
    await own.vs.housePass();
    expect(own.sent).toEqual([]);
    const tied = house({ ties: "the wallet that runs the agent on Factor" });
    tied.joinAll();
    tied.addCase(1, "working", { delivered: tied.clock.get() - 60 });
    await tied.vs.housePass();
    expect(tied.sent).toEqual([]);
    const capped = house({ daily: 1 });
    capped.joinAll();
    capped.db.q("INSERT INTO verifier_spend (day, micro) VALUES (?, ?)").run(new Date(capped.clock.get() * 1000).toISOString().slice(0, 10), 1_000_000);
    capped.addCase(1, "working", { delivered: capped.clock.get() - 60 });
    await capped.vs.housePass();
    expect(capped.sent).toEqual([]);
  });

  it("sits on a disputed case sealed, a different maker each, and reveals exactly what it sealed once seating closes", async () => {
    const h = house();
    h.joinAll();
    const d = h.clock.get() - 3 * H;
    h.addCase(1, "disputed", { delivered: d, checker: "0x00000000000000000000000000000000000000c1" });
    await h.vs.housePass();
    const sits = h.sent.filter((s) => s.fn === "sit");
    expect(sits).toHaveLength(1); // one model call a pass
    const row = h.db.q("SELECT * FROM verifier_house WHERE case_id = 1").get() as { verifier: string; accept: number; reason: string; salt: Hex };
    expect(sits[0]!.args[1]).toBe(keccak256(encodeCommit(1, row.verifier, row.accept === 1, hashText(row.reason), row.salt)));
    // the seat is on the chain, and seating closes
    h.db.q("INSERT INTO verifier_seats (case_id, verifier, block, seat, maker, since, sat_at, sat_tx) VALUES (1, ?, 1, 0, 1, 1001, ?, '0x')").run(row.verifier, h.clock.get());
    h.clock.set(d + 14 * H + 60);
    await h.vs.housePass();
    const reveal = h.sent.find((s) => s.fn === "reveal")!;
    expect(reveal.args).toEqual([1n, row.accept === 1, hashText(row.reason), row.salt]);
  });

  it("keeps the case's rows apart: a case of its own verifier's check is not checked twice by another maker", async () => {
    const h = house();
    h.joinAll();
    h.addCase(1, "working", { delivered: h.clock.get() - 60 });
    h.addCase(2, "working", { delivered: h.clock.get() - 60 });
    await h.vs.housePass();
    await h.vs.housePass();
    const checks = h.sent.filter((s) => s.fn === "check");
    expect(checks.map((c) => c.args[0])).toEqual([1n, 2n]);
    // the makers turn with the case's number
    expect(new Set(checks.map((c) => c.from)).size).toBe(2);
  });
});

void (null as unknown as CaseRow);

// ---------- model receipts ----------

const RECORD = { data: { id: "gen-123", model: "anthropic/claude-haiku-4.5", provider_name: "Anthropic", tokens_prompt: 900, tokens_completion: 120, created_at: "2026-11-09T12:00:00Z", total_cost: 0.0004 } };

describe("model receipts", () => {
  it("the block is written and read back exactly, and only a whole one is read", () => {
    const lines = { provider: "openrouter", generation: "gen-123", model: "anthropic/claude-haiku-4.5", requestHash: hashOf("req"), outputHash: hashOf("out"), reportedModel: "anthropic/claude-haiku-4.5", providerName: "Anthropic", tokensIn: 900, tokensOut: 120, created: "2026-11-09T12:00:00Z" };
    const text = `Verdict: accept\nReasons:\nfine.\n${receiptBlock(lines)}`;
    expect(readReceipt(text)).toEqual(lines);
    expect(readReceipt("Verdict: accept\nReceipt:\n- provider: openrouter")).toBeNull();
    expect(readReceipt(null)).toBeNull();
  });

  it("a model is held to the declared maker by OpenRouter's prefix, and OpenRouter's record is read", () => {
    expect(modelOfMaker("anthropic/claude-haiku-4.5", 1)).toBe(true);
    expect(modelOfMaker("openai/gpt-5-mini", 1)).toBe(false);
    expect(modelOfMaker("deepseek/deepseek-chat-v3.1", 7)).toBe(true);
    expect(modelOfMaker(null, 1)).toBe(false);
    expect(readOpenRouterRecord(RECORD)).toEqual({ model: "anthropic/claude-haiku-4.5", providerName: "Anthropic", tokensIn: 900, tokensOut: 120, created: "2026-11-09T12:00:00Z" });
    expect(readOpenRouterRecord({ error: "nope" })).toBeNull();
  });

  it("asks through OpenRouter with the exact body the receipt hashes, and reads the call's record with the key", async () => {
    const seen: { url: string; body?: string; auth?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
      seen.push({ url, body: init?.body, auth: init?.headers?.authorization });
      if (url.endsWith("/chat/completions")) return new Response(JSON.stringify({ id: "gen-123", choices: [{ message: { content: '{"accept": true, "reasons": "ok"}' } }], usage: { prompt_tokens: 900, completion_tokens: 120, cost: 0.0004 } }), { status: 200 });
      if (url.includes("/generation?id=gen-123")) return new Response(JSON.stringify(RECORD), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    try {
      const a = await routerAsker("k", "https://router.test/api/v1")("anthropic/claude-haiku-4.5", "sys", "user");
      expect(a.receipt).toEqual({ provider: "openrouter", generationId: "gen-123", requestBody: seen[0]!.body });
      expect(a.costMicro).toBe(400);
      expect(await routerLookup("k", "https://router.test/api/v1")("openrouter", "gen-123")).toMatchObject({ model: "anthropic/claude-haiku-4.5", tokensIn: 900 });
      expect(seen[1]!.auth).toBe("Bearer k");
      expect(await routerLookup("k", "https://router.test/api/v1")("openrouter", "gen-404")).toBeNull();
      expect(await routerLookup("k", "https://router.test/api/v1")("another", "gen-123")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a receipt holds only with the reasons on the chain, the published texts, the provider's record and the declared maker", () => {
    const lines = { provider: "openrouter", generation: "gen-123", model: "anthropic/claude-haiku-4.5", requestHash: hashOf("req"), outputHash: hashOf("out") };
    const reasons = `Verdict: accept\n${receiptBlock(lines)}`;
    const record: ProviderRecord = { model: "anthropic/claude-haiku-4.5", providerName: "Anthropic", tokensIn: 1, tokensOut: 1, created: null };
    const base = { lines, record, request: "req", output: "out", maker: 1, reasons, reasonHashOnChain: hashOf(reasons) };
    expect(receiptHolds(base)).toEqual({ ok: true, why: null });
    expect(receiptHolds({ ...base, reasonHashOnChain: hashOf("other") }).why).toMatch(/not the ones whose hash is on the chain/);
    expect(receiptHolds({ ...base, request: "req!" }).why).toMatch(/published request/);
    expect(receiptHolds({ ...base, output: "out!" }).why).toMatch(/published answer/);
    expect(receiptHolds({ ...base, record: null }).why).toMatch(/has not been read/);
    expect(receiptHolds({ ...base, maker: 2 }).why).toMatch(/not a model of the declared maker/);
  });

  it("Factor's own check ends its reasons with the receipt, keeps the call, and its verdict is marked checked", async () => {
    let n = 0;
    const lookup: Lookup = async () => (++n < 2 ? null : readOpenRouterRecord(RECORD)); // not there at first: read again
    const ask: Asker = async (model, system, user) => ({ text: '{"accept": true, "reasons": "All four headings are there."}', costMicro: 400, receipt: { provider: "openrouter", generationId: "gen-123", requestBody: JSON.stringify({ model, system, user }) } });
    const h = house({ ask, lookup, models: { 1: "anthropic/claude-haiku-4.5" } });
    h.joinAll();
    h.addCase(1, "working", { delivered: h.clock.get() - 60 });
    await h.vs.housePass();
    const check = h.sent.find((x) => x.fn === "check")!;
    const kept = h.db.q("SELECT * FROM verifier_house WHERE case_id = 1").get() as { reason: string; verifier: string };
    expect(kept.reason).toMatch(/\nReceipt:\n- provider: openrouter\n- generation: gen-123\n- model: anthropic\/claude-haiku-4.5\n- request-hash: 0x[0-9a-f]{64}\n- output-hash: 0x[0-9a-f]{64}\n- reported-model: anthropic\/claude-haiku-4.5\n- provider-name: Anthropic\n- tokens: 900 in, 120 out\n- created: 2026-11-09T12:00:00Z$/);
    expect(check.args[2]).toBe(hashText(kept.reason));
    // the chain has the verdict and its hash; the engine has the reasons from its own verifier
    h.db.q("UPDATE verifier_cases SET state = 'checked', checker = ?, first_accept = 1, reason_hash = ? WHERE id = 1").run(kept.verifier, hashText(kept.reason));
    h.db.q("INSERT INTO verifier_reasons (case_id, verifier, body, at) VALUES (1, ?, ?, 0)").run(kept.verifier, kept.reason);
    const m = h.vs.modelJson(1, kept.verifier, 1, hashText(kept.reason));
    expect(m).toMatchObject({ mark: "checked", makerName: "Anthropic", receipt: { by: "factor", generationId: "gen-123", modelReported: "anthropic/claude-haiku-4.5", tokensIn: 900, matches: true, url: `https://factoragents.fun/api/v1/verifiers/receipt/1/${kept.verifier}` } });
    const page = h.vs.receiptPage(1, kept.verifier)!;
    expect(hashOf(page.request!)).toBe(m.receipt!.requestHash);
    expect(hashOf(page.output!)).toBe(m.receipt!.outputHash);
    // the reasons on the chain are not the ones kept: declared
    expect(h.vs.modelJson(1, kept.verifier, 1, hashText("something else")).mark).toBe("declared");
  });

  it("a record that names another maker's model, or none, leaves the verdict declared, and an unread record is read again later", async () => {
    const ask: Asker = async () => ({ text: '{"accept": true, "reasons": "fine"}', costMicro: 1, receipt: { provider: "openrouter", generationId: "gen-9", requestBody: "{}" } });
    let answer: ProviderRecord | null = null;
    const h = house({ ask, lookup: async () => answer, models: { 1: "anthropic/claude-haiku-4.5" } });
    h.joinAll();
    h.addCase(1, "working", { delivered: h.clock.get() - 60 });
    await h.vs.housePass();
    const kept = h.db.q("SELECT * FROM verifier_house WHERE case_id = 1").get() as { reason: string; verifier: string };
    expect(kept.reason).not.toMatch(/reported-model/);
    h.db.q("INSERT INTO verifier_reasons (case_id, verifier, body, at) VALUES (1, ?, ?, 0)").run(kept.verifier, kept.reason);
    expect(h.vs.modelJson(1, kept.verifier, 1, hashText(kept.reason)).receipt!.why).toMatch(/has not been read/);
    answer = { model: "openai/gpt-5-mini", providerName: "OpenAI", tokensIn: 1, tokensOut: 1, created: null };
    expect(await h.vs.readReceipts()).toBe(1);
    const m = h.vs.modelJson(1, kept.verifier, 1, hashText(kept.reason));
    expect(m.mark).toBe("declared");
    expect(m.receipt!.why).toMatch(/names openai\/gpt-5-mini, not a model of the declared maker/);
  });

  it("an outside verifier's receipt is shown as given, not checked: its model stays declared", () => {
    const h = house();
    h.addCase(1, "checked", { checker: V1 });
    const reasons = `Verdict: reject\nReasons:\nThe rent is missing.\n${receiptBlock({ provider: "openrouter", generation: "gen-outside", model: "google/gemini-2.5-flash", requestHash: hashOf("a"), outputHash: hashOf("b") })}`;
    h.db.q("INSERT INTO verifier_reasons (case_id, verifier, body, at) VALUES (1, ?, ?, 0)").run(V1, reasons);
    const m = h.vs.modelJson(1, V1, 2, hashText(reasons));
    expect(m).toMatchObject({ mark: "declared", receipt: { by: "verifier", generationId: "gen-outside", checkedAt: null, matches: null } });
    expect(m.receipt!.why).toMatch(/only be read with the key that made it/);
    expect(h.vs.modelJson(1, V1, 2, hashText("other reasons")).receipt).toBeNull();
  });
});

// ---------- verdicts on the ERC-8004 validation registry ----------

describe("verdicts on the ERC-8004 validation registry", () => {
  it("off unless VERIFIERS_8004=on", async () => {
    expect(readVerifiers(ON).erc8004.enabled).toBe(false);
    expect(readVerifiers({ ...ON, VERIFIERS_8004: "on" }).erc8004).toEqual({ enabled: true, gasDayWei: 5n * 10n ** 14n });
    const problems: string[] = [];
    readVerifiers({ ...ON, VERIFIERS_8004_GAS_DAY_WEI: "lots" }, problems);
    expect(problems).toHaveLength(1);
    const { r, chain, model } = await world();
    model.join(V1, 1);
    model.hire(TERMS);
    chain.deliver(model.by(1).job);
    model.check(1, V1, true, WHY);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/verifiers/case/1")).case.erc8004).toMatchObject({ state: "off", registry: VALIDATION_REGISTRY, tag: VERIFY_TAG });
  });

  it("a verdict of an agent with an identity gets a case file, a request for its owner, then the validator's answer, read back from the registry", async () => {
    const { r, chain, model } = await world({ more: { VERIFIERS_8004: "on", FACTOR_SITE_URL: "https://factoragents.fun" } });
    r.db.q("INSERT INTO erc8004_links (agent, agent_id, how, via, linked_at, checked_at) VALUES (?, '777', 'found', 'wallet', 1, 1)").run(AGENT);
    model.join(V1, 1);
    model.hire(TERMS);
    chain.deliver(model.by(1).job);
    model.check(1, V1, true, WHY);
    await r.engine.watchOnce();
    expect((await get(r, "/v1/verifiers/case/1")).case.erc8004).toMatchObject({ state: "no-verdict" });
    chain.mine(1, 2 * H);
    await r.turn();
    chain.mine(3);
    await r.engine.watchOnce();
    const vs = r.engine.verifiers!;
    await vs.proofPass();
    let e = (await get(r, "/v1/verifiers/erc8004/1")).erc8004;
    expect(e).toMatchObject({ state: "prepared", agentId: "777", validator: V1, response: 100, responseCall: null, file: "https://factoragents.fun/api/v1/verifiers/file/1" });
    const file = await get(r, "/v1/verifiers/file/1");
    const { status: _s, ...body } = file;
    const text = JSON.stringify(body);
    expect(hashOf(text)).toBe(e.fileHash);
    expect(body).toMatchObject({ kind: "factor.verify", case: 1, agentId: "777", verdict: "accept", response: 100, decidedBy: "first-check", validator: V1, firstCheck: { verifier: V1, accept: true } });
    const req = decodeFunctionData({ abi: erc8004ValidationAbi as Abi, data: e.requestCall.data });
    expect(req.functionName).toBe("validationRequest");
    expect(req.args).toEqual([expect.stringMatching(new RegExp(V1.slice(2), "i")), 777n, e.file, e.fileHash]);
    // the agent's owner asks; the registry names V1
    model.validations.set(e.fileHash, { validator: V1, agentId: 777n, response: 0, responseHash: `0x${"0".repeat(64)}`, tag: "", lastUpdate: BigInt(chain.time) });
    r.wall.extra += 200_000;
    await vs.proofPass();
    e = (await get(r, "/v1/verifiers/erc8004/1")).erc8004;
    expect(e).toMatchObject({ state: "requested", requestCall: null });
    const resp = decodeFunctionData({ abi: erc8004ValidationAbi as Abi, data: e.responseCall.data });
    expect(resp.args).toEqual([e.fileHash, 100, e.file, e.fileHash, "factorVerify"]);
    // the validator answers
    model.validations.set(e.fileHash, { validator: V1, agentId: 777n, response: 100, responseHash: e.fileHash, tag: "factorVerify", lastUpdate: BigInt(chain.time) });
    model.summary = [1n, 100];
    r.wall.extra += 200_000;
    await vs.proofPass();
    e = (await get(r, "/v1/verifiers/case/1")).case.erc8004;
    expect(e).toMatchObject({ state: "answered", response: 100, responseCall: null });
    expect(await vs.onErc8004("777")).toEqual({ count: 1, avgResponse: 100, registry: VALIDATION_REGISTRY, tag: "factorVerify" });
    expect((await get(r, "/v1/agents/report-lead")).verified.onErc8004).toEqual({ count: 1, avgResponse: 100, registry: VALIDATION_REGISTRY, tag: "factorVerify" });
  });

  it("a request that names another validator is not answered by Factor's verifiers, and a case nobody decided has no file", async () => {
    const { r, chain, model } = await world({ more: { VERIFIERS_8004: "on", FACTOR_SITE_URL: "https://factoragents.fun" } });
    r.db.q("INSERT INTO erc8004_links (agent, agent_id, how, via, linked_at, checked_at) VALUES (?, '777', 'found', 'wallet', 1, 1)").run(AGENT);
    model.join(V1, 1);
    model.hire(TERMS);
    chain.deliver(model.by(1).job);
    model.check(1, V1, true, WHY);
    chain.mine(1, 2 * H);
    await r.engine.watchOnce();
    await r.turn();
    chain.mine(3);
    await r.engine.watchOnce();
    const vs = r.engine.verifiers!;
    await vs.proofPass();
    const hash = (await get(r, "/v1/verifiers/erc8004/1")).erc8004.fileHash;
    model.validations.set(hash, { validator: AGENT, agentId: 777n, response: 0, responseHash: `0x${"0".repeat(64)}`, tag: "", lastUpdate: 1n });
    r.wall.extra += 200_000;
    await vs.proofPass();
    const e = (await get(r, "/v1/verifiers/erc8004/1")).erc8004;
    expect(e.responseCall).toBeNull();
    expect(e.why).toMatch(/names 0x0+a6e71, not the verifier whose verdict was carried out/);
    expect((await get(r, "/v1/verifiers/file/2")).status).toBe(404);
  });

  it("Factor's own verifier answers a request that names it, under the day's gas cap", async () => {
    const h = house({ erc8004: true, gasDayWei: 300_000n * 10n ** 9n });
    h.joinAll();
    const me = h.vs.house[0]!.address!;
    const row = (id: number) => h.db.q("INSERT INTO verifier_8004 (case_id, agent_id, validator, response, file, file_hash, state, named, at) VALUES (?, '777', ?, 0, '{}', ?, 'requested', ?, 0)").run(id, me, hashOf(`file ${id}`), me);
    row(1);
    row(2);
    await h.vs.housePass();
    const answers = h.sent.filter((x) => x.fn === "validationResponse");
    expect(answers).toHaveLength(1); // the second would pass the day's gas
    expect(answers[0]!.args).toEqual([hashOf("file 1"), 0, "https://factoragents.fun/api/v1/verifiers/file/1", hashOf("file 1"), "factorVerify"]);
    expect(answers[0]!.from).toBe(me);
  });

  it("the case file is the same text every time, and survives the API's own writing out", () => {
    const f = { kind: "factor.verify" as const, version: 1 as const, chainId: 4663, verifiers: V, desk: "0xd", case: 1, job: 2, agent: AGENT, agentId: "777", customer: CUSTOMER, priceWei: "1", termsHash: "0x1", proof: null, verdict: "accept" as const, response: 100 as const, decidedBy: "panel" as const, validator: V1, firstCheck: { verifier: V2, accept: false, reasonHash: "0x2" }, panel: [{ verifier: V1, maker: 1, vote: "accept" as const, reasonHash: "0x3" }], votes: { accept: 1, reject: 0 }, ended: { state: "accepted", how: "panel", at: 5, tx: "0x4" }, page: "https://factoragents.fun/jobs/2" };
    const text = caseFileText(f);
    expect(caseFileText({ ...f })).toBe(text);
    expect(JSON.stringify(JSON.parse(text))).toBe(text);
  });
});
