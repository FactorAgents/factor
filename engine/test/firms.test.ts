// Agent firms, on the made-up chain: a lead signs a firm, the agents it invites sign to join, a customer hires the
// firm through its lead, the lead splits the job among its members as sub-jobs, and the firm's one shared record
// counts it all. Then the rules: who may sign what, the names a firm cannot take, the jobs that cannot be the firm's,
// a Pay with Factor link sold for a firm, and the switch.

import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { firmHireMessage, firmMessage, firmRecordTypedData, joinMessage, leaveMessage, readFirms, slugOf, type FirmJson, type FirmRecordJson } from "../src/firms.js";
import { encodePayLink, payLinkMessage, type PayLink } from "../src/pay.js";
import { profileMessage } from "../src/profiles.js";
import { hireMessage, type HirePlan, type TreeJson } from "../src/subjobs.js";
import { A, ETH, FakeChain } from "./chain/fake.js";
import { rig, TEST_KEY, type Rig } from "./chain/harness.js";

// anvil's public test keys: worth nothing anywhere
const leadKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9d86dae88c7a8412f4603b6b78690d");
const aKey = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const bKey = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
const cKey = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const buyerKey = privateKeyToAccount("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
const LEAD = leadKey.address.toLowerCase(), MA = aKey.address.toLowerCase(), MB = bKey.address.toLowerCase(), MC = cKey.address.toLowerCase(), BUYER = buyerKey.address.toLowerCase();
const PRICE = ETH / 100n; // 0.01
const DAY = 86_400;
type Key = typeof leadKey;
type Body = Record<string, any>;

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.engine.stop();
});

async function desk(more: Record<string, string> = {}): Promise<Rig> {
  const chain = new FakeChain();
  chain.fund(ETH);
  for (const a of [LEAD, MA, MB, MC]) chain.register(a);
  const r = await rig("live", { chain, more: { FIRMS: "on", SUBJOBS: "on", ...more } });
  rigs.push(r);
  await r.engine.watchOnce();
  return r;
}

const post = async (r: Rig, path: string, body: unknown): Promise<Body> => { const a = (await r.engine.post(path, body, "1.2.3.4"))!; return { status: a.status, ...(a.body as Body) }; };
const get = async (r: Rig, path: string): Promise<Body> => { const a = (await r.engine.handle(path))!; return { status: a.status, ...(a.body as Body) }; };

async function name(r: Rig, key: Key, n: string, does = "Does one kind of job well"): Promise<void> {
  const address = key.address.toLowerCase(), at = r.chain.time;
  const signature = await key.signMessage({ message: profileMessage(address, n, does, at) });
  expect((await post(r, "/v1/agents/profile", { address, name: n, does, at, signature })).status).toBe(200);
}

/** The lead signs a firm (or edits it). */
async function form(r: Rig, o: { key?: Key; slug?: string; name?: string; does?: string; members?: string[]; at?: number } = {}): Promise<Body> {
  const key = o.key ?? leadKey;
  const name_ = o.name ?? "Figure Check Co";
  const f = { slug: o.slug ?? slugOf(name_), name: name_, does: o.does ?? "Market notes where every figure is checked", lead: key.address.toLowerCase(), members: o.members ?? [MA, MB], at: o.at ?? r.chain.time };
  const signature = await key.signMessage({ message: firmMessage(f) });
  return post(r, "/v1/firms/form", { ...f, ...(o.slug ? {} : { slug: undefined }), signature });
}
async function join(r: Rig, key: Key, slug = "figure-check-co"): Promise<Body> {
  const member = key.address.toLowerCase(), at = r.chain.time;
  const signature = await key.signMessage({ message: joinMessage({ slug, lead: LEAD, member, at }) });
  return post(r, "/v1/firms/join", { firm: slug, member, at, signature });
}
async function leave(r: Rig, key: Key, slug = "figure-check-co"): Promise<Body> {
  const member = key.address.toLowerCase(), at = r.chain.time;
  const signature = await key.signMessage({ message: leaveMessage({ slug, member, at }) });
  return post(r, "/v1/firms/leave", { firm: slug, member, at, signature });
}
/** A customer locks a job for the lead and signs that it hires the firm with it. */
async function hire(r: Rig, o: { key?: Key; slug?: string; price?: bigint; title?: string; brief?: string; agent?: string } = {}): Promise<{ job: number; a: Body }> {
  const key = o.key ?? buyerKey;
  const job = r.chain.lock(key.address.toLowerCase(), o.agent ?? LEAD, o.price ?? PRICE, 2 * DAY, true);
  await r.engine.watchOnce();
  const h = { slug: o.slug ?? "figure-check-co", lead: o.agent ?? LEAD, job, title: o.title ?? "A one-page market note", brief: o.brief ?? "What moved this week, every figure checked.", at: r.chain.time };
  const signature = await key.signMessage({ message: firmHireMessage(h) });
  return { job, a: await post(r, "/v1/firms/hire", { firm: h.slug, job, title: h.title, brief: h.brief, at: h.at, signature }) };
}
/** The lead hires one of its members for part of a job, as any agent hires (./subjobs.test.ts). */
async function sub(r: Rig, parent: number, agent: string, price = PRICE / 4n): Promise<number> {
  const p: HirePlan = { parent, agent, price: price.toString(), dueAt: r.chain.time + DAY, early: false, title: "Check every figure", brief: "Every figure against its source.", at: r.chain.time };
  const signature = await leadKey.signMessage({ message: hireMessage(p) });
  const planned = await post(r, "/v1/subjobs/plan", { ...p, signature });
  expect(planned.status, planned.error).toBe(200);
  const lock = r.chain.lockTx(LEAD, agent, price, DAY, false);
  expect((await post(r, "/v1/subjobs/link", { plan: planned.plan, job: lock.id, lockTx: lock.hash })).status).toBe(200);
  await r.engine.watchOnce();
  return lock.id;
}

describe("the switch and the words", () => {
  it("is off unless FIRMS=on, and a firm invites eight agents at most by default", () => {
    expect(readFirms({})).toEqual({ enabled: false, mostMembers: 8, memberOf: 5, most: 1000 });
    expect(readFirms({ FIRMS: "on", FIRMS_MAX_MEMBERS: "3" })).toMatchObject({ enabled: true, mostMembers: 3 });
    const problems: string[] = [];
    readFirms({ FIRMS_MAX_MEMBERS: "99" }, problems);
    expect(problems).toHaveLength(1);
  });

  it("signs readable words, the same the kit and the site build", () => {
    expect(firmMessage({ slug: "figure-check-co", name: "Figure Check Co", does: "Market notes where every figure is checked", lead: LEAD, members: [MA, MB], at: 1_800_000_000 })).toBe(
      ["Factor firm", "firm: figure-check-co", "name: Figure Check Co", "does: Market notes where every figure is checked", `lead: ${LEAD}`, `members: ${MA}, ${MB}`, "at: 1800000000"].join("\n"));
    expect(joinMessage({ slug: "figure-check-co", lead: LEAD, member: MA, at: 1 })).toBe(`Factor: join a firm\nfirm: figure-check-co\nlead: ${LEAD}\nmember: ${MA}\nat: 1`);
    expect(leaveMessage({ slug: "figure-check-co", member: MA, at: 1 })).toBe(`Factor: leave a firm\nfirm: figure-check-co\nmember: ${MA}\nat: 1`);
    expect(firmHireMessage({ slug: "figure-check-co", lead: LEAD, job: 7, title: "A note", brief: "Line one\nLine two", at: 1 })).toBe(`Factor: hire a firm\nfirm: figure-check-co\nlead: ${LEAD}\njob: 7\ntitle: A note\nat: 1\n\nLine one\nLine two`);
    expect(firmHireMessage({ slug: "x-y-z", lead: LEAD, job: 7, title: "A note", brief: "", at: 1 })).not.toContain("\n\n");
    expect(slugOf("Figure Check & Co.")).toBe("figure-check-and-co");
  });

  it("refuses every write while it is off, and lists nothing as on", async () => {
    const r = await desk({ FIRMS: "" });
    expect((await form(r)).status).toBe(503);
    const s = await get(r, "/v1/state");
    expect(s.firms).toMatchObject({ enabled: false, count: 0, items: [] });
    expect((await get(r, "/v1/firms")).enabled).toBe(false);
  });
});

describe("a firm", () => {
  it("is signed by its lead, and an invited agent is in it only once it signs to join", async () => {
    const r = await desk();
    await name(r, leadKey, "report-lead");
    await name(r, aKey, "fact-checker");
    const made = await form(r);
    expect(made.status, made.error).toBe(200);
    expect(made).toMatchObject({ ok: true, firm: "figure-check-co", edited: false, invited: [MA, MB] });
    let f = (await get(r, "/v1/firms/figure-check-co")).firm as FirmJson;
    expect(f.lead).toMatchObject({ address: LEAD, name: "report-lead", named: true });
    expect(f.members.map((m) => [m.address, m.role])).toEqual([[LEAD, "lead"], [MA, "invited"], [MB, "invited"]]);
    // a stranger cannot join; the invited can, once
    expect((await join(r, cKey)).status).toBe(403);
    expect((await join(r, aKey)).status).toBe(200);
    expect((await join(r, aKey)).joined).toBe(true);
    // a signature by another key for that member is not its own
    const at = r.chain.time;
    const forged = await post(r, "/v1/firms/join", { firm: "figure-check-co", member: MB, at, signature: await cKey.signMessage({ message: joinMessage({ slug: "figure-check-co", lead: LEAD, member: MB, at }) }) });
    expect(forged.status).toBe(401);
    f = (await get(r, "/v1/firms/figure-check-co")).firm as FirmJson;
    expect(f.members.find((m) => m.address === MA)).toMatchObject({ role: "member", name: "fact-checker" });
    // listed, on the first page's state, and on each agent's page
    expect(((await get(r, "/v1/firms")).items as FirmJson[]).map((x) => x.slug)).toEqual(["figure-check-co"]);
    expect((await get(r, "/v1/state")).firms).toMatchObject({ enabled: true, count: 1 });
    expect((await get(r, `/v1/agents/${MA}`)).firms).toEqual([{ slug: "figure-check-co", name: "Figure Check Co", house: false, role: "member" }]);
    expect((await get(r, `/v1/agents/${LEAD}`)).firms).toEqual([{ slug: "figure-check-co", name: "Figure Check Co", house: false, role: "lead" }]);
    expect((await get(r, `/v1/agents/${MB}`)).firms[0].role).toBe("invited");
  });

  it("is edited by its lead only, with newer words, and a member leaves by its own signature", async () => {
    const r = await desk();
    expect((await form(r)).status).toBe(200);
    await join(r, aKey);
    await join(r, bKey);
    // somebody else signs the same firm: not the lead
    const other = await form(r, { key: cKey, slug: "figure-check-co", members: [MA] });
    expect(other.status).toBe(403);
    // the same words again, not newer: refused
    const same = await form(r, { slug: "figure-check-co", at: r.chain.time - 5 });
    expect(same.status).toBe(409);
    r.chain.mine(1, 30);
    // the lead drops MB and invites MC, and renames the firm
    const edit = await form(r, { slug: "figure-check-co", name: "Figure Check Company", members: [MA, MC] });
    expect(edit).toMatchObject({ status: 200, edited: true, invited: [MC] });
    let f = (await get(r, "/v1/firms/figure-check-co")).firm as FirmJson;
    expect(f.name).toBe("Figure Check Company");
    expect(f.members.map((m) => [m.address, m.role])).toEqual([[LEAD, "lead"], [MA, "member"], [MC, "invited"]]);
    // a member leaves; the lead cannot leave its own firm
    expect((await leave(r, aKey)).status).toBe(200);
    expect((await leave(r, leadKey)).status).toBe(409);
    f = (await get(r, "/v1/firms/figure-check-co")).firm as FirmJson;
    expect(f.members.map((m) => m.address)).toEqual([LEAD, MC]);
    // invited again, it must sign to join again
    r.chain.mine(1, 30);
    await form(r, { slug: "figure-check-co", name: "Figure Check Company", members: [MA, MC] });
    expect(((await get(r, "/v1/firms/figure-check-co")).firm as FirmJson).members.find((m) => m.address === MA)!.role).toBe("invited");
  });

  it("is made of agents on the desk, a lead leads one firm, and its words are fresh", async () => {
    const r = await desk();
    const stranger = privateKeyToAccount("0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6");
    expect(String((await form(r, { members: [stranger.address.toLowerCase()] })).error)).toMatch(/has not registered/);
    expect(String((await form(r, { members: [] })).error)).toMatch(/at least one other agent/);
    expect(String((await form(r, { members: [LEAD, MA] })).error)).toMatch(/lead is in the firm already/);
    expect(String((await form(r, { members: [MA, MA] })).error)).toMatch(/twice/);
    expect(String((await form(r, { at: r.chain.time - 3600 })).error)).toMatch(/ten minutes/);
    expect((await form(r)).status).toBe(200);
    expect(String((await form(r, { name: "Second Desk Of Mine" })).error)).toMatch(/leads one firm/);
    // two firms never share a name, whoever leads them
    expect(String((await form(r, { key: cKey, name: "figure check co", slug: "another-slug", members: [MB] })).error)).toMatch(/another firm has that name/);
    const few = await desk({ FIRMS_MAX_MEMBERS: "1" });
    expect(String((await form(few)).error)).toMatch(/1 agents at most/);
  });

  it("never passes for Factor, its staff, or an agent outside the firm", async () => {
    const r = await desk();
    await name(r, cKey, "fact-checker");
    for (const [n, why] of [["Factor Research", /word Factor/], ["The Official Desk", /staff/], ["Plain Reader", /not available/], ["The Research Desk", /not available/], ["Fact Checker", /an agent outside the firm/], ["https desk.com", /one plain line|letters, digits/], ["Shitty Firm", /not available/]] as const) {
      const a = await form(r, { name: n });
      expect(a.status, n).toBe(400);
      expect(String(a.error), n).toMatch(why);
    }
    // an agent's own name is the firm's to use when that agent is in it
    expect((await form(r, { name: "Fact Checker", members: [MC] })).status).toBe(200);
  });
});

describe("hiring a firm", () => {
  it("is a job locked for the lead, filed under the firm by its customer's signature with its title and brief", async () => {
    const r = await desk();
    await form(r);
    await join(r, aKey);
    const { job, a } = await hire(r);
    expect(a).toMatchObject({ status: 200, ok: true, firm: "figure-check-co", job, lead: LEAD });
    const page = await get(r, `/v1/jobs/${job}`);
    expect(page.job).toMatchObject({ customer: BUYER, agentId: LEAD, title: "A one-page market note", firm: { slug: "figure-check-co", name: "Figure Check Co", house: false, part: false } });
    expect(page.brief).toBe("What moved this week, every figure checked.");
    // the lead splits it: a sub-job for a member is the firm's work too, and the chain of work says who is in the firm
    const s = await sub(r, job, MA);
    const subPage = await get(r, `/v1/jobs/${s}`);
    expect(subPage.job.firm).toMatchObject({ slug: "figure-check-co", part: true });
    const tree = subPage.tree as TreeJson & { firm: { slug: string } };
    expect(tree.firm).toMatchObject({ slug: "figure-check-co", name: "Figure Check Co" });
    expect(tree.nodes.map((n) => [n.job, n.inFirm])).toEqual([[job, true], [s, true]]);
    // asked again, the same answer
    const at = r.chain.time;
    const again = await post(r, "/v1/firms/hire", { firm: "figure-check-co", job, title: "A one-page market note", brief: "", at, signature: await buyerKey.signMessage({ message: firmHireMessage({ slug: "figure-check-co", lead: LEAD, job, title: "A one-page market note", brief: "", at }) }) });
    expect(again.status).toBe(200);
  });

  it("takes only an open job locked for the lead, signed by its customer, from outside the firm", async () => {
    const r = await desk();
    await form(r);
    await join(r, aKey);
    expect(String((await hire(r, { agent: MA })).a.error)).toMatch(/not locked for the firm's lead/);
    expect(String((await hire(r, { key: aKey })).a.error)).toMatch(/cannot hire itself/);
    expect(String((await hire(r, { slug: "no-such-firm" })).a.error)).toMatch(/no such firm/);
    // a signature that is not the customer's
    const job = r.chain.lock(BUYER, LEAD, PRICE, DAY, true);
    await r.engine.watchOnce();
    const at = r.chain.time;
    const h = { slug: "figure-check-co", lead: LEAD, job, title: "A note", brief: "", at };
    expect((await post(r, "/v1/firms/hire", { firm: h.slug, job, title: h.title, brief: "", at, signature: await cKey.signMessage({ message: firmHireMessage(h) }) })).status).toBe(401);
    // a job that is no longer open
    r.chain.deliver(job);
    await r.engine.watchOnce();
    expect(String((await post(r, "/v1/firms/hire", { firm: h.slug, job, title: h.title, brief: "", at, signature: await buyerKey.signMessage({ message: firmHireMessage(h) }) })).error)).toMatch(/no longer open/);
  });

  it("can be bought through a Pay with Factor link the lead signed for the firm, and only that", async () => {
    const r = await desk();
    await form(r);
    const link: PayLink = { v: 1, agent: LEAD, price: PRICE.toString(), title: "A one-page market note", brief: "", due: 24, early: true, exp: r.chain.time + 30 * DAY, id: "0123456789abcdef", firm: "figure-check-co" };
    // the link's words say the firm; a link without one says what it always said
    expect(payLinkMessage(link)).toContain(`agent: ${LEAD}\nfirm: figure-check-co\nprice:`);
    expect(payLinkMessage({ ...link, firm: undefined })).not.toContain("firm:");
    const token = encodePayLink(link, await leadKey.signMessage({ message: payLinkMessage(link) }));
    const info = await get(r, `/v1/pay/link/${token}`);
    expect(info.firm).toEqual({ slug: "figure-check-co", name: "Figure Check Co", house: false });
    const { id, hash } = r.chain.lockTx(BUYER, LEAD, PRICE, 24 * 3600, true);
    const deal = await post(r, "/v1/pay/deal", { link: token, job: id, lockTx: hash });
    expect(deal).toMatchObject({ status: 200, firm: "figure-check-co" });
    await r.engine.watchOnce();
    expect((await get(r, `/v1/jobs/${id}`)).job.firm.slug).toBe("figure-check-co");
    // the same link with the firm's name changed on the way: its signature no longer covers it
    const [, sig] = token.split(".");
    const other = `${Buffer.from(JSON.stringify({ ...link, firm: "another-firm" })).toString("base64url")}.${sig}`;
    expect((await get(r, `/v1/pay/link/${other}`)).status).toBe(400);
    // a link signed by somebody who does not lead the firm: the deal stands, and is not the firm's
    const theirs: PayLink = { ...link, agent: MA, id: "fedcba9876543210" };
    const t2 = encodePayLink(theirs, await aKey.signMessage({ message: payLinkMessage(theirs) }));
    const l2 = r.chain.lockTx(BUYER, MA, PRICE, 24 * 3600, true);
    const d2 = await post(r, "/v1/pay/deal", { link: t2, job: l2.id, lockTx: l2.hash });
    expect(d2.status).toBe(200);
    expect(d2.firmNote).toMatch(/not locked for the firm's lead/);
    // the lead's published links that sell the firm show on the firm's page
    expect((await post(r, "/v1/pay/links", { link: token })).status).toBe(200);
    expect(((await get(r, "/v1/firms/figure-check-co")).links as { firm: string }[])[0]!.firm).toBe("figure-check-co");
  });
});

describe("the shared record", () => {
  it("counts the firm's jobs and the sub-jobs under them, each member's part, and is signed by Factor", async () => {
    const r = await desk();
    await name(r, leadKey, "report-lead");
    await form(r, { members: [MA, MB] });
    await join(r, aKey);
    await join(r, bKey);
    const { job } = await hire(r, { price: PRICE });
    const s1 = await sub(r, job, MA, PRICE / 4n);
    const s2 = await sub(r, job, MB, PRICE / 4n);
    // an agent outside the firm is hired too: the firm's work, not one of its members
    const s3 = await sub(r, job, MC, PRICE / 10n);
    for (const s of [s1, s2, s3]) { r.chain.deliver(s); r.chain.accept(s); }
    r.chain.deliver(job);
    r.chain.accept(job);
    await r.engine.watchOnce();
    const page = await get(r, "/v1/firms/figure-check-co");
    const f = page.firm as FirmJson;
    expect(f).toMatchObject({ hired: 1, settled: 1, settledEth: 0.01 });
    expect(f.members.map((m) => [m.address, m.part.jobs, m.part.settled, m.part.settledEth])).toEqual([[LEAD, 1, 1, 0.01], [MA, 1, 1, 0.0025], [MB, 1, 1, 0.0025]]);
    const rec = page.record as FirmRecordJson;
    expect(rec.jobs).toMatchObject({ hired: 1, settled: 1, open: 0 });
    expect(rec.subJobs).toEqual({ count: 3, settled: 3, toMembers: 2, toOthers: 1 });
    expect(rec.customers).toBe(1);
    expect(rec.attestation).toBeNull(); // the page's copy; the record's own path carries it
    // the page lists the firm's jobs, newest first, each with the chain of work under it
    expect((page.jobs as { n: number; tree: TreeJson }[])[0]).toMatchObject({ n: job });
    expect((page.jobs as { tree: TreeJson }[])[0]!.tree.nodes).toHaveLength(4);
    // the record for an app: signed by Factor's record key, which anyone checks with the typed data
    const signed = (await get(r, "/v1/firms/figure-check-co/record")) as unknown as FirmRecordJson & { status: number };
    expect(signed.status).toBe(200);
    expect(signed.attestation).not.toBeNull();
    expect(signed.page).toMatch(/\/firms\/figure-check-co$/);
    expect(signed.badge).toMatch(/\/api\/v1\/firms\/figure-check-co\/badge$/);
    const typed = firmRecordTypedData(signed.chainId, signed.desk, signed.attestation!.message);
    expect(await verifyTypedData({ ...typed, address: signed.attestation!.signer as `0x${string}`, signature: signed.attestation!.signature } as never)).toBe(true);
    expect(signed.attestation!.message).toMatchObject({ firm: "figure-check-co", hired: 1, settled: 1, subJobs: 3, settledValue: PRICE.toString() });
    expect((await get(r, "/v1/firms/no-such-firm/record")).status).toBe(404);
  });

  it("can be hidden by the owner", async () => {
    const r = await desk({ ENGINE_ADMIN_KEY: "an-owner-key-of-24-chars-or-more" });
    await form(r);
    const hid = (await r.engine.post("/v1/admin/hide", { what: "firm", key: "figure-check-co" }, "1.2.3.4", "an-owner-key-of-24-chars-or-more"))!;
    expect(hid.status).toBe(200);
    expect((await get(r, "/v1/firms/figure-check-co")).status).toBe(404);
    expect((await get(r, "/v1/firms")).items).toEqual([]);
  });
});

void TEST_KEY;
void A;
void FakeChain;
