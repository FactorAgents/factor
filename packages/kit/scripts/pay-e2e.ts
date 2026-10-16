// Pay with Factor, end to end, on a LOCAL fork of Robinhood Chain: the fork, the contracts deployed there by the
// engine's own script, the engine, and the site in front of it, all on 127.0.0.1. Nothing here reaches the real
// chain, and nothing calls a model (the engine's stand-in answers).
//
//   npm run pay-e2e            every check, then everything is stopped
//   npm run pay-e2e -- --stay  everything is left running (the site on 3720) for a look or for pictures
//   npm run pay-e2e -- --stop  stops what --stay left running
//
// What it does, through the kit pointed at the SITE (so the site's own doors are part of it):
//   1  an agent from outside, with a brand new key, signs up in one step and makes a signed payment link
//   2  a buyer pays the link: the lock and the deal's burn, both checked on the chain by the engine
//   3  the agent draws half early, delivers, the buyer accepts: every wei where it should be
//   4  a second deal the buyer rejects: half back, to the wei
//   5  another agent's program buys over x402: a 402, the lock, the proof, the job's number
//   6  a buyer with no wallet (a Factor account, gas paid by the engine) pays in one order
//   7  a link somebody changed, and one that expired, are refused politely, by the site and the API
//   8  the agent's record: the figures the desk holds, open to other sites, with an attestation that checks out;
//      the badge; and the assistant's tools reading both
//
// Keys: anvil's built-in test keys (inside the engine's script) and keys made up here, funded on the fork only.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, parseEther, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodePayLink, Factor, payLinkMessage, readPayLink, Refusal, type AgentRecord, type PayLink } from "../src/index.js";
import { runTool } from "../src/tools.js";

const KIT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(KIT, "..", "..", "engine");
const WEB = join(KIT, "..", "..", "web");
const PORTS = { site: 3720, anvil: 3721, engine: 3722, model: 3723 };
const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-pay-e2e");
const SITE = `http://127.0.0.1:${PORTS.site}`;
const E2E_ENV = { E2E_ANVIL_PORT: String(PORTS.anvil), E2E_ENGINE_PORT: String(PORTS.engine), E2E_MODEL_PORT: String(PORTS.model), E2E_WORK: WORK };
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
};

async function main(): Promise<void> {
  if (args.includes("--stop")) { await stopAll(); console.log("stopped"); return; }
  mkdirSync(WORK, { recursive: true });
  step("0  the fork, the contracts, the engine and a traded token (the engine's own script), and the site in front of it");
  await stopPort(PORTS.site);
  const bareRun = spawnSync("npm", ["run", "e2e", "--", "--bare"], { cwd: ENGINE, encoding: "utf8", timeout: 900_000, env: { ...process.env, ...E2E_ENV } });
  if (bareRun.status !== 0) throw new Error(`the engine's script failed:\n${(bareRun.stdout + bareRun.stderr).split("\n").slice(-30).join("\n")}`);
  const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8")) as { rpc: string; api: string; desk: Hex; burnPot: Hex; keys: Hex[] };
  const siteLog = openSync(join(WORK, "site.log"), "a");
  spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORTS.site)], { cwd: WEB, stdio: ["ignore", siteLog, siteLog], detached: true, env: { ...process.env, FACTOR_ENGINE_URL: bare.api, FACTOR_SAMPLE: "", FACTOR_STATE_SHARE_MS: "0" } }).unref();
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${SITE}/api/v1/state`)).ok) break; } catch { /* starting */ } await sleep(500); }
  const where = { api: `${SITE}/api/v1`, rpcUrl: bare.rpc };
  const chain = createPublicClient({ transport: http(bare.rpc) });
  const rpc = async (method: string, params: unknown[]) => (await (await fetch(bare.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: unknown };
  const fund = async (address: string, eth: string) => { await rpc("anvil_setBalance", [address, `0x${parseEther(eth).toString(16)}`]); };
  const balance = (a: string) => chain.getBalance({ address: a as Hex });
  const gasOf = async (hash: Hex) => { const r = await chain.getTransactionReceipt({ hash }); return r.gasUsed * r.effectiveGasPrice; };
  const DESK = parseAbi(["function job(uint256) view returns ((address customer, uint40 dueAt, uint40 deliveredAt, uint8 state, bool allowEarly, bool late, address agent, uint256 price, uint256 early, uint256 fromPool, bytes32 proof))", "function score(address) view returns (uint256)"]);
  const job = (n: number) => chain.readContract({ address: bare.desk, abi: DESK, functionName: "job", args: [BigInt(n)] }) as Promise<{ customer: string; state: number; price: bigint; early: bigint; agent: string; allowEarly: boolean; dueAt: number }>;
  const get = async (path: string, headers: Record<string, string> = {}) => { const r = await fetch(`${SITE}${path}`, { headers }); return { status: r.status, text: await r.text(), headers: r.headers }; };
  check("the site answers in front of the engine", (await get("/api/v1/state")).status === 200);

  step("1  an agent from outside signs up in one step and makes a signed link");
  const agentKey = generatePrivateKey();
  await fund(privateKeyToAccount(agentKey).address, "1");
  const agent = await Factor.connect({ ...where, privateKey: agentKey });
  const up = await agent.signUp({ name: "lumen-pay", does: "Summarises long documents and contracts" });
  check("one call registers the wallet and names it", up.registered && (await agent.me())?.agent.name === "lumen-pay");
  await sleep(1100); // a profile is signed with the second it was signed in, and a newer one must carry a later one
  check("signing up again only renames it, and sends nothing", !(await agent.signUp({ name: "lumen-pay", does: "Summarises long documents and contracts" })).registered);
  const made = await agent.createPayLink({ price: "0.02", title: "Summarise one contract", brief: "Send the contract after paying. You get every date and every amount.", dueInHours: 24, allowEarly: true });
  check("the link is signed by the agent and shown on its page", made.published && made.url === `${SITE}/pay/${made.token}` && made.link.agent === agent.address);
  const shown = JSON.parse((await get(`/api/v1/pay/links/${agent.address}`)).text) as { items: { url: string }[] };
  check("the agent's page lists it", shown.items.length === 1 && shown.items[0]!.url.endsWith(made.token));
  const checkout = await get(`/pay/${made.token}`);
  check("the checkout shows the agent, the price, the burn and what happens on delivery or rejection", checkout.status === 200 && checkout.text.includes("Summarise one contract") && checkout.text.includes("lumen-pay") && checkout.text.includes("0.0200 ETH") && checkout.text.includes("0.0002 ETH") && checkout.text.includes("You reject the delivery"));

  step("2  a buyer pays the link: the lock and the deal's burn, both checked on the chain");
  const buyerKey = generatePrivateKey();
  await fund(privateKeyToAccount(buyerKey).address, "2");
  const buyer = await Factor.connect({ ...where, privateKey: buyerKey });
  check("a link over the buyer's cap is refused before anything is sent", (await refused(buyer.payLink(made.url, { maxEth: "0.02" }))).includes("over the 0.02 ETH allowed"));
  const potBefore = await balance(bare.burnPot);
  const deal = await buyer.payLink(made.url, { maxEth: "0.05" });
  const locked = await job(deal.jobId);
  check("the desk holds the job for the agent at the link's price, early allowed, due in 24 hours", locked.customer.toLowerCase() === buyer.address && locked.agent.toLowerCase() === agent.address && locked.price === parseEther("0.02") && locked.allowEarly && locked.state === 1);
  const burnTx = await chain.getTransaction({ hash: deal.burnTx! });
  check("the buyer sent the deal's share to the burn pot, and Factor counted it", deal.burned && burnTx.to?.toLowerCase() === bare.burnPot.toLowerCase() && burnTx.value === parseEther("0.0002"), `pot ${potBefore} -> ${await balance(bare.burnPot)}`);
  const page1 = await buyer.waitFor(deal.jobId, ["locked"]);
  check("the job carries the link's title and says it was paid with Factor", page1.title === "Summarise one contract" && (page1 as unknown as { deal?: { via: string; burnEth: number } }).deal?.burnEth === 0.0002);

  step("3  the agent draws half early, delivers, the buyer accepts");
  const can = await agent.canDraw(deal.jobId);
  check("half of the payment can be drawn early", can.early === "0.01");
  const agentBefore = await balance(agent.address!);
  const drew = await agent.draw(deal.jobId, can.early, "early");
  check("the agent has half, less the 1% fee, at once", (await balance(agent.address!)) - agentBefore + (await gasOf(drew.hash)) === parseEther("0.0099"));
  await agent.deliver(deal.jobId, "Dates: 1 March, 30 June. Amounts: 12,000 and 4,500.");
  const beforeAccept = await balance(agent.address!);
  await buyer.accept(deal.jobId);
  check("accepted: the rest, less the 2% job fee, to the wei", (await balance(agent.address!)) - beforeAccept === parseEther("0.0096"));
  check("the desk says settled", (await job(deal.jobId)).state === 4);

  step("4  a second deal the buyer rejects: half back");
  const second = await buyer.payLink(made.url, { maxEth: "0.05" });
  await agent.deliver(second.jobId, "Not what was asked for.");
  const buyerBefore = await balance(buyer.address!);
  const rej = await buyer.reject(second.jobId);
  check("rejected: half of the price is back with the buyer, to the wei", (await balance(buyer.address!)) - buyerBefore + (await gasOf(rej.hash)) === parseEther("0.01"));
  check("the desk says settled at half", (await job(second.jobId)).state === 5);

  step("5  another agent's program buys over x402");
  const raw = await get(`/api/v1/x402/${made.token}`);
  const offer = (JSON.parse(raw.text) as { accepts: { scheme: string; payTo: string; maxAmountRequired: string }[] }).accepts?.[0];
  check("the address answers 402 with what to pay: the desk, the price and the burn", raw.status === 402 && offer?.scheme === "factor-lock" && offer.payTo.toLowerCase() === bare.desk.toLowerCase() && offer.maxAmountRequired === parseEther("0.0202").toString() && raw.headers.get("access-control-allow-origin") === "*");
  const botKey = generatePrivateKey();
  await fund(privateKeyToAccount(botKey).address, "1");
  const bot = await Factor.connect({ ...where, privateKey: botKey });
  const viaX = await bot.payX402(made.x402, { maxEth: "0.03" });
  check("the program pays and gets the job's number, with the settlement header", viaX.jobId > second.jobId && viaX.response.job === viaX.jobId && viaX.burned);
  const replay = await get(`/api/v1/x402/${made.token}`, { "x-payment": Buffer.from(JSON.stringify({ x402Version: 1, scheme: "factor-lock", network: "robinhood-chain", payload: { job: viaX.jobId, lockTx: viaX.lockTx, burnTx: viaX.burnTx } })).toString("base64") });
  check("the same proof again answers the same job (a retry is safe) with X-PAYMENT-RESPONSE", replay.status === 200 && JSON.parse(Buffer.from(replay.headers.get("x-payment-response") ?? "", "base64").toString() || "{}").job === viaX.jobId);
  const otherJob = await get(`/api/v1/x402/${made.token}`, { "x-payment": Buffer.from(JSON.stringify({ x402Version: 1, scheme: "factor-lock", network: "robinhood-chain", payload: { job: deal.jobId, lockTx: viaX.lockTx } })).toString("base64") });
  check("a proof that names another job is refused with a new 402", otherJob.status === 402);
  await agent.deliver(viaX.jobId, "The summary, for a program.");
  await bot.accept(viaX.jobId);
  const xJob = await bot.waitFor(viaX.jobId, ["settled"]);
  check("delivered and settled on the desk, and marked as paid over x402", xJob.state === "settled" && (xJob as unknown as { deal?: { via: string } }).deal?.via === "x402");

  step("6  a buyer with no wallet pays in one order, gas paid by the engine");
  const keyOnly = generatePrivateKey();
  const gasless = await Factor.connect({ ...where, privateKey: keyOnly, gasless: true });
  await fund(gasless.address!, "0.5");
  const viaAccount = await gasless.payLink(made.url, { maxEth: "0.05" });
  check("the lock and the burn are one transaction, and Factor counted the burn", viaAccount.lockTx === viaAccount.burnTx && viaAccount.burned && (await job(viaAccount.jobId)).customer.toLowerCase() === gasless.address);
  check("the key itself holds nothing and paid nothing", (await balance(privateKeyToAccount(keyOnly).address)) === 0n);

  step("7  a changed link and an expired one are refused politely");
  const facts = readPayLink(made.token)!;
  const cheaper = encodePayLink({ ...facts.link, price: parseEther("0.001").toString() }, facts.signature);
  const changedPage = await get(`/pay/${cheaper}`);
  check("the checkout of a changed link says it cannot be paid, and why", changedPage.status === 200 && changedPage.text.includes("This link cannot be paid.") && changedPage.text.includes("changed after its agent signed it"));
  check("the kit refuses to pay it", (await refused(buyer.payLink(cheaper))).includes("changed after its agent signed it"));
  const head = Number((await chain.getBlock()).timestamp);
  const old: PayLink = { ...made.link, exp: head - 60, id: "00000000000000aa" };
  const expired = encodePayLink(old, await privateKeyToAccount(agentKey).signMessage({ message: payLinkMessage(old) }));
  const expiredPage = await get(`/pay/${expired}`);
  check("an expired link says when it expired and to ask for a new one", expiredPage.text.includes("This link has expired.") && expiredPage.text.includes("Ask the agent for a new one"));
  check("over x402 too", (await get(`/api/v1/x402/${expired}`)).status === 410);

  step("8  the record, open to other sites, and its attestation");
  await sleep(3000);
  const recRes = await get(`/api/v1/record/lumen-pay`, { origin: "https://another-marketplace.example" });
  const rec = JSON.parse(recRes.text) as AgentRecord;
  const onChain = Number(await chain.readContract({ address: bare.desk, abi: DESK, functionName: "score", args: [agent.address as Hex] }));
  check("the record: delivered, on time, settled, settled at half, volume, deals and the burn", rec.jobs.delivered === 3 && rec.jobs.settled === 2 && rec.jobs.settledAtHalf === 1 && rec.jobs.onTime === 2 && rec.jobs.open === 1 && rec.volumeEth === "0.04" && rec.payWithFactor.deals === 4 && rec.payWithFactor.burnedEth === "0.0008", JSON.stringify(rec.jobs));
  check("its score is the desk's own", rec.score === onChain, `${rec.score} / ${onChain}`);
  check("any site may read it (CORS)", recRes.headers.get("access-control-allow-origin") === "*");
  const signer = await agent.recordSigner();
  const verified = await agent.verifyRecord(rec, signer!);
  check("the attestation is signed by the key Factor publishes", !!signer && verified.ok && rec.attestation?.signer === signer, verified.why);
  const forged = { ...rec, attestation: { ...rec.attestation!, message: { ...rec.attestation!.message, settledAtHalf: 0 } } };
  check("one figure changed, it no longer checks out", !(await agent.verifyRecord(forged, signer!)).ok);
  const badge = await get(`/api/v1/badge/${agent.address}`);
  check("the badge is an image any site can show, with the live count", badge.status === 200 && /image\/svg\+xml/.test(badge.headers.get("content-type") ?? "") && badge.text.includes("2 jobs settled"));
  const tool = await runTool(agent, "factor_record", { agent: "lumen-pay" }, null);
  check("the assistant's tool reads the record and confirms Factor signed it", !tool.isError && tool.text.includes("signed by Factor") && tool.text.includes("Paid with Factor: 4 deals"));
  const info = await runTool(buyer, "factor_pay_link_info", { link: made.url }, null);
  check("and reads what a link sells", !info.isError && info.text.includes('"Summarise one contract" from lumen-pay: 0.02 ETH, plus 0.0002 ETH that buys and burns $FACTOR'));
  const agentPage = await get(`/agents/lumen-pay`);
  check("the agent's public page has its link, its deals and its badge", agentPage.text.includes("Pay with Factor") && agentPage.text.includes(`/api/v1/badge/${agent.address}`) && agentPage.text.includes("Summarise one contract"));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  if (args.includes("--stay")) {
    console.log(`Left running: the site on ${SITE}, the engine on ${bare.api}, the fork on ${bare.rpc}. Link: ${made.url}`);
    console.log(JSON.stringify({ site: SITE, link: made.token, agent: agent.address, agentName: "lumen-pay", unregistered: privateKeyToAccount(generatePrivateKey()).address }));
  } else await stopAll();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  if (!args.includes("--stay")) await stopAll();
  process.exit(1);
});
