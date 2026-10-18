// Factor's own firm, The Research Desk, on the made-up chain with a stand-in for the model maker (no model is ever
// called): the engine puts it together from Factor's own agents, and a customer from outside hires it. Its lead,
// plain-reader, reads the material, draws half early, hires data-shaper and faq-smith for their parts, accepts them,
// has red-pen proofread the whole, and delivers it with who did what. Then the cases where it works alone, and the rule
// that Factor's agents hire each other only inside that firm, for an outside customer.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { KIND } from "../src/accounts.js";
import { firmHireMessage, HOUSE_FIRM, type FirmJson, type FirmRecordJson } from "../src/firms.js";
import type { HouseSigner } from "../src/house/house.js";
import { SERVICES } from "../src/house/services.js";
import { briefMessage } from "../src/profiles.js";
import { hireMessage, type TreeJson } from "../src/subjobs.js";
import { A, ETH, FakeChain, GOOD_SIGNATURE } from "./chain/fake.js";
import { rig, wallet, type Rig } from "./chain/harness.js";

const customerKey = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const CUSTOMER = customerKey.address.toLowerCase();
const ALL = SERVICES;
const numberOf = (name: string) => { const i = ALL.findIndex((s) => s.name === name); return i >= 0 ? 0xa000 + i : 0xb000 + [...name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 0xfff, 7); };
const signerFor = (name: string): HouseSigner => ({ address: wallet(numberOf(name)), signTypedData: async () => GOOD_SIGNATURE, signMessage: async () => GOOD_SIGNATURE });
const accountOf = (name: string) => FakeChain.accountOf({ kind: KIND.wallet, a: `0x${"0".repeat(24)}${signerFor(name).address.slice(2)}`, b: `0x${"0".repeat(64)}` });
const READER = accountOf("plain-reader"), SHAPER = accountOf("data-shaper"), FAQ = accountOf("faq-smith"), PEN = accountOf("red-pen");

const READING = "IN ONE LINE\nA quarter's results for a small shop.\n\nWHAT IT SAYS\n- Sales rose in every month.\n\nWHAT TO WATCH FOR\n- Costs rose faster than sales in March.";
const TABLE = "month,sales,costs\nJanuary,1200,800\nFebruary,1350,900\nMarch,1500,1250";
const QA = "Q: Did sales rise?\nA: Yes, in every month of the quarter, from 1200 to 1500.\n\nQ: What should a reader watch?\nA: Costs rose faster than sales in March, from 900 to 1250.";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => { s.closeAllConnections(); s.close(() => done()); })));
});
async function model(): Promise<{ url: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as { system: string; messages: { content: string }[] };
      const who = /You are ([a-z-]+)/.exec(body.system)?.[1] ?? "?";
      asked.push(who);
      const text = who === "data-shaper" ? TABLE : who === "faq-smith" ? QA : who === "red-pen" ? `CORRECTED\n${body.messages[0]!.content.replace(/^[\s\S]*?The text:\n\n/, "").replace("in March.", "in March, by a wide margin.")}\n\nCHANGES\n- One clause made clearer.` : READING;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text }], usage: { input_tokens: 1500, output_tokens: 600 } }));
    });
  });
  servers.push(server);
  const url = await new Promise<string>((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  return { url, asked };
}

type Body = Record<string, any>;
const post = async (r: Rig, path: string, body: unknown): Promise<Body> => { const a = (await r.engine.post(path, body, "1.1.1.1"))!; return { status: a.status, ...(a.body as Body) }; };
const get = async (r: Rig, path: string): Promise<Body> => { const a = (await r.engine.handle(path))!; return { status: a.status, ...(a.body as Body) }; };
const round = async (w: Rig, n = 1) => { for (let i = 0; i < n; i++) { await w.engine.houseOnce(); await w.turn(); await w.engine.watchOnce(); } };
const rigs: Rig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.engine.stop(); });

async function world(more: Record<string, string> = {}): Promise<Rig & { asked: string[] }> {
  const m = await model();
  const chain = new FakeChain();
  chain.balances.set(A.bot, ETH);
  const w = await rig("live", { chain, houseSigners: signerFor, more: { HOUSE_MODE: "on", FIRMS: "on", SUBJOBS: "on", FACTOR_ACCOUNTS: A.accounts, HOUSE_UPSTREAM_URL: m.url, ANTHROPIC_API_KEY: "sk-ant-test-0000-the-owners-key", ...more } });
  rigs.push(w);
  await w.engine.watchOnce();
  await round(w, 8);
  return { ...w, asked: m.asked };
}

const MATERIAL = `Quarterly results for the corner shop, as the owner sent them.
January: sales 1200, costs 800.
February: sales 1350, costs 900.
March: sales 1500, costs 1250.
${"The owner wants to know what these figures say about the quarter, what a lender would ask about them, and whether costs are under control. ".repeat(5)}`.trim();

/** A customer from outside locks a job for the firm's lead and files it under the firm, with its brief. */
async function hireFirm(w: Rig, o: { price?: bigint; early?: boolean; dueS?: number; brief?: string; key?: typeof customerKey } = {}): Promise<number> {
  const key = o.key ?? customerKey;
  const job = w.chain.lock(key.address.toLowerCase(), READER, o.price ?? ETH / 100n, o.dueS ?? 2 * 86_400, o.early ?? true);
  await w.engine.watchOnce();
  const at = w.chain.time;
  const h = { slug: HOUSE_FIRM.slug, lead: READER, job, title: "What the quarter says", brief: o.brief ?? MATERIAL, at };
  const a = await post(w, "/v1/firms/hire", { firm: h.slug, job, title: h.title, brief: h.brief, at, signature: await key.signMessage({ message: firmHireMessage(h) }) });
  expect(a.status, a.error).toBe(200);
  return job;
}

describe("The Research Desk", () => {
  it("is put together by the engine from Factor's own agents, and marked as Factor's", async () => {
    const w = await world();
    const firms = (await get(w, "/v1/firms")).items as FirmJson[];
    expect(firms).toHaveLength(1);
    expect(firms[0]).toMatchObject({ slug: "the-research-desk", name: "The Research Desk", house: true, lead: { address: READER, name: "plain-reader" }, fromEth: 0.008 });
    expect(firms[0]!.members.map((m) => [m.name, m.role])).toEqual([["plain-reader", "lead"], ["data-shaper", "member"], ["faq-smith", "member"], ["red-pen", "member"]]);
    // nobody else can take its name, edit it, or leave it
    expect((await get(w, `/v1/agents/${READER}`)).firms).toEqual([{ slug: "the-research-desk", name: "The Research Desk", house: true, role: "lead" }]);
    expect(w.engine.houseFirm()).toBe(false); // it stands already: nothing is written again
  });

  it("splits a job among its members, pays each on delivery, proofreads the whole and delivers it", async () => {
    const w = await world();
    const job = await hireFirm(w);
    await round(w, 40);
    const page = await get(w, `/v1/jobs/${job}`);
    expect(page.job.state).toBe("delivered");
    expect(page.job.advance).toMatchObject({ kind: "customer", eth: 0.005 });
    // the chain of work: the three members, each its own job locked by the lead and accepted
    const tree = page.tree as TreeJson & { firm: { slug: string } };
    expect(tree.firm.slug).toBe("the-research-desk");
    const kids = tree.nodes.filter((n) => n.parent === job);
    expect(kids.map((n) => [n.agent, n.state, n.customer])).toEqual([[SHAPER, "settled", READER], [FAQ, "settled", READER], [PEN, "settled", READER]]);
    expect(kids.every((n) => n.inFirm && n.verified)).toBe(true);
    // each member is paid what it takes a job for, more on a larger job: 0.01 pays each 1.4 times its floor
    expect(kids.map((n) => n.priceEth)).toEqual([0.0014, 0.0021, 0.0014]);
    // and each hire added its 1% to the burn, from the lead's own order
    expect(kids.map((n) => n.burnEth)).toEqual([0.000014, 0.000021, 0.000014]);
    // the work: proofread, with the figures and the questions, and who did each part
    const work = page.work.text as string;
    expect(work).toContain("by a wide margin");
    expect(work).toContain("THE FIGURES\nmonth,sales,costs");
    expect(work).toContain("QUESTIONS AND ANSWERS\nQ: Did sales rise?");
    expect(work).toMatch(/The Research Desk, Factor's own firm: read by plain-reader, figures by data-shaper \(job \d{4}\), questions by faq-smith \(job \d{4}\), proofread by red-pen \(job \d{4}\)\./);
    expect(page.firmNote).toMatch(/^The Research Desk took this job: plain-reader read it and hired data-shaper, faq-smith, red-pen\.$/);
    // the model was asked once by each: the lead's reading, two parts, the proofreading
    expect(w.asked.filter((x) => x !== "?").sort()).toEqual(["data-shaper", "faq-smith", "plain-reader", "red-pen"]);
    // the customer accepts: the firm's record counts the job, its three parts and each member's part
    w.chain.accept(job);
    await w.engine.watchOnce();
    const f = (await get(w, "/v1/firms/the-research-desk"));
    expect((f.firm as FirmJson)).toMatchObject({ hired: 1, settled: 1, settledEth: 0.01 });
    expect((f.firm as FirmJson).members.map((m) => [m.name, m.part.settled])).toEqual([["plain-reader", 1], ["data-shaper", 1], ["faq-smith", 1], ["red-pen", 1]]);
    expect((f.record as FirmRecordJson).subJobs).toEqual({ count: 3, settled: 3, toMembers: 3, toOthers: 0 });
  });

  it("does the job alone when the customer allowed no early advance, the price is under the team's, or nothing is for the team", async () => {
    const w = await world();
    const noEarly = await hireFirm(w, { early: false });
    const small = await hireFirm(w, { price: ETH / 500n });
    await round(w, 12);
    for (const [job, why] of [[noEarly, /allowed no early advance/], [small, /under what the whole team takes a job for \(0\.008 ETH\)/]] as const) {
      const page = await get(w, `/v1/jobs/${job}`);
      expect(page.job.state).toBe("delivered");
      expect(page.firmNote).toMatch(why);
      expect(page.tree).toBeUndefined();
    }
  });

  it("is the only place Factor's own agents hire each other, and only for a customer from outside", async () => {
    const w = await world();
    // an ordinary job for plain-reader, not hired through the firm: hiring data-shaper under it is the same hand
    const plain = w.chain.lock(CUSTOMER, READER, ETH / 100n, 2 * 86_400, true);
    await w.engine.watchOnce();
    const t = w.chain.time;
    const p = { parent: plain, agent: SHAPER, price: (ETH / 1000n).toString(), dueAt: t + 86_400, early: false, title: "A part", brief: "x".repeat(50), at: t };
    expect(w.engine.subjobs!.ownPlan(p, READER, GOOD_SIGNATURE).body.error).toMatch(/same hand/);
    // the firm's job, but its customer is Factor's own demonstration customer: still the same hand
    const own = w.chain.lock(accountOf("demonstration customer"), READER, ETH / 100n, 2 * 86_400, true);
    await w.engine.watchOnce();
    w.db.q("INSERT INTO firm_jobs (job_id, firm_id, customer, lead, via, title, signed_at, signature, at) VALUES (?, 1, ?, ?, 'hire', '', 0, 'x', 0)").run(own, accountOf("demonstration customer"), READER);
    w.engine.house!.demoCustomer = accountOf("demonstration customer");
    expect(w.engine.subjobs!.ownPlan({ ...p, parent: own }, READER, GOOD_SIGNATURE).body.error).toMatch(/same hand/);
    // for an outside customer's job hired through the firm, it may
    const firmJob = await hireFirm(w);
    expect(w.engine.subjobs!.ownPlan({ ...p, parent: firmJob }, READER, GOOD_SIGNATURE).status).toBe(200);
    void hireMessage;
    void briefMessage;
  });
});
