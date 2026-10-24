// Verified owners, end to end, on a LOCAL fork of Robinhood Chain: the fork (read through the rehearsal's own
// go-between, engine/scripts/rehearsal-node.ts), the contracts deployed there by the engine's own script, the engine with
// OPENJOBS=on, AUTOAPPLY=on, BIDS=on and VERIFIED=on, the stand-in for Human Passport and Talent Protocol
// (VERIFIED_FAKE=on: no request reaches either service), Factor's own agents on the stand-in model, and the site in
// front of it, all on 127.0.0.1. Nothing here reaches the real chain, and no model or outside service is called.
//
//   npm run verified-e2e            every check, then everything is stopped
//   npm run verified-e2e -- --stay  everything is left running (the site on 3820) for a look or for pictures
//   npm run verified-e2e -- --stop  stops what --stay left running
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  two agents that run themselves sign up: loaf-builder, whose owner's wallet passes, and quick-pages, whose does not
//   2  loaf-builder's owner verifies with one signature: the mark on its page, its record, its score and its badge;
//      quick-pages' owner is checked and does not pass, and its page says nothing of it; a wallet that does not run an
//      agent cannot verify it, and a signature is never taken twice
//   3  a customer posts a job open to offers for verified owners only: on the board's filter, marked on its page
//   4  loaf-builder's program offers on its own; quick-pages is refused; page-smith's auto-apply passes over it until
//      Factor's admin (its owner) verifies, then offers on its own
//   5  on a job for every agent, the offers say plainly whose owner is verified, and a customer can show only those
//   6  the customer compares and picks loaf-builder's offer: locked on the desk at the offer, delivered from its own
//      program, accepted and settled; the Factor Score shows the verified owner beside the number, which did not move
//   7  the owner's verified switch hides every mark and refuses the job's offers at once, and turned back, they return
//   8  the assistant's tools say it in words
//
// Keys: anvil's built-in test keys (inside the engine's script; the first is the admin wallet) and keys made up here for
// this run, funded on the fork only. No wallet of Factor's.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
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
const PORTS = { site: 3820, anvil: 3821, engine: 3822, model: 3823, source: 3824 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-verified-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ADMIN_API_KEY = "e2e-owner-key-of-this-local-run"; // the engine script's own, for this local run only
// anvil's first built-in key: the admin wallet in the engine's script, and so the owner of Factor's own agents
const ADMIN = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80").address.toLowerCase();
const args = process.argv.slice(2);
// the owners the stand-in passes: made before the engine starts, so it knows them
mkdirSync(WORK, { recursive: true });
const keysFile = join(WORK, "verified-keys.json");
const fresh = !args.includes("--stop");
const KEYS = fresh ? { loaf: generatePrivateKey(), quick: generatePrivateKey(), customer: generatePrivateKey() } : (JSON.parse(readFileSync(keysFile, "utf8")) as { loaf: Hex; quick: Hex; customer: Hex });
if (fresh) writeFileSync(keysFile, JSON.stringify(KEYS, null, 2), { mode: 0o600 });
const LOAF = privateKeyToAccount(KEYS.loaf).address.toLowerCase();
const E2E_ENV = { E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK, E2E_FORK_URL: `http://127.0.0.1:${PORTS.source}`, OPENJOBS: "on", AUTOAPPLY: "on", BIDS: "on", SUBJOBS: "on", FIRMS: "on", PLANS: "on", VERIFIED: "on", VERIFIED_FAKE: "on", VERIFIED_FAKE_PASS: `${LOAF},${ADMIN}`, ENGINE_PULSE: "off", DESK_MIND: "off", ACTIVITY: "off", MATCH: "off" };

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
const milli = (n: number) => parseEther((n / 1000).toFixed(6));

async function main(): Promise<void> {
  if (args.includes("--stop")) { await stopAll(); console.log("stopped"); return; }
  step("0  the copy's source, the fork, the contracts, the engine with VERIFIED=on and the stand-in, and the site");
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
  const job = (n: number) => chain.readContract({ address: bare.desk, abi: DESK, functionName: "job", args: [BigInt(n)] }) as Promise<{ customer: string; dueAt: number; state: number; price: bigint; agent: string; early: bigint }>;
  const get = async (path: string) => { const r = await fetch(`${SITE}${path}`); return { status: r.status, text: (await r.text()).replace(/<!-- -->/g, "") }; };
  const words = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ").replace(/ ([,.])/g, "$1");
  const switchVerified = (on: boolean) => fetch(`${bare.api}/v1/admin/switch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": ADMIN_API_KEY }, body: JSON.stringify({ what: "verified", on, ...(on ? {} : { note: "a look at the owner checks" }) }) });
  const s0 = JSON.parse((await get("/api/v1/state")).text) as { verified?: { enabled: boolean; checks: { name: string }[] }; agents: { name: string; address: string }[] };
  check("the site answers in front of the engine, and says owners are checked by both services", s0.verified?.enabled === true && s0.verified.checks.map((c) => c.name).join() === "Human Passport,Talent Protocol", JSON.stringify(s0.verified?.checks));
  check("the admin wallet of the engine's script is the one the stand-in passes", privateKeyToAccount(bare.keys[0]!).address.toLowerCase() === ADMIN);
  const PAGE = s0.agents.find((a) => a.name === "page-smith")!.address;

  step("1  two agents that run themselves sign up");
  for (const k of [KEYS.loaf, KEYS.quick, KEYS.customer]) await fund(privateKeyToAccount(k).address, "1");
  const loaf = await Factor.connect({ ...where, privateKey: KEYS.loaf });
  await loaf.signUp({ name: "loaf-builder", does: "Builds one calm page for a small shop, from its brief" });
  const quick = await Factor.connect({ ...where, privateKey: KEYS.quick });
  await quick.signUp({ name: "quick-pages", does: "Makes a landing page the same day" });
  const customer = await Factor.connect({ ...where, privateKey: KEYS.customer });
  check("both are on the desk", !!(await until("both to show", async () => (await customer.agent("loaf-builder")) && (await customer.agent("quick-pages")), 30_000)));
  check("before anybody verifies, no agent shows the mark", !words((await get("/agents")).text).includes("Verified owner"));

  step("2  the owners verify: one passes, one does not, and nothing negative is said of the other");
  const a = await loaf.verifyOwner();
  check("loaf-builder's owner signs once and Human Passport passes for its wallet", a.verified && a.owner === LOAF && a.checks.find((c) => c.name === "Human Passport")?.outcome === "pass" && a.checks.find((c) => c.name === "Human Passport")?.band === "20 to 29", JSON.stringify(a.checks));
  const b = await quick.verifyOwner();
  check("quick-pages' owner is checked and neither service passes", !b.verified && b.checks.every((c) => c.outcome === "fail"), JSON.stringify(b.checks));
  check("a wallet that does not run loaf-builder cannot verify it", /does not run this agent/.test(await refused(quick.verifyOwner({ agent: "loaf-builder" }))));
  check("one agent is checked once a minute at most", /a moment ago/.test(await refused(loaf.verifyOwner())));
  const loafPage = words((await get("/agents/loaf-builder")).text);
  check("loaf-builder's page shows Verified owner, how it is checked, and when", loafPage.includes("loaf-builder Verified owner") && loafPage.includes("How this is checked") && loafPage.includes("Human Passport (a real person holds the wallet)") && /Checked \d{1,2} [A-Z][a-z]{2} 2026/.test(loafPage));
  const quickPage = words((await get("/agents/quick-pages")).text);
  check("quick-pages' page says nothing of it, good or bad", !/Verified owner|not verified/i.test(quickPage.replace(/Do you run quick-pages\? Connect its wallet to verify the owner\./, "")));
  check("the list of agents marks loaf-builder alone", (words((await get("/agents")).text).match(/Verified owner/g) ?? []).length === 1);
  const rec = JSON.parse((await get("/api/v1/record/loaf-builder")).text) as { verifiedOwner?: { sources: string[] }; attestation?: { message: Record<string, unknown> } };
  check("its record carries the outcome, outside the attestation", rec.verifiedOwner?.sources?.[0] === "Human Passport" && !!rec.attestation && !("verifiedOwner" in rec.attestation.message));
  const badge = (await get(`/api/v1/badge/${LOAF}?show=owner`)).text;
  check("its badge says verified, with the day", /Owner: verified \d{1,2} [A-Z][a-z]{2} 2026/.test(badge), badge.match(/aria-label="([^"]+)"/)?.[1]);
  check("and the first badge says it after the jobs", (await get(`/api/v1/badge/${LOAF}`)).text.includes("verified owner"));
  const qBadge = (await get(`/api/v1/badge/${privateKeyToAccount(KEYS.quick).address.toLowerCase()}`)).text;
  check("quick-pages' badge is as it always was", !qBadge.includes("verified"));

  step("3  a customer posts a job open to offers, for verified owners only");
  const posted = await customer.postJob({ title: "A one-page site for our bakery", offers: true, budget: "0.006", brief: PAGE_BRIEF, dueInHours: 48, allowEarly: true, closesInHours: 6, verifiedOnly: true });
  const first = (await customer.openJob(posted.id))!.open;
  check("the listing is for verified owners only, and its customer signed it so", first.verifiedOnly === true && (first.signed?.message ?? "").includes("\nwho: verified owners only\n"));
  check("the board's filter shows it", (await customer.openJobs({ verifiedOnly: true })).map((j) => j.id).includes(posted.id) && words((await get("/open-jobs?verified=1")).text).includes("A one-page site for our bakery Verified owners only"));
  check("its page says who can offer", words((await get(`/open-jobs/${posted.id}`)).text).includes("Verified owners only: only agents whose owner passed Human Passport or Talent Protocol can make an offer."));

  step("4  loaf-builder's program offers on its own, quick-pages is refused, page-smith waits for its owner");
  await loaf.setAutoApply({ takes: ["Landing pages"], words: ["bakery"], from: "0.003", atOnce: 2, early: true, pitch: "One calm page for your shop, from your brief", offers: { price: "0.0048", whenFree: "0.0045", dueInHours: 24 } });
  const pickedLoaf: number[] = [];
  const watch = loaf.watchOpenJobs({ everyMs: 3000, onPicked: async ({ jobId, brief }) => { pickedLoaf.push(jobId); return `<!doctype html><html><head><title>Our bakery</title></head><body><h1>Our bakery</h1><p>${brief.slice(0, 120)}</p></body></html>`; }, onError: (e) => console.log(`  (the watch said: ${e instanceof Error ? e.message : String(e)})`) });
  const owner = await Factor.connect({ ...where, privateKey: bare.keys[0]! });
  await owner.setAutoApply({ agent: "page-smith", takes: ["Landing pages"], from: "0.003", atOnce: 3, hours: "always", early: true, pitch: "One page from your brief, delivered on its own", offers: { price: "0.005", whenFree: "0.004", dueInHours: 24 } });
  const one = await until("loaf-builder to offer", async () => { const p = (await customer.openJob(posted.id))!.open; return p.applicants.some((x) => x.name === "loaf-builder") ? p : null; }, 90_000);
  const loafOffer = one?.applicants.find((x) => x.name === "loaf-builder");
  check("loaf-builder offered on its own, 0.0045 ETH with nothing on its hands, marked as verified", !!loafOffer?.auto && loafOffer.offer?.priceWei === milli(4.5).toString() && loafOffer.verifiedOwner === true, JSON.stringify(loafOffer?.offer));
  check("quick-pages cannot make an offer on it", /only agents whose owner is verified/.test(await refused(quick.bid(posted.id, { price: "0.004", dueInHours: 6 }))));
  await sleep(12_000);
  const p2 = (await customer.openJob(posted.id))!.open;
  check("page-smith's auto-apply passed over it: its owner is not verified", !p2.applicants.some((x) => x.name === "page-smith"), p2.applicants.map((x) => x.name).join());
  const pv = await owner.verifyOwner({ agent: "page-smith" });
  check("Factor's admin, page-smith's owner, verifies it with one signature", pv.verified && pv.owner === ADMIN);
  const two = await until("page-smith to offer", async () => { const p = (await customer.openJob(posted.id))!.open; return p.applicants.some((x) => x.name === "page-smith") ? p : null; }, 90_000);
  check("then page-smith offers on its own, marked as verified", !!two?.applicants.find((x) => x.name === "page-smith" && x.auto && x.verifiedOwner === true));

  step("5  on a job for every agent, the offers say plainly whose owner is verified");
  const open = await customer.postJob({ title: "A landing page for our flower stall", offers: true, budget: "0.006", brief: "Our stall, the flowers of the week and our hours, on one page.", dueInHours: 48, closesInHours: 6 });
  await quick.bid(open.id, { price: "0.0042", dueInHours: 12, pitch: "Ready the same day" });
  const both = await until("page-smith to offer there too", async () => { const p = (await customer.openJob(open.id))!.open; return p.applicants.length >= 2 ? p : null; }, 90_000);
  check("quick-pages offered, and the offers carry each owner's outcome", both?.applicants.find((x) => x.name === "quick-pages")?.verifiedOwner === false && both?.applicants.find((x) => x.name === "page-smith")?.verifiedOwner === true);
  const openPage = words((await get(`/open-jobs/${open.id}`)).text);
  check("the listing says Owner not verified beside quick-pages, plainly, and has the switch to show verified owners only", openPage.includes("quick-pages Owner not verified") && openPage.includes("Verified owners only") && /Verified owners only \d of \d/.test(openPage));
  const filtered = (await runTool(customer, "factor_offers", { open: open.id, verified_only: true }, null)).text;
  check("an assistant shows only the offers of verified owners", !filtered.includes("quick-pages") && filtered.includes("page-smith") && filtered.includes("verified owner"), filtered);

  step("6  the customer compares and picks loaf-builder's offer: locked at it, delivered, accepted");
  const compared = await customer.offers(posted.id, "price");
  check("every offer on the job is from a verified owner", compared.length >= 2 && compared.every((x) => x.verifiedOwner === true), compared.map((x) => `${x.name} ${x.offer?.priceEth}`).join(", "));
  const scoreBefore = (await customer.agent("loaf-builder"))!.agent.score;
  const hired = await customer.pickAgent(posted.id, { agent: "loaf-builder" });
  const onDesk = await job(hired.jobId);
  check("the price locked on the desk is loaf-builder's offer, 0.0045 ETH", hired.linked && onDesk.price === milli(4.5) && onDesk.agent.toLowerCase() === LOAF, hired.note ?? "");
  const done = await until("loaf-builder's program to deliver", async () => { const j = await job(hired.jobId); return j.state === 3 ? j : null; }, 120_000);
  check("its program was told it was picked, drew half and delivered", !!done && pickedLoaf.includes(hired.jobId) && done.early === milli(4.5) / 2n, done ? `${done.early} wei drawn` : "not delivered");
  await customer.accept(hired.jobId);
  await customer.waitFor(hired.jobId, ["settled"]);
  check("accepted: settled at the offer", ((await customer.job(hired.jobId))?.job.state ?? "") === "settled");
  watch.stop();
  await watch.done;
  const after = (await customer.agent("loaf-builder"))!;
  const fs = after.factorScore as unknown as { score: number; verifiedOwner?: { sources: string[] } | null };
  check("its Factor Score shows the verified owner beside the number, which is the desk's own", fs.verifiedOwner?.sources[0] === "Human Passport" && fs.score === after.agent.score && after.agent.score >= scoreBefore);
  check("the score page says it is a trust factor that moves nothing", words((await get("/agents/loaf-builder")).text).includes("A trust factor, not a part") );

  step("7  the owner's verified switch, and back");
  const vjob = await customer.postJob({ title: "A second page for our bakery", offers: true, budget: "0.006", brief: PAGE_BRIEF, closesInHours: 6, verifiedOnly: true });
  check("switched off", (await switchVerified(false)).ok && (await customer.state()).verified?.enabled === false);
  check("every mark is gone at once", !words((await get("/agents")).text).includes("Verified owner") && !words((await get("/agents/loaf-builder")).text).includes("Verified owner"));
  check("no job for verified owners only can be posted", /not switched on/.test(await refused(customer.postJob({ title: "Another page for verified owners", offers: true, verifiedOnly: true }))));
  check("and one posted before takes nobody, a verified owner included", /only agents whose owner is verified/.test(await refused(loaf.bid(vjob.id, { price: "0.0045", dueInHours: 24 }))));
  check("turned back on, the marks return and the job takes loaf-builder's offer", (await switchVerified(true)).ok && words((await get("/agents")).text).includes("Verified owner") && (await loaf.bid(vjob.id, { price: "0.0045", dueInHours: 24 })).rank >= 1);

  step("8  the assistant's tools say it in words");
  const said = (await runTool(customer, "factor_verified_owner", { agent: "loaf-builder" }, null)).text;
  check("factor_verified_owner says who passed, and when", said.startsWith("The owner of loaf-builder is verified: Human Passport passed"), said);
  const not = (await runTool(customer, "factor_verified_owner", { agent: "quick-pages" }, null)).text;
  check("and for one that is not, where its owner verifies", not.includes("is not verified") && not.includes("/agents/quick-pages#verified"), not);
  check("the board through an assistant marks the job", (await runTool(customer, "factor_open_jobs", { verified_only: true, show: "all" }, null)).text.includes("(verified owners only)"));
  void PAGE;

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  if (args.includes("--stay")) {
    console.log(`Left running: the site on ${SITE}, the engine on ${bare.api}, the fork on ${bare.rpc}. Keys in ${keysFile}.`);
  } else await stopAll();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  if (!args.includes("--stay")) await stopAll();
  process.exit(1);
});
