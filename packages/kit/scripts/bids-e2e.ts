// Offers, end to end, on a LOCAL fork of Robinhood Chain: the fork (read through the rehearsal's own go-between,
// engine/scripts/rehearsal-node.ts), the contracts deployed there by the engine's own script, the engine with
// OPENJOBS=on, AUTOAPPLY=on and BIDS=on and Factor's own agents at work (their model is the stand-in,
// scripts/stub-model.ts), and the site in front of it, all on 127.0.0.1. Nothing here reaches the real chain, and no
// model is called.
//
//   npm run bids-e2e            every check, then everything is stopped
//   npm run bids-e2e -- --stay  everything is left running (the site on 3800) for a look or for pictures
//   npm run bids-e2e -- --stop  stops what --stay left running
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  page-smith's owner (Factor's admin) signs its rules with its pricing for offers
//   2  an agent that runs itself signs its own, and starts its watch, pricing its offers from its own program
//   3  a customer posts a job open to offers, with a budget: page-smith offers on its own at its price with nothing on
//      its hands, the other agent offers from its own program, and a third agent offers by hand, then changes it
//   4  what an offer can never be: over the budget, under the agent's own lowest price, longer than the job gives
//   5  the customer compares the offers by score, price and speed, on the site and through the kit
//   6  the customer picks page-smith's offer: the price locks on the desk at the offer, not the budget, due the
//      offer's hours after the lock, with 1% of the offer to the burn; page-smith draws half of it and delivers on its
//      own, and the customer accepts
//   7  a second job: the other agent's program is picked at its own price, draws half of that and delivers
//   8  a withdrawn offer, a lock at another price that is never linked, and the owner's bids switch, which stops new
//      offers at once
//   9  the assistant's tools say it in words
//
// Keys: anvil's built-in test keys (inside the engine's script; the first is the admin wallet) and keys made up here for
// this run, funded on the fork only. No wallet of Factor's.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Factor, Refusal } from "../src/index.js";
import { runTool } from "../src/tools.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WEB = join(KIT, "..", "..", "web");
const PORTS = { site: 3800, anvil: 3801, engine: 3802, model: 3803, source: 3804 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-bids-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const LIVE_RPC = process.env.E2E_SOURCE_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ADMIN_API_KEY = "e2e-owner-key-of-this-local-run"; // the engine script's own, for this local run only
const E2E_ENV = { E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK, E2E_FORK_URL: `http://127.0.0.1:${PORTS.source}`, OPENJOBS: "on", AUTOAPPLY: "on", BIDS: "on", SUBJOBS: "on", FIRMS: "on", PLANS: "on", ENGINE_PULSE: "off", DESK_MIND: "off", ACTIVITY: "off", MATCH: "off" };
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
const milli = (n: number) => parseEther((n / 1000).toFixed(6));

async function main(): Promise<void> {
  if (args.includes("--stop")) { await stopAll(); console.log("stopped"); return; }
  mkdirSync(WORK, { recursive: true });
  step("0  the copy's source, the fork, the contracts, the engine with Factor's own agents and BIDS=on, and the site");
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
  const DESK = parseAbi([
    "function job(uint256) view returns ((address customer, uint40 dueAt, uint40 deliveredAt, uint8 state, bool allowEarly, bool late, address agent, uint256 price, uint256 early, uint256 fromPool, bytes32 proof))",
    "function lock(address to, uint256 dueAt, bool allowEarly) payable returns (uint256)",
    "event Locked(uint256 indexed id, address indexed customer, address indexed agent, uint256 price, uint256 dueAt, bool allowEarly)",
  ]);
  const job = (n: number) => chain.readContract({ address: bare.desk, abi: DESK, functionName: "job", args: [BigInt(n)] }) as Promise<{ customer: string; dueAt: number; state: number; price: bigint; agent: string; early: bigint; allowEarly: boolean }>;
  const lockedAt = async (tx: Hex) => Number((await chain.getBlock({ blockNumber: (await chain.getTransactionReceipt({ hash: tx })).blockNumber })).timestamp);
  const get = async (path: string) => { const r = await fetch(`${SITE}${path}`); return { status: r.status, text: (await r.text()).replace(/<!-- -->/g, "") }; };
  const words = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ").replace(/ ([,.])/g, "$1");
  const switchBids = (on: boolean) => fetch(`${bare.api}/v1/admin/switch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": ADMIN_API_KEY }, body: JSON.stringify({ what: "bids", on, ...(on ? {} : { note: "a look at offers" }) }) });
  const s0 = JSON.parse((await get("/api/v1/state")).text) as { openJobs?: { enabled: boolean; bids?: boolean }; agents: { name: string; address: string; house: boolean }[] };
  check("the site answers in front of the engine, and says offers are on", s0.openJobs?.enabled === true && s0.openJobs.bids === true, JSON.stringify(s0.openJobs));
  const PAGE = s0.agents.find((a) => a.name === "page-smith")!.address;

  step("1  page-smith's owner (Factor's admin) signs its rules with its pricing for offers");
  const keyOf = async (eth: string) => { const k = generatePrivateKey(); await fund(privateKeyToAccount(k).address, eth); return k; };
  const owner = await Factor.connect({ ...where, privateKey: bare.keys[0]! });
  const rules = await owner.setAutoApply({ agent: "page-smith", takes: ["Landing pages"], from: "0.003", atOnce: 3, hours: "always", early: true, pitch: "One page from your brief, delivered on its own", offers: { price: "0.005", whenFree: "0.004", dueInHours: 24 } });
  check("the rules carry its pricing: 0.005 ETH an offer, 0.004 ETH with nothing on its hands, delivered in 24 hours", rules.bid?.normalWei === milli(5).toString() && rules.bid.freeWei === milli(4).toString() && rules.bid.hours === 24);
  check("the words its owner signed say the pricing", ((await owner.autoApply("page-smith"))?.signed?.message ?? "").includes("offers: 0.005 ETH a job, 0.004 ETH with nothing on its hands, due 24 hours after the lock"));
  const agentPage = words((await get("/agents/page-smith")).text);
  check("page-smith's page shows its offers", agentPage.includes("Its offers 0.005 ETH, 0.004 ETH when free, in 24 hours"));

  step("2  an agent that runs itself signs its own rules, and starts its watch, pricing its offers from its own program");
  const self = await Factor.connect({ ...where, privateKey: await keyOf("1") });
  await self.signUp({ name: "crumb-writer", does: "Writes the words for a small shop's pages and menus" });
  await self.setAutoApply({ words: ["bakery", "menu"], from: "0.002", atOnce: 2, early: true, pitch: "Words for your shop, written the same day", offers: { price: "0.004", whenFree: "0.0035", dueInHours: 24 } });
  const pickedSelf: { jobId: number; drewEth: number }[] = [];
  const quotes: string[] = [];
  const watch = self.watchOpenJobs({
    everyMs: 3000,
    // its own program prices it: half a thousandth under what its rules make, in twelve hours, never under its lowest price
    price: (j, quote) => { quotes.push(`${j.title}: ${quote.priceWei}`); const p = quote.priceWei - parseEther("0.0005"); return { price: p < parseEther("0.002") ? parseEther("0.002") : p, dueInHours: Math.min(12, j.dueHours) }; },
    onPicked: async ({ jobId, brief, drewEth }) => { pickedSelf.push({ jobId, drewEth }); return `Menu copy for the job, written from the brief (${brief.length} characters), with ${drewEth} ETH drawn up front.`; },
    onError: (e) => console.log(`  (the watch said: ${e instanceof Error ? e.message : String(e)})`),
  });
  const hand = await Factor.connect({ ...where, privateKey: await keyOf("0.5") });
  await hand.signUp({ name: "proof-hand", does: "Builds and proofreads small pages by hand" });

  step("3  a customer posts a job open to offers: page-smith offers on its own, the other from its program, a third by hand");
  const customerKey = await keyOf("1");
  const customer = await Factor.connect({ ...where, privateKey: customerKey });
  const posted = await customer.postJob({ title: "A one-page site for our bakery", offers: true, budget: "0.006", brief: PAGE_BRIEF, dueInHours: 48, allowEarly: true, closesInHours: 6 });
  const first = (await customer.openJob(posted.id))!.open;
  check("the listing is open to offers, with its budget and no price of its own", first.offers === true && first.budgetWei === milli(6).toString() && first.priceWei === "0" && first.dueHours === 48);
  const two = await until("both to offer on their own", async () => { const p = (await customer.openJob(posted.id))!.open; return p.applicants.length >= 2 ? p : null; }, 90_000);
  const pageOffer = two?.applicants.find((a) => a.name === "page-smith");
  check("page-smith offered on its own: 0.004 ETH with nothing on its hands, in 24 hours", !!pageOffer?.auto && pageOffer.offer?.priceWei === milli(4).toString() && pageOffer.offer.dueHours === 24, JSON.stringify(pageOffer?.offer));
  const crumbOffer = two?.applicants.find((a) => a.name === "crumb-writer");
  check("crumb-writer's program priced its own offer from its rules: 0.003 ETH in 12 hours, on its own", !!crumbOffer?.auto && crumbOffer.offer?.priceWei === milli(3).toString() && crumbOffer.offer.dueHours === 12 && quotes[0]?.endsWith(milli(3.5).toString()), `${JSON.stringify(crumbOffer?.offer)} ${quotes[0]}`);
  const byHand = await hand.bid(posted.id, { price: "0.0045", dueInHours: 6, pitch: "Built and proofread by hand, the same morning" });
  check("proof-hand offered by hand: 0.0045 ETH in 6 hours", byHand.offer?.priceWei === milli(4.5).toString() && !byHand.replaced);
  await sleep(1500);
  const changed = await hand.bid(posted.id, { price: "0.0042", dueInHours: 6, pitch: "Built and proofread by hand, the same morning" });
  const after = await until("the change to show", async () => { const p = (await customer.openJob(posted.id))!.open; return p.applicants.find((a) => a.name === "proof-hand")?.offer?.changes === 1 ? p : null; }, 20_000);
  check("its newer offer replaced the first: one offer per agent, changed once", changed.replaced === true && after?.count === 3 && after.applicants.find((a) => a.name === "proof-hand")?.offer?.priceWei === milli(4.2).toString(), `replaced ${changed.replaced}, ${after?.count} offers, ${after?.applicants.find((a) => a.name === "proof-hand")?.offer?.priceWei}`);
  const logP = (await owner.autoApply("page-smith"))!.log.find((l) => l.open === posted.id && l.kind === "applied");
  check("page-smith's log says what it offered", logP?.note.startsWith("Offered 0.004 ETH, due 24 hours after the lock"), logP?.note);

  step("4  what an offer can never be");
  check("over the customer's budget", /budget is 0\.006 ETH/.test(await refused(hand.bid(posted.id, { price: "0.007", dueInHours: 6 }))));
  check("longer than the job gives", /from 1 to 48/.test(await refused(hand.bid(posted.id, { price: "0.004", dueInHours: 72 }))));
  check("under the agent's own lowest price, even by hand", /under the agent's own lowest price/.test(await refused(self.bid(posted.id, { price: "0.0015", dueInHours: 12 }))));
  const fixed = await customer.postJob({ title: "A landing page with its price", price: "0.004", brief: PAGE_BRIEF, closesInHours: 3 });
  check("and no offer on a job with a fixed price", /fixed price/.test(await refused(hand.bid(fixed.id, { price: "0.004", dueInHours: 6 }))));

  step("5  the customer compares the offers by score, price and speed");
  const byPrice = (await customer.offers(posted.id, "price")).map((a) => a.name).join(", ");
  const bySpeed = (await customer.offers(posted.id, "fast")).map((a) => a.name).join(", ");
  check("lowest price first: crumb-writer, page-smith, proof-hand", byPrice === "crumb-writer, page-smith, proof-hand", byPrice);
  check("fastest first: proof-hand, crumb-writer, page-smith", bySpeed === "proof-hand, crumb-writer, page-smith", bySpeed);
  const listingPage = words((await get(`/open-jobs/${posted.id}`)).text);
  check("the listing's page shows the offers side by side, with the sorting", listingPage.includes("Price, time and Factor Score, side by side.") && listingPage.includes("Sort the offers Best score Lowest price Fastest") && listingPage.includes("Offer 0.0040 ETH") && listingPage.includes("Delivered in 24 hours") && listingPage.includes("Offered on its own"));
  check("the board marks it open to offers with its budget", words((await get("/open-jobs")).text).includes("Budget up to 0.0060 ETH"));

  step("6  the customer picks page-smith's offer: locked at the offer, half drawn and delivered on its own, accepted");
  const hired = await customer.pickAgent(posted.id, { agent: "page-smith" });
  const onDesk = await job(hired.jobId);
  const at = await lockedAt(hired.lockTx);
  check("the price locked on the desk is page-smith's offer, 0.004 ETH, not the 0.006 budget", hired.linked && onDesk.price === milli(4) && hired.priceWei === milli(4) && onDesk.agent.toLowerCase() === PAGE, hired.note ?? "");
  check("due 24 hours after the lock, the offer's own time", Math.abs(Number(onDesk.dueAt) - at - 24 * 3600) <= 60, `${Number(onDesk.dueAt) - at} s`);
  check("1% of the offer went to the burn", hired.burned && hired.burnTx !== null);
  const done1 = await until("page-smith to deliver", async () => { const j = await job(hired.jobId); return j.state === 3 ? j : null; }, 180_000);
  check("page-smith drew half of its offer up front and delivered, on its own", done1?.early === milli(2), done1 ? `${done1.early} wei drawn` : "not delivered");
  const log2 = await until("the log to fill in", async () => { const l = (await owner.autoApply("page-smith"))!.log.filter((x) => x.open === posted.id).map((x) => x.kind).reverse(); return l.join() === "found,applied,picked,delivering,delivered" ? l : null; }, 30_000);
  check("page-smith's log: found, applied, picked, delivering, delivered", !!log2, log2?.join());
  await customer.accept(hired.jobId);
  await customer.waitFor(hired.jobId, ["settled"]);
  check("accepted: settled at its offer", ((await customer.job(hired.jobId))?.job.state ?? "") === "settled");
  const hiredPage = words((await get(`/open-jobs/${posted.id}`)).text);
  check("the listing says it was locked at the offer picked", hiredPage.includes("at 0.0040 ETH, the offer picked"));

  step("7  a second job: the other agent's program is picked at its own price, draws half of that and delivers");
  const menu = await customer.postJob({ title: "The words for our bakery's new menu", offers: true, brief: "Twelve items, two lines each, warm and short.", dueInHours: 24, allowEarly: true, closesInHours: 6 });
  const menuOffers = await until("crumb-writer to offer", async () => { const p = (await customer.openJob(menu.id))!.open; return p.applicants.length ? p : null; }, 60_000);
  const crumb2 = menuOffers?.applicants[0];
  check("only crumb-writer offers on the menu: page-smith's rules do not take it", menuOffers?.applicants.length === 1 && crumb2?.name === "crumb-writer" && !!crumb2.auto);
  const menuHire = await customer.pickAgent(menu.id, { by: "price" });
  const menuDone = await until("crumb-writer's program to deliver", async () => { const j = await job(menuHire.jobId); return j.state === 3 ? j : null; }, 90_000);
  const offered = BigInt(crumb2?.offer?.priceWei ?? "0");
  check("its program was told, drew half of its own offer up front and delivered", menuHire.priceWei === offered && menuDone?.early === offered / 2n && pickedSelf.some((p) => p.jobId === menuHire.jobId), `offer ${offered}, drawn ${menuDone?.early}`);
  watch.stop();
  await watch.done;

  step("8  a withdrawn offer, a lock at another price, and the owner's bids switch");
  // work neither agent's rules take, so only the agent that offers by hand is on it
  const third = await customer.postJob({ title: "Proofread the price list of our flower stall", offers: true, budget: "0.005", brief: "Forty lines, each a flower and its price. Check the spelling and that every price has its euro sign.", closesInHours: 3 });
  await hand.bid(third.id, { price: "0.004", dueInHours: 6 });
  check("proof-hand withdraws its offer", (await hand.withdrawOffer(third.id)).withdrawn && (await customer.openJob(third.id))!.open.count === 0);
  check("and it cannot be picked", /Nobody has applied yet|No offer is standing/.test(await refused(customer.pickAgent(third.id))));
  await hand.bid(third.id, { price: "0.0042", dueInHours: 6 });
  // a lock straight on the desk at the customer's budget, for that agent: an ordinary job, never linked to the listing
  const handAddr = hand.address! as Hex;
  const wallet = createWalletClient({ account: privateKeyToAccount(customerKey), transport: http(bare.rpc) });
  const head = Number((await chain.getBlock()).timestamp);
  const lockTx = await wallet.writeContract({ address: bare.desk, abi: DESK, functionName: "lock", args: [handAddr, BigInt(head + 6 * 3600), true], value: milli(5), chain: null });
  const receipt = await chain.waitForTransactionReceipt({ hash: lockTx });
  const strayJob = Number(BigInt(receipt.logs.find((l) => l.address.toLowerCase() === bare.desk.toLowerCase())!.topics[1]!));
  const link = await until("the engine to read the lock", async () => { const r = await fetch(`${SITE}/api/v1/openjobs/hire`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ open: third.id, job: strayJob, lockTx }) }); return r.status === 404 ? null : { status: r.status, body: (await r.json()) as { error?: string } }; }, 60_000);
  check("a lock at the budget instead of the offer is never linked to the listing", link?.status === 409 && /price or time is not proof-hand's offer/.test(link.body.error ?? ""), link?.body.error);
  check("it stands as an ordinary job of the customer's; the agent declines it and the customer has it all back", (await hand.decline(strayJob)) && (await job(strayJob)).state === 6 && (await customer.openJob(third.id))!.open.status === "open");
  const sw = await switchBids(false);
  check("the owner's switch stops offers at once", sw.ok && (await customer.state()).openJobs?.bids === false);
  check("no job is posted open to offers while it is stopped", /not switched on/.test(await refused(customer.postJob({ title: "Another job open to offers", offers: true }))));
  check("and no offer is made", /switched off/i.test(await refused(hand.bid(third.id, { price: "0.0041", dueInHours: 6 }))));
  check("an offer can still be withdrawn", (await hand.withdrawOffer(third.id)).withdrawn);
  await switchBids(true);
  check("turned back on, offers are made again", (await hand.bid(third.id, { price: "0.0041", dueInHours: 6 })).offer?.priceWei === milli(4.1).toString());

  step("9  the assistant's tools say it in words");
  const said = (await runTool(customer, "factor_offers", { open: third.id }, null)).text;
  check("factor_offers lists the offers side by side", said.startsWith("1. proof-hand: 0.0041 ETH, in 6 hours, Factor Score"), said.split("\n")[0]);
  const auto = (await runTool(customer, "factor_auto_apply", { agent: "page-smith" }, null)).text;
  check("factor_auto_apply says its pricing", auto.includes("offers 0.005 ETH, 0.004 ETH with nothing on its hands, delivered in 24 hours"));

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
