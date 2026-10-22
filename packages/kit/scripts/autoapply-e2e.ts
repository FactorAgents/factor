// Auto-apply, end to end, on a LOCAL fork of Robinhood Chain: the fork (read through the rehearsal's own go-between,
// engine/scripts/rehearsal-node.ts), the contracts deployed there by the engine's own script, the engine with
// OPENJOBS=on and AUTOAPPLY=on and Factor's own agents at work (their model is the stand-in, scripts/stub-model.ts), and
// the site in front of it, all on 127.0.0.1. Nothing here reaches the real chain, and no model is called.
//
//   npm run autoapply-e2e            every check, then everything is stopped
//   npm run autoapply-e2e -- --stay  everything is left running (the site on 3790) for a look or for pictures
//   npm run autoapply-e2e -- --stop  stops what --stay left running
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  the owner (Factor's admin) sets page-smith's rules once; nobody else can
//   2  an agent that runs itself sets its own rules and starts its watch, with its own key
//   3  a customer posts an open job: page-smith finds it and applies on its own, and so does the other agent
//   4  the customer picks page-smith: half drawn up front, the work done and delivered on its own, then accepted
//   5  a job only the other agent's rules take: its own program applies, is picked, draws half and delivers
//   6  what the rules refuse: the owner's own job, under the price, and the owner's switch, which stops it at once
//   7  the assistant's tool says it in words
//
// Keys: anvil's built-in test keys (inside the engine's script; the first is the admin wallet) and keys made up here for
// this run, funded on the fork only. No wallet of Factor's.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Factor, Refusal } from "../src/index.js";
import { runTool } from "../src/tools.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WEB = join(KIT, "..", "..", "web");
const PORTS = { site: 3790, anvil: 3791, engine: 3792, model: 3793, source: 3794 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-autoapply-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ADMIN_API_KEY = "e2e-owner-key-of-this-local-run"; // the engine script's own, for this local run only
const E2E_ENV = { E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK, E2E_FORK_URL: `http://127.0.0.1:${PORTS.source}`, OPENJOBS: "on", AUTOAPPLY: "on", SUBJOBS: "on", FIRMS: "on", PLANS: "on", ENGINE_PULSE: "off", DESK_MIND: "off", ACTIVITY: "off", MATCH: "off" };
const args = process.argv.slice(2);

const step = (title: string) => console.log(`\n== ${title}`);
const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: unknown, detail = ""): void {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
const refused = async (p: Promise<unknown>): Promise<string> => { try { await p; return ""; } catch (e) { return e instanceof Refusal ? e.message : `NOT A REFUSAL: ${(e as Error).message}`; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T | null> => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } if (Date.now() - t0 > ms) { console.log(`  (gave up waiting for ${what})`); return null; } await sleep(1000); } };
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

const PAGE_BRIEF = "Our hours (seven to noon), the menu of the day and where to find us, on one calm page. Plain words, a warm colour.";

async function main(): Promise<void> {
  if (args.includes("--stop")) { await stopAll(); console.log("stopped"); return; }
  mkdirSync(WORK, { recursive: true });
  step("0  the copy's source, the fork, the contracts, the engine with Factor's own agents and AUTOAPPLY=on, and the site");
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
  const DESK = parseAbi(["function job(uint256) view returns ((address customer, uint40 dueAt, uint40 deliveredAt, uint8 state, bool allowEarly, bool late, address agent, uint256 price, uint256 early, uint256 fromPool, bytes32 proof))"]);
  const job = (n: number) => chain.readContract({ address: bare.desk, abi: DESK, functionName: "job", args: [BigInt(n)] }) as Promise<{ customer: string; state: number; price: bigint; agent: string; early: bigint; allowEarly: boolean }>;
  const get = async (path: string) => { const r = await fetch(`${SITE}${path}`); return { status: r.status, text: (await r.text()).replace(/<!-- -->/g, "") }; };
  const words = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ").replace(/ ([,.])/g, "$1");
  const s0 = JSON.parse((await get("/api/v1/state")).text) as { autoApply?: { enabled: boolean; perAgentHour: number }; agents: { name: string; address: string; house: boolean }[] };
  check("the site answers in front of the engine, and says auto-apply is on", s0.autoApply?.enabled === true && s0.autoApply.perAgentHour === 6, JSON.stringify(s0.autoApply));
  const PAGE = s0.agents.find((a) => a.name === "page-smith")!.address;
  check("page-smith is on the desk, one of Factor's own", !!PAGE && s0.agents.find((a) => a.name === "page-smith")!.house);

  step("1  the owner (Factor's admin) sets page-smith's rules once; nobody else can");
  const keyOf = async (eth: string) => { const k = generatePrivateKey(); await fund(privateKeyToAccount(k).address, eth); return k; };
  const owner = await Factor.connect({ ...where, privateKey: bare.keys[0]! });
  const stranger = await Factor.connect({ ...where, privateKey: await keyOf("0.1") });
  check("a wallet that does not run page-smith cannot set its rules", /only the agent itself/i.test(await refused(stranger.setAutoApply({ agent: "page-smith", takes: ["Landing pages"] }))));
  const before = await owner.autoApply("page-smith");
  check("page-smith is run by Factor and set by Factor's admin, with no rules yet", before?.runBy === "factor" && before.setters[0] === owner.address && before.rules === null, JSON.stringify(before?.setters));
  const rules = await owner.setAutoApply({ agent: "page-smith", takes: ["Landing pages"], from: "0.003", atOnce: 3, hours: "always", early: true, pitch: "One page from your brief, delivered on its own" });
  check("the rules are signed and kept: landing pages, from 0.003 ETH, up to 3 at a time, always on, half up front", rules.on && rules.takes.join() === "Landing pages" && rules.floorWei === parseEther("0.003").toString() && rules.atOnce === 3 && rules.early);
  const agentPage = words((await get("/agents/page-smith")).text);
  check("page-smith's page shows the rules and says it finds its own work", agentPage.includes("It finds its own work") && agentPage.includes("Takes Landing pages From 0.003 ETH a job At a time Up to 3 jobs Hours Always on Half up front When the customer allows it"));

  step("2  an agent that runs itself sets its own rules and starts its watch, with its own key");
  const self = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  await self.signUp({ name: "crumb-writer", does: "Writes the words for a small shop's pages and menus" });
  await self.setAutoApply({ words: ["bakery", "menu"], from: "0.002", atOnce: 2, early: true, pitch: "Words for your shop, written the same day" });
  const pickedSelf: number[] = [];
  const watch = self.watchOpenJobs({ everyMs: 3000, onPicked: async ({ jobId, brief, drewEth }) => { pickedSelf.push(jobId); return `Menu copy for the job, written from the brief (${brief.length} characters), with ${drewEth} ETH drawn up front.`; }, onError: (e) => console.log(`  (the watch said: ${e instanceof Error ? e.message : String(e)})`) });

  step("3  a customer posts an open job: page-smith finds it and applies on its own, and so does the other agent");
  const customer = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  const posted = await customer.postJob({ title: "A one-page site for our bakery", price: "0.004", brief: PAGE_BRIEF, dueInHours: 24, allowEarly: true, closesInHours: 6 });
  const applied = await until("both to apply on their own", async () => { const p = (await customer.openJob(posted.id))!.open; return p.applicants.length >= 2 ? p : null; }, 90_000);
  const pageApp = applied?.applicants.find((a) => a.name === "page-smith");
  check("page-smith applied on its own, with the line from its rules, marked on the listing", !!pageApp?.auto && pageApp.pitch === "One page from your brief, delivered on its own", JSON.stringify(pageApp));
  check("crumb-writer's own program applied on its own too, with its own key", !!applied?.applicants.find((a) => a.name === "crumb-writer")?.auto);
  const log1 = (await owner.autoApply("page-smith"))!.log.map((l) => l.kind).reverse();
  check("page-smith's log: found, applied", log1.join() === "found,applied", log1.join());
  check("the listing page says it applied on its own", words((await get(`/open-jobs/${posted.id}`)).text).includes("Applied on its own"));

  step("4  the customer picks page-smith: half drawn up front, the work done and delivered on its own, then accepted");
  const hired = await customer.pickAgent(posted.id, { agent: "page-smith" });
  check("the price is locked for page-smith as an ordinary job, linked to the listing", hired.linked && hired.agent === PAGE, hired.note ?? "");
  const delivered = await until("page-smith to deliver", async () => { const j = await job(hired.jobId); return j.state === 3 ? j : null; }, 180_000);
  check("page-smith drew half up front and delivered, in one order, on its own", delivered?.early === parseEther("0.002"), delivered ? `${delivered.early} wei drawn` : "not delivered");
  const jp = await until("the work on the job's page", async () => { const p = await customer.job(hired.jobId); return p?.work?.text ? p : null; }, 60_000);
  check("the work is on the job's page", !!jp?.work?.text && jp.work.text.length > 40);
  const log2 = await until("the log to fill in", async () => { const l = (await owner.autoApply("page-smith"))!.log.filter((x) => x.open === posted.id).map((x) => x.kind).reverse(); return l.join() === "found,applied,picked,delivering,delivered" ? l : null; }, 30_000);
  check("page-smith's log: found, applied, picked, delivering, delivered", !!log2, log2?.join());
  await customer.accept(hired.jobId);
  await customer.waitFor(hired.jobId, ["settled"]);
  check("accepted: it counts on page-smith's record like any job", ((await customer.agent("page-smith"))?.agent.settled ?? 0) >= 1);
  const pageAfter = words((await get("/agents/page-smith")).text);
  check("page-smith's page shows its log and the job marked as found on its own", pageAfter.includes("What it did on its own") && pageAfter.includes("Delivered job") && pageAfter.includes("On its own"));

  step("5  a job only the other agent's rules take: its own program applies, is picked, draws half and delivers");
  const menu = await customer.postJob({ title: "The words for our bakery's new menu", price: "0.003", brief: "Twelve items, two lines each, warm and short.", dueInHours: 24, allowEarly: true, closesInHours: 6 });
  const menuApplied = await until("crumb-writer to apply", async () => { const p = (await customer.openJob(menu.id))!.open; return p.applicants.length ? p : null; }, 60_000);
  check("only crumb-writer applies: page-smith's rules do not take menu copy", menuApplied?.applicants.length === 1 && menuApplied.applicants[0]!.name === "crumb-writer" && !!menuApplied.applicants[0]!.auto);
  const menuHire = await customer.pickAgent(menu.id);
  const menuDone = await until("crumb-writer's program to deliver", async () => { const j = await job(menuHire.jobId); return j.state === 3 ? j : null; }, 90_000);
  check("its program was told it was picked, drew half up front, and delivered what it wrote", pickedSelf.includes(menuHire.jobId) && menuDone?.early === parseEther("0.0015"), `picked ${pickedSelf.join(",")}`);
  const selfLog = await until("its log to fill in", async () => { const l = (await self.autoApply())!.log.filter((x) => x.open === menu.id).map((x) => x.kind).reverse(); return l.join() === "found,applied,picked,delivering,delivered" ? l : null; }, 30_000);
  check("its log, followed from the desk: found, applied, picked, delivering, delivered", !!selfLog, selfLog?.join());
  watch.stop();
  await watch.done;

  step("6  what the rules refuse: the owner's own job, under the price, and the owner's switch");
  await fund(owner.address!, "1");
  const own = await owner.postJob({ title: "A landing page for Factor's own launch", price: "0.004", brief: PAGE_BRIEF, closesInHours: 3 });
  const cheap = await customer.postJob({ title: "A tiny landing page", price: "0.002", brief: PAGE_BRIEF, closesInHours: 3 });
  await sleep(6000);
  check("page-smith never applies to a job its own owner posted", (await customer.openJob(own.id))!.open.applicants.length === 0);
  check("nor to one under the lowest price its rules take", !(await customer.openJob(cheap.id))!.open.applicants.some((a) => a.name === "page-smith"));
  const sw = await fetch(`${bare.api}/v1/admin/switch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": ADMIN_API_KEY }, body: JSON.stringify({ what: "autoapply", on: false, note: "a look" }) });
  check("the owner's switch stops it at once", sw.ok && (await customer.state()).autoApply?.enabled === false);
  const held = await customer.postJob({ title: "A landing page for a flower shop", price: "0.005", brief: PAGE_BRIEF, closesInHours: 3 });
  await sleep(6000);
  check("while it is stopped nobody applies on its own", (await customer.openJob(held.id))!.open.applicants.length === 0);
  await fetch(`${bare.api}/v1/admin/switch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": ADMIN_API_KEY }, body: JSON.stringify({ what: "autoapply", on: true }) });
  const back = await until("page-smith to apply again", async () => (await customer.openJob(held.id))!.open.applicants.find((a) => a.name === "page-smith"), 30_000);
  check("turned back on, it applies again", !!back?.auto);

  step("7  the assistant's tool says it in words");
  const said = (await runTool(customer, "factor_auto_apply", { agent: "page-smith" }, null)).text;
  check("factor_auto_apply says the rules and the log", said.includes("auto-apply is on") && said.includes("Rules: takes Landing pages") && said.includes("delivered:"), said.split("\n")[0]);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  if (args.includes("--stay")) {
    console.log(`Left running: the site on ${SITE}, the engine on ${bare.api}, the fork on ${bare.rpc}.`);
  } else await stopAll();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  if (!args.includes("--stay")) await stopAll();
  process.exit(1);
});
