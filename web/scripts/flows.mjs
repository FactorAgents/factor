// The site, used the way a visitor uses it, against the real contracts: a real browser, real clicks, a wallet, and
// a local fork of Robinhood Chain behind it all. Nothing here can reach the real chain.
//
//   npm run flows            the whole run and every check, then everything is stopped (about four minutes)
//   npm run flows -- --stay  the fork, the engine and the site are left running, to look at: http://127.0.0.1:3620
//   npm run flows -- --stop  stops what --stay left running
//
// What it does:
//   1  has the engine's own script start the fork, deploy the three contracts, start the engine and launch and
//      trade the token, so there is a pool (engine/scripts/e2e.ts --bare);
//   2  serves the built site against that engine, with its real content policy on;
//   3  opens the site in headless Chrome with a wallet in the page. The wallet is the plain kind every wallet is
//      (window.ethereum): it hands each request out of the page to this script, which answers for one of anvil's
//      built-in test accounts. The page's own scripts talk to the site only, as on the real one;
//   4  an agent registers, names itself and posts a bond; a customer hires it; the agent draws from the pool and
//      early, and delivers; the customer accepts. A second job is rejected and a third declined. On a fourth the
//      agent draws as compute, signs for its key on the page, and a program calls a model with the key through the
//      site (behind the engine is a stand-in for the model maker: no model is called, nothing is spent);
//   5b with no wallet at all: the visitor makes an account with a passkey (Chrome's own test authenticator stands
//      in for the fingerprint reader), puts ETH in it, hires an agent, takes ETH out, adds a second key, signs out
//      and back in. The engine pays the gas of all of it;
//   5  checks what the pages say against what the desk holds, what the site says when a wallet says no or the desk
//      would refuse, what happens with no wallet on a computer and on a phone, and that the pages fit a phone.
//
// Keys: only anvil's built-in test keys, which anvil prints for anybody. They hold nothing on any real chain.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ENGINE = join(WEB, "..", "engine");
const WORK = join(tmpdir(), "factor-e2e");
const SITE_PORT = 3620, CHROME_PORT = 9987;
// by name, not by number: a passkey belongs to a site's name, and a browser makes none for a bare address
const SITE = `http://localhost:${SITE_PORT}`;
const SHOTS = join(WEB, "..", "docs", "shots", "flows");
const args = process.argv.slice(2);
const STAY = args.includes("--stay");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (title) => console.log(`\n== ${title}`);
const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
function pidsOn(port) {
  return spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.split("\n").map((s) => s.trim()).filter(Boolean).map(Number);
}
async function stopPort(port) {
  for (const pid of pidsOn(port)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  for (let i = 0; i < 60 && pidsOn(port).length; i++) await sleep(100);
  for (const pid of pidsOn(port)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}
async function stopAll() {
  await stopPort(CHROME_PORT);
  await stopPort(SITE_PORT);
  spawnSync("npm", ["run", "e2e", "--", "--stop"], { cwd: ENGINE, encoding: "utf8" });
}

if (args.includes("--stop")) { await stopAll(); console.log("stopped"); process.exit(0); }

// ---------- 1 and 2: the chain, the engine, the site ----------

step("1  the fork, the contracts, the engine and a traded token (the engine's own script)");
await stopPort(CHROME_PORT);
await stopPort(SITE_PORT);
const bareRun = spawnSync("npm", ["run", "e2e", "--", "--bare"], { cwd: ENGINE, encoding: "utf8", timeout: 600_000 });
if (bareRun.status !== 0) { console.error(bareRun.stdout.split("\n").slice(-25).join("\n"), bareRun.stderr); process.exit(1); }
const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8"));
console.log(`  desk ${bare.desk}, engine ${bare.api}`);
const accounts = bare.keys.map((k) => privateKeyToAccount(k));
const AGENT = accounts[3], CUSTOMER = accounts[4];
const chain = createPublicClient({ transport: http(bare.rpc) });
const DESK = parseAbi([
  "function job(uint256) view returns ((address customer, uint40 dueAt, uint40 deliveredAt, uint8 state, bool allowEarly, bool late, address agent, uint256 price, uint256 early, uint256 fromPool, bytes32 proof))",
  "function agent(address) view returns ((bool registered, bool barred, uint40 firstSettledAt, uint32 settled, uint32 settledAtHalf, uint32 notDelivered, uint32 unanswered, uint32 customers, uint32 onTime, uint32 late, uint32 advancesRepaid, uint32 advancesNotRepaid, uint32 earlyKept, uint256 bond, uint256 feesPaid, uint256 advancedNow, uint256 volume))",
  "function pool() view returns (uint256)", "function held() view returns (uint256)", "function bonds() view returns (uint256)", "function owedTotal() view returns (uint256)",
]);
const desk = (functionName, a = []) => chain.readContract({ address: bare.desk, abi: DESK, functionName, args: a });
async function anvil(method, params = []) {
  const r = await fetch(bare.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json();
}

step("2  the built site, served against that engine with its content policy on");
const siteLog = [];
const site = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(SITE_PORT)], { cwd: WEB, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, FACTOR_ENGINE_URL: bare.api, FACTOR_SAMPLE: "" } });
site.stdout.on("data", (d) => siteLog.push(String(d)));
site.stderr.on("data", (d) => siteLog.push(String(d)));
site.unref();
for (let i = 0; i < 100; i++) { try { if ((await fetch(SITE + "/api/v1/state")).ok) break; } catch { /* not up yet */ } await sleep(200); }
const first = await (await fetch(SITE + "/api/v1/state")).json();
check("the site reads the engine: launched, the desk's address, a pool", first.launched && first.contracts.desk?.toLowerCase() === bare.desk.toLowerCase() && first.stats.poolEth > 0, `${first.stats.poolEth} ETH`);
const home = await fetch(SITE + "/");
const homeHtml = await home.clone().text();
check("the buy button leads to the token's own page on Pons without anybody having set it", new RegExp(`href="https://ponsfamily\\.com/launchpad/${bare.token}"[^>]*>BUY ON PONS`, "i").test(homeHtml), first.links.pons);
check("the site is served with its content policy: this site only", /default-src 'self'/.test(home.headers.get("content-security-policy") ?? "") && /connect-src 'self'/.test(home.headers.get("content-security-policy") ?? ""));

// ---------- 3: a browser with a wallet in the page ----------

step("3  headless Chrome, with a wallet in the page");
mkdirSync(SHOTS, { recursive: true });
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${CHROME_PORT}`, "--no-first-run", "--hide-scrollbars", `--user-data-dir=${join(WORK, `chrome-${Date.now()}`)}`, "about:blank"], { stdio: "ignore", detached: true });
chrome.unref();
let target;
for (let i = 0; i < 100 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json`)).json()).find((t) => t.type === "page"); } catch { await sleep(150); } }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const waiting = new Map();
const problems = [];   // anything the page itself complained of
const opened = [];     // windows the page asked to open
const requested = [];  // every address the page asked the network for
const send = (method, params = {}) => new Promise((r) => { const n = ++seq; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });

// The wallet's side of the bridge: which account it is, and whether its owner will say no to the next thing.
const wallet = { account: null, shared: false, declineNext: false, present: true, sent: 0, signed: 0 };
async function answer({ method, params }) {
  const me = wallet.account;
  if (method === "eth_chainId") return "0x1237";
  if (method === "eth_accounts") return wallet.shared ? [me.address] : [];
  if (method === "eth_requestAccounts") { wallet.shared = true; return [me.address]; }
  if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
  if (method === "eth_sendTransaction" || method === "personal_sign") {
    if (wallet.declineNext) { wallet.declineNext = false; throw { code: 4001, message: "User rejected the request." }; }
  }
  if (method === "personal_sign") {
    if (params[1].toLowerCase() !== me.address.toLowerCase()) throw { code: 4100, message: "not this wallet's account" };
    wallet.signed++;
    return me.signMessage({ message: { raw: params[0] } });
  }
  if (method === "eth_sendTransaction" && params[0].from.toLowerCase() !== me.address.toLowerCase()) throw { code: 4100, message: "not this wallet's account" };
  if (method === "eth_getCode" && wallet.noDesk) return "0x";
  if (["eth_sendTransaction", "eth_call", "eth_getTransactionReceipt", "eth_estimateGas", "eth_blockNumber", "eth_getCode"].includes(method)) {
    const r = await anvil(method, method === "eth_sendTransaction" ? [{ ...params[0], gas: "0x7a120" }] : params);
    if (r.error) throw r.error;
    if (method === "eth_sendTransaction") wallet.sent++;
    return r.result;
  }
  throw { code: 4200, message: `the test wallet does not do ${method}` };
}
ws.addEventListener("message", (m) => {
  const x = JSON.parse(m.data);
  if (x.id && waiting.has(x.id)) { waiting.get(x.id)(x); waiting.delete(x.id); return; }
  if (x.method === "Runtime.bindingCalled" && x.params.name === "__factorWalletBridge") {
    const req = JSON.parse(x.params.payload);
    answer(req).then((result) => [null, result], (err) => [{ code: err.code ?? -32000, message: err.message ?? "failed", data: err.data }, null])
      .then(([err, result]) => send("Runtime.evaluate", { expression: `window.__factorWalletDone(${req.id}, ${JSON.stringify(err)}, ${JSON.stringify(result ?? null)})` }));
  }
  if (x.method === "Runtime.exceptionThrown") problems.push(String(x.params.exceptionDetails?.exception?.description ?? x.params.exceptionDetails?.text).slice(0, 200));
  if (x.method === "Runtime.consoleAPICalled" && x.params.type === "error") problems.push("console: " + x.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200));
  // the browser writes a line for every 404, and two are answers, not faults: "this wallet has not registered", and
  // "the engine has not seen this brand new job yet" (asked again a moment later)
  // and so is the account's "that would not go through" (400), said to the visitor in words before anything is signed
  if (x.method === "Log.entryAdded" && x.params.entry.level === "error" && !(/status of 404/.test(x.params.entry.text) && /\/api\/v1\/(agents\/0x[0-9a-f]{40}|jobs\/title|jobs\/brief)$/.test(x.params.entry.url ?? "")) && !(/status of (400|409)/.test(x.params.entry.text) && /\/api\/v1\/accounts\/(check|call|relay)$/.test(x.params.entry.url ?? ""))) problems.push(`log: ${x.params.entry.text.slice(0, 200)} ${x.params.entry.url ?? ""}`);
  if (x.method === "Page.windowOpen") opened.push(x.params.url);
  if (x.method === "Network.requestWillBeSent") requested.push(x.params.request.url);
});
const PROVIDER = `(() => {
  if (!window.__factorWalletBridge) return;
  let n = 0; const waiting = new Map(); const listeners = {};
  window.__factorWalletDone = (id, err, result) => { const w = waiting.get(id); waiting.delete(id); if (!w) return; if (err) w.reject(Object.assign(new Error(err.message), err)); else w.resolve(result); };
  window.ethereum = {
    isMetaMask: true,
    request: ({ method, params }) => new Promise((resolve, reject) => { const id = ++n; waiting.set(id, { resolve, reject }); window.__factorWalletBridge(JSON.stringify({ id, method, params: params || [] })); }),
    on: (ev, f) => { (listeners[ev] = listeners[ev] || []).push(f); },
    removeListener: (ev, f) => { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); },
  };
})();`;
await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable"); await send("Network.enable");
await send("Network.setBlockedURLs", { urls: ["*metamask.app.link*", "*metamask.io*"] });
await send("Runtime.addBinding", { name: "__factorWalletBridge" });
const { result: { identifier: providerScript } } = await send("Page.addScriptToEvaluateOnNewDocument", { source: PROVIDER });
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };
await send("Emulation.setDeviceMetricsOverride", DESKTOP);

const run = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(`in the page: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
  return r.result?.result?.value;
};
async function go(path) {
  await send("Page.navigate", { url: SITE + path });
  for (let i = 0; i < 100; i++) { await sleep(120); if ((await run("document.readyState").catch(() => "")) === "complete") break; }
  await sleep(700); // hydration, and the wallet being found again
}
const text = () => run("document.body.innerText");
async function until(what, fn, ms = 45_000) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { await shot(`stuck-${Date.now()}`); throw new Error(`timed out waiting for ${what}. The page says: ${(await text().catch(() => "")).replace(/\s+/g, " ").slice(-600)}`); }
    await sleep(350);
  }
}
const says = (words, ms) => until(`the page to say "${words}"`, async () => (await text()).includes(words), ms);
// What the page's own helpers need: find a field by its label, a button by its words, inside the block with a heading.
const PAGE = `
  const scopeOf = (heading) => heading ? [...document.querySelectorAll(".act, .form, .acts")].filter((el) => [...el.querySelectorAll(":scope > .h3, :scope > .label")].some((h) => h.textContent.trim() === heading)).pop() || null : document;
  const fieldOf = (scope, label) => { const l = [...scope.querySelectorAll("label.field")].find((x) => x.querySelector(".label")?.textContent.trim() === label); return l ? l.querySelector("input, select, textarea") : null; };
  const setValue = (el, v) => { const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); };
  const buttonOf = (scope, words) => [...scope.querySelectorAll("button, a.btn")].find((b) => b.textContent.trim() === words && !b.disabled) || null;
`;
const inPage = (body) => run(`(() => { ${PAGE} ${body} })()`);
const fill = (label, value, heading = null) => until(`the field "${label}"`, () => inPage(`const s = scopeOf(${JSON.stringify(heading)}); const el = s && fieldOf(s, ${JSON.stringify(label)}); if (!el || el.disabled) return false; setValue(el, ${JSON.stringify(value)}); return true;`));
const press = (words, heading = null) => until(`the button "${words}"`, () => inPage(`const s = scopeOf(${JSON.stringify(heading)}); const b = s && buttonOf(s, ${JSON.stringify(words)}); if (!b) return false; b.click(); return true;`));
const has = (words, heading = null) => inPage(`const s = scopeOf(${JSON.stringify(heading)}); return !!(s && buttonOf(s, ${JSON.stringify(words)}));`);
const statusOf = (heading) => inPage(`const s = scopeOf(${JSON.stringify(heading)}); const p = s && s.querySelector(".status"); return p ? p.innerText : "";`);
const settled = (heading, words, ms = 60_000) => until(`"${words}" under "${heading}"`, async () => { const s = await statusOf(heading); if (s.includes(words)) return s; return false; }, ms);
async function shot(name) { const p = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(p.result.data, "base64")); }
async function as(account) { wallet.account = account; wallet.shared = false; await run("try { localStorage.removeItem('factor-wallet') } catch (e) {}").catch(() => undefined); }
const connect = async () => { if (await has("Connect, or use a passkey")) await press("Connect, or use a passkey"); await until("the wallet to be connected", async () => (await text()).includes(`${wallet.account.address.slice(0, 6).toLowerCase()}…${wallet.account.address.slice(-4).toLowerCase()}`)); };

try {
  // ---------- 4: the flows ----------

  step("4a an agent registers, names itself and posts a bond");
  await as(AGENT);
  await go("/work");
  check("the page offers to connect, and connecting shows the wallet in the header", await has("Connect, or use a passkey"));
  await connect();
  await says("Register this wallet");
  await press("Register as an agent", "Register this wallet");
  await says("Registered. This wallet is an agent on the desk.");
  check("registering is one transaction, and the desk has the agent", (await desk("agent", [AGENT.address])).registered);
  await says("Give it a name");
  await fill("Name", "lumen-07", "Give it a name");
  await fill("What it does", "Summarises long documents and contracts", "Give it a name");
  await press("Sign and save", "Give it a name");
  await until("the name to be saved", async () => (await text()).includes("The agent goes by lumen-07"));
  check("the agent's name is one signature and no transaction", wallet.signed === 1 && wallet.sent === 1);
  await fill("Amount in ETH", "0.004", "Bond");
  await press("Add to the bond", "Bond");
  await settled("Bond", "0.004 ETH added to your bond.");
  check("the bond is in the desk", (await desk("agent", [AGENT.address])).bond === 4_000_000_000_000_000n);
  await until("the console to show the bond and the limit", async () => /Limit with the pool[\s\S]*0\.0040 ETH/.test(await text()));
  await shot("desktop-work-connected");
  await go("/agents/lumen-07");
  const agentPage = await text();
  check("the agent's public page carries its name, what it does, and its limit", agentPage.includes("lumen-07") && agentPage.includes("Summarises long documents and contracts.") && /Limit[\s\S]*0\.0040 ETH/.test(agentPage));

  // the owner pauses new jobs (the engine's switch, with the owner's key of this local run): the site says so on
  // every page and offers nothing to lock, and is as it was when the switch is turned back
  const flip = (on) => fetch(`${bare.api}/v1/admin/switch`, { method: "POST", headers: { "content-type": "application/json", "x-admin-key": bare.adminKey }, body: JSON.stringify({ what: "hiring", on }) });
  await flip(false);
  await as(CUSTOMER);
  await go("/hire?agent=lumen-07");
  const pausedText = await text();
  check("while new jobs are paused the site says so, and offers nothing to lock", pausedText.includes("New jobs are paused for now.") && (await run(`[...document.querySelectorAll(".btn.off")].some((b) => b.textContent.trim() === "New jobs are paused")`)) && !(await has("Connect, or use a passkey")));
  await flip(true);
  await go("/hire?agent=lumen-07");
  check("turned back, the site offers it again", !(await text()).includes("New jobs are paused") && (await has("Connect, or use a passkey")));

  step("4b a customer hires it: the price is locked, then the title is signed");
  await as(CUSTOMER);
  await go("/hire?agent=lumen-07");
  await connect();
  await fill("Price in ETH", "0.0001");
  check("a price under the smallest job is said before anything is sent", (await text()).includes("The smallest job is 0.001 ETH.") && !(await has("Lock 0.0001 ETH")));
  await fill("Price in ETH", "0.01");
  await fill("What you want done", "Summarise a 40-page service agreement");
  await inPage(`document.querySelector("button.toggle").click(); return true;`);
  await sleep(200);
  check("the early switch is on", await inPage(`return document.querySelector("button.toggle").getAttribute("aria-checked") === "true";`));
  const sentBefore = wallet.sent;
  wallet.declineNext = true;
  await press("Lock 0.01 ETH");
  await until("the page to say the wallet declined", async () => (await text()).includes("You declined it in your wallet. Nothing was sent."));
  check("saying no in the wallet sends nothing, and the page says so", wallet.sent === sentBefore && (await desk("held")) === 0n);
  await press("Lock 0.01 ETH");
  await until("the job to be locked and titled", async () => (await text()).includes("Job 0001 is locked for lumen-07."), 90_000);
  const j1 = await desk("job", [1n]);
  check("the desk holds the job: 0.01 ETH locked for the agent, early allowed", j1.state === 1 && j1.price === 10n ** 16n && j1.allowEarly && j1.agent.toLowerCase() === AGENT.address.toLowerCase() && j1.customer.toLowerCase() === CUSTOMER.address.toLowerCase());
  await until("the customer's own list to show it", async () => /Jobs you have locked[\s\S]*0001[\s\S]*Summarise a 40-page service agreement/i.test(await text()));
  await shot("desktop-hire-locked");
  await go("/jobs/0001");
  const jobPage = await text();
  check("the job's page carries the signed title and the bill", jobPage.includes("Summarise a 40-page service agreement") && /Locked by the customer[\s\S]*0\.0100 ETH/.test(jobPage) && jobPage.includes("LOCKED"));
  await connect();
  check("its customer is told there is nothing to do while the agent works", (await text()).includes("There is nothing for you to do until it delivers.") && !(await has("Accept the delivery")) && !(await has("Draw it")));

  // a wallet on a chain where the desk is not: the page must refuse to send anything at all
  wallet.noDesk = true;
  const sentWrong = wallet.sent;
  await go("/hire?agent=lumen-07");
  await connect();
  await fill("Price in ETH", "0.01");
  await press("Lock 0.01 ETH");
  await until("the page to refuse", async () => (await text()).includes("Your wallet does not see the desk on the chain it is on. Nothing was sent."));
  check("a wallet that does not see the desk is sent nothing to sign: no ETH can go to an empty address", wallet.sent === sentWrong);
  wallet.noDesk = false;

  step("4c the agent draws from the pool and early, and delivers");
  await as(AGENT);
  await go("/jobs/0001");
  await connect();
  await until("the desk's own answer on what can be drawn", async () => (await text()).includes("Up to 0.004 ETH right now."));
  await inPage(`document.querySelector(".act .linkish").click(); return true;`);
  const agentBefore = await chain.getBalance({ address: AGENT.address });
  await press("Draw it", "Draw an advance");
  await says("0.00396 ETH is in your wallet. 0.00004 ETH buys back and burns $FACTOR.");
  const got = (await chain.getBalance({ address: AGENT.address })) - agentBefore;
  check("the pool advance reached the agent's wallet, less its fee (and the gas of asking)", got > 3_000_000_000_000_000n && got <= 3_960_000_000_000_000n && (await desk("agent", [AGENT.address])).advancedNow === 4_000_000_000_000_000n, `${Number(got) / 1e18} ETH`);
  await press("Early, from the job", "Draw an advance");
  await fill("Amount in ETH", "0.001", "Draw an advance");
  await press("Draw it", "Draw an advance");
  await says("0.00099 ETH is in your wallet.");
  // half of the job is out now: the desk would refuse another wei, and the page says why without sending anything
  const sentAtHalf = wallet.sent;
  await fill("Amount in ETH", "0.001", "Draw an advance");
  await press("Draw it", "Draw an advance");
  await settled("Draw an advance", "Half of this job is already advanced. Nothing more can be drawn on it.");
  check("a draw the desk would refuse never reaches the wallet, and is explained in plain words", wallet.sent === sentAtHalf);
  await fill("What you delivered", "The summary: https://example.org/summary-0001 (12 points, 3 risks)", "Deliver");
  await press("Deliver the job", "Deliver");
  await says("Delivered. The customer has 24 hours to accept or reject; after that the job settles by itself.");
  const delivered = await desk("job", [1n]);
  check("the desk has the delivery, with the fingerprint of what was pasted", delivered.state === 3 && delivered.early === 10n ** 15n && delivered.fromPool === 4n * 10n ** 15n && /^0x[0-9a-f]{64}$/.test(delivered.proof) && !/^0x0+$/.test(delivered.proof));
  await until("the page to show the agent it has delivered", async () => (await text()).includes("You have delivered. Your customer can accept or reject until") && !(await has("Deliver the job")));
  check("once delivered, the agent is told what happens next and is offered nothing more", !(await has("Draw it")) && !(await has("Decline the job")));
  await shot("desktop-job-delivered-agent");

  step("4d the customer accepts");
  await as(CUSTOMER);
  await go("/jobs/0001");
  await connect();
  await says("lumen-07 has delivered");
  await shot("desktop-job-delivered-customer");
  const agentBeforePay = await chain.getBalance({ address: AGENT.address });
  await press("Accept the delivery");
  await until("the acceptance", async () => (await text()).includes("Accepted. The agent is paid."), 60_000);
  check("the agent is paid the rest, less the 2% job fee, to the wei", (await chain.getBalance({ address: AGENT.address })) - agentBeforePay === 10n ** 16n - 5n * 10n ** 15n - 2n * 10n ** 14n);
  await until("the page to show the job settled", async () => { const t = await text(); return t.includes("Paid to the agent on delivery") && /0\.0048 ETH/.test(t) && !t.includes("What can be done".toUpperCase()); });
  check("the settled job's page shows what it paid and offers nothing more", true);

  step("4e a second job is rejected, a third declined");
  await go("/hire?agent=lumen-07");
  await connect();
  await fill("Price in ETH", "0.01");
  await fill("What you want done", "Translate a product page into German");
  await press("Lock 0.01 ETH");
  await until("job 2", async () => (await text()).includes("Job 0002 is locked for lumen-07."), 90_000);
  await fill("What you want done", "Audit a token contract");
  await press("Lock 0.01 ETH");
  await until("job 3", async () => (await text()).includes("Job 0003 is locked for lumen-07."), 90_000);
  await as(AGENT);
  await go("/jobs/0002");
  await connect();
  await fill("What you delivered", "Etwas ganz anderes", "Deliver");
  await press("Deliver the job", "Deliver");
  await says("Delivered. The customer has 24 hours");
  await go("/jobs/0003");
  await connect();
  await press("Decline the job", "Not for you?");
  await says("Declined. The customer has the payment back.");
  await as(CUSTOMER);
  await go("/jobs/0002");
  await connect();
  await says("Not what you asked for?");
  const customerBefore = await chain.getBalance({ address: CUSTOMER.address });
  await press("Reject it", "Not what you asked for?");
  await says("Rejected. The job settled at half.");
  const back = (await chain.getBalance({ address: CUSTOMER.address })) - customerBefore;
  check("rejecting brings half of the price back to the customer (less the gas of saying so)", back > 49n * 10n ** 14n && back <= 5n * 10n ** 15n, `${Number(back) / 1e18} ETH`);
  const [s2, s3] = [(await desk("job", [2n])).state, (await desk("job", [3n])).state];
  check("the desk has job 2 settled at half and job 3 declined", s2 === 5 && s3 === 6);
  await until("the rejected job's page", async () => { const t = await text(); return t.includes("SETTLED AT HALF") && /Returned to the customer[\s\S]*0\.0050 ETH/.test(t); });
  await shot("desktop-job-half");

  step("4f compute credit: drawn on the job's page, the key signed for on the agent's page, spent through the site");
  await go("/hire?agent=lumen-07");
  await connect();
  await fill("Price in ETH", "0.01");
  await fill("What you want done", "Summarise a lease in one line");
  await press("Lock 0.01 ETH");
  await until("job 4", async () => (await text()).includes("Job 0004 is locked for lumen-07."), 90_000);
  await as(AGENT);
  await go("/jobs/0004");
  await connect();
  await until("the desk's own answer on what can be drawn", async () => (await text()).includes("right now."));
  await press("As compute", "Draw an advance");
  await says("It becomes credit your agent spends on models.");
  await fill("Amount in ETH", "0.002", "Draw an advance");
  const gateway = accounts[1].address;
  const [gatewayBefore, agentBeforeCompute] = await Promise.all([chain.getBalance({ address: gateway }), chain.getBalance({ address: AGENT.address })]);
  await press("Draw it", "Draw an advance");
  await says("0.00198 ETH is compute credit for your agent now.");
  check("drawn as compute, the ETH went to the gateway and none of it to the agent's wallet", (await chain.getBalance({ address: gateway })) - gatewayBefore > 1_900_000_000_000_000n && (await chain.getBalance({ address: AGENT.address })) < agentBeforeCompute);
  await shot("desktop-job-compute-drawn");
  await go("/work");
  await connect();
  await until("the credit on the agent's page", async () => /LEFT TO SPEND\s*\$\d+\.\d\d/i.test((await text()).replace(/\n+/g, " ")) && (await text()).includes("Job 0004"));
  const [signedBefore, sentBeforeKey] = [wallet.signed, wallet.sent];
  await press("Sign for a key", "Compute credit");
  await settled("Compute credit", "This is the key.");
  const computeKey = await run(`document.querySelector("[data-key]")?.textContent ?? ""`);
  check("the key is one signature and no transaction, and is shown on the page", /^fck_[A-Za-z0-9_-]{32}$/.test(computeKey) && wallet.signed === signedBefore + 1 && wallet.sent === sentBeforeKey);
  const base = await run(`[...document.querySelectorAll(".keybox .code")].pop()?.textContent ?? ""`);
  check("the page says which address an agent's program calls", base === `${SITE}/api/v1/compute`, base);
  check("the key is kept nowhere in the browser", await run(`!JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]).includes("fck_")`));
  await run(`document.querySelector(".keybox").scrollIntoView({ block: "center" })`);
  await sleep(400);
  await shot("desktop-work-compute-key");
  // an agent's program, anywhere: the model maker's request, sent to the site with the key
  const creditOf = async () => (await (await fetch(`${SITE}/api/v1/compute/credit/${AGENT.address.toLowerCase()}`)).json()).balanceUsd;
  const credit0 = await creditOf();
  const askModel = (body) => fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": computeKey, "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 400, messages: [{ role: "user", content: "Summarise the lease in one line." }], ...body }) });
  const plain = await askModel({});
  const plainBody = await plain.json();
  check("a call through the site is answered in the model maker's shape and comes off the credit", plain.status === 200 && plainBody.content?.[0]?.text?.startsWith("Summary:") && (await creditOf()) < credit0, `$${(credit0 - (await creditOf())).toFixed(6)}`);
  const streamed = await askModel({ stream: true });
  let chunks = 0, streamText = "";
  const reader = streamed.body.getReader();
  const firstAt = Date.now();
  let lastAt = firstAt;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks++; lastAt = Date.now(); streamText += new TextDecoder().decode(value); }
  check("a stream comes through the site as it is made, not all at once at the end", streamed.headers.get("content-type") === "text/event-stream" && chunks > 3 && lastAt - firstAt > 60 && streamText.trimEnd().endsWith('data: {"type":"message_stop"}'), `${chunks} pieces over ${lastAt - firstAt} ms`);
  check("through the site too, no key means no model, and the owner's health page is not there", (await fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": "fck_" + "a".repeat(32), "content-type": "application/json" }, body: "{}" })).status === 401 && (await fetch(`${base}/health`)).status === 404 && (await fetch(`${base}/v1/complete`, { method: "POST", body: "{}" })).status === 404);
  await until("the page to show what was spent", async () => /\$0\.00\d+ of \$\d+\.\d\d spent/.test(await text()), 40_000);
  await run(`document.querySelector(".keybox").scrollIntoView({ block: "center" })`);
  await sleep(400);
  await shot("desktop-work-compute-spent");
  await go("/docs");
  const docsText = await text();
  await run(`document.getElementById("compute").scrollIntoView({ block: "start" })`);
  await sleep(900);
  await shot("desktop-docs-compute");
  check("the docs list the models with what they cost here", /claude-sonnet-5-5\s*\$2\.10 in · \$10\.50 out/.test(docsText.replace(/\n+/g, " ")) && docsText.includes("credit.baseURL"));
  // the job is finished, so that nothing of it is left open for the comparisons below
  await go("/jobs/0004");
  await connect();
  await fill("What you delivered", "The lease runs for two years and renews by itself.", "Deliver");
  await press("Deliver the job", "Deliver");
  await says("Delivered. The customer has 24 hours");
  await as(CUSTOMER);
  await go("/jobs/0004");
  await connect();
  await says("lumen-07 has delivered");
  await press("Accept the delivery");
  await until("the acceptance", async () => (await text()).includes("Accepted. The agent is paid."), 60_000);
  check("the job repaid the pool for the compute it advanced", (await desk("agent", [AGENT.address])).advancedNow === 0n);

  // ---------- 5: what the pages say, against what the desk holds ----------

  step("5a the pages against the desk");
  const state = await until("the engine to have all four jobs closed", async () => { const s = await (await fetch(SITE + "/api/v1/state")).json(); return s.jobs.length === 4 && s.jobs.every((j) => ["settled", "half", "declined"].includes(j.state)) ? s : null; });
  const rec = await desk("agent", [AGENT.address]);
  const shown = state.agents.find((a) => a.name === "lumen-07");
  check("the agent's record on the site is the desk's", shown && shown.settled === rec.settled && shown.settledAtHalf === rec.settledAtHalf && Math.abs(shown.feesPaidEth - Number(rec.feesPaid) / 1e18) < 1e-9 && shown.drawnEth === 0, `settled ${rec.settled}, at half ${rec.settledAtHalf}`);
  const [pool, held, bonds, owed, balance] = await Promise.all([desk("pool"), desk("held"), desk("bonds"), desk("owedTotal"), chain.getBalance({ address: bare.desk })]);
  check("the desk holds exactly what its books say, and no job's money is left in it", balance === pool + held + bonds + owed && held === 0n);
  await go("/ledger");
  const ledger = await text();
  check("the ledger prints what happened, in words", ["lumen-07 delivered, the pool was repaid", "the customer rejected the delivery, the job settled at half", "lumen-07 declined the job, the customer has it all back", "lumen-07 drew an advance its customer allowed", "lumen-07 had its compute paid from the pool", "trading fees arrived in the pool"].every((l) => ledger.includes(l)));
  await go("/");
  const homeText = await text();
  check("the home page shows the agent and the jobs that settled", homeText.includes("lumen-07") && /JOBS SETTLED\s*2\b/.test(homeText.replace(/\n+/g, " ")), (homeText.match(/JOBS SETTLED\s*\S+/) ?? [""])[0].replace(/\s+/g, " "));
  await shot("desktop-home-live");
  check("the browser asked the network for this site only", requested.every((u) => u.startsWith(SITE) || u.startsWith("data:") || u.startsWith("about:")), requested.find((u) => !u.startsWith(SITE) && !u.startsWith("data:") && !u.startsWith("about:")) ?? `${requested.length} requests`);
  check("the pages raised no error and broke no rule of the content policy", problems.length === 0, problems.slice(0, 3).join(" | "));

  step("5a2 somebody with no agent of their own makes one on the site");
  {
    const MAKER = accounts[5];
    const how = "Write one plain sentence that says what the customer's text is about. Nothing else, and never more than one sentence.";
    await as(MAKER);
    await go("/work");
    await connect();
    await says("A new agent");
    check("the page says who holds the key of an agent made here before anything is signed", /Factor holds the agent's key/.test(await text()) && /you are trusting Factor to run it/.test(await text()));
    await fill("Name", "one-liner", "A new agent");
    await fill("What it does, in one line", "Says what a text is about in one sentence", "A new agent");
    await fill("How it should do it", how, "A new agent");
    await fill("Price of a job, in ETH", "0.002", "A new agent");
    const signedBefore = wallet.signed, sentBefore = wallet.sent;
    await press("Sign and make it", "A new agent");
    await until("the agent to be made", async () => (await text()).includes("one-liner is made"));
    check("making an agent is one signature and no transaction", wallet.signed === signedBefore + 1 && wallet.sent === sentBefore);
    const made = await until("the engine to put it on the desk", async () => { const r = await fetch(`${bare.api}/v1/agents/one-liner`); const a = r.ok ? (await r.json()).agent : null; return a?.named && a.service ? a : false; }, 240_000);
    check("the engine put it on the desk, run by Factor for the wallet that made it", made.hosted === true && made.owner === MAKER.address.toLowerCase() && made.house === false && (await desk("agent", [made.address])).registered);
    await until("the page to list it as theirs", async () => /Yours[\s\S]*one-liner[\s\S]*takes a job from 0\.002 ETH/.test(await text()), 60_000);
    await shot("desktop-make-agent");
    await press("Pause", "Yours");
    await until("it to be paused", async () => (await text()).includes("one-liner is paused"));
    const mine = await (await fetch(`${bare.api}/v1/agents/made/${MAKER.address.toLowerCase()}`)).json();
    check("its maker pauses it with one more signature", mine.items.length === 1 && mine.items[0].paused === true && wallet.signed === signedBefore + 2);
    await go("/agents/one-liner");
    check("its own page says it is run by Factor, and never shows its maker's instructions", /Run by Factor/i.test(await text()) && !(await text()).includes("never more than one sentence"));
    await go("/agents");
    check("the list of agents marks it apart from Factor's own", /one-liner\s*Run by Factor/i.test(await text()));
  }

  step("5b with no wallet: an account with a passkey, and the gas paid for");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: providerScript });
  await send("Runtime.removeBinding", { name: "__factorWalletBridge" });
  // Chrome's own test authenticator: it makes and uses passkeys as a phone's fingerprint reader would, and says yes
  await send("WebAuthn.enable");
  const { result: { authenticatorId } } = await send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await go("/hire?agent=lumen-07");
  await run("try { localStorage.removeItem('factor-wallet') } catch (e) {}");
  check("there is no wallet in this page", await run("typeof window.ethereum === 'undefined'"));
  const botTxs = await chain.getTransactionCount({ address: accounts[1].address });
  await press("Connect, or use a passkey");
  await says("An account with a passkey");
  await shot("desktop-passkey-dialog");
  opened.length = 0;
  await press("Use a wallet instead");
  await until("a new window", async () => opened.length > 0, 10_000).catch(() => undefined);
  check("somebody who would rather use a wallet is still sent to where one is got", opened.some((u) => u.startsWith("https://metamask.io/download")), opened[0] ?? "nothing opened");
  await press("Connect, or use a passkey");
  await press("Create an account");
  const session = await until("the account to be made", async () => { const raw = await run("localStorage.getItem('factor-account')"); return raw ? JSON.parse(raw) : null; }, 90_000);
  const person = session.address;
  await until("the dialog to close", async () => !(await text()).includes("An account with a passkey"));
  const code = await chain.getCode({ address: person });
  check("a passkey makes an account on the chain, and the header shows it", !!code && code !== "0x" && (await text()).includes(`${person.slice(0, 6)}…${person.slice(-4)}`), person);
  check("the browser keeps where the account is and its public key, and nothing a thief could use", Object.keys(session).sort().join() === "address,credential,x,y" && (await run("document.cookie")) === "");
  await says("YOUR ACCOUNT");
  // nothing in it yet: the page says so before the passkey is asked for anything
  await fill("Price in ETH", "0.01");
  await fill("What you want done", "Proofread a product page");
  await press("Lock 0.01 ETH");
  await says("Your account holds 0 ETH: not enough for the 0.01 ETH this needs.");
  check("with nothing in the account, hiring is refused in words and nothing is sent", (await chain.getTransactionCount({ address: accounts[1].address })) === botTxs + 1, "the one transaction so far made the account");
  // the visitor's ETH arrives from wherever they have it
  await anvil("eth_sendTransaction", [{ from: accounts[2].address, to: person, value: "0xb1a2bc2ec50000" }]); // 0.05 ETH
  await until("the page to show the ETH", async () => /IN IT\s*0\.05 ETH/i.test((await text()).replace(/\n+/g, " ")), 30_000);
  await shot("desktop-account-panel");
  await press("Lock 0.01 ETH");
  await until("job 5", async () => (await text()).includes("Job 0005 is locked for lumen-07."), 90_000);
  const j5 = await desk("job", [5n]);
  check("the passkey hires the agent: the desk holds the job for the account", j5.customer.toLowerCase() === person && j5.price === 10n ** 16n && j5.state === 1 && (await chain.getBalance({ address: person })) === 4n * 10n ** 16n);
  await until("the job's page to carry the title the passkey signed", async () => { await go("/jobs/0005"); return (await text()).includes("Proofread a product page"); }, 40_000);
  check("its customer is shown what it can do there, as a wallet's owner is", (await text()).includes("There is nothing for you to do until it delivers."));
  await go("/hire?agent=lumen-07");
  await says("YOUR ACCOUNT");
  await press("Take ETH out");
  const home = "0x00000000000000000000000000000000000a11ce";
  await fill("To this address", home);
  await fill("Amount in ETH", "0.01");
  await press("Send it");
  await says("0.01 ETH left your account.");
  check("ETH leaves the account for any address, and its owner paid no gas", (await chain.getBalance({ address: home })) === 10n ** 16n && (await chain.getBalance({ address: person })) === 3n * 10n ** 16n);
  await press("Add a second key");
  await fill("The wallet's address", CUSTOMER.address);
  await press("Add it as a key");
  await says("That wallet is a key of your account now.");
  const keyCount = await chain.readContract({ address: person, abi: parseAbi(["function keyCount() view returns (uint256)"]), functionName: "keyCount" });
  check("a wallet is added as a second way in", keyCount === 2n);
  // one of Factor's own agents, hired with a brief: two fingerprints (the payment, then the words), and the page it
  // builds is on the job's page a little later
  await go("/hire?agent=page-smith");
  await says("YOUR ACCOUNT");
  check("the form says what one of Factor's own agents needs and takes a job for", (await text()).includes("Say what the page is for, who it is for, and the words that must be on it.") && (await text()).includes("One of Factor's own agents."));
  await fill("Price in ETH", "0.001");
  await until("the price to be read", async () => (await text()).includes("page-smith takes a job from 0.003 ETH. Under that it declines"));
  check("a price under what the agent takes cannot be locked", !(await has("Lock 0.001 ETH")));
  await fill("Price in ETH", "0.004");
  await fill("What you want done", "Tide Tea");
  await fill("The brief", "A page for Tide Tea, a small shop that posts loose leaf tea every week. Calm and plain, for people who like tea.");
  await press("Lock 0.004 ETH");
  await until("job 6", async () => (await text()).includes("Job 0006 is locked for page-smith."), 120_000);
  await until("the page to be delivered and shown", async () => { await go("/jobs/0006"); return (await run(`!!document.querySelector("iframe.workpage")`)) && (await text()).includes("has delivered"); }, 150_000);
  const jobText = await text();
  check("the job's page carries the brief the passkey signed, and the work", jobText.includes("A page for Tide Tea, a small shop that posts loose leaf tea every week.") && /THE WORK/i.test(jobText) && jobText.includes("Its fingerprint is the proof the contract holds for this job."));
  check("the page is shown in a frame that can run nothing", await run(`(() => { const f = document.querySelector("iframe.workpage"); return f.getAttribute("sandbox") === "" && f.getAttribute("src") === "/jobs/0006/work?frame"; })()`));
  const delivered6 = await fetch(`${SITE}/jobs/0006/work`);
  const policy6 = delivered6.headers.get("content-security-policy") ?? "";
  const body6 = await delivered6.text();
  check("by itself it is served under its own policy: no script, no form, no request, and a line saying what it is", policy6.split("; ").includes("sandbox") && policy6.includes("default-src 'none'") && !/script-src|allow-/.test(policy6) && body6.includes("Tide Tea") && body6.includes("A page delivered by page-smith for job 0006 on Factor.") && !/<script/i.test(body6));
  await run(`document.querySelector("iframe.workpage").scrollIntoView({ block: "center" })`);
  await sleep(900);
  await shot("desktop-job-own-agent");
  await press("Accept the delivery");
  await until("the acceptance", async () => (await text()).includes("Accepted. The agent is paid."), 60_000);
  check("the passkey accepts, and Factor's own agent is paid like anybody's", (await desk("job", [6n])).state === 4);
  await go("/hire?agent=lumen-07");
  await says("YOUR ACCOUNT");
  // signed out, and back in with nothing but the passkey
  await run(`document.querySelector("button.wallet").click()`);
  await until("signed out", async () => (await run("localStorage.getItem('factor-account')")) === null && (await text()).includes("CONNECT"));
  await press("Connect, or use a passkey");
  await press("I have one already");
  await until("signed in again", async () => (await run("localStorage.getItem('factor-account')")) !== null && !(await text()).includes("An account with a passkey"), 30_000);
  check("the passkey alone finds the account again", JSON.parse(await run("localStorage.getItem('factor-account')")).address === person);
  const paid = (await chain.getTransactionCount({ address: accounts[1].address })) - botTxs;
  check("every transaction of it was sent and paid for by the engine's gas wallet", paid === 7, `${paid} transactions: the account, the job, the ETH out, the key, then the second job, its agent's delivery and the acceptance`);
  check("the pages raised no error and broke no rule of the content policy, with a passkey too", problems.length === 0, problems.slice(0, 3).join(" | "));
  await send("Emulation.setDeviceMetricsOverride", PHONE);
  await send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" });
  await go("/hire?agent=lumen-07");
  check("the phone is seen as a phone", await run("window.matchMedia('(pointer: coarse)').matches && /iPhone/.test(navigator.userAgent)"));
  await says("YOUR ACCOUNT");
  check("the account's own part of the page fits a phone", (await run("document.documentElement.scrollWidth")) <= PHONE.width + 1);
  await run(`document.querySelector(".account").scrollIntoView({ block: "start" })`);
  await sleep(500);
  // a figure keeps its line when it is not allowed to wrap and still fits its column
  const squeezed = await run(`[...document.querySelectorAll(".account .kv dd")].every((d) => getComputedStyle(d).whiteSpace === "nowrap" && d.scrollWidth <= d.clientWidth + 1 && d.getBoundingClientRect().width > 40)`);
  check("on a phone each figure of the account keeps to one line", squeezed);
  await shot("phone-account-panel");
  await run("try { localStorage.removeItem('factor-account') } catch (e) {}");
  await go("/hire?agent=lumen-07");
  await press("Connect, or use a passkey");
  await says("An account with a passkey");
  check("the dialog fits a phone", (await run("document.documentElement.scrollWidth")) <= PHONE.width + 1 && (await run(`document.querySelector(".dialog").getBoundingClientRect().width`)) <= PHONE.width);
  await shot("phone-passkey-dialog");
  requested.length = 0;
  await press("Use a wallet instead");
  const deep = `https://metamask.app.link/dapp/localhost:${SITE_PORT}/hire?agent=lumen-07`;
  await until("the phone to be sent into MetaMask", async () => requested.includes(deep), 10_000).catch(() => undefined);
  check("on a phone, a wallet instead opens this very page inside MetaMask", requested.includes(deep), requested.find((u) => u.includes("metamask")) ?? "no such request");
  await send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  await send("WebAuthn.disable");

  step("5c the wallet pages on a phone");
  problems.length = 0;
  await send("Runtime.addBinding", { name: "__factorWalletBridge" });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PROVIDER });
  for (const [who, name, path] of [[AGENT, "work", "/work"], [CUSTOMER, "hire", "/hire?agent=lumen-07"], [AGENT, "job", "/jobs/0001"]]) {
    await as(who);
    await go(path);
    await run("try { localStorage.setItem('factor-wallet', '1') } catch (e) {}");
    wallet.shared = true;
    await go(path);
    await sleep(1500);
    const [wide, tall] = [await run("document.documentElement.scrollWidth"), await run("document.documentElement.scrollHeight")];
    check(`${path} fits a phone with a wallet connected`, wide <= PHONE.width + 1, `${wide} wide`);
    for (const [i, y] of [0, Math.max(0, Math.round((tall - PHONE.height) * 0.45)), Math.max(0, tall - PHONE.height)].entries()) { await run(`window.scrollTo(0, ${y})`); await sleep(500); await shot(`phone-${name}-${i + 1}`); }
  }
  check("a wallet that was connected is connected again when its owner comes back", (await text()).length > 0 && await run("localStorage.getItem('factor-wallet') === '1'"));
  check("the phone pages raised no error", problems.length === 0, problems.slice(0, 3).join(" | "));
} catch (e) {
  check(`the run reached its end`, false, e.message.slice(0, 700));
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed.`);
if (failed.length) console.log(failed.map((f) => `  FAILED: ${f.name}`).join("\n"));
ws.close();
await stopPort(CHROME_PORT);
if (STAY && !failed.length) {
  console.log(`\nLeft running: the site on ${SITE}, the engine on ${bare.api}, the fork on ${bare.rpc}. Stop them with: npm run flows -- --stop`);
  process.exit(0);
}
await stopAll();
process.exit(failed.length ? 1 : 0);
