// Agent firms, end to end, on a LOCAL fork of Robinhood Chain: the fork (read through the rehearsal's own go-between,
// scripts/rehearsal-node.ts), the contracts deployed there by the engine's own script, the engine with FIRMS=on and
// SUBJOBS=on and Factor's own agents running on a stand-in for the model, and the site in front of it, all on
// 127.0.0.1. Nothing here reaches the real chain, and no model is called.
//
//   npm run firms-e2e            every check, then everything is stopped
//   npm run firms-e2e -- --stay  everything is left running (the site on 3760) for a look or for pictures
//   npm run firms-e2e -- --stop  stops what --stay left running
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  three agents from outside sign up; one forms a firm and invites the other two, who sign to join
//   2  a customer hires the firm: the price is locked for its lead and the job is filed under the firm
//   3  the lead draws half early and hires both members for their parts; the rules, live
//   4  the members deliver and are paid; the lead delivers and the customer accepts. Every wei where it should be
//   5  the firm's shared record and its attestation, each member's part, the badge, the pages
//   6  a firm hired through a Pay with Factor link its lead signed for it
//   7  Factor's own firm, The Research Desk: a customer hires it, its lead splits the job among its members by itself,
//      and delivers the whole
//
// Keys: anvil's built-in test keys (inside the engine's script) and keys made up here for this run, funded on the fork
// only. No wallet of Factor's, and not the demonstration customer's.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, parseEther, verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Factor, Refusal, type FirmPage, type JobTree } from "../src/index.js";
import { runTool } from "../src/tools.js";
import { firmRecordTypedData } from "../../../engine/src/firms.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WEB = join(KIT, "..", "..", "web");
const PORTS = { site: 3760, anvil: 3761, engine: 3762, model: 3763, source: 3764 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-firms-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const E2E_ENV = { E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK, E2E_FORK_URL: `http://127.0.0.1:${PORTS.source}`, SUBJOBS: "on", FIRMS: "on", ENGINE_PULSE: "off", DESK_MIND: "off", ACTIVITY: "off", MATCH: "off" };
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
  step("0  the copy's source, the fork, the contracts, the engine with FIRMS=on and Factor's own agents, and the site");
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
  const DESK = parseAbi(["function job(uint256) view returns ((address customer, uint40 dueAt, uint40 deliveredAt, uint8 state, bool allowEarly, bool late, address agent, uint256 price, uint256 early, uint256 fromPool, bytes32 proof))"]);
  const job = (n: number) => chain.readContract({ address: bare.desk, abi: DESK, functionName: "job", args: [BigInt(n)] }) as Promise<{ customer: string; state: number; price: bigint; early: bigint; agent: string; dueAt: number }>;
  const get = async (path: string) => { const r = await fetch(`${SITE}${path}`); return { status: r.status, text: (await r.text()).replace(/<!-- -->/g, ""), type: r.headers.get("content-type") ?? "" }; };
  const words = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").replace(/ ([,.])/g, "$1");
  const tree = async (n: number) => JSON.parse((await get(`/api/v1/jobs/${n}/tree`)).text) as JobTree & { firm?: { slug: string } };
  const s0 = JSON.parse((await get("/api/v1/state")).text) as { firms?: { enabled: boolean; items: { slug: string }[] } };
  check("the site answers in front of the engine, and says firms are on", s0.firms?.enabled === true, JSON.stringify(s0.firms?.items.map((f) => f.slug)));

  step("1  three agents sign up; one forms a firm and invites the other two, who sign to join");
  const keyOf = async (eth: string) => { const k = generatePrivateKey(); await fund(privateKeyToAccount(k).address, eth); return k; };
  const lead = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  const checker = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  const charts = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  await lead.signUp({ name: "note-lead", does: "Writes short market notes, every figure checked" });
  await checker.signUp({ name: "figure-check", does: "Checks each figure in a text against its source" });
  await charts.signUp({ name: "chart-hand", does: "Draws one clear chart from a table of figures" });
  const formed = await lead.formFirm({ name: "Weekly Note Co", does: "A one-page market note each week, every figure checked", members: ["figure-check", "chart-hand"] });
  check("the firm is formed, its two members invited", formed.slug === "weekly-note-co" && formed.invited.length === 2 && !formed.edited, JSON.stringify(formed));
  let page = (await lead.firm("weekly-note-co"))!;
  check("until they sign, they are only invited", page.firm.members.map((m) => m.role).join() === "lead,invited,invited");
  await checker.joinFirm("weekly-note-co");
  await charts.joinFirm("weekly-note-co");
  page = (await lead.firm("weekly-note-co"))!;
  check("both signed to join: the firm is its lead and two members", page.firm.members.map((m) => `${m.name}:${m.role}`).join() === "note-lead:lead,figure-check:member,chart-hand:member");
  const stranger = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  check("an agent the lead did not invite cannot join", (await refused(stranger.joinFirm("weekly-note-co"))).includes("invited"));
  check("a firm cannot pass for Factor", (await refused(checker.formFirm({ name: "Factor Notes", does: "Notes", members: ["chart-hand"] }))).includes("Factor"));

  step("2  a customer hires the firm: the price is locked for its lead, and the job is the firm's");
  const customer = await Factor.connect({ ...where, privateKey: await keyOf("2") });
  const hired = await customer.hireFirm("weekly-note-co", { price: "0.003", title: "This week in one page", brief: "What moved this week, in plain words, every figure checked, with one chart.", dueInHours: 48, allowEarly: true });
  const P = hired.jobId;
  const locked = await job(P);
  check("the job is locked for the lead at 0.003 ETH, early allowed", locked.agent.toLowerCase() === lead.address && locked.customer.toLowerCase() === customer.address && locked.price === parseEther("0.003") && locked.state === 1);
  check("and filed under the firm, with its title and brief", hired.filed && (await lead.job(P))?.job.firm?.slug === "weekly-note-co" && (await lead.job(P))?.brief?.startsWith("What moved this week") === true, hired.note ?? "");
  const self = await checker.hireFirm("weekly-note-co", { price: "0.001", title: "Hire myself" });
  check("a member cannot hire its own firm: the money is locked for the lead as an ordinary job, and it is not the firm's", !self.filed && /cannot hire itself/.test(self.note ?? ""), self.note);

  step("3  the lead draws half early and hires both members for their parts");
  const can = await lead.canDraw(P);
  await lead.draw(P, can.early, "early");
  const a = await lead.hireForJob(P, "figure-check", "0.001", "Check every figure in the note against its source.", { title: "Check every figure", dueInHours: 24 });
  const b = await lead.hireForJob(P, "chart-hand", "0.001", "One chart of the week's moves from the table in the note.", { title: "One chart of the week", dueInHours: 24 });
  check("both parts are locked from the lead's wallet and linked under the firm's job", a.linked && b.linked && (await job(a.jobId)).customer.toLowerCase() === lead.address && (await job(b.jobId)).customer.toLowerCase() === lead.address, `${a.note ?? ""} ${b.note ?? ""}`);
  check("over what is left of the job's price is refused", (await refused(lead.hireForJob(P, "figure-check", "0.002", "More."))).includes("left"));

  step("4  the members deliver and are paid; the lead delivers and the customer accepts");
  const cb = await balance(checker.address!), hb = await balance(charts.address!);
  const d1 = await checker.deliver(a.jobId, "Checked 9 figures. 8 hold. The weekly volume is 41.2 million, not 42.1 million.", { show: true });
  const d2 = await charts.deliver(b.jobId, "A bar chart of the five moves, largest first, with the source under it.", { show: true });
  await lead.accept(a.jobId);
  await lead.accept(b.jobId);
  const g1 = await chain.getTransactionReceipt({ hash: d1.hash }), g2 = await chain.getTransactionReceipt({ hash: d2.hash });
  check("each member is paid its price less the job fee, to the wei", (await balance(checker.address!)) - cb + g1.gasUsed * g1.effectiveGasPrice === parseEther("0.00098") && (await balance(charts.address!)) - hb + g2.gasUsed * g2.effectiveGasPrice === parseEther("0.00098"));
  await lead.deliver(P, "This week in one page, every figure checked by figure-check, the chart by chart-hand.", { show: true });
  const lb = await balance(lead.address!);
  await customer.accept(P);
  check("the lead is paid the rest of the firm's job, less the job fee, to the wei", (await balance(lead.address!)) - lb === parseEther("0.003") / 2n - parseEther("0.003") * 2n / 100n);
  check("the desk says all three settled", (await job(P)).state === 4 && (await job(a.jobId)).state === 4 && (await job(b.jobId)).state === 4);

  step("5  the firm's shared record, its attestation, each member's part, the badge and the pages");
  await lead.waitFor(P, ["settled"]);
  await lead.waitFor(a.jobId, ["settled"]);
  await lead.waitFor(b.jobId, ["settled"]);
  const rec = await customer.firmRecord("weekly-note-co");
  check("the record: one job hired and settled, two parts to members, 0.003 ETH of settled work, one customer", rec.jobs.hired === 1 && rec.jobs.settled === 1 && rec.subJobs.count === 2 && rec.subJobs.toMembers === 2 && rec.settledEth === "0.003" && rec.customers === 1, JSON.stringify({ jobs: rec.jobs, subJobs: rec.subJobs }));
  check("each one's part", rec.members.map((m) => `${m.name}:${m.jobs}/${m.settled}`).join() === "note-lead:1/1,figure-check:1/1,chart-hand:1/1");
  const typed = firmRecordTypedData(rec.chainId, rec.desk, rec.attestation!.message as never);
  check("Factor's attestation of it checks out with the typed data", !!rec.attestation && (await verifyTypedData({ ...typed, address: rec.attestation.signer as Hex, signature: rec.attestation.signature } as never)));
  const t = await tree(P);
  check("the tree: the firm's job and its two parts, all in the firm, all checked on the chain", t.firm?.slug === "weekly-note-co" && t.nodes.length === 3 && t.nodes.every((n) => (n as { inFirm?: boolean }).inFirm && n.verified === true && n.state === "settled"));
  const firmPage = words((await get("/firms/weekly-note-co")).text);
  check("the firm's page shows its members and their parts, and its work", firmPage.includes("Weekly Note Co") && firmPage.includes("figure-check Member") && firmPage.includes("Who hired whom, job by job") && firmPage.includes("Jobs hired 1 Settled 1"), firmPage.slice(0, 200));
  const badge = await get("/api/v1/firms/weekly-note-co/badge");
  check("the badge says one job settled", badge.type.startsWith("image/svg+xml") && badge.text.includes("1 job settled"));
  check("the agents page lists the firm", words((await get("/agents")).text).includes("Weekly Note Co"));
  check("the job's page says the firm was hired", words((await get(`/jobs/${String(P).padStart(4, "0")}`)).text).includes("Hired: Weekly Note Co"));
  const tool = await runTool(customer, "factor_firm_record", { firm: "weekly-note-co" }, null);
  check("the assistant's tool reads the record", !tool.isError && tool.text.includes("2 to members"), tool.text.split("\n")[2]);

  step("6  a firm hired through a link its lead signed for it");
  const link = await lead.createPayLink({ price: "0.002", title: "A one-page note on one company", dueInHours: 48, allowEarly: true, firm: "weekly-note-co" });
  check("a member cannot make a link for the firm", (await refused(checker.createPayLink({ price: "0.002", title: "Not mine", firm: "weekly-note-co" }))).includes("Only the lead"));
  const checkout = words((await get(`/pay/${link.token}`)).text);
  check("the checkout names the firm", checkout.includes("From the firm Weekly Note Co, through its lead note-lead"));
  const deal = await customer.payLink(link.url, { maxEth: "0.00202" });
  await sleep(1500);
  check("the deal is the firm's", (await customer.job(deal.jobId))?.job.firm?.slug === "weekly-note-co");
  const page2 = (await customer.firm("weekly-note-co"))! as FirmPage;
  check("the firm's page shows the lead's link for the firm", page2.links.some((l) => l.firm === "weekly-note-co"));

  step("7  Factor's own firm: a customer hires The Research Desk, and its lead splits the job by itself");
  const house = (await customer.firms()).find((f) => f.house);
  check("The Research Desk stands, plain-reader leading data-shaper, faq-smith and red-pen", house?.slug === "the-research-desk" && house.members.filter((m) => m.role === "member").map((m) => m.name).join() === "data-shaper,faq-smith,red-pen", JSON.stringify(house?.members.map((m) => m.name)));
  const material = `Quarterly results for the corner shop.\nJanuary: sales 1200, costs 800.\nFebruary: sales 1350, costs 900.\nMarch: sales 1500, costs 1250.\n${"What do these figures say about the quarter, what would a lender ask, and are costs under control? ".repeat(6).trim()}`;
  const R = (await customer.hireFirm("the-research-desk", { price: "0.01", title: "What the quarter says", brief: material, dueInHours: 48, allowEarly: true })).jobId;
  const done = await customer.waitFor(R, ["delivered"], { timeoutMs: 600_000, pollMs: 3000 }).catch(() => null);
  // the work is shown a moment after the delivery is read from the chain
  let rpage = await customer.job(R);
  for (let i = 0; i < 40 && !rpage?.work; i++) { await sleep(1500); rpage = await customer.job(R); }
  const rt = await tree(R);
  const kids = rt.nodes.filter((n) => n.parent === R);
  check("its lead delivered the whole", !!done, rpage?.job.state);
  const nameOf = new Map(house!.members.map((m) => [m.address, m.name]));
  check("it hired data-shaper, faq-smith and red-pen, each its own job, each accepted", kids.map((n) => `${nameOf.get(n.agent)}:${n.state}`).join() === "data-shaper:settled,faq-smith:settled,red-pen:settled", JSON.stringify(kids.map((n) => [n.job, nameOf.get(n.agent), n.state])));
  const work = rpage?.work?.text ?? "";
  check("the work carries the figures, the questions, and who did each part", work.includes("THE FIGURES") && work.includes("QUESTIONS AND ANSWERS") && /The Research Desk, Factor's own firm: read by plain-reader, figures by data-shaper \(job \d{4}\), questions by faq-smith \(job \d{4}\), proofread by red-pen \(job \d{4}\)/.test(work), work.slice(-200));
  await customer.accept(R);
  await customer.waitFor(R, ["settled"]);
  const hr = (await customer.firm("the-research-desk"))!;
  check("its record counts the job and its three parts", hr.record.jobs.settled === 1 && hr.record.subJobs.count === 3 && hr.record.subJobs.toMembers === 3, JSON.stringify(hr.record.subJobs));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  if (args.includes("--stay")) {
    console.log(`Left running: the site on ${SITE}, the engine on ${bare.api}, the fork on ${bare.rpc}.`);
    console.log(JSON.stringify({ site: SITE, rpc: bare.rpc, P, A: a.jobId, B: b.jobId, R, firm: "weekly-note-co" }));
  } else await stopAll();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  if (!args.includes("--stay")) await stopAll();
  process.exit(1);
});
