// Bounties, the way a visitor uses them, against the real contracts on a local fork: a real browser, real clicks, a wallet in
// the page, and a passkey account with no wallet at all. It reads what `npm run bounties-e2e -- --stay` (in engine/) left
// running. Nothing here can reach the real chain.
//
//   cd engine && npm run bounties-e2e -- --stay
//   cd web && node scripts/bounties-flows.mjs
//
// What it does: a wallet posts a bounty from the form; a wallet agent enters from the page; a passkey account registers and
// enters too, with the gas paid; the page shows only the count; from the deadline the poster reads by signature in the page,
// and picks; the winner delivers from the page and is paid; all of it on a desktop, with screen-sized pictures on a phone.
// Then a passkey account posts, reads with its passkey and picks. Keys: anvil's and keys made up by the rehearsal.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const WORK = process.env.E2E_WORK?.trim() || join(tmpdir(), "factor-bounties-e2e");
const SITE_PORT = 3870, CHROME_PORT = 9975;
const SITE = `http://localhost:${SITE_PORT}`;
const SHOTS = process.env.SHOOT_OUT || join(WORK, "shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (title) => console.log(`\n== ${title}`);
const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}
const bare = JSON.parse(readFileSync(join(WORK, "bare.json"), "utf8"));
const K = JSON.parse(readFileSync(join(WORK, "bounties-keys.json"), "utf8"));
const accounts = bare.keys.map((k) => privateKeyToAccount(k));
const POSTER = privateKeyToAccount(K.poster), AGENT = privateKeyToAccount(K.a2), AGENT3 = privateKeyToAccount(K.a3);
const chain = createPublicClient({ transport: http(bare.rpc) });
const BOUNTY = parseAbi([
  "function bountyCount() view returns (uint256)",
  "function bounty(uint256) view returns ((address poster, uint40 deadline, uint16 minScore, uint8 state, bool bondsBack, address winner, uint256 prize, uint256 fee, uint256 bond, uint256 job, bytes32 task))",
  "function entrants(uint256) view returns (address[])",
]);
const rd = (functionName, a = []) => chain.readContract({ address: bare.bounty, abi: BOUNTY, functionName, args: a });
async function anvil(method, params = []) {
  const r = await fetch(bare.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json();
}
const warp = async (s) => { await anvil("evm_increaseTime", [s]); await anvil("evm_mine", []); };
for (const a of [POSTER, AGENT, AGENT3]) await anvil("anvil_setBalance", [a.address, "0x8ac7230489e80000"]);

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

const fits = () => run("document.documentElement.scrollWidth <= window.innerWidth + 1");
async function shots(name) {
  for (const [view, m] of [["desktop", DESKTOP], ["phone", PHONE]]) {
    await send("Emulation.setDeviceMetricsOverride", m);
    await sleep(500);
    const tall = await run("document.documentElement.scrollHeight");
    check(`${name} on a ${view}: nothing wider than the screen`, await fits());
    await run("window.scrollTo(0, 0)"); await sleep(300);
    await shot(`${view}-${name}-1`);
    if (tall > m.height * 1.3) { await run(`window.scrollTo(0, ${Math.max(0, tall - m.height)})`); await sleep(300); await shot(`${view}-${name}-2`); }
  }
  await send("Emulation.setDeviceMetricsOverride", DESKTOP);
  await run("window.scrollTo(0, 0)");
}

let exit = 1;
try {
  step("1  a wallet posts a bounty from the form");
  await as(POSTER);
  await go("/bounties");
  await shots("board");
  await connect();
  await fill("The task", "A landing page for our print shop");
  await fill("What you need, in full", "We print posters on thick paper. Say what it is, who it is for, and end with a link to the shop.");
  await fill("The prize, ETH", "0.005");
  await fill("Entries until", "1");
  await shots("post-filled");
  const before = await rd("bountyCount");
  await press("Lock the prize and post");
  await until("the post", async () => (await text()).includes("is posted"), 90_000);
  const b1 = Number(await rd("bountyCount"));
  check("the form posted it: one more bounty on the chain, with the words the hash of what was typed", BigInt(b1) === before + 1n && (await rd("bounty", [BigInt(b1)])).prize === 5000000000000000n);
  await until("its page with its words", async () => { await go(`/bounties/${b1}`); return (await text()).includes("We print posters on thick paper"); }, 40_000);
  check("the poster is told it cannot enter its own bounty", (await text()).includes("You posted this bounty"));

  step("2  a wallet agent enters from the page");
  await as(AGENT);
  await go(`/bounties/${b1}`);
  await press("Connect the agent's wallet or account");
  const WORKTEXT = "THE-WALLET-AGENTS-WORK: a page about thick paper posters, finished, in plain words.";
  await fill("Your work", WORKTEXT);
  await shots("enter-filled");
  await press("Enter, with 0.00005 ETH as a bond");
  await until("the entry", async () => (await text()).includes("You are in"), 90_000);
  check("it entered: on the chain", (await rd("entrants", [BigInt(b1)])).map((a) => a.toLowerCase()).includes(AGENT.address.toLowerCase()));
  await until("the page to say the entry is in", async () => { await go(`/bounties/${b1}`); return (await text()).includes("Your entry is in"); }, 30_000);
  check("its work is nowhere on the page", !(await text()).includes("THE-WALLET-AGENTS-WORK"));

  step("3  a passkey account registers and enters, with the gas paid");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: providerScript });
  await send("Runtime.removeBinding", { name: "__factorWalletBridge" });
  await send("WebAuthn.enable");
  await send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await go("/work");
  await run("try { localStorage.removeItem('factor-wallet') } catch (e) {}");
  check("there is no wallet in this page", await run("typeof window.ethereum === 'undefined'"));
  await press("Connect, or use a passkey");
  await press("Create an account");
  const session = await until("the account to be made", async () => { const raw = await run("localStorage.getItem('factor-account')"); return raw ? JSON.parse(raw) : null; }, 90_000);
  const person = session.address;
  await anvil("anvil_setBalance", [person, "0x2386f26fc10000"]); // 0.01
  await until("the Register button", async () => { await go("/work"); return has("Register this account") || has("Register this wallet") || has("Register"); }, 40_000);
  const reg = (await has("Register this account")) ? "Register this account" : (await has("Register this wallet")) ? "Register this wallet" : "Register";
  await press(reg);
  await until("it to be on the desk", async () => (await chain.readContract({ address: bare.desk, abi: parseAbi(["function agent(address) view returns ((bool registered, bool barred, uint40 firstSettledAt, uint32 settled, uint32 settledAtHalf, uint32 notDelivered, uint32 unanswered, uint32 customers, uint32 onTime, uint32 late, uint32 advancesRepaid, uint32 advancesNotRepaid, uint32 earlyKept, uint256 bond, uint256 feesPaid, uint256 advancedNow, uint256 volume))"]), functionName: "agent", args: [person] })).registered, 90_000);
  await go(`/bounties/${b1}`);
  const PK_WORK = "THE-PASSKEY-AGENTS-WORK: another page about posters.";
  await fill("Your work", PK_WORK);
  await press("Enter, with 0.00005 ETH as a bond");
  await until("the passkey's entry", async () => (await text()).includes("You are in"), 120_000);
  check("the passkey account entered, its own bond and Factor's gas", (await rd("entrants", [BigInt(b1)])).map((a) => a.toLowerCase()).includes(person.toLowerCase()) && (await chain.getBalance({ address: person })) === 9950000000000000n, person);
  await run("localStorage.removeItem('factor-account')");

  step("4  from the deadline the poster reads by signature in the page, and picks");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PROVIDER }).then((r) => r);
  await send("Runtime.addBinding", { name: "__factorWalletBridge" });
  await warp(3700);
  await as(POSTER);
  await until("the page to say the poster is choosing", async () => { await go(`/bounties/${b1}`); return (await text()).includes("The poster is choosing") || (await text()).includes("Read the entries, and pick a winner"); }, 40_000);
  await shots("choosing-public");
  check("past the deadline the public still reads only a count", !(await text()).includes("THE-WALLET-AGENTS-WORK"));
  if (await has("Connect it")) await press("Connect it"); else await connect();
  await press("Read the entries");
  await until("the entries in the page", async () => (await text()).includes("THE-WALLET-AGENTS-WORK") && (await text()).includes("THE-PASSKEY-AGENTS-WORK"), 30_000);
  await shots("poster-reads");
  check("one signature shows the poster every entry", wallet.signed > 0, `${wallet.signed} signature`);
  await inPage(`const e = [...document.querySelectorAll(".entry")].find((x) => x.innerText.includes("THE-WALLET-AGENTS-WORK")); [...e.querySelectorAll("button")].find((b) => b.textContent.trim() === "Pick this one").click(); return true;`);
  await until("the final words", async () => (await text()).includes("This is final"), 10_000);
  await inPage(`const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("This is final")); b.click(); return true;`);
  await until("the winner", async () => (await rd("bounty", [BigInt(b1)])).state === 2, 90_000);
  check("the poster picked: the prize is on the desk for the winner", (await rd("bounty", [BigInt(b1)])).winner.toLowerCase() === AGENT.address.toLowerCase());

  step("5  the winner delivers from the page and is paid, and every entry is public");
  await as(AGENT);
  await until("the winner's button", async () => { await go(`/bounties/${b1}`); return (await text()).includes("Every entry, in the open"); }, 40_000);
  check("every entry is on the page now", (await text()).includes("THE-PASSKEY-AGENTS-WORK") && (await text()).includes("THE-WALLET-AGENTS-WORK"));
  await connect().catch(() => undefined);
  await until("the delivery button", async () => has("Deliver and be paid"), 30_000);
  await shots("deliver");
  const paid0 = await chain.getBalance({ address: AGENT.address });
  await press("Deliver and be paid");
  await until("the keeper to close it", async () => (await rd("bounty", [BigInt(b1)])).state === 3, 120_000);
  check("it is won: the keeper accepted on the desk, and the winner is paid", (await chain.getBalance({ address: AGENT.address })) > paid0);
  await until("the winner page", async () => { await go(`/bounties/${b1}`); return (await text()).includes("delivered its entry and was paid"); }, 40_000);
  await shots("winner-page");
  await go(`/agents/${AGENT.address.toLowerCase()}`);
  await until("the bounties on the agent's page", async () => { await go(`/agents/${AGENT.address.toLowerCase()}`); return (await text()).includes("Won a bounty"); }, 40_000);
  await run(`document.getElementById("bounties")?.scrollIntoView()`);
  await shot("desktop-agent-bounties");
  check("the win is on the agent's page", (await text()).includes("Bounties"));

  step("6  a passkey account posts, reads with its passkey, and picks");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: providerScript }).catch(() => undefined);
  await send("Runtime.removeBinding", { name: "__factorWalletBridge" }).catch(() => undefined);
  await go("/bounties");
  await run("try { localStorage.removeItem('factor-wallet'); localStorage.removeItem('factor-account') } catch (e) {}");
  await go("/bounties");
  await press("Connect, or use a passkey");
  await press("Create an account");
  const s2 = await until("the second account", async () => { const raw = await run("localStorage.getItem('factor-account')"); const v = raw ? JSON.parse(raw) : null; return v && v.address !== person ? v : null; }, 90_000);
  const poster2 = s2.address;
  await anvil("anvil_setBalance", [poster2, "0x2386f26fc10000"]);
  await go("/bounties");
  await fill("The task", "A landing page for our second shop");
  await fill("Entries until", "1");
  await press("Lock the prize and post");
  await until("the passkey's post", async () => (await text()).includes("is posted"), 120_000);
  const b2 = Number(await rd("bountyCount"));
  check("a passkey account posted, its own ETH and Factor's gas", (await rd("bounty", [BigInt(b2)])).poster.toLowerCase() === poster2.toLowerCase());
  const { result: tx } = await anvil("eth_sendRawTransaction", [await AGENT3.signTransaction({ chainId: 4663, nonce: await chain.getTransactionCount({ address: AGENT3.address }), gas: 300000n, maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 0n, to: bare.bounty, value: 50000000000000n, data: (await import("viem")).encodeFunctionData({ abi: parseAbi(["function enter(uint256,address,bytes32) payable"]), functionName: "enter", args: [BigInt(b2), AGENT3.address, (await import("viem")).keccak256((await import("viem")).encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }], [bare.bounty, BigInt(b2), AGENT3.address, (await import("viem")).keccak256((await import("viem")).toHex("THE-THIRD-AGENTS-WORK"))]))] }) })]);
  await chain.waitForTransactionReceipt({ hash: tx, timeout: 30_000, pollingInterval: 200 });
  await until("its work taken", async () => (await fetch(`${SITE}/api/v1/bounties/entry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: b2, agent: AGENT3.address.toLowerCase(), work: "THE-THIRD-AGENTS-WORK" }) })).ok, 30_000);
  await warp(3700);
  await until("the choosing page", async () => { await go(`/bounties/${b2}`); return (await text()).includes("Read the entries, and pick a winner"); }, 40_000);
  await press("Read the entries");
  await until("the entry in the page", async () => (await text()).includes("THE-THIRD-AGENTS-WORK"), 60_000);
  check("the passkey signed the read, and the engine took the account's key as the poster's", (await text()).includes("THE-THIRD-AGENTS-WORK"));
  await inPage(`[...document.querySelectorAll(".entry button")].find((b) => b.textContent.trim() === "Pick this one").click(); return true;`);
  await until("the final words", async () => (await text()).includes("This is final"), 10_000);
  await inPage(`[...document.querySelectorAll("button")].find((x) => x.textContent.includes("This is final")).click(); return true;`);
  await until("the pick", async () => (await rd("bounty", [BigInt(b2)])).state === 2, 120_000);
  check("the passkey account picked its winner", (await rd("bounty", [BigInt(b2)])).winner.toLowerCase() === AGENT3.address.toLowerCase());

  const bad = problems.filter((p) => !/status of 40[04]/.test(p));
  check("the page itself complained of nothing", bad.length === 0, bad.slice(0, 3).join(" | "));
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`);
  exit = failed.length ? 1 : 0;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
} finally {
  try { process.kill(-chrome.pid, "SIGKILL"); } catch { /* gone */ }
  process.exit(exit);
}
