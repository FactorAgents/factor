// Monthly clients, end to end, on a LOCAL fork of Robinhood Chain: the fork (read through the rehearsal's own
// go-between, engine/scripts/rehearsal-node.ts), the contracts deployed there by the engine's own script, the engine
// with PLANS=on (and FIRMS and SUBJOBS), and the site in front of it, all on 127.0.0.1. Nothing here reaches the real
// chain, and no model is called.
//
//   npm run plans-e2e            every check, then everything is stopped
//   npm run plans-e2e -- --stay  everything is left running (the site on 3770) for a look or for pictures
//   npm run plans-e2e -- --stop  stops what --stay left running
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  an agent signs up and builds a record: three small jobs from another customer, and a bond
//   2  a customer puts it on a three-month plan: signed once, month 1 locked at once with its burn
//   3  the agent starts month 1 with half and delivers it; month 2 can then be locked, ahead of its month
//   4  next month early: the agent draws on month 2 from the pool, within the desk's own limits
//   5  each month accepted on its own; the pool is repaid out of month 2; every wei where it should be
//   6  the recurring income on the record: the plan's page, the agent's page, the record, the badge, the tool
//   7  stopping: month 3 locked ahead, the plan stopped, the agent declines month 3 and the customer has it all back
//   8  a plan with a firm, and a plan bought through a subscribe link
//   9  a month locked when its own month begins, a month later on the fork's clock, due at that month's end
//
// Keys: anvil's built-in test keys (inside the engine's script) and keys made up here for this run, funded on the fork
// only. No wallet of Factor's.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Factor, MONTH_S, Refusal } from "../src/index.js";
import { runTool } from "../src/tools.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WEB = join(KIT, "..", "..", "web");
const PORTS = { site: 3770, anvil: 3771, engine: 3772, model: 3773, source: 3774 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-plans-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const E2E_ENV = { E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK, E2E_FORK_URL: `http://127.0.0.1:${PORTS.source}`, PLANS: "on", SUBJOBS: "on", FIRMS: "on", ENGINE_PULSE: "off", DESK_MIND: "off", ACTIVITY: "off", MATCH: "off" };
const args = process.argv.slice(2);

const step = (title: string) => console.log(`\n== ${title}`);
const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
const refused = async (p: Promise<unknown>): Promise<string> => { try { await p; return ""; } catch (e) { return e instanceof Refusal ? e.message : `NOT A REFUSAL: ${(e as Error).message}`; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidsOn = (port: number): number[] => spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.split("\n").map((s) => s.trim()).filter(Boolean).map(Number);
async function stopPort(port: number): Promise<void> {
  for (const pid of pidsOn(port)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  for (let i = 0; i < 60 && pidsOn(port).length; i++) await sleep(100);
  for (const pid of pidsOn(port)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}
const stopAll = async () => {
  await stopPort(PORTS.site);
  spawnSync("npm", ["run", "e2e", "--", "--stop"], { cwd: ENGINE, encoding: "utf8", env: { ...process.env, ...E2E_ENV } });
  await stopPort(PORTS.source);
};

async function main(): Promise<void> {
  if (args.includes("--stop")) { await stopAll(); console.log("stopped"); return; }
  mkdirSync(WORK, { recursive: true });
  step("0  the copy's source, the fork, the contracts, the engine with PLANS=on, and the site");
  await stopPort(PORTS.site);
  await stopPort(PORTS.source);
  const nodeLog = openSync(join(WORK, "source.log"), "a");
  spawn(join(ENGINE, "node_modules", ".bin", "tsx"), ["scripts/rehearsal-node.ts", "source", String(PORTS.source), LIVE_RPC], { cwd: ENGINE, stdio: ["ignore", nodeLog, nodeLog], detached: true }).unref();
  for (let i = 0; i < 60 && !pidsOn(PORTS.source).length; i++) await sleep(250);
  const bareRun = spawnSync("npm", ["run", "e2e", "--", "--bare"], { cwd: ENGINE, encoding: "utf8", timeout: 1_200_000, env: { ...process.env, ...E2E_ENV } });
  if (bareRun.status !== 0) throw new Error(`the engine's script failed:\n${(bareRun.stdout + bareRun.stderr).split("\n").slice(-30).join("\n")}`);
  const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8")) as { rpc: string; api: string; desk: Hex; burnPot: Hex; keys: Hex[] };
  const rpc = async (method: string, params: unknown[]) => (await (await fetch(bare.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: unknown };
  for (const a of ["0x0000F90827F1C53a10cb7A02335B175320002935", "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02"]) await rpc("anvil_setCode", [a, "0x"]);
  const siteLog = openSync(join(WORK, "site.log"), "a");
  spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORTS.site)], { cwd: WEB, stdio: ["ignore", siteLog, siteLog], detached: true, env: { ...process.env, FACTOR_ENGINE_URL: bare.api, FACTOR_SAMPLE: "", FACTOR_STATE_SHARE_MS: "0" } }).unref();
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${SITE}/api/v1/state`)).ok) break; } catch { /* starting */ } await sleep(500); }
  const where = { api: `${SITE}/api/v1`, rpcUrl: bare.rpc };
  const chain = createPublicClient({ transport: http(bare.rpc) });
  const fund = async (address: string, eth: string) => { await rpc("anvil_setBalance", [address, `0x${parseEther(eth).toString(16)}`]); };
  const balance = (a: string) => chain.getBalance({ address: a as Hex });
  const gasOf = async (hash: Hex) => { const r = await chain.getTransactionReceipt({ hash }); return r.gasUsed * r.effectiveGasPrice; };
  const DESK = parseAbi([
    "function job(uint256) view returns ((address customer, uint40 dueAt, uint40 deliveredAt, uint8 state, bool allowEarly, bool late, address agent, uint256 price, uint256 early, uint256 fromPool, bytes32 proof))",
    "function agent(address) view returns ((bool registered, bool barred, uint40 firstSettledAt, uint32 settled, uint32 settledAtHalf, uint32 notDelivered, uint32 unanswered, uint32 customers, uint32 onTime, uint32 late, uint32 advancesRepaid, uint32 advancesNotRepaid, uint32 earlyKept, uint256 bond, uint256 feesPaid, uint256 advancedNow, uint256 volume))",
  ]);
  const job = (n: number) => chain.readContract({ address: bare.desk, abi: DESK, functionName: "job", args: [BigInt(n)] }) as Promise<{ customer: string; state: number; price: bigint; early: bigint; fromPool: bigint; agent: string; dueAt: number }>;
  const deskAgent = (a: string) => chain.readContract({ address: bare.desk, abi: DESK, functionName: "agent", args: [a as Hex] }) as Promise<{ settled: number; advancedNow: bigint; bond: bigint; feesPaid: bigint }>;
  const blockTime = async () => Number((await chain.getBlock()).timestamp);
  const get = async (path: string) => { const r = await fetch(`${SITE}${path}`); return { status: r.status, text: (await r.text()).replace(/<!-- -->/g, ""), type: r.headers.get("content-type") ?? "" }; };
  const words = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").replace(/ ([,.])/g, "$1");
  const s0 = JSON.parse((await get("/api/v1/state")).text) as { plans?: { enabled: boolean; mostMonths: number } };
  check("the site answers in front of the engine, and says monthly plans are on", s0.plans?.enabled === true && s0.plans.mostMonths === 12, JSON.stringify(s0.plans));

  step("1  an agent signs up and builds a record: three small jobs from another customer, and a bond");
  const keyOf = async (eth: string) => { const k = generatePrivateKey(); await fund(privateKeyToAccount(k).address, eth); return k; };
  const agent = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  await agent.signUp({ name: "note-writer", does: "Writes a short market note every week, every figure checked" });
  const other = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  for (let i = 0; i < 3; i++) {
    const { jobId } = await other.hire({ agent: "note-writer", price: "0.001", title: `A short note, number ${i + 1}`, dueInHours: 24 });
    await agent.deliver(jobId, `Note ${i + 1}, every figure checked.`);
    await other.accept(jobId);
  }
  await agent.addBond("0.002");
  const rec0 = await deskAgent(agent.address!);
  check("three jobs settled and a bond of 0.002 ETH: its limit with the pool is the bond plus the fees", rec0.settled === 3 && rec0.bond === parseEther("0.002") && rec0.feesPaid === parseEther("0.00006"), JSON.stringify({ settled: rec0.settled, fees: String(rec0.feesPaid) }));

  step("2  a customer puts it on a three-month plan: signed once, month 1 locked at once with its burn");
  const customer = await Factor.connect({ ...where, privateKey: await keyOf("2") });
  const cb0 = await balance(customer.address!);
  const m1 = await customer.subscribe({ agent: "note-writer", price: "0.002", months: 3, title: "A weekly market note", brief: "Every Monday: what moved last week, in plain words, every figure checked.", allowEarly: true });
  const j1 = await job(m1.jobId);
  const t1 = await blockTime();
  check("month 1 is locked for the agent at 0.002 ETH, early allowed, and linked to the plan", m1.linked && m1.month === 1 && m1.months === 3 && j1.agent.toLowerCase() === agent.address && j1.price === parseEther("0.002") && j1.state === 1, m1.note ?? "");
  check("it is due a month after its lock", Math.abs(Number(j1.dueAt) - (t1 + MONTH_S)) < 1200, `${Number(j1.dueAt) - t1} s`);
  check("its 1% went to the burn, checked on the chain", m1.burned && !!m1.burnTx);
  const spent1 = cb0 - (await balance(customer.address!));
  check("the customer paid the month, the burn and gas, nothing more", spent1 > parseEther("0.00202") && spent1 < parseEther("0.00202") + parseEther("0.0005"), String(spent1));
  let plan = (await customer.plan(m1.plan))!.plan;
  check("the plan's page: running, month 1 of 3 locked, month 2 waits for month 1's delivery", plan.status === "active" && plan.locked === 1 && plan.next?.month === 2 && !plan.next.open && /month 1 is not delivered/.test(plan.next.why ?? ""), JSON.stringify(plan.next));
  await customer.waitFor(m1.jobId, ["locked"]);
  check("month 1's job carries the plan's words", (await customer.job(m1.jobId))?.job.title === "Month 1 of 3: A weekly market note" && (await customer.job(m1.jobId))?.job.plan?.month === 1);
  check("month 2 cannot be locked before month 1 is delivered", (await refused(customer.payMonth(m1.plan))).includes("month 1 is not delivered yet"));
  check("only the customer locks a month", (await refused(other.payMonth(m1.plan))).includes("Only the plan's customer"));

  step("3  the agent starts month 1 with half and delivers it; month 2 can then be locked, ahead of its month");
  const ab0 = await balance(agent.address!);
  const can1 = await agent.canDraw(m1.jobId);
  const d1 = await agent.draw(m1.jobId, can1.early, "early");
  check("up front: half of month 1, less the 1% fee, to the wei", (await balance(agent.address!)) - ab0 + (await gasOf(d1.hash)) === parseEther("0.001") - parseEther("0.00001"), can1.early);
  await agent.deliver(m1.jobId, "Last week in one page: five moves, every figure checked against its source.", { show: true });
  await agent.waitFor(m1.jobId, ["delivered"]);
  plan = (await customer.plan(m1.plan))!.plan;
  check("month 2 can be locked now", plan.next?.month === 2 && plan.next.open === true, JSON.stringify(plan.next));
  const m2 = await customer.payMonth(m1.plan);
  const j2 = await job(m2.jobId);
  const t2 = await blockTime();
  check("month 2 is locked ahead: due 30 days after its lock, before its own month would end", m2.linked && m2.month === 2 && Math.abs(Number(j2.dueAt) - (t2 + MONTH_S)) < 1200 && Number(j2.dueAt) < Number(j1.dueAt) + MONTH_S, m2.note ?? "");

  step("4  next month early: the agent draws on month 2 from the pool, within the desk's own limits");
  plan = (await agent.plan(m1.plan))!.plan;
  const offer = plan.drawEarly;
  check("it is offered: month 2, ahead of its month, by the agent's record", offer?.month === 2 && offer.ahead && offer.open, JSON.stringify(offer));
  check("the offer is within what the desk allows: half the month at most, and the agent's limit", !!offer && BigInt(offer.fromPoolWei) > 0n && BigInt(offer.fromPoolWei) <= parseEther("0.001"), offer?.fromPoolWei);
  check("only the plan's agent draws on it", (await refused(customer.drawNextMonth(m1.plan))).includes("Only the plan's agent"));
  const ab1 = await balance(agent.address!);
  const dn = await agent.drawNextMonth(m1.plan);
  check("drawn from the pool: the agent has it, less the 1% fee", (await balance(agent.address!)) - ab1 + (await gasOf(dn.hash)) === dn.amountWei - dn.amountWei / 100n, String(dn.amountWei));
  check("the desk says month 2 has it from the pool, and the agent owes the pool that much", (await job(m2.jobId)).fromPool === dn.amountWei && (await deskAgent(agent.address!)).advancedNow === dn.amountWei);
  await sleep(2500);
  plan = (await agent.plan(m1.plan))!.plan;
  check("the plan's page counts it as next month early", plan.items[1]?.nextEarlyEth === Number(dn.amountWei) / 1e18 && plan.drawEarly?.open === false, JSON.stringify(plan.items[1]));

  step("5  each month accepted on its own; the pool is repaid out of month 2");
  await customer.accept(m1.jobId);
  await agent.deliver(m2.jobId, "This week in one page.", { show: true });
  const ab2 = await balance(agent.address!);
  await customer.accept(m2.jobId);
  check("month 2 pays the agent the rest: the price less the pool's advance and the job fee, to the wei", (await balance(agent.address!)) - ab2 === parseEther("0.002") - dn.amountWei - parseEther("0.00004"));
  check("the pool is repaid", (await deskAgent(agent.address!)).advancedNow === 0n && (await job(m2.jobId)).state === 4 && (await job(m1.jobId)).state === 4);

  step("6  the recurring income on the record: the plan's page, the agent's page, the record, the badge, the tool");
  await customer.waitFor(m2.jobId, ["settled"]);
  const rec = await customer.record("note-writer");
  check("the record: one plan running, one client, 0.002 ETH a month, two months delivered and settled", rec.plans?.active === 1 && rec.plans.clients === 1 && rec.plans.monthlyEth === "0.002" && rec.plans.monthsDelivered === 2 && rec.plans.monthsSettled === 2, JSON.stringify(rec.plans));
  const badge = await get(`/api/v1/badge/${agent.address}`);
  check("the badge counts the monthly client", badge.type.startsWith("image/svg+xml") && badge.text.includes("5 jobs settled · 1 monthly client"), badge.text.match(/aria-label="([^"]+)"/)?.[1]);
  const ap = words((await get("/agents/note-writer")).text);
  check("the agent's page shows its monthly clients", ap.includes("Monthly clients Recurring income, on the record.") && ap.includes("0.0020 ETH a month Plans running 1 Monthly clients 1 Months delivered 2"), ap.slice(ap.indexOf("Monthly clients"), ap.indexOf("Monthly clients") + 220));
  const pp = words((await get(`/plans/${m1.plan}`)).text);
  check("the plan's page: months 1 and 2 settled, the up-front and the next-month-early draws, month 3 ready to lock", pp.includes("Months delivered 2 of 3") && pp.includes("Month 1") && pp.includes("Up front 0.0010 ETH") && pp.includes("Next month early") && pp.includes("Ready to lock"), pp.slice(pp.indexOf("Months delivered"), pp.indexOf("Months delivered") + 300));
  const tool = await runTool(customer, "factor_plan", { plan: m1.plan }, null);
  check("the assistant's tool reads the plan", !tool.isError && tool.text.includes("Months locked 2 of 3, delivered 2, settled 2") && tool.text.includes("Month 3 can be locked now"), tool.text.split("\n").slice(0, 2).join(" | "));
  const recTool = await runTool(customer, "factor_record", { agent: "note-writer" }, null);
  check("the record tool says the monthly clients", recTool.text.includes("Monthly clients: 1 plan running for 1 client, 0.002 ETH a month; 2 months delivered, 2 settled."), recTool.text.split("\n").at(-2));

  step("7  stopping: month 3 locked ahead, the plan stopped, the agent declines month 3 and the customer has it all back");
  const m3 = await customer.payMonth(m1.plan);
  const cb3 = await balance(customer.address!);
  const stopped = await customer.stopPlan(m1.plan);
  check("the plan is stopped; month 3 is locked and not started", stopped.stopped && stopped.notStarted.join() === String(m3.jobId), JSON.stringify(stopped));
  check("no month can be locked after it", (await refused(customer.payMonth(m1.plan))).length > 0);
  const dc = await agent.decline(m3.jobId);
  check("the agent declines month 3, and the customer has the whole month back", (await balance(customer.address!)) - cb3 === parseEther("0.002") && (await job(m3.jobId)).state === 6, dc.hash);
  await customer.waitFor(m3.jobId, ["declined"]);
  plan = (await customer.plan(m1.plan))!.plan;
  check("the plan's page says it was stopped after 3 of 3 months were locked", plan.status === "stopped" && /stopped by the customer after 3 of 3 months/.test(plan.note ?? ""), plan.note);

  step("8  a plan with a firm, and a plan bought through a subscribe link");
  const member = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  await member.signUp({ name: "chart-maker", does: "Draws one clear chart from a table of figures" });
  await agent.formFirm({ name: "Monday Note", does: "A one-page market note every Monday", members: ["chart-maker"] });
  await member.joinFirm("monday-note");
  const f1 = await customer.subscribe({ firm: "monday-note", price: "0.003", months: 2, title: "The Monday note", brief: "One page every Monday, with a chart.", allowEarly: true });
  const fj = (await customer.job(f1.jobId))!.job;
  check("month 1 of the firm's plan is locked for its lead and filed under the firm", f1.linked && fj.firm?.slug === "monday-note" && fj.plan?.month === 1, JSON.stringify(fj.firm));
  check("the firm's page shows its monthly client", JSON.parse((await get("/api/v1/firms/monday-note")).text).plans?.active === 1);
  check("a member of the firm cannot be its monthly client", (await refused(member.subscribe({ firm: "monday-note", price: "0.003", months: 2, title: "Self" }))).includes("cannot hire itself"));
  const link = await agent.createPayLink({ price: "0.001", title: "A short note every month", months: 2, allowEarly: true });
  check("a subscribe link is signed with its months, and is not sold over x402", link.link.months === 2 && link.link.due === 720 && (await fetch(link.x402)).status === 409);
  check("it is not paid as a single deal", (await refused(customer.payLink(link.url))).includes("subscribe link"));
  const viaLink = await customer.subscribeLink(link.url);
  check("a plan bought through it is linked and marked as the link's", viaLink.linked && (await customer.plan(viaLink.plan))?.plan.via === "link", viaLink.note);
  const checkout = words((await get(`/pay/${link.token}`)).text);
  check("its checkout says it is a monthly plan", checkout.includes("Pay with Factor · a monthly plan") && checkout.includes("Each month, locked for the agent"), checkout.slice(0, 160));

  step("9  a month locked when its own month begins, a month later on the fork's clock, due at that month's end");
  const late = await customer.subscribe({ agent: "note-writer", price: "0.001", months: 2, title: "A slow note", allowEarly: false });
  const lj = await job(late.jobId);
  const start = Number(lj.dueAt) - MONTH_S;
  check("month 2 waits while month 1 is not delivered", (await refused(customer.payMonth(late.plan))).includes("not delivered yet"));
  await rpc("evm_setNextBlockTimestamp", [start + MONTH_S + 120]);
  await rpc("evm_mine", []);
  await agent.deliver(late.jobId, "The note, a little late in its month.");
  for (let i = 0; i < 20; i++) { const p = (await customer.plan(late.plan))!.plan; if (p.next?.open) break; await sleep(1500); }
  const ml = await customer.payMonth(late.plan);
  const mj = await job(ml.jobId);
  check("month 2 is locked in its own month, due at that month's end", ml.linked && Math.abs(Number(mj.dueAt) - (start + 2 * MONTH_S)) <= 3600, `${Number(mj.dueAt) - (start + 2 * MONTH_S)} s`);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  if (args.includes("--stay")) {
    console.log(`Left running: the site on ${SITE}, the engine on ${bare.api}, the fork on ${bare.rpc}.`);
    console.log(JSON.stringify({ site: SITE, rpc: bare.rpc, plan: m1.plan, firmPlan: f1.plan, linkPlan: viaLink.plan }));
  } else await stopAll();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  if (!args.includes("--stay")) await stopAll();
  process.exit(1);
});
