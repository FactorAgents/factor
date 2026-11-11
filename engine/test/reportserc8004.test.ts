// Credit scores on ERC-8004 (src/reportserc8004.ts), end to end on the made-up chain: every ranked agent's report written
// once to the reputation registry, best first, and read back from it, the file at its address hashing to the entry's hash;
// nothing for Factor's own or a score of 0; nothing again while the score stands; a change written after its week and the
// entry before revoked; the day's gas; a restart in the middle of a run, with a transaction on its way; the registry
// holding an entry Factor's notes do not know of; dry mode; and the switches. The report, the API, the signed answer and
// the words say since when.

import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, toHex, type Abi, type AbiEvent, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { erc8004ReputationAbi } from "../src/abi/index.js";
import { opened, type Sealed } from "../src/everywhere.js";
import { reportText, type ReportJson } from "../src/reports.js";
import { readReportsErc8004, reportFile, REPORT_TAG1, REPORT_TAG2, REPORTS_ERC8004_GAS_DAY_DEFAULT } from "../src/reportserc8004.js";
import { turn } from "../src/switches.js";
import { A, ETH, FakeChain } from "./chain/fake.js";
import { rig, type Rig } from "./chain/harness.js";

const SIGNING = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const OWNER = "0x00000000000000000000000000000000000a0001";
const AGENT = "0x00000000000000000000000000000000000a6e01";
const LENDER = "0x00000000000000000000000000000000000a6e02";
const DEFAULTER = "0x00000000000000000000000000000000000a6e03";
const POOL = "0x00000000000000000000000000000000000b0012";
const cust = (i: number) => `0x0000000000000000000000000000000000c0${String(i).padStart(4, "0")}`;
type Body = Record<string, any>;

const priorsAbi = parseAbi([
  "event Borrowed(uint256 indexed loanId, uint256 indexed agentId, uint256 indexed sponsorId, uint256 principal, uint256 fee, uint64 dueAt, address to)",
  "event Repaid(uint256 indexed loanId, uint256 indexed agentId, uint256 principal, uint256 fee, address payer)",
  "event Defaulted(uint256 indexed loanId, uint256 indexed agentId, uint256 indexed sponsorId, uint256 principal, uint256 sharesBurnt, address owner)",
]);

function push(chain: FakeChain, address: string, abi: Abi, eventName: string, args: Record<string, unknown>): void {
  chain.mine();
  const event = abi.find((x) => x.type === "event" && x.name === eventName) as AbiEvent;
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const rest = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(rest, rest.map((i) => args[i.name!]) as never);
  chain.allLogs.push({ address, topics, data, blockNumber: chain.number, transactionHash: `0x${"cd".repeat(31)}${(chain.allLogs.length % 256).toString(16).padStart(2, "0")}`, logIndex: 0 });
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

let loanId = 0;
/** A loan of $50 held a week and repaid by its agent: a repayment that counts. */
function loan(chain: FakeChain, agentId: number, to: string): void {
  loanId++;
  push(chain, POOL, priorsAbi as Abi, "Borrowed", { loanId: BigInt(loanId), agentId: BigInt(agentId), sponsorId: 1n, principal: 50_000_000n, fee: 1000n, dueAt: BigInt(chain.time + 30 * 86400), to });
  // an hour a block, so a log's time read between its span's ends is within the hour
  for (let h = 0; h < 170; h++) chain.mine(1, 3600);
  push(chain, POOL, priorsAbi as Abi, "Repaid", { loanId: BigInt(loanId), agentId: BigInt(agentId), principal: 50_000_000n, fee: 1000n, payer: to });
}

/** The world: a desk agent with paid work, a lender on Priors, one that defaulted, a blank one, and one of Factor's own. */
function world(): { chain: FakeChain; ids: { agent: number; lender: number; defaulter: number; blank: number; own: number } } {
  const chain = new FakeChain();
  chain.fund(ETH);
  chain.register(AGENT);
  const agent = chain.identity(OWNER, AGENT);
  for (let i = 1; i <= 3; i++) {
    const id = chain.lock(cust(i), AGENT, ETH / 20n);
    chain.deliver(id);
    chain.accept(id);
  }
  const lender = chain.identity(LENDER, LENDER);
  for (let i = 0; i < 3; i++) loan(chain, lender, LENDER);
  const defaulter = chain.identity(DEFAULTER, DEFAULTER);
  loanId++;
  push(chain, POOL, priorsAbi as Abi, "Borrowed", { loanId: BigInt(loanId), agentId: BigInt(defaulter), sponsorId: 1n, principal: 20_000_000n, fee: 1000n, dueAt: BigInt(chain.time + 86400), to: DEFAULTER });
  chain.mine(1, 3 * 86400);
  push(chain, POOL, priorsAbi as Abi, "Defaulted", { loanId: BigInt(loanId), agentId: BigInt(defaulter), sponsorId: 1n, principal: 20_000_000n, sharesBurnt: 5n, owner: DEFAULTER });
  const blank = chain.identity(cust(99), null);
  // one of Factor's own: the demo wallet's identity, repaying loans like any other; scored, ranked apart, never written
  const demo = "0x50a9bf50c3337d5db03efdf89deb0f5a0b908f17";
  const own = chain.identity(demo, demo);
  for (let i = 0; i < 3; i++) loan(chain, own, demo);
  chain.mine(5, 60);
  return { chain, ids: { agent, lender, defaulter, blank, own } };
}

async function live(chain: FakeChain, more: Record<string, string> = {}, sqlite?: Rig["sqlite"], mode: "live" | "dry" = "live"): Promise<Rig> {
  const r = await rig(mode, { chain, sqlite, copilotModel: null, more: { REPORTS: "on", REPORTS_ERC8004: "on", REPORTS_FROM_BLOCK: "0", REPORTS_SPAN: "100", REPORTS_PER_PASS: "200", REPORTS_CONFIRMATIONS: "0", REPORTS_PRIORS_POOLS: `2:${POOL}@0`, EVERYWHERE_SIGNING_KEY: SIGNING, ...more } });
  rigs.push(r);
  await r.engine.watchOnce();
  let passes = 0;
  while (!r.engine.reports!.caughtUp() && passes < 200) { await r.engine.reports!.pass(); passes++; }
  await r.engine.reports!.pass();
  r.engine.reports!.scoreAll();
  return r;
}

const get = async (r: Rig, path: string): Promise<Body> => { const [p, q = ""] = path.split("?"); const a = (await r.engine.handle(p!, new URLSearchParams(q), "1.2.3.4"))!; return { status: a.status, ...(a.body as Body) }; };
const entries = (r: Rig, id: number) => r.chain.entriesOf(id, A.bot).filter((e) => e.tag1 === REPORT_TAG1);
const scoreOf = (r: Rig, id: number) => (r.db.q("SELECT score FROM report_scores WHERE agent_id = ?").get(id) as { score: number }).score;

describe("the switch and the file", () => {
  it("is off unless REPORTS_ERC8004=on, a week between entries, 10 a pass, 0.004 ETH of gas a day; and refuses what makes no sense", () => {
    expect(readReportsErc8004({})).toMatchObject({ enabled: false, everyH: 168, perPass: 10, gasDayWei: 4_000_000_000_000_000n });
    expect(REPORTS_ERC8004_GAS_DAY_DEFAULT).toBe(4_000_000_000_000_000n);
    // the default holds the first full run: 405 entries of about 200,000 gas at 0.0243 gwei, the most each could cost, twice over
    expect(REPORTS_ERC8004_GAS_DAY_DEFAULT).toBeGreaterThan(2n * 405n * 200_000n * 24_300_000n);
    const problems: string[] = [];
    readReportsErc8004({ REPORTS_ERC8004: "yes", REPORTS_ERC8004_GAS_DAY_WEI: "0.01", REPORTS_ERC8004_EVERY_H: "-1", REPORTS_ERC8004_PER_PASS: "500" }, problems);
    expect(problems).toHaveLength(4);
    expect(readReportsErc8004({ REPORTS_ERC8004: "on", REPORTS_ERC8004_EVERY_H: "24" })).toMatchObject({ enabled: true, everyH: 24 });
  });

  it("the file: the standard's fields and Factor's, the score with no decimals, its hash keccak256 of its words", () => {
    const f = reportFile({ chainId: 4663, identity: A.identity, agentId: "8716", writer: A.bot, site: "https://factoragents.fun", score: 223, parts: { work: 0, repayment: 136, feedback: 0, time: 23, reliability: 64 }, block: 111_824_357, atS: 1_794_000_000, before: null });
    expect(f.file).toMatchObject({ agentId: 8716, value: 223, valueDecimals: 0, tag1: "factorReport", tag2: "1.1.0", factor: { report: "https://factoragents.fun/reports/8716", version: "factor-report/1.1.0", score: 223, of: 1000, before: null, block: 111_824_357 } });
    expect(f.hash).toBe(keccak256(toHex(f.body)));
    expect(JSON.stringify(JSON.parse(f.body))).toBe(f.body);
    expect(REPORT_TAG2).toBe("1.1.0");
  });
});

describe("writing", () => {
  it("writes every ranked agent once, best first, and the registry, the report, its file, the signed answer and the words all say so", async () => {
    const { chain, ids } = world();
    const r = await live(chain);
    expect(scoreOf(r, ids.agent)).toBeGreaterThan(0);
    expect(scoreOf(r, ids.lender)).toBeGreaterThan(0);
    expect(scoreOf(r, ids.defaulter)).toBe(0);
    expect(scoreOf(r, ids.blank)).toBe(0);
    expect(scoreOf(r, ids.own)).toBeGreaterThan(0);
    // before: prepared, not written
    const before = await get(r, `/v1/reports/erc8004/${ids.agent}`);
    expect(before).toMatchObject({ written: false, prepared: true, sent: false, why: /Not written yet/ });
    expect((await get(r, `/v1/reports/agent/${ids.agent}`)).onChain).toMatchObject({ written: false, prepared: `https://factoragents.fun/api/v1/reports/erc8004/${ids.agent}` });
    await r.turn();
    const a = entries(r, ids.agent), l = entries(r, ids.lender);
    expect(a).toHaveLength(1);
    expect(l).toHaveLength(1);
    expect(a[0]).toMatchObject({ value: BigInt(scoreOf(r, ids.agent)), decimals: 0, tag1: "factorReport", tag2: "1.1.0" });
    // the best first
    const sent = chain.sends("giveFeedback").map((s) => Number(s.tx.call!.args![0] as bigint));
    const best = scoreOf(r, ids.agent) >= scoreOf(r, ids.lender) ? ids.agent : ids.lender;
    expect(sent[0]).toBe(best);
    // never Factor's own, never a score of 0
    expect(entries(r, ids.own)).toHaveLength(0);
    expect(entries(r, ids.defaulter)).toHaveLength(0);
    expect(entries(r, ids.blank)).toHaveLength(0);
    expect((await get(r, `/v1/reports/erc8004/${ids.own}`)).why).toMatch(/Factor's own agents are ranked apart/);
    // the file at its address is the one the entry hashes
    const n = Number(/\/report\/(\d+)$/.exec(a[0]!.uri)![1]);
    expect(a[0]!.uri).toBe(`https://factoragents.fun/api/v1/erc8004/report/${n}`);
    const { status, ...file } = await get(r, `/v1/erc8004/report/${n}`);
    expect(status).toBe(200);
    expect(a[0]!.hash).toBe(keccak256(toHex(JSON.stringify(file))));
    expect(file).toMatchObject({ agentId: ids.agent, value: scoreOf(r, ids.agent), tag1: "factorReport", factor: { report: `https://factoragents.fun/reports/${ids.agent}`, before: null } });
    expect((await get(r, "/v1/erc8004/report/999")).status).toBe(404);
    // the report and its API: since when, the transaction
    const rep = await get(r, `/v1/reports/agent/${ids.agent}`);
    const tx = chain.sends("giveFeedback").find((s) => Number(s.tx.call!.args![0] as bigint) === ids.agent)!.hash;
    expect(rep.onChain).toMatchObject({ written: true, score: scoreOf(r, ids.agent), version: "factor-report/1.1.0", tx, txUrl: `https://robinhoodchain.blockscout.com/tx/${tx}`, index: 1, entries: 1, tag1: "factorReport", prepared: null });
    expect(rep.onChain.since).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await get(r, `/v1/reports/erc8004/${ids.agent}`)).toMatchObject({ written: true, sent: true, tx });
    expect(reportText(rep as unknown as ReportJson)).toContain(`On ERC-8004 since ${rep.onChain.since.slice(0, 10)}: any app reads this score from the reputation registry (tag factorReport). https://robinhoodchain.blockscout.com/tx/${tx}`);
    // the count on /v1/reports and on the state
    expect((await get(r, "/v1/reports")).onErc8004).toMatchObject({ enabled: true, reports: 2, entries: 2, tag1: "factorReport", firstTx: expect.any(String) });
    expect((await get(r, "/v1/state")).reports).toMatchObject({ enabled: true, onErc8004: true });
    // the signed answer carries it
    const signed = await get(r, `/v1/reports/signed/${ids.agent}`);
    const o = await opened<Body>(signed as unknown as Sealed, signed.signer, chain.time);
    expect(o.ok).toBe(true);
    expect((o as { data: Body }).data.erc8004).toMatchObject({ tx, score: scoreOf(r, ids.agent), tag1: "factorReport" });
    // the owner's health
    expect((await get(r, "/v1/health")).reportsErc8004).toMatchObject({ on: true, byStatus: { done: 2 }, transactions: 2, reports: 2 });
    // unchanged: nothing more, however many passes
    for (let i = 0; i < 3; i++) await r.turn();
    expect(chain.sends("giveFeedback")).toHaveLength(2);
    expect(chain.sends("revokeFeedback")).toHaveLength(0);
  });

  it("a changed score is written again once its week is over, and the entry before it revoked; a fall to 0 at once", async () => {
    const { chain, ids } = world();
    const r = await live(chain, { REPORTS_ERC8004_EVERY_H: "168" });
    await r.turn();
    const first = scoreOf(r, ids.agent);
    // more paid work: the score moves
    for (let i = 4; i <= 6; i++) { const j = chain.lock(cust(i), AGENT, ETH / 20n); chain.deliver(j); chain.accept(j); }
    await r.engine.watchOnce();
    await r.engine.reports!.pass();
    r.engine.reports!.scoreAll();
    expect(scoreOf(r, ids.agent)).not.toBe(first);
    // within the week: nothing
    await r.turn();
    expect(entries(r, ids.agent)).toHaveLength(1);
    // after it: the new one written, then the one before revoked
    r.wall.extra += 169 * 3_600_000;
    await r.engine.reports!.pass();
    r.engine.reports!.scoreAll();
    await r.turn();
    await r.turn();
    const e = entries(r, ids.agent);
    expect(e).toHaveLength(2);
    expect(e[1]).toMatchObject({ value: BigInt(scoreOf(r, ids.agent)) });
    expect(e[0]!.revoked).toBe(true);
    expect(e[1]!.revoked).toBeFalsy();
    const { status: _s, ...file } = await get(r, `/v1/erc8004/report/${/\/report\/(\d+)$/.exec(e[1]!.uri)![1]}`);
    expect(file.factor.before).toBe(first);
    expect((await get(r, `/v1/reports/agent/${ids.agent}`)).onChain).toMatchObject({ written: true, entries: 2, index: 2 });
    // a fall to 0 is written at once, inside the week: the lender defaults
    const lenderBefore = entries(r, ids.lender).length;
    loanId++;
    push(chain, POOL, priorsAbi as Abi, "Borrowed", { loanId: BigInt(loanId), agentId: BigInt(ids.lender), sponsorId: 1n, principal: 900_000_000n, fee: 1000n, dueAt: BigInt(chain.time + 86400), to: LENDER });
    chain.mine(1, 2 * 86400);
    push(chain, POOL, priorsAbi as Abi, "Defaulted", { loanId: BigInt(loanId), agentId: BigInt(ids.lender), sponsorId: 1n, principal: 900_000_000n, sharesBurnt: 5n, owner: LENDER });
    chain.mine(2);
    await r.engine.reports!.pass();
    r.engine.reports!.scoreAll();
    expect(scoreOf(r, ids.lender)).toBe(0);
    await r.turn();
    await r.turn();
    const le = entries(r, ids.lender);
    expect(le).toHaveLength(lenderBefore + 1);
    expect(le[le.length - 1]).toMatchObject({ value: 0n });
    expect(le[le.length - 2]!.revoked).toBe(true);
  });

  it("dry mode shows what it would write and writes nothing", async () => {
    const { chain, ids } = world();
    const r = await live(chain, {}, undefined, "dry");
    await r.turn();
    expect(chain.sends("giveFeedback")).toHaveLength(0);
    expect(r.lines.some((l) => /\[dry\] would send erc8004_report show:\d+: giveFeedback/.test(l))).toBe(true);
    expect((await get(r, `/v1/reports/agent/${ids.agent}`)).onChain.written).toBe(false);
  });
});

describe("the guards", () => {
  it("the day's gas: once the entries have cost what REPORTS_ERC8004_GAS_DAY_WEI allows, the rest wait for the next day", async () => {
    // room for one entry at its most (218,000 gas and a quarter more, at the made-up chain's 0.022 gwei), not two
    const one = ((218_000n * 12_500n) / 10_000n) * 22_000_000n;
    const { chain, ids } = world();
    const r = await live(chain, { REPORTS_ERC8004_GAS_DAY_WEI: String(one + one / 2n) });
    await r.turn();
    expect(chain.sends("giveFeedback")).toHaveLength(1);
    expect((await get(r, "/v1/health")).actions.erc8004_report.result).toMatch(/the day's gas for credit reports is spent/);
    await r.turn();
    expect(chain.sends("giveFeedback")).toHaveLength(1);
    // a day later the rest go
    r.wall.extra += 25 * 3_600_000;
    await r.turn();
    expect(chain.sends("giveFeedback")).toHaveLength(2);
    expect(entries(r, ids.agent).length + entries(r, ids.lender).length).toBe(2);
    // a cap of 1 wei: nothing at all
    const poor = await live(world().chain, { REPORTS_ERC8004_GAS_DAY_WEI: "1" });
    await poor.turn();
    expect(poor.chain.sends("giveFeedback")).toHaveLength(0);
  });

  it("a restart in the middle of a run, with a transaction on its way: it is found, and every agent is written exactly once", async () => {
    const { chain, ids } = world();
    const r = await live(chain, { REPORTS_ERC8004_PER_PASS: "1" });
    await r.turn();
    expect(chain.sends("giveFeedback")).toHaveLength(1);
    // the next one is sent and not mined, and the process stops
    chain.hold = true;
    await r.turn();
    expect(chain.sends("giveFeedback")).toHaveLength(2);
    await r.engine.stop();
    chain.release();
    chain.hold = false;
    // a new engine on the same database: it looks the transaction up, and writes nobody twice
    const again = await live(chain, { REPORTS_ERC8004_PER_PASS: "1" }, r.sqlite);
    for (let i = 0; i < 4; i++) await again.turn();
    expect(entries(again, ids.agent)).toHaveLength(1);
    expect(entries(again, ids.lender)).toHaveLength(1);
    expect(chain.sends("giveFeedback")).toHaveLength(2);
    expect((again.db.q("SELECT COUNT(*) AS n FROM report_erc8004 WHERE status = 'done'").get() as { n: number }).n).toBe(2);
  });

  it("an entry on the registry that Factor's notes do not hold: nothing more is written to that identity", async () => {
    const { chain, ids } = world();
    const r = await live(chain);
    // the gas wallet wrote to the agent's identity from somewhere Factor does not know of
    await chain.signer().send({ call: { to: A.reputation, abi: erc8004ReputationAbi as Abi, functionName: "giveFeedback", args: [BigInt(ids.agent), 1n, 0, "other", "", "", "", `0x${"00".repeat(32)}`] }, gas: 300_000n, nonce: chain.nonce, fees: { maxFeePerGas: chain.gasPrice, maxPriorityFeePerGas: 1n } }, () => undefined);
    await r.turn();
    expect(entries(r, ids.agent)).toHaveLength(0);
    expect(entries(r, ids.lender)).toHaveLength(1);
    expect(r.lines.some((l) => /nothing more is written to it until that is looked at/.test(l))).toBe(true);
    await r.turn();
    expect(entries(r, ids.agent)).toHaveLength(0);
  });

  it("the job entries' guard counts the report entries too: a report written is never taken for an unknown entry", async () => {
    const { chain, ids } = world();
    const r = await live(chain, { ERC8004: "on" });
    await r.turn();
    expect(entries(r, ids.agent)).toHaveLength(1);
    expect(await r.engine.erc8004!.guard(String(ids.agent), A.bot)).toBeNull();
  });
});

describe("the switches", () => {
  it("nothing while it is off, while the reports are off, or while the owner stopped it; written once turned back on", async () => {
    const off = await live(world().chain, { REPORTS_ERC8004: "off" });
    await off.turn(); await off.turn();
    expect(off.chain.sends("giveFeedback")).toHaveLength(0);
    expect((await get(off, "/v1/reports")).onErc8004).toMatchObject({ enabled: false, reports: 0 });
    expect((await get(off, "/v1/state")).reports.onErc8004).toBe(false);

    const { chain } = world();
    const r = await live(chain);
    turn(r.db, "reports8004", false, "a look");
    await r.turn(); await r.turn();
    expect(chain.sends("giveFeedback")).toHaveLength(0);
    expect((await get(r, "/v1/health")).actions.erc8004_report.result).toMatch(/stopped by the owner: a look/);
    turn(r.db, "reports8004", true);
    turn(r.db, "reports", false);
    await r.turn();
    expect(chain.sends("giveFeedback")).toHaveLength(0);
    turn(r.db, "reports", true);
    await r.turn();
    expect(chain.sends("giveFeedback")).toHaveLength(2);
  });

  it("the owner's switch over the API", async () => {
    const r = await live(world().chain, { ENGINE_ADMIN_KEY: "k".repeat(32) });
    const a = await r.engine.post("/v1/admin/switch", { what: "reports8004", on: false, note: "rollback" }, "1.2.3.4", "k".repeat(32));
    expect(a?.status).toBe(200);
    await r.turn();
    expect(r.chain.sends("giveFeedback")).toHaveLength(0);
  });
});
