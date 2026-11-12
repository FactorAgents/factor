// Builds nothing: it expects `next build` to have run, serves the site and reads the real HTML of every page. What
// it holds the site to: each page is there with one main heading and the same header, the copy keeps to the rules,
// an address that does not exist says so, and each document is small enough for a phone.
//
// Two servers: one on the sample (FACTOR_SAMPLE=1, every page with something in it), and one with nothing set, which
// must show an empty desk and never a sample figure. The site on a real engine is tested by scripts/flows.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.SMOKE_PORT) || 3611, BASE = `http://127.0.0.1:${PORT}`, BARE = `http://127.0.0.1:${PORT + 1}`;
// the sample's verifiers (lib/verifiersSample.ts): factor-claude, one of Factor's own
const CLAUDE = "0x5abe732d259d4a69189773efce14dea3dc976cbc";
const PAGES = ["/bounties", "/bounties/1", "/bounties/2", "/bounties/3", "/bounties/4", "/", "/agents/orbit-ops", "/ledger", "/ledger?show=burned", "/agents", "/agents/lumen-07", "/jobs/0412", "/jobs/0406", "/jobs/0404", "/jobs/0403", "/hire", "/hire?agent=page-smith", "/hire?agent=lumen-07&cover=1", "/work", "/protocol", "/token", "/burn", "/docs", "/log", "/security", "/pay", "/firms/night-desk", "/hire?firm=night-desk", "/plans/0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a", "/open-jobs", "/open-jobs/0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", "/coins", "/coins?sort=new", "/coins/page-smith", "/jobs/0416", "/jobs/0408", "/agents/page-smith", "/hire?stages=1", "/everywhere", "/hire?agent=lumen-07&price=0.01&title=Summarise+one+contract&due=48&early=1", "/ask", "/ask?q=A+landing+page+for+my+coin", "/hire?agent=page-smith&price=0.003&title=A+landing+page&due=38&via=ask", "/copilot", "/copilot?q=What+is+lumen-07%27s+score", "/verifiers", `/verifiers/${CLAUDE}`, "/jobs/0419", "/jobs/0421", "/jobs/0422", "/jobs/0424", "/hire?agent=price-desk&verifier=1", "/reports", "/reports?page=1", "/reports/486", "/reports/467", "/reports/20852", "/vouching"];
// The header's five groups and the pages in each, in order. A group of one page is a plain link.
const GROUPS = { Hire: ["/ask", "/copilot", "/hire", "/open-jobs", "/bounties"], Agents: ["/agents", "/reports", "/coins", "/work", "/verifiers", "/vouching"], Ledger: ["/ledger"], Protocol: ["/protocol", "/docs", "/everywhere", "/roadmap"], Token: ["/token", "/burn"] };
const NAV = Object.values(GROUPS).flat();
// the group each page is in, which the header marks as the current one (none for a page of no group)
const CURRENT = { "/ask": "Hire", "/copilot": "Hire", "/bounties": "Hire", "/bounties/1": "Hire", "/hire": "Hire", "/open-jobs": "Hire", "/agents": "Agents", "/agents/lumen-07": "Agents", "/jobs/0412": "Agents", "/coins/page-smith": "Agents", "/work": "Agents", "/verifiers": "Agents", [`/verifiers/${CLAUDE}`]: "Agents", "/reports": "Agents", "/reports/486": "Agents", "/vouching": "Agents", "/ledger": "Ledger", "/protocol": "Protocol", "/docs": "Protocol", "/everywhere": "Protocol", "/token": "Token", "/burn": "Token", "/": null, "/log": null, "/security": null, "/pay": null };
// Words the copy does not use: no long dash, no promise of gain. A list kept beside this file and out of the repo
// (forbidden.local.json, pairs of pattern and flags) adds to them on the machine it is on.
const LOCAL = new URL("./forbidden.local.json", import.meta.url);
// "Guarantee" is the name of a feature (an agent's guarantee bond, and the cover it sells: "Guaranteed up to"), so the
// word itself is allowed; a guarantee of any gain is not.
const FORBIDDEN = [/—/, /\binvest/i, /\breturns?\b/i, /\bprofit/i, /\byield/i, /guarantee[sd]?\s+(of\s+)?(an?\s+|your\s+)?(returns?|profits?|gains?|income|earnings|price|pump)/i, /guaranteed\s+(to\s+)?(rise|grow|go up|earn|pay out)/i, ...(existsSync(LOCAL) ? JSON.parse(readFileSync(LOCAL, "utf8")).map(([p, f]) => new RegExp(p, f)) : [])];
let server, bare, pushed, unpushed, raetoSite;
// A stand-in for the engine's live stream (engine/src/live.ts): it says hello to each stream it is asked for, and
// sends what a test tells it to. Everything else it answers 404, so the pages on it show an engine with no figures.
const engine = { streams: new Set(), opened: 0 };
const fakeEngine = createServer((req, res) => {
  if (req.url !== "/v1/live") { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
  engine.opened++;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" });
  res.write(`event: hello\ndata: {"seq":0}\n\n`);
  engine.streams.add(res);
  res.on("close", () => engine.streams.delete(res));
});
const engineSays = (event, data) => { for (const r of engine.streams) r.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
// a page's words with React's joins taken out: "Anthropic , running" reads "Anthropic, running"
const plain = (html) => text(html).replace(/<!-- -->/g, "").replace(/ ([,.;:%])/g, "$1");
const get = async (path, base = BASE) => { const r = await fetch(base + path); return { status: r.status, html: await r.text(), headers: r.headers }; };
// next itself, in a process group of its own, so that stopping it leaves nothing running
const start = (port, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, FACTOR_ENGINE_URL: "", FACTOR_SAMPLE: "", ...env } });
  const t = setTimeout(() => reject(new Error("the site did not start")), 30_000);
  child.stdout.on("data", (d) => { if (/Ready|Local:/i.test(String(d))) { clearTimeout(t); resolve(child); } });
});
const stop = (child) => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } child.stdout.destroy(); child.stderr.destroy(); };

before(async () => {
  await new Promise((r) => fakeEngine.listen(0, "127.0.0.1", r));
  const ENGINE = `http://127.0.0.1:${fakeEngine.address().port}`;
  raetoSite = await start(PORT + 4, { FACTOR_SAMPLE: "1", FACTOR_SAMPLE_RAETO: "1" });
  [server, bare, pushed, unpushed] = await Promise.all([start(PORT, { FACTOR_SAMPLE: "1" }), start(PORT + 1, {}), start(PORT + 2, { FACTOR_ENGINE_URL: ENGINE }), start(PORT + 3, { FACTOR_ENGINE_URL: ENGINE, LIVE_PUSH: "off" })]);
});
after(() => { stop(server); stop(bare); stop(pushed); stop(unpushed); stop(raetoSite); for (const r of engine.streams) r.destroy(); fakeEngine.close(); });

test("raeto/auto: nothing about it while it is off, on any page or in the log", async () => {
  for (const path of ["/", "/work", "/docs", "/log", "/jobs/0414", "/agents/orbit-ops", "/protocol", "/security"]) {
    const { status, html } = await get(path);
    assert.equal(status, 200, path);
    assert.doesNotMatch(html, /raeto/i, `${path} speaks of Raeto while it is off`);
  }
  assert.doesNotMatch((await get("/api/v1/compute/v1/models")).html, /raeto/i);
  assert.doesNotMatch((await get("/api/v1/compute/models")).html, /raeto/i);
});

test("raeto/auto: when it is on, the work page, the docs, the log, a job's page and an agent's page say how it works and what was spent", async () => {
  const on = async (path) => { const r = await get(path, `http://127.0.0.1:${PORT + 4}`); return { ...r, html: r.html.replace(/<!-- -->/g, "") }; };
  const work = text((await on("/work")).html);
  assert.match(work, /raeto\/auto/);
  assert.match(work, /Raeto.s charge \+ 5%/);
  assert.match(work, /Model \+ 8% \+ routing/);
  assert.match(work, /at most \$0\.000200/);
  assert.match(work, /\$5\.67 in · \$28\.35 out/);
  assert.match(work, /Built on Raeto/);
  const docs = text((await on("/docs")).html);
  assert.match(docs, /x-raeto-model/);
  assert.match(docs, /x-factor-cost-usd/);
  assert.match(docs, /nothing is taken from the credit/);
  assert.match(text((await on("/log")).html), /raeto\/auto Agent|raeto\/auto An agent/);
  for (const path of ["/jobs/0414", "/agents/orbit-ops"]) {
    const page = text((await on(path)).html);
    assert.match(page, /Compute it spent/, path);
    assert.match(page, /anthropic\/claude-sonnet-5\.5/, path);
    assert.match(page, /mistralai\/mistral-small-3\.2-24b-instruct/, path);
    assert.match(page, /top tier, 1 call/, path);
    assert.match(page, /\$0\.000214/, path);
  }
  assert.doesNotMatch(text((await on("/jobs/0412")).html), /Compute it spent/);
  const models = await (await fetch(`http://127.0.0.1:${PORT + 4}/api/v1/compute/v1/models`)).json();
  assert.equal(models.data[0].id, "raeto/auto");
  // no partnership and no figure of savings
  for (const path of ["/work", "/docs", "/log"]) {
    const page = text((await on(path)).html);
    assert.doesNotMatch(page, /partner(ed|ship)? with Raeto|cheaper|savings|saves? you/i, path);
  }
});

test("every page answers, with one main heading and the header that leads to the others", async () => {
  for (const path of PAGES) {
    const { status, html } = await get(path);
    assert.equal(status, 200, path);
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, `${path} has one main heading`);
    // the header itself leads to every page, each in its group, and folds them the same way into the phone's menu
    const header = /<header class="top">[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
    const menu = /<nav class="menu[^"]*" aria-label="Pages">[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    assert.ok(header && menu, `${path} has no header, or no menu`);
    for (const to of NAV) {
      assert.match(header, new RegExp(`href="${to}"`), `${path}: the header does not lead to ${to}`);
      assert.match(menu, new RegExp(`href="${to}"`), `${path}: the menu does not lead to ${to}`);
    }
    assert.match(menu, /href="\/log"/, `${path}: the menu has no Dev log`);
    for (const [name, pages] of Object.entries(GROUPS)) {
      if (pages.length === 1) {
        assert.match(header, new RegExp(`<a [^>]*href="${pages[0]}"[^>]*>${name}</a>`), `${path}: ${name} is not a plain link`);
        continue;
      }
      const button = new RegExp(`<button[^>]*data-group="${name}"[^>]*>`).exec(header)?.[0] ?? "";
      assert.match(button, /aria-expanded="false"/, `${path}: the ${name} group is not a closed button`);
      assert.match(button, new RegExp(`aria-controls="pages-${name.toLowerCase()}"`), `${path}: the ${name} group names no list`);
      const list = new RegExp(`<div class="drop" id="pages-${name.toLowerCase()}"[^>]*>([\\s\\S]*?)</div>`).exec(header)?.[1] ?? "";
      assert.deepEqual([...list.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), pages, `${path}: the ${name} group holds other pages`);
      assert.match(menu, new RegExp(`<div class="label mh">${name}</div>`), `${path}: the menu has no ${name} heading`);
    }
    // the group of the page being read, and only it, is marked as current
    if (path in CURRENT) {
      const marked = [...header.matchAll(/<button[^>]*data-group="([^"]+)"[^>]*>/g)].filter((m) => /class="on"/.test(m[0]) && /aria-current="true"/.test(m[0])).map((m) => m[1]);
      const ledger = /<a [^>]*>Ledger<\/a>/.exec(header)?.[0] ?? "";
      if (/class="on"/.test(ledger) && /aria-current="page"/.test(ledger)) marked.push("Ledger");
      assert.deepEqual(marked, CURRENT[path] ? [CURRENT[path]] : [], `${path}: the wrong group is marked`);
    }
    assert.match(html, /BUY ON PONS|NOT LIVE YET/, `${path} has no buy button`);
    assert.match(html, /aria-label="GitHub/, `${path} has no GitHub icon`);
    assert.match(html, /at your own risk/, `${path} has no own-risk line`);
  }
});

test("the copy keeps to the rules on every page", async () => {
  for (const path of PAGES) {
    const t = text((await get(path)).html);
    for (const re of FORBIDDEN) assert.doesNotMatch(t, re, `${path} says ${re}`);
  }
});

test("a house agent is marked as one wherever it shows, and an agent that did not repay cannot draw", async () => {
  assert.match(text((await get("/agents/page-smith")).html), /House agent/);
  assert.match(text((await get("/agents")).html), /house agents, run by Factor/);
  const bad = text((await get("/agents/tally-bot")).html);
  assert.match(bad, /did not repay an advance/);
  // a barred agent draws nothing, and is not told "yet"
  assert.match(bad, /Can draw nothing (?!yet)/);
});

test("an agent's coin shows beside it, in the lists and on its own page, with its own risk and nothing about shares", async () => {
  const page = text((await get("/agents/page-smith")).html);
  assert.match(page, /\$SMITH/);
  assert.match(page, /pays for page-smith/);
  assert.match(text((await get("/agents")).html), /\$LUMEN/);
  assert.match(text((await get("/")).html), /Agent coins · 2/);
  const coin = text((await get("/coins/page-smith")).html);
  assert.match(coin, /Trade on Pons/);
  assert.match(coin, /its compute, its maker, the \$FACTOR burn and Factor/);
  assert.match(coin, /at your own risk/);
  const list = text((await get("/coins")).html);
  assert.match(list, /Page Smith/);
  for (const t of [page, coin, list]) assert.doesNotMatch(t, /\b(40|20)\s?%/, "a share of the fees is never said");
  assert.equal((await get("/coins/nobody-here")).status, 404);
  // the docs and the protocol say how a coin works, and name where its fees go without a share
  const docs = text((await get("/docs")).html);
  assert.match(docs, /An agent's own coin pays for its work/);
  assert.match(docs, /factor_launch_coin/);
  const protocol = text((await get("/protocol")).html);
  assert.match(protocol, /One coin per agent, and fees that run it/);
  assert.match(protocol, /The coin launcher/);
  for (const t of [docs.slice(docs.indexOf("Agent coins")), protocol.slice(protocol.indexOf("Agent coins"), protocol.indexOf("The contracts Where it lives"))]) assert.doesNotMatch(t, /\b(40|20)\s?%/);
  // the coin's picture: the agent's seal, as a picture any site can show
  const logo = await fetch(`${BASE}/api/v1/coins/logo/page-smith`);
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get("content-type") ?? "", /image\/png/);
});

test("a job's bill adds up", async () => {
  const t = text((await get("/jobs/0412")).html);
  // the rulebook's own example: 0.04 locked, 0.02 advanced with 0.0002 taken off it at the draw, a 2% job fee
  assert.match(t, /Locked by the customer.*0\.0400 ETH/);
  assert.match(t, /Fee on the job.*0\.0008 ETH/);
  assert.match(t, /Paid to the agent on delivery 0\.0192 ETH/);
  // rejected: 0.03 locked, 0.009 of compute, half back, 2% of the agent's half, the rest to the agent
  const half = text((await get("/jobs/0404")).html);
  assert.match(half, /Settled at half/);
  assert.match(half, /Returned to the customer.*0\.0150 ETH/);
  assert.match(half, /Paid to the agent on delivery 0\.0057 ETH/);
  assert.match(text((await get("/jobs/0403")).html), /Declined by the agent, returned to the customer 0\.0180 ETH/);
  assert.match(text((await get("/jobs/0406")).html), /the advance was not repaid/);
});

test("the pool's limit is the bond plus the fees, counted once, and the score follows the formula", async () => {
  const t = text((await get("/agents/lumen-07")).html);
  // 1.42 ETH of settled work at 2% is 0.0284 in fees; with a bond of 0.02 the limit is 0.0484
  assert.match(t, /Limit.*0\.0484 ETH/);
  assert.doesNotMatch(t, /times the fees|Counted \d/);
  // 56 for fees, 250 for customers, 200 for jobs, 18 for nine days, 100 for advances repaid
  assert.match(t, /624\s*of 1000/);
  assert.match(text((await get("/protocol")).html), /limit\(agent\) = bond ?\(agent\) \+ feesPaid ?\(agent\)/);
  assert.match(text((await get("/work")).html), /Your own ETH, held by the contract/);
});

test("an agent that has not signed a name shows under its address, and is found by it", async () => {
  const agents = (await (await fetch(BASE + "/api/v1/agents")).json()).items;
  const unnamed = agents.find((a) => !a.named);
  assert.ok(unnamed, "the sample has one");
  const { status, html } = await get(`/agents/${unnamed.address}`);
  assert.equal(status, 200);
  assert.match(text(html), /has registered and has not said what it does yet/);
  assert.match(text((await get("/agents")).html), /An agent that has not signed a name yet/);
  // a named agent is linked by its name, and found by its address too
  assert.match((await get("/agents")).html, /href="\/agents\/lumen-07"/);
  const named = agents.find((a) => a.name === "lumen-07");
  assert.equal((await get(`/agents/${named.address}`)).status, 200);
});

test("the SDK installs from the site itself, before it is on npm", async () => {
  const r = await fetch(`${BASE}/factor-kit.tgz`);
  assert.equal(r.status, 200);
  assert.ok((await r.arrayBuffer()).byteLength > 10_000);
  assert.match(text((await get("/docs")).html), /npm install https:\/\/factoragents\.fun\/factor-kit\.tgz/);
});

test("the burn page: the pot's clock and figures, the pool, every burn; before the launch it says when they start", async () => {
  const t = text((await get("/burn")).html);
  assert.match(t, /Next burn/);
  assert.match(t, /The burn pot/);
  assert.match(t, /Came in from trading/);
  assert.match(t, /0\.0123 ETH/);
  assert.doesNotMatch(t, /\b(10|20|70) ?%/);
  const bare = text((await get("/burn", BARE)).html);
  assert.match(bare, /Burns start at the launch/);
  assert.match(bare, /No burn yet: they start at the launch/);
  assert.doesNotMatch(bare, /0\.0123/);
});

test("the sample offers no wallet anything to send: its addresses are made up", async () => {
  const hire = text((await get("/hire")).html);
  assert.match(hire, /Nothing leaves your wallet until you confirm it there/);
  assert.match(hire, /Let the agent have half early/);
  assert.match(hire, /Nothing is live yet/);
  assert.doesNotMatch(hire, /Connect a wallet/);
  assert.match(text((await get("/work")).html), /Nothing is live yet/);
  assert.doesNotMatch(text((await get("/jobs/0414")).html), /What can be done/);
  for (const path of ["/", "/hire", "/work", "/jobs/0414"]) assert.doesNotMatch((await get(path)).html, />CONNECT</, path);
});

test("the browser's one door to the engine passes the public reads and nothing else", async () => {
  for (const path of ["state", "agents", "agents/lumen-07", "jobs", "jobs/412", "ledger", "burns"]) assert.equal((await fetch(`${BASE}/api/v1/${path}`)).status, 200, path);
  for (const path of ["health", "metrics", "admin/hide", "agents/profile", "jobs/title", "state/../health", "nothing"]) assert.equal((await fetch(`${BASE}/api/v1/${path}`)).status, 404, path);
  const post = (path, body) => fetch(`${BASE}/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("admin/hide", { what: "agent", key: "x" })).status, 404, "the owner's key is not usable through the site");
  assert.equal((await post("state", {})).status, 404);
  // with no engine behind the site a signed write has nowhere to go, and says so
  assert.equal((await post("agents/profile", {})).status, 503);
  assert.equal((await post("jobs/title", { title: "x".repeat(5000) })).status, 503);
  const jobs = await (await fetch(`${BASE}/api/v1/jobs?agent=${"0x" + "0".repeat(40)}&nonsense=1`)).json();
  assert.deepEqual(jobs.items, []);
});

test("the door to compute credit passes the gateway's own addresses and nothing else", async () => {
  const models = await (await fetch(`${BASE}/api/v1/compute/models`)).json();
  assert.equal(models.enabled, true);
  assert.ok(models.models.some((m) => m.id === "claude-sonnet-5-5" && m.inUsd === 2.1 && m.outUsd === 10.5));
  for (const path of ["health", "usage", "keys", "v1/messages", "credit/nobody", "models/../../health"]) assert.equal((await fetch(`${BASE}/api/v1/compute/${path}`)).status, 404, path);
  const post = (base, path, body) => fetch(`${base}/api/v1/compute/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "fck_" + "a".repeat(32) }, body });
  for (const path of ["models", "balance", "v1/complete", "v1/messages/batches", "admin"]) assert.equal((await post(BASE, path, "{}")).status, 404, path);
  // with no engine behind the site there is no gateway: said in the model maker's own shape, so its library reads it
  for (const base of [BASE, BARE]) {
    const r = await post(base, "v1/messages", JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 10, messages: [] }));
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { type: "error", error: { type: "api_error", message: "Nothing is live yet." } });
    assert.equal((await post(base, "key", "{}")).status, 503);
  }
  assert.equal((await post(BARE, "key", "x".repeat(5000))).status, 503);
  assert.equal((await fetch(`${BARE}/api/v1/compute/models`)).status, 503);
});

test("the door to accounts passes what an account asks of the engine and nothing else", async () => {
  const account = "0x" + "ab".repeat(20), order = "0x" + "cd".repeat(32);
  // the sample has no engine behind it: nothing of an account is made up
  for (const path of [`accounts/${account}`, `accounts/relay/${order}`, "accounts/by-credential/0xc0ffee"]) assert.equal((await fetch(`${BASE}/api/v1/${path}`)).status, 404, path);
  for (const path of ["accounts", "accounts/nobody", "accounts/relay/1", `accounts/${account}/keys`, "accounts/by-credential/zz"]) assert.equal((await fetch(`${BASE}/api/v1/${path}`)).status, 404, path);
  const post = (base, path, body) => fetch(`${base}/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const base of [BASE, BARE]) {
    for (const path of ["accounts", "accounts/check", "accounts/call", "accounts/relay"]) assert.equal((await post(base, path, {})).status, 503, path);
    for (const path of ["accounts/keys", "accounts/relay/x", "accounts/admin", `accounts/${account}`]) assert.equal((await post(base, path, {})).status, 404, path);
  }
  const state = await (await fetch(`${BASE}/api/v1/state`)).json();
  assert.deepEqual(state.accounts, { enabled: false, factory: null, ordersPerDay: 40 });
});

test("the site offers a passkey only where an engine can pay for it, and the docs say what an account is", async () => {
  for (const path of ["/hire", "/work", "/"]) {
    const { html } = await get(path);
    assert.doesNotMatch(html, /use a passkey/i, `${path} offers a passkey with nothing behind it`);
  }
  const t = text((await get("/docs")).html);
  assert.match(t, /gasless ?: true/);
  assert.match(t, /await factor\. ?withdraw ?\(/);
  assert.match(t, /Factor never holds a key/);
  assert.match(t, /Accounts are not switched on yet/);
  assert.match(t, /Nobody can bring an account back/);
});

test("a job's page carries its brief and the work, and a delivered page is served to run nothing", async () => {
  const reading = text((await get("/jobs/0411")).html);
  assert.match(reading, /THE BRIEF/i);
  assert.match(reading, /This lease is made between the landlord and the tenant/);
  assert.match(reading, /WHAT TO WATCH FOR/);
  assert.match(reading, /Its fingerprint is the proof the contract holds for this job/);
  assert.match(text((await get("/jobs/0410")).html), /NVDA\s+\$224\.15/);
  // a job with no words shows no such part
  assert.doesNotMatch(text((await get("/jobs/0412")).html), /THE WORK/i);
  // a page: in a frame on the job's page that can run nothing...
  const built = (await get("/jobs/0408")).html;
  assert.match(built, /<iframe[^>]*src="\/jobs\/0408\/work\?frame"[^>]*sandbox=""/);
  // ...and by itself under a policy of its own: no script, no form, no request, no origin
  const page = await fetch(`${BASE}/jobs/0408/work`);
  assert.equal(page.status, 200);
  const policy = page.headers.get("content-security-policy") ?? "";
  for (const part of ["sandbox", "default-src 'none'", "form-action 'none'", "frame-ancestors 'self'"]) assert.ok(policy.split("; ").includes(part), `the delivered page's policy lacks ${part}: ${policy}`);
  assert.doesNotMatch(policy, /script-src|allow-scripts|allow-same-origin|allow-forms/);
  assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(page.headers.get("x-robots-tag") ?? "", /noindex/);
  const body = await page.text();
  assert.match(body, /A page delivered by page-smith for job 0408 on Factor\. It is not a page of Factor's/);
  assert.match(body, /Charts from the sheet you already have/);
  // saved, it is the file as it was delivered, with nothing added
  const saved = await fetch(`${BASE}/jobs/0408/work?save`);
  assert.match(saved.headers.get("content-disposition") ?? "", /attachment; filename="factor-job-0408\.html"/);
  assert.doesNotMatch(await saved.text(), /A page delivered by/);
  // every other page keeps the site's own policy, and may be framed by nobody
  const job = await fetch(`${BASE}/jobs/0408`);
  assert.match(job.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(job.headers.get("x-frame-options"), "DENY");
  for (const path of ["/jobs/0411/work", "/jobs/0412/work", "/jobs/9999/work", "/jobs/x/work"]) assert.equal((await fetch(`${BASE}${path}`)).status, 404, path);
});

test("Factor's own agents say what they take a job for, on their page and where they are hired", async () => {
  const t = text((await get("/agents/page-smith")).html);
  assert.match(t, /House agent/);
  assert.match(t, /Run by Factor\. Say what the page is for/);
  assert.match(t, /It takes a job from 0\.003 ETH/);
  assert.doesNotMatch(text((await get("/agents/lumen-07")).html), /Run by Factor/);
  const hire = text((await get("/hire?agent=plain-reader")).html);
  assert.match(hire, /THE BRIEF/i);
  assert.match(hire, /Paste the text itself into the brief/);
  assert.match(hire, /Anyone can read a brief on the job.s page/);
  const post = (base, path, body) => fetch(`${base}/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  for (const path of ["jobs/brief", "jobs/delivery"]) assert.equal((await post(BARE, path, {})).status, 503, path);
});

test("the security page says where a report goes, what counts, and what cannot be stopped", async () => {
  const t = text((await get("/security")).html);
  assert.match(t, /Tell us first/);
  assert.match(t, /The contracts cannot be stopped/);
  assert.match(t, /No outside firm has audited these contracts/);
  assert.match(t, /decided case by case/);
  assert.match(t, /By direct message on X/);
  assert.match((await get("/")).html, /href="\/security"/);
  // the file researchers look for first, once there is somewhere to write to
  const file = await fetch(`${BASE}/.well-known/security.txt`);
  assert.equal(file.status, 200);
  const body = await file.text();
  assert.match(body, /^Contact: https:\/\/x\.com$/m);
  assert.match(body, new RegExp(`^Policy: ${BASE}/security$`, "m"));
  assert.match(body, /^Expires: \d{4}-\d{2}-\d{2}T/m);
  // with nothing live there is nowhere to write to yet, and the page says so
  assert.equal((await fetch(`${BARE}/.well-known/security.txt`)).status, 404);
  const bare = text((await get("/security", BARE)).html);
  assert.match(bare, /The address to write to will be here when Factor is live/);
  assert.match(bare, /not deployed yet/);
});

test("making an agent on the site says plainly who holds its key, and is shut until it is switched on", async () => {
  const t = text((await get("/work")).html);
  assert.match(t, /Make one here, in a minute\./);
  assert.match(t, /Factor holds the agent's key/);
  assert.match(t, /you are trusting Factor to run it/);
  assert.match(t, /less what the model cost/);
  assert.match(t, /This opens with the launch\./);
  assert.match((await get("/agents")).html, /href="\/work#make"[^>]*>Make an agent</);
});

test("before the launch the site makes nothing up: no sample figure, no example line, no burn and no fee that did not happen", async () => {
  for (const path of ["/", "/ledger", "/agents", "/hire", "/work", "/protocol", "/token", "/burn", "/docs", "/log", "/security"]) {
    const { status, html } = await get(path, BARE);
    assert.equal(status, 200, path);
    const t = text(html);
    // (page-smith is a real agent's name now, and the dev log says so: the sample's own names are the mark)
    assert.doesNotMatch(t, /lumen-07|quill-02|orbit-ops|4,120,553|0\.62 ETH/, `${path} shows a sample figure`);
    assert.match(html, /NOT LIVE YET/, path);
    assert.doesNotMatch(html, />CONNECT</, `${path} offers a wallet with nothing to send to`);
  }
  assert.match(text((await get("/", BARE)).html), /No agent has registered yet/);
  // with nothing live the home page says so, and prints no line of a kind that needs a desk or a token
  const home = text((await get("/", BARE)).html);
  assert.match(home, /Nothing has happened on the desk yet/);
  assert.doesNotMatch(home, /Every line, printed as it is written/);
  for (const path of ["/", "/ledger"]) assert.doesNotMatch(text((await get(path, BARE)).html), /example · |bought back and burned|trading fees arrived|locked the payment|drew an advance/, path);
  assert.match(text((await get("/hire", BARE)).html), /Nothing is live yet/);
  assert.match(text((await get("/protocol", BARE)).html), /not deployed yet/);
  assert.equal((await get("/agents/lumen-07", BARE)).status, 404);
  assert.equal((await get("/jobs/0412", BARE)).status, 404);
  assert.equal((await fetch(`${BARE}/api/v1/state`)).status, 503);
});

test("the docs show the kit as it is: the install, an agent, a customer, and the assistant's tools with its caps", async () => {
  const t = text((await get("/docs")).html);
  assert.match(t, /npm install https:\/\/factoragents\.fun\/factor-kit\.tgz/);
  assert.match(t, /for await \(const job of factor\.jobsForMe \(\)\)|for await \(const job of factor\. ?jobsForMe ?\(\)\)/);
  assert.match(t, /await factor\. ?hire ?\(\{/);
  assert.match(t, /FACTOR_MAX_JOB_ETH/);
  assert.match(t, /Two caps you set, which it cannot lift/);
  assert.match(t, /It never sees the key/);
  assert.match(t, /canDrawOn ?\(jobId\) view/);
});

test("the docs show compute credit: the model maker's library with the address changed, the models and their prices", async () => {
  const t = text((await get("/docs")).html);
  assert.match(t, /import OpenAI from &quot;openai&quot;|import OpenAI from "openai"/);
  assert.match(t, /const credit = await factor\. ?compute ?\(\)/);
  assert.match(t, /baseURL: credit\. ?openaiBaseURL/);
  assert.match(t, /claude-sonnet-5-5 ?\$2\.10 in · \$10\.50 out/);
  assert.match(t, /Never what was asked or answered/);
  // with nothing live the page says it is not switched on, and shows no price
  const bare = text((await get("/docs", BARE)).html);
  assert.match(bare, /Compute credit is not switched on yet/);
  assert.doesNotMatch(bare, /\$2\.10 in/);
});

test("Pay with Factor: the page signs agents up and gives a marketplace three steps, a link that is not one is refused politely, and the record, the badge and x402 are open to other sites", async () => {
  const page = text((await get("/pay")).html);
  assert.match(page, /Get paid for your agent's work, anywhere ?\./);
  assert.match(page, /Add Pay with Factor to your marketplace in three steps ?\./);
  assert.match(page, /signs it, so nobody can change it on the way/);
  const bad = await get("/pay/not-a-link.at-all");
  assert.equal(bad.status, 200);
  assert.match(text(bad.html), /This link cannot be paid\./);
  assert.match(text(bad.html), /Nothing was taken from anybody/);
  for (const re of FORBIDDEN) assert.doesNotMatch(text(bad.html), re);
  const pre = await fetch(`${BASE}/api/v1/record/lumen-07`, { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  const rec = await fetch(`${BARE}/api/v1/record/lumen-07`);
  assert.equal(rec.status, 503);
  assert.equal(rec.headers.get("access-control-allow-origin"), "*");
  const badge = await fetch(`${BARE}/api/v1/badge/0x0000000000000000000000000000000000000001`);
  assert.match(badge.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  assert.match(await badge.text(), /Paid with Factor/);
  const x = await fetch(`${BARE}/api/v1/x402/nope`);
  assert.equal(x.status, 404);
  assert.equal(x.headers.get("access-control-allow-origin"), "*");
  const button = await fetch(`${BASE}/pay/button.js`);
  assert.equal(button.status, 200);
  const js = await button.text();
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|sendBeacon|document\.cookie|localStorage/, "the button script calls nothing and keeps nothing");
  const docs = text((await get("/docs")).html);
  assert.match(docs, /createPayLink/);
  assert.match(docs, /payX402/);
  assert.match(docs, /factor-lock/);
});

test("the docs say how an agent hires agents for part of a job, what the chain holds and what Factor holds", async () => {
  const t = text((await get("/docs")).html);
  assert.match(t, /Agents that hire agents/);
  assert.match(t, /hireForJob/);
  assert.match(t, /On the chain, by the contract/);
  assert.match(t, /By Factor&#x27;s engine|By Factor's engine/);
  assert.match(t, /Due before the job itself/);
  assert.match(t, /factor_hire_for_job/);
});

test("the Factor Score: on an agent's page with its parts, the income behind it and what the desk lets it draw; on a firm's page; in the list, ordered by it; in the docs", async () => {
  const t = text((await get("/agents/lumen-07")).html);
  assert.match(t, /Factor Score All its paid work, in one number ?\./);
  assert.match(t, /624\s*of 1000 Most of it from jobs settled \(200\) and different customers \(250\)|624\s*of 1000 Most of it from different customers \(250\) and jobs settled \(200\)/);
  assert.match(t, /Jobs settled · 41 200 of 200 41 jobs delivered and paid in full\. 10 points each, up to 200\./);
  assert.match(t, /It is the desk.s own score: score\( ?0x/);
  // what it can draw is the desk's, and the score never moves it
  assert.match(t, /Limit with the pool the bond plus the fees, counted once 0\.0484 ETH/);
  assert.match(t, /nobody can change the rule\. The score does not move it\./);
  // where it comes from: each way, the firm's job among them, and the total adds up to the fees above
  assert.match(t, /Where it comes from/);
  assert.match(t, /Firm work jobs hired through a firm it leads.* 1 0 0\.0400 ETH 0\.0008 ETH/);
  assert.match(t, /All of it 41 0 1\.4200 ETH 0\.0284 ETH Each job counts once\. Monthly clients and sub-jobs count here too, the moment there are any\./);
  assert.match((await get("/agents/lumen-07")).html, /\/api\/v1\/badge\/0x[0-9a-f]{40}\?show=score/);
  // a firm's: the same formula over its jobs, drawn on through its lead
  const f = text((await get("/firms/night-desk")).html);
  assert.match(f, /Factor Score · the firm \d+\s*of 1000/);
  assert.match(f, /What can be drawn · through lumen-07/);
  assert.match(f, /A firm draws through its lead\./);
  assert.match(f, /Jobs hired through the firm/);
  // the list: every agent's Factor Score, and the order can change
  const list = text((await get("/agents")).html);
  assert.match(list, /Order by Factor Score Can draw Jobs settled Newest/);
  assert.match(list, /Factor Score 624/);
  assert.match(list, /Night Desk .* Factor Score \d+/);
  assert.ok(list.indexOf("lumen-07") < list.indexOf("An agent that has not signed a name yet"), "the highest score first");
  const newest = text((await get("/agents?sort=new")).html);
  assert.ok(newest.indexOf("An agent that has not signed a name yet") < newest.indexOf("lumen-07"), "the newest first");
  assert.match(newest, /Order by Factor Score Can draw Jobs settled Newest/);
  // the docs say how it is made
  const d = text((await get("/docs")).html);
  assert.match(d, /12 Factor Score/);
  assert.match(d, /What it can draw is not the score.s to say\./);
});

test("an address that does not exist says so", async () => {
  for (const path of ["/nope", "/agents/nobody", "/jobs/9999", "/firms/no-such-firm", "/firms/Not_A_Slug", `/plans/0x${"00".repeat(32)}`, "/plans/not-a-plan"]) assert.equal((await get(path)).status, 404, path);
});

test("agent firms: listed with the agents, a firm's page with its members and each one's part, its record and badge, and the docs", async () => {
  const list = text((await get("/agents")).html);
  assert.match(list, /Firms · 1/);
  assert.match(list, /Night Desk Contracts read overnight, every change watched Led by lumen-07/);
  const page = await get("/firms/night-desk");
  const t = text(page.html);
  assert.match(t, /Night Desk/);
  assert.match(t, /a firm · since .* · led by lumen-07/);
  assert.match(t, /Hire the firm/);
  assert.match(page.html, /href="\/hire\?firm=night-desk"/);
  // its members, each with its role and its part; the invited one says it has not signed to join
  assert.match(t, /lumen-07 Lead · since .* Firm jobs 1 Settled 1 Worth 0\.0400 ETH/);
  assert.match(t, /orbit-ops Member · since/);
  assert.match(t, /quill-02 Invited · has not signed to join yet/);
  // the shared record, the badge and the record for an app
  assert.match(t, /Jobs hired 1 Settled 1 Settled work 0\.0400 ETH Parts split out 0/);
  assert.match(page.html, /\/api\/v1\/firms\/night-desk\/badge/);
  assert.match(t, /GET https:\/\/factoragents\.fun\/api\/v1\/firms\/night-desk\/record/);
  // the list itself lives with the agents
  const r = await fetch(`${BASE}/firms`, { redirect: "manual" });
  assert.ok([307, 308].includes(r.status) && /\/agents#firms$/.test(r.headers.get("location") ?? ""), `/firms goes to the agents: ${r.status} ${r.headers.get("location")}`);
  // the hire form offers the firm, through its lead
  assert.match(text((await get("/hire?firm=night-desk")).html), /The agent, or a firm|The agent/);
  // the door passes the firms' reads, and their writes go to the engine only
  assert.equal((await fetch(`${BASE}/api/v1/firms`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/v1/firms/night-desk`)).status, 200);
  for (const w of ["firms/form", "firms/join", "firms/leave", "firms/hire"]) assert.equal((await fetch(`${BASE}/api/v1/${w}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 503, w);
  assert.equal((await fetch(`${BASE}/api/v1/firms/night-desk/record`)).status, 503, "the sample has no record to sign");
  const badge = await fetch(`${BASE}/api/v1/firms/night-desk/badge`);
  assert.equal(badge.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  // the docs say how firms work
  const d = text((await get("/docs")).html);
  assert.match(d, /10 Agent firms/);
  assert.match(d, /formFirm/);
  assert.match(d, /hireFirm/);
  assert.match(d, /A job is the firm.s only when it is locked for its lead/);
  assert.match(d, /factor_hire_firm/);
});

test("each page is small enough for a phone, and nothing loads from another site but HEY's badge for Factor", async () => {
  for (const path of PAGES) {
    const { html, headers } = await get(path);
    // the docs, with every section on, are the largest page: still a fraction of one picture
    assert.ok(html.length < 290_000, `${path} is ${html.length} bytes`);
    // HEY Research Lab's own badge for Factor in the footer, and the links to Factor's page on HEY, are the one exception
    assert.doesNotMatch(html, /(src|href)="https?:\/\/(?!ponsfamily\.com|github\.com|x\.com|robinhoodchain\.blockscout\.com\/(tx|address)\/0x|heyresearch\.xyz\/(api\/badge\/factor(\?theme=dark)?"|project\/factor(\?utm_source=badge&amp;utm_medium=html)?"))/, `${path} loads from another site`);
    assert.match(headers.get("content-security-policy") ?? "", /default-src 'self'/, `${path} has no content policy`);
  }
});

test("monthly clients: a plan's page with its months, an agent's monthly income, the door, the docs and the words", async () => {
  const page = await get("/plans/0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a");
  const t = text(page.html);
  assert.match(t, /A monthly plan Release notes every month/);
  assert.match(t, /0\.0250 ETH a month · 3 months · Running/);
  // the months as a row: month 1 locked and started from the pool, the next two not locked yet
  assert.match(t, /Month 1 job 0415 0\.0250 ETH Advanced From the pool 0\.0125 ETH To the burn 0\.00025 ETH/);
  assert.match(t, /Months delivered 0 of 3 Paid up front nothing yet Next month early nothing yet Paid on delivery nothing yet/);
  assert.match(t, /Month 2 0\.0250 ETH Not locked yet Month 1 is not delivered yet\. Or from/);
  assert.match(t, /Month 3 0\.0250 ETH Not locked yet Locked when it comes\./);
  assert.match(t, /Months delivered 0 of 3/);
  assert.match(t, /What the customer signed/);
  assert.match(page.html, /href="\/jobs\/0415"/);
  // the agent's page: its monthly clients, only because it has a plan
  const a = text((await get("/agents/quill-02")).html);
  assert.match(a, /Monthly clients Recurring income, on the record ?\./);
  assert.match(a, /A month, from plans running now 0\.0250 ETH a month Plans running 1 Monthly clients 1 Months delivered 0 settled 0/);
  // an agent with no plan shows no monthly section (its Factor Score only names the way)
  assert.doesNotMatch(text((await get("/agents/lumen-07")).html), /Monthly clients (Recurring income|Monthly clients)|Plans running/);
  // the door passes the plans' reads, and their writes go to the engine only
  assert.equal((await fetch(`${BASE}/api/v1/plans/0x${"5a".repeat(32)}`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/v1/plans?agent=quill-02`)).status, 200);
  for (const w of ["plans/create", "plans/month", "plans/stop"]) assert.equal((await fetch(`${BASE}/api/v1/${w}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 503, w);
  // the docs say how plans work and why month by month
  const d = text((await get("/docs")).html);
  assert.match(d, /11 Monthly clients/);
  assert.match(d, /subscribe/);
  assert.match(d, /Why month by month\./);
  assert.match(d, /Next month early is the desk.s own pool advance/);
});

test("verified owners stay out of sight while the engine does not check owners: no mark, no filter, no switch on the form, no docs section", async () => {
  for (const path of ["/agents", "/open-jobs", "/open-jobs/0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", "/docs", "/work"]) {
    const t = text((await get(path)).html);
    assert.ok(!/Verified owner|verified owners only|Owner not verified|Verify the owner/i.test(t), `nothing of verified owners on ${path}`);
  }
  assert.ok(!/id="verified"/.test((await get("/docs")).html), "no docs section on verified owners");
});

test("offers stay out of sight while the engine has them off: the form names one price, the listings have no offers and the docs have no section on them", async () => {
  const board = text((await get("/open-jobs")).html);
  assert.match(board, /Price in ETH/);
  assert.ok(!/Open to offers|Fixed price|Budget/.test(board), "no price mode on the form");
  const listing = text((await get("/open-jobs/0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")).html);
  assert.ok(!/Sort the offers|Make an offer/.test(listing), "no offers on a listing");
  const docs = text((await get("/docs")).html);
  assert.ok(!/Agents that bid/.test(docs), "no docs section on offers");
});

test("credit lines: an agent's line on its page, its mark in the list, the work page, the docs and the protocol, nothing to send on the sample, and no share of a fee but the rulebook's own", async () => {
  const page = text((await get("/agents/orbit-ops")).html);
  assert.match(page, /Credit line How lines work → Owes 0\.0060 ETH ?, due/);
  assert.match(page, /Can draw now/);
  assert.match(page, /1 on time/);
  assert.match(page, /Its record carries over/);
  assert.match(page, /line account, its desk address for new jobs/);
  // the sample has no line contract: nothing can be opened, drawn or repaid from it
  assert.doesNotMatch(page, /Open the line|Draw as compute/);
  assert.match(text((await get("/agents")).html), /orbit-ops Credit line/);
  const work = text((await get("/work")).html);
  assert.match(work, /Open a credit line\./);
  assert.match(work, /Credit lines are not open yet/);
  const docs = text((await get("/docs")).html);
  assert.match(docs, /Credit lines Credit before the job, paid back from the next one ?\./);
  assert.match(docs, /factor_draw_line/);
  assert.match(docs, /drawLine/);
  const protocol = text((await get("/protocol")).html);
  assert.match(protocol, /Credit lines Credit with no job behind it/);
  assert.match(protocol, /The credit lines/);
  // the only shares said are the draw fee's own two halves; nobody's cut of anything
  for (const t of [page, work, docs.slice(docs.indexOf("Credit lines")), protocol.slice(protocol.indexOf("Credit lines"))]) assert.doesNotMatch(t, /\b(70|20|40|10)\s?%/);
  const api = await (await fetch(`${BASE}/api/v1/lines/orbit-ops`)).json();
  assert.equal(api.line.status, "owing");
  assert.equal((await fetch(`${BASE}/api/v1/lines/nobody-here`)).status, 404);
});

test("bounties: the board, a page with counts only until the reveal, every entry beside the winner, the docs and the protocol; nothing to send on the sample", async () => {
  const board = text((await get("/bounties")).html);
  assert.match(board, /Lock a prize\. Agents enter with the finished work ?\./);
  assert.match(board, /Write the words for our front page/);
  assert.match(board, /3 of 25/);
  assert.match(board, /It cannot be fully stopped/);
  assert.match(board, /Bounties are not open yet/);
  // the entries are hidden before the reveal: counts only
  const open = text((await get("/bounties/4")).html);
  assert.match(open, /Hidden until a winner is picked/);
  assert.match(open, /3 entries are in/);
  assert.doesNotMatch(open, /Entry 1/);
  const choosing = text((await get("/bounties/3")).html);
  assert.match(choosing, /The poster can read them now/);
  assert.doesNotMatch(choosing, /Entry 1/);
  // after a pick: everything, beside the winner, and the poster's history
  const won = text((await get("/bounties/2")).html);
  assert.match(won, /Every entry, in the open/);
  assert.match(won, /Entry 1 · lumen-07 Winner/);
  assert.match(won, /Entry 2/);
  assert.match(won, /Tide Tea/);
  assert.match(won, /What it did with its other bounties/);
  assert.match(won, /delivered its entry and was paid/);
  const split = text((await get("/bounties/1")).html);
  assert.match(split, /No winner was picked in time/);
  assert.match(split, /from the split/);
  assert.equal((await get("/bounties/99")).status, 404);
  const docs = text((await get("/docs")).html);
  assert.match(docs, /Bounties Enter with the finished work\. The poster picks one ?\./);
  assert.match(docs, /api\/v1\/bounties\/entry/);
  const protocol = text((await get("/protocol")).html);
  assert.match(protocol, /Bounties A prize locked for a task, paid through the desk/);
  assert.match(protocol, /The bounties/);
  for (const t of [board, open, won, split, docs.slice(docs.indexOf("Bounties Enter")), protocol.slice(protocol.indexOf("Bounties A prize"))]) assert.doesNotMatch(t, /\b(70|20|40|10)\s?%/);
  const api = await (await fetch(`${BASE}/api/v1/bounties/2`)).json();
  assert.equal(api.items.length, 2);
  assert.equal((await (await fetch(`${BASE}/api/v1/bounties/4`)).json()).items, undefined);
});

test("milestones: hiring in stages under Hire, the stage tracker on a stage's page, the stages on the agent's page, the docs, the protocol and the log; nothing to send on the sample", async () => {
  const hire = text((await get("/hire?agent=page-smith&stages=1")).html);
  assert.match(hire, /In stages/);
  assert.match(hire, /Stage 1 What it delivers/);
  assert.match(hire, /Stage 2 What it delivers/);
  assert.match(hire, /Add a stage/);
  assert.match(hire, /Let the agent start each stage with half/);
  // the sample has no milestone contract: nothing can be locked from it
  assert.match(hire, /Not open yet/);
  assert.match(hire, /A job in stages is one bigger job split into 2 to 6 parts/);
  // the plain form is still the plain form, with the third mode beside it
  const plain = text((await get("/hire")).html);
  assert.match(plain, /One job (Monthly )?In stages/);
  assert.match(plain, /What you want done/);
  const stage = text((await get("/jobs/0416")).html);
  assert.match(stage, /Stage 2 of 3 of A site for a coffee roaster ?, a job in stages/);
  assert.match(stage, /A job in 3 stages/);
  assert.match(stage, /01 A pricing page with three plans/);
  assert.match(stage, /Paid/);
  assert.match(stage, /On the desk/);
  assert.match(stage, /03 The order page/);
  assert.match(stage, /Not started/);
  assert.match(stage, /through the milestone contract/);
  const first = text((await get("/jobs/0408")).html);
  assert.match(first, /Stage 1 of 3/);
  assert.doesNotMatch(text((await get("/jobs/0412")).html), /A job in \d stages/);
  const agent = text((await get("/agents/page-smith")).html);
  assert.match(agent, /Jobs in stages How jobs in stages work → Paid stage by stage ?\./);
  assert.match(agent, /1 of 3 stages paid ?, stage 2 on the desk/);
  const docs = text((await get("/docs")).html);
  assert.match(docs, /Milestones A bigger job in stages, the whole budget locked up front ?\./);
  assert.match(docs, /hireInStages/);
  assert.match(docs, /api\/v1\/milestones\/terms/);
  assert.match(docs, /factor_hire_in_stages/);
  const protocol = text((await get("/protocol")).html);
  assert.match(protocol, /Milestones A bigger job in stages, each one paid through the desk/);
  assert.match(protocol, /The milestones/);
  assert.match(text((await get("/security")).html), /The milestones/);
  assert.match(text((await get("/log")).html), /Milestones A customer can hire an agent for a bigger job in 2 to 6 stages/);
  for (const t of [hire, stage, agent, docs.slice(docs.indexOf("Milestones A bigger")), protocol.slice(protocol.indexOf("Milestones A bigger"))]) {
    assert.doesNotMatch(t, /\b(70|20|40|10)\s?%/);
    assert.doesNotMatch(t, /\bdemo\b/i);
  }
  const api = await (await fetch(`${BASE}/api/v1/milestones/job/416`)).json();
  assert.equal(api.stages.length, 3);
  assert.equal(api.current, 2);
  // nothing of it before the launch, or with milestones off
  assert.doesNotMatch(text((await get("/hire", BARE)).html), /In stages/);
});

test("guarantees: Guaranteed up to on an agent's page, in the list and on its firm, the cover on a job's page, hire with cover, the work page, the docs and the protocol; nothing to send on the sample, and no share but the fee's own", async () => {
  const page = text((await get("/agents/lumen-07")).html);
  assert.match(page, /Guaranteed up to 0\.0400 ETH/);
  assert.match(page, /Guarantee How guarantees work → Guaranteed up to 0\.0400 ETH a job ?\./);
  assert.match(page, /Held back for covers/);
  assert.match(page, /1 delivered/);
  // the sample has no guarantee contract: nothing can be bonded or covered from it
  assert.doesNotMatch(page, /Add to the bond|Set the offer|Take it out|Hire lumen-07 with cover|Hire with cover/);
  assert.match(text((await get("/agents")).html), /lumen-07[^·]{0,40}Guaranteed up to 0\.0400 ETH/);
  assert.match(text((await get("/firms/night-desk")).html), /Guaranteed up to 0\.0400 ETH/);
  const job = text((await get("/jobs/0412")).html);
  assert.match(job, /Covered 0\.02 ETH/);
  assert.match(job, /Cover Covered from lumen-07's guarantee bond 0\.0200 ETH/);
  assert.match(job, /Delivered/);
  const hire = text((await get("/hire?agent=lumen-07&cover=1")).html);
  // the sample has no guarantee contract: the form offers no cover it could not send; the steps still say what cover does
  assert.doesNotMatch(hire, /Hire with cover/);
  assert.match(hire, /paid the cover from the agent's guarantee bond as well/);
  const work = text((await get("/work")).html);
  assert.match(work, /Set your guarantee\./);
  assert.match(work, /Guarantees are not open yet/);
  const docs = text((await get("/docs")).html);
  assert.match(docs, /Guarantees Hire with cover\. Paid from the bond if it is not delivered ?\./);
  assert.match(docs, /hireWithCover/);
  assert.match(docs, /factor_hire_with_cover/);
  const protocol = text((await get("/protocol")).html);
  assert.match(protocol, /Guarantees Cover on a job, held back from the agent's own bond/);
  assert.match(protocol, /The guarantees/);
  for (const t of [page, job, work, docs.slice(docs.indexOf("Guarantees Hire")), protocol.slice(protocol.indexOf("Guarantees Cover"))]) assert.doesNotMatch(t, /\b(70|20|40|10)\s?%/);
  const api = await (await fetch(`${BASE}/api/v1/guarantees/agent/lumen-07`)).json();
  assert.equal(api.guarantee.upToEth, 0.04);
  assert.equal((await fetch(`${BASE}/api/v1/guarantees/agent/nobody-here`)).status, 404);
});

test("the roadmap: on the home page, every phase in order, what is live checked off with its day, what is planned said as a plan", async () => {
  const { html } = await get("/");
  assert.match(html, /id="roadmap"/);
  const t = text(html);
  assert.match(t, /07 Roadmap The credit layer for AI agents \./);
  assert.match(t, /17 of 20 phases live/);
  // the intro counts from the roadmap itself, so it never goes stale
  assert.match(t, /Seventeen phases are live, the next three are planned, and more will follow\./);
  assert.doesNotMatch(t, /Thirteen phases|Fourteen phases|Fifteen phases|Sixteen phases/);
  const names = ["Launch", "Compute on credit", "Pay with Factor", "Agents hire agents", "Agent firms", "Monthly clients", "Agents find their own work", "Agents that bid", "Bounties", "Agent coins", "Factor Score", "Credit lines", "Verified owners", "Guarantees", "Milestones", "Factor everywhere", "Verifiers", "Vouching", "Selling locked pay", "Agent treasury"];
  let at = t.indexOf("Stage 1");
  names.forEach((name, i) => { const k = t.indexOf(`Phase ${String(i + 1).padStart(2, "0")} ${name}`, at); assert.ok(k > at, `phase ${i + 1} ${name} in order`); at = k; });
  for (const day of ["14 Oct", "15 Oct", "16 Oct", "17 Oct", "18 Oct", "19 Oct", "20 Oct", "22 Oct", "23 Oct", "24 Oct", "28 Oct", "30 Oct", "1 Nov", "2 Nov", "3 Nov", "4 Nov", "9 Nov"]) assert.match(t, new RegExp(`Live ${day}`));
  assert.match(t, /Live 20 Oct Phase 11 Factor Score/);
  assert.match(t, /Live 28 Oct Phase 10 Agent coins/);
  assert.match(t, /Live 30 Oct Phase 12 Credit lines/);
  assert.match(t, /Live 24 Oct Phase 13 Verified owners/);
  assert.match(t, /Live 1 Nov Phase 14 Guarantees/);
  assert.match(t, /Live 2 Nov Phase 09 Bounties/);
  assert.match(t, /Live 3 Nov Phase 15 Milestones/);
  assert.match(t, /Live 4 Nov Phase 16 Factor everywhere/);
  assert.match(t, /Live 9 Nov Phase 17 Verifiers/);
  assert.match(t, /Next Phase 18 Vouching The plan is/);
  assert.equal((t.match(/Planned Phase/g) ?? []).length, 2);
  for (const name of ["Selling locked pay", "Agent treasury"]) assert.match(t, new RegExp(`Planned Phase \\d+ ${name} The plan is`));
  assert.match(t, /Stage 5 Agents fund each other/);
  for (const w of ["October", "November", "December"]) assert.ok(!t.slice(t.indexOf("Stage 2")).includes(w), `no planned date: ${w}`);
  // the line runs on past the last phase into a stage still being planned, with no phase number and no date
  const more = t.slice(t.indexOf("Phase 20 Agent treasury"));
  assert.match(more, /Stage 6 Coming What comes next/);
  assert.match(more, /The next stage is being planned\. New phases are added here as we get close to finishing the ones above/);
  assert.ok(!/Phase 21/.test(t), "no phase number for what comes next");
  assert.equal((t.match(/checked off the day it goes live/g) ?? []).length, 1);
  assert.equal((t.match(/Builds on/g) ?? []).length, 11);
  // the footer leads to it on every page, as the header does
  assert.match(html, /<footer[\s\S]*href="\/roadmap"/);
});

// Reads a stream until `want` is in what came, or `ms` passed. Returns what came.
async function readUntil(reader, want, ms = 8_000) {
  let got = "";
  const end = Date.now() + ms;
  while (!want.test(got) && Date.now() < end) {
    const r = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res({ timeout: true }), Math.max(1, end - Date.now())))]);
    if (r.timeout || r.done) break;
    got += r.value;
  }
  return got;
}

test("pages are told of changes as they happen: one stream to the engine per server, passed on to every open page", async () => {
  const PUSHED = `http://127.0.0.1:${PORT + 2}`;
  const opened = engine.opened;
  const open = async () => {
    const ac = new AbortController();
    const r = await fetch(`${PUSHED}/api/live`, { signal: ac.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.match(r.headers.get("cache-control") ?? "", /no-transform/);
    assert.equal(r.headers.get("x-accel-buffering"), "no");
    return { ac, reader: r.body.pipeThrough(new TextDecoderStream()).getReader() };
  };
  const a = await open(), b = await open();
  assert.match(await readUntil(a.reader, /event: up\n/), /event: hello\ndata: \{"up":(true|false),"since":"[0-9a-f]+:\d+"\}/);
  await readUntil(b.reader, /event: up\n|"up":true/);
  // two pages open, and the engine was asked for one stream
  assert.equal(engine.opened - opened, 1);
  engineSays("state", { seq: 1, kind: "state", at: new Date().toISOString() });
  const [ga, gb] = await Promise.all([readUntil(a.reader, /event: change/), readUntil(b.reader, /event: change/)]);
  assert.match(ga, /event: change\ndata: \{"since":"[0-9a-f]+:\d+"\}/);
  assert.match(gb, /event: change/);
  engineSays("pulse", { seq: 2, kind: "pulse", at: "2026-10-20T07:18:51.374Z", block: 93272637, gwei: 0.02 });
  assert.match(await readUntil(a.reader, /event: pulse/), /event: pulse\ndata: \{"block":93272637,"gwei":0.02,"at":"2026-10-20T07:18:51.374Z"\}/);
  a.ac.abort(); b.ac.abort();
  // a page on it says so in the footer only once its stream is open in the browser: nothing in the page as served
  const { status, html } = await get("/", PUSHED);
  assert.equal(status, 200);
  assert.doesNotMatch(html, /class="livemark"/);
});

test("LIVE_PUSH=off, or no engine, and there is no stream: pages read themselves on their timers as before", async () => {
  const opened = engine.opened;
  const off = await fetch(`http://127.0.0.1:${PORT + 3}/api/live`);
  assert.equal(off.status, 404);
  assert.equal((await fetch(`${BARE}/api/live`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/live`)).status, 404);
  assert.equal(engine.opened, opened, "the engine was not asked for a stream");
  assert.equal((await get("/", `http://127.0.0.1:${PORT + 3}`)).status, 200);
});

test("an agent with an ERC-8004 identity shows it by its name and in a section of its own, and the docs explain it", async () => {
  const page = text((await get("/agents/lumen-07")).html);
  assert.match(page, /ERC-8004 #211/);
  assert.match(page, /On ERC-8004/);
  assert.match(page, /getSummary\(211, \[FACTOR\]/);
  const other = text((await get("/agents/quill-02")).html);
  assert.doesNotMatch(other, /On ERC-8004/);
  const docs = await get("/docs");
  assert.match(docs.html, /id="erc8004"/);
  assert.match(text(docs.html), /linkErc8004/);
  // the file an entry points at is passed on word for word by the engine; the sample has none
  assert.equal((await get("/api/v1/erc8004/feedback/12")).status, 404);
});


test("auto-apply: an agent's rules and its log on its page, the applications made on their own marked, and the docs", async () => {
  const agent = text((await get("/agents/page-smith")).html);
  assert.match(agent, /Auto-apply/);
  assert.match(agent, /Takes Landing pages From 0\.003 ETH a job At a time Up to 3 jobs Hours Always on Half up front When the customer allows it/);
  assert.match(agent, /What it did on its own/);
  assert.match(agent, /Applied with one signature, ranked 1 of 1 by Factor Score/);
  // an agent with no rules and auto-apply off on the sample shows no section
  assert.doesNotMatch(text((await get("/agents/lumen-07")).html), /What it did on its own/);
  assert.match(text((await get("/open-jobs")).html), /Applied · 1 · 1 on its own/);
  assert.match(text((await get("/open-jobs/0x0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c")).html), /page-smith House agent Applied on its own/);
  const docs = await get("/docs");
  assert.match(docs.html, /id="auto-apply"/);
  assert.match(text(docs.html), /15 Auto-apply Agents that find their own work \./);
  assert.match(text(docs.html), /watchOpenJobs/);
  // the site's own door passes an agent's rules and log, and the rules an owner signs
  assert.equal((await fetch(`${BASE}/api/v1/autoapply/page-smith`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/v1/autoapply/page-smith/log`)).status, 404);
  // with no engine: nothing to show
  assert.doesNotMatch(text((await get("/agents/page-smith", BARE)).html), /What it did on its own/);
});

test("open jobs: the board, a listing with its applicants ranked by Factor Score, and nothing to send on the sample", async () => {
  const board = text((await get("/open-jobs")).html);
  assert.match(board, /Post the job\. The agents come to you ?\./);
  assert.match(board, /Check every figure in our quarterly note/);
  assert.match(board, /A one-page site for a bakery/);
  assert.match(board, /best Factor Score takes it/);
  assert.match(board, /Open jobs are off for now|Nothing is live yet/);
  assert.doesNotMatch((await get("/open-jobs")).html, />CONNECT</);
  const { html } = await get("/open-jobs/0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b");
  const t = text(html);
  assert.match(t, /Ranked by Factor Score/);
  // ranked by the score, highest first: lumen-07 (624) above orbit-ops and quill-02
  const order = ["lumen-07", "orbit-ops", "quill-02"].map((n) => t.indexOf(`${n}`, t.indexOf("Ranked by Factor Score")));
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], `ranked ${order}`);
  assert.match(t, /Forty-one jobs settled, all but one on time/);
  assert.match(t, /What the customer signed/);
  assert.equal((await get("/open-jobs/0x0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d")).status, 404);
  assert.equal((await get("/open-jobs/not-a-listing")).status, 404);
  // the site's own door passes the board and a listing, and only the writes a wallet signs
  assert.equal((await fetch(`${BASE}/api/v1/openjobs`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/v1/openjobs/0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/v1/openjobs/pick`, { method: "POST", body: "{}" })).status, 404);
  // with no engine: an empty board that says so, never a sample listing
  const bare = text((await get("/open-jobs", BARE)).html);
  assert.match(bare, /No open job right now/);
  assert.doesNotMatch(bare, /quarterly note/);
  assert.equal((await get("/open-jobs/0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", BARE)).status, 404);
});

test("Factor everywhere: its page under Protocol with a snippet for each case, the signed answer and the embed on the sample, the assistant's endpoint, a filled-in pay flow, an agent's page, the docs, the protocol, the security page and the log", async () => {
  const { status, html } = await get("/everywhere");
  assert.equal(status, 200);
  const t = text(html).replace(/<!-- -->/g, "");
  assert.match(t, /Check an agent before you hire it, anywhere ?\./);
  for (const head of ["01 One answer", "02 Check the signature", "03 Embed it", "04 Factor Connect", "05 In every assistant", "06 Ask Factor", "07 On ERC-8004", "08 What it is"]) assert.match(t, new RegExp(head), head);
  for (const snippet of ["/api/v1/everywhere/agent/", "verifyMessage", "checkAgent", "data-factor-agent", "embed.js", "/api/v1/connect/", "register", "verifyWebhook", "claude mcp add --transport http factor", "mcpServers", "factorScore"]) assert.ok(t.includes(snippet), snippet);
  // the sample's own signer, and live embeds of the best agent, drawn by the script from this site
  assert.match(t, /0xa4cedcbc8f7718430b68e5c3a8363a6c258fc976/);
  assert.match(html, /data-factor-agent="[a-z0-9-]+"[^>]*data-factor-theme="dark"/);
  assert.match(html, /<script src="\/embed\.js" async/);
  assert.doesNotMatch(t, /\bdemo\b/i);
  assert.doesNotMatch(t, /holds? (your|the customer's|their) (money|payment)(?! )/i);
  // the header lists it under Protocol, and nowhere else
  assert.match(html, /data-pages="Protocol"[\s\S]*?href="\/everywhere"/);

  // the signed answer, checked the way an app checks it, against the signer the about names
  const about = await (await fetch(`${BASE}/api/v1/everywhere`)).json();
  assert.equal(about.enabled, true);
  const r = await fetch(`${BASE}/api/v1/everywhere/agent/lumen-07`);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  const sealed = await r.json();
  const { verifyMessage } = await import("viem");
  assert.ok(await verifyMessage({ address: about.signer, message: sealed.answer, signature: sealed.signature }));
  const a = JSON.parse(sealed.answer);
  assert.equal(a.kind, "factor.agent");
  assert.equal(a.agent.name, "lumen-07");
  assert.ok(a.expiresAt - a.issuedAt === 600);
  assert.ok(typeof a.score.value === "number" && "line" in a && "guarantee" in a);
  assert.equal((await fetch(`${BASE}/api/v1/everywhere/agent/nobody-here`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/v1/everywhere/agent/8004%3A42`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/v1/everywhere/whatever`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/v1/everywhere`, { method: "OPTIONS" })).headers.get("access-control-allow-headers"), "content-type, authorization");

  // the embeds' script: from this site, loading nothing else, keeping nothing
  const js = await fetch(`${BASE}/embed.js`);
  assert.equal(js.status, 200);
  assert.equal(js.headers.get("cross-origin-resource-policy"), "cross-origin");
  const code = await js.text();
  assert.match(code, /attachShadow/);
  assert.match(code, /credentials: "omit"/);
  assert.doesNotMatch(code, /localStorage|document\.cookie|sendBeacon|https?:\/\/(?!factoragents\.fun)[a-z]/);

  // the assistant's endpoint: the kit's tools, none of which sends anything
  const mcp = async (body) => (await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) })).json();
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
  assert.equal(init.result.serverInfo.name, "factor");
  const tools = (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).result.tools;
  assert.deepEqual(tools.map((x) => x.name).sort(), ["factor_agent", "factor_agents", "factor_ask", "factor_builder_record", "factor_check_agent", "factor_copilot", "factor_credit_leaderboard", "factor_credit_report", "factor_erc8004", "factor_find_agent", "factor_firm_record", "factor_guarantee", "factor_hire_link", "factor_line", "factor_open_jobs", "factor_overview", "factor_record", "factor_reviews", "factor_verified_erc8004", "factor_verifier", "factor_verifier_case", "factor_verifier_cases", "factor_verifiers", "factor_verifiers_about"]);
  assert.ok(tools.every((x) => x.annotations.readOnlyHint === true));
  assert.equal((await fetch(`${BASE}/mcp`)).status, 405);

  // the pay flow, filled in by a link (the kit's hireLink): every field still the customer's to change
  const hire = (await get("/hire?agent=lumen-07&price=0.01&title=Summarise+one+contract&due=48&early=1")).html;
  assert.match(hire, /value="0\.01"/);
  assert.match(hire, /<textarea class="oneline"[^>]*>Summarise one contract<\/textarea>/);
  assert.match(hire, /<option value="172800" selected="">48 hours<\/option>/);

  // an agent's page: check it anywhere, with its embed and its signed answer
  const agentHtml = (await get("/agents/lumen-07")).html;
  const agent = text(agentHtml).replace(/<!-- -->/g, "");
  assert.match(agent, /Factor everywhere (?:How it works → )?Check lumen-07 anywhere ?\./);
  assert.match(agent, /api\/v1\/everywhere\/agent\/lumen-07/);
  assert.match(agentHtml, /<div style="[^"]*" data-factor-agent="lumen-07" data-factor-show="score guarantee hire"><\/div>/);
  assert.match(agent, /data-factor-agent=&quot;lumen-07&quot;/);

  const docs = text((await get("/docs")).html).replace(/<!-- -->/g, "");
  assert.match(docs, /Factor everywhere (?:The whole page → )?The score, the line and the Guarantee, for any app ?\./);
  assert.match(docs, /factor_check_agent/);
  assert.match(text((await get("/protocol")).html).replace(/<!-- -->/g, ""), /Factor everywhere (?:The whole page → )?The same record, read and checked anywhere ?\./);
  assert.match(text((await get("/security")).html).replace(/<!-- -->/g, ""), /Factor everywhere What the signed answers can and cannot do ?\./);
  assert.match(text((await get("/log")).html), /Factor everywhere Any app, marketplace or assistant can check an agent before hiring it/);

  // with no engine: the page says it is off, and nothing is answered
  const bare = text((await get("/everywhere", BARE)).html);
  assert.match(bare, /Factor everywhere is switched off right now/);
  assert.equal((await fetch(`${BARE}/api/v1/everywhere/agent/lumen-07`)).status, 503);
  assert.doesNotMatch(text((await get("/docs", BARE)).html), /Factor everywhere The score/);
});

test("Ask Factor: the box on the home page and its own page under Hire, a sentence answered with the job and the agents, the hire form filled in with stages, the assistant's tool, the docs, the protocol, the security page and the log", async () => {
  // the home page: the box, and the page it leads to
  const home = text((await get("/")).html).replace(/<!-- -->/g, "");
  assert.match(home, /Ask Factor (?:How Ask works → )?Say what you need\. Factor writes the job ?\./);
  assert.match(home, /Say what you need, in one sentence/);
  assert.match(home, /A landing page for my coin by Friday, under 0\.02 ETH/);
  // its own page, in the Hire group of the header and nowhere else
  const { status, html } = await get("/ask");
  assert.equal(status, 200);
  const t = text(html).replace(/<!-- -->/g, "");
  assert.match(t, /Say what you need\. Factor writes the job ?\./);
  for (const rule of ["It writes, you lock", "Every figure is the desk's", "Nothing of it is kept"]) assert.ok(t.includes(rule), rule);
  assert.match(t, /never signs, never moves money and never chooses an address/);
  assert.match(html, /data-pages="Hire"[\s\S]*?href="\/ask"/);
  assert.doesNotMatch(t, /\bdemo\b/i);
  assert.doesNotMatch(t, /holds? (your|the customer's|their) (money|payment)(?! )/i);

  // a sentence, as the page sends it: the job written and the agents that fit, each with its reasons and a price
  assert.deepEqual(await (await fetch(`${BASE}/api/v1/ask`)).json(), { enabled: true, mostChars: 500, perMinute: 4, perDay: 40, reads: "plain" });
  const r = await fetch(`${BASE}/api/v1/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "A landing page for my coin by Friday", tz: 60 }) });
  assert.equal(r.status, 200);
  const a = await r.json();
  assert.equal(a.job.title, "A landing page for my coin by Friday");
  assert.ok(a.agents.length >= 1 && a.agents.length <= 3);
  assert.equal(a.agents[0].name, "page-smith");
  assert.ok(a.agents[0].reasons.some((x) => /^Factor Score \d+ of 1000\.$/.test(x)));
  assert.equal((await fetch(`${BASE}/api/v1/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) })).status, 400);

  // the hire form, filled in from Ask: said so, every field the customer's, and no second box to match the job
  const hire = (await get("/hire?agent=page-smith&price=0.003&title=A+landing+page&due=38&via=ask")).html;
  assert.match(text(hire), /Filled in by Ask Factor from your sentence\. Check every field/);
  assert.match(hire, /value="0\.003"/);
  assert.match(hire, /<textarea class="oneline"[^>]*>A landing page<\/textarea>/);
  assert.match(hire, /<option value="136800" selected="">38 hours<\/option>/);
  assert.doesNotMatch(text(hire), /Just say what you need/);
  // a job in stages from Ask: the stage form, each stage as Ask wrote it, a time it does not list offered too
  const plan = encodeURIComponent(JSON.stringify([["The words", "Write every page", "0.002", 72], ["The pages", "Build them", "0.003", 96]]));
  const staged = (await get(`/hire?agent=page-smith&price=0.005&title=A+shop+site&due=168&stages=1&plan=${plan}&via=ask`)).html;
  assert.match(staged, /value="A shop site"/);
  assert.match(staged, /value="The words"/);
  assert.match(staged, /value="The pages"/);
  assert.match(staged, /value="0\.003"/);
  assert.match(staged, /<option value="345600" selected="">4 days<\/option>/);
  // a plan that is not one is ignored, and the form is the plain one
  assert.equal((await get(`/hire?agent=page-smith&stages=1&plan=${encodeURIComponent("[[1,2]]")}&via=ask`)).status, 200);

  const docs = text((await get("/docs")).html).replace(/<!-- -->/g, "");
  assert.match(docs, /Ask Factor (?:Try it → )?One sentence in, a job out ?\./);
  assert.match(docs, /factor_ask/);
  assert.match(text((await get("/protocol")).html).replace(/<!-- -->/g, ""), /Ask Factor (?:Try it → )?It writes the job\. You lock it ?\./);
  assert.match(text((await get("/security")).html).replace(/<!-- -->/g, ""), /Ask Factor A model reads the sentence\. Nothing it says moves money ?\./);
  assert.match(text((await get("/log")).html), /Ask Factor Say what you need in one sentence/);

  // also new: every agent's live score card, a picture made from its record, and the picture its page's links show
  const card = await fetch(`${BASE}/api/v1/agents/lumen-07/card.png`);
  assert.equal(card.status, 200);
  assert.equal(card.headers.get("content-type"), "image/png");
  assert.match(card.headers.get("cache-control") ?? "", /max-age=300/);
  const png = Buffer.from(await card.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.equal((await fetch(`${BASE}/api/v1/agents/nobody-here/card.png`)).status, 404);
  assert.match((await get("/agents/lumen-07")).html, /<meta property="og:image" content="https:\/\/factoragents\.fun\/api\/v1\/agents\/lumen-07\/card\.png"\/>/);
  assert.match(text((await get("/log")).html), /Also new: a live score card for every agent/);

  // with no engine: no box on the home page, the page says it is resting, and nothing is answered
  assert.doesNotMatch(text((await get("/", BARE)).html), /Say what you need, in one sentence/);
  assert.match(text((await get("/ask", BARE)).html), /Ask Factor is resting just now/);
  assert.equal((await fetch(`${BARE}/api/v1/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "A landing page for my coin" }) })).status, 503);
  assert.doesNotMatch(text((await get("/docs", BARE)).html), /One sentence in, a job out/);
});

test("Factor Copilot: a button on every page, its own page in the Hire group, the docs, and nothing of it with no engine", async () => {
  // the button on every page but its own, and the chat on its page
  for (const path of ["/", "/agents", "/jobs/0412", "/docs"]) assert.match((await get(path)).html, /class="cp-dock"[^>]*>[\s\S]*?Copilot/, path);
  const { status, html } = await get("/copilot");
  assert.equal(status, 200);
  assert.doesNotMatch(html, /class="cp-dock"/);
  const t = text(html).replace(/<!-- -->/g, "");
  assert.match(t, /Say it\. Copilot prepares it\. You sign ?\./);
  for (const rule of ["It prepares, you sign", "Only what you said", "Nothing of it is kept"]) assert.ok(t.includes(rule), rule);
  for (const call of ["FactorDesk.lock", "FactorGuarantee.reserve", "FactorDesk.accept", "FactorBounty.post", "FactorMilestones.post", "FactorGuarantee.addBond"]) assert.ok(t.includes(call), call);
  assert.match(t, /One action moves 0\.1 ETH at most/);
  assert.match(html, /data-pages="Hire"[\s\S]*?href="\/copilot"/);
  assert.doesNotMatch(t, /\bdemo\b/i);
  // a message, as the chat sends it: the sample answers from its agents and prepares nothing
  assert.deepEqual(await (await fetch(`${BASE}/api/v1/copilot`)).json(), { enabled: true, mostChars: 500, mostEth: "0.1", perMinute: 8, perDay: 150, reads: "plain" });
  const r = await fetch(`${BASE}/api/v1/copilot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "find an agent for a landing page", tz: 60 }) });
  assert.equal(r.status, 200);
  const a = await r.json();
  assert.equal(a.reply.action, null);
  assert.equal(a.reply.agents[0].name, "page-smith");
  assert.equal((await fetch(`${BASE}/api/v1/copilot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "" }) })).status, 400);
  assert.equal((await fetch(`${BASE}/api/v1/copilot/c/${"ab".repeat(16)}`)).status, 404);
  const docs = text((await get("/docs")).html).replace(/<!-- -->/g, "");
  assert.match(docs, /Factor Copilot (?:Open it → )?Plain words in, a card to sign out ?\./);
  assert.match(docs, /factor_copilot/);
  assert.match(text((await get("/security")).html).replace(/<!-- -->/g, ""), /Factor Copilot It prepares\. Your wallet signs ?\./);
  assert.match(text((await get("/log")).html), /Factor Copilot A chat on every page that runs the desk from plain sentences/);
  // with no engine: no button, the page says it is resting, and nothing is answered
  assert.doesNotMatch((await get("/", BARE)).html, /class="cp-dock"/);
  assert.match(text((await get("/copilot", BARE)).html), /Copilot is resting\. Every form on the site works as always/);
  assert.equal((await fetch(`${BARE}/api/v1/copilot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }) })).status, 503);
  assert.doesNotMatch(text((await get("/docs", BARE)).html), /Plain words in, a card to sign out/);
});

test("HEY builder records: HEY's own badge for Factor in the footer with this team ships, the docs, the security page and the log, the door's reads and the link, and nothing of it with no engine", async () => {
  const home = await get("/");
  // HEY's own badge, as its badge page gives it, linked to Factor's page on HEY; the dark one and the light one
  assert.match(home.html, /<a class="hey-badge" href="https:\/\/heyresearch\.xyz\/project\/factor\?utm_source=badge&amp;utm_medium=html"/);
  assert.match(home.html, /src="https:\/\/heyresearch\.xyz\/api\/badge\/factor\?theme=dark"/);
  assert.match(home.html, /src="https:\/\/heyresearch\.xyz\/api\/badge\/factor"/);
  assert.match(text(home.html), /This team ships\. HEY Research Lab, the public record of building on Robinhood Chain, keeps Factor's builder record/);
  // HEY's badge is the one thing of another site's a page loads: the policy allows that and nothing more
  const csp = (await fetch(`${BASE}/`)).headers.get("content-security-policy");
  if (csp) { assert.match(csp, /img-src 'self' data: https:\/\/heyresearch\.xyz;/); assert.match(csp, /connect-src 'self';/); }
  // never as a rating of an agent
  for (const path of ["/", "/docs", "/security", "/log"]) assert.doesNotMatch(text((await get(path)).html), /HEY (rates|rating of|score of)|rated by HEY|HEY score/i, path);
  const docs = text((await get("/docs")).html).replace(/<!-- -->/g, "");
  assert.match(docs, /HEY builder records Whether the team behind it ships ?\./);
  assert.match(docs, /factor_builder_record/);
  assert.match(docs, /It is not a rating, and it never changes the Factor Score/);
  assert.match(text((await get("/security")).html).replace(/<!-- -->/g, ""), /One request goes to HEY from your browser/);
  assert.match(text((await get("/log")).html), /HEY builder records HEY Research Lab, the public record of building on Robinhood Chain, now shows on Factor/);
  // the door passes the reads and the owner's link, and the sample has no engine to answer them
  assert.deepEqual(await (await fetch(`${BASE}/api/v1/hey/record?q=factor`)).json(), { enabled: false });
  assert.deepEqual(await (await fetch(`${BASE}/api/v1/hey/agent/lumen-07`)).json(), { enabled: false });
  assert.equal((await fetch(`${BASE}/api/v1/hey/somewhere`)).status, 404);
  assert.notEqual((await fetch(`${BASE}/api/v1/hey/link`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
  // with no engine: no badge, no section, no entry
  for (const path of ["/", "/docs", "/security", "/log"]) assert.doesNotMatch((await get(path, BARE)).html, /heyresearch\.xyz|HEY builder records/, path);
});

test("paid reviews: the average under each agent in the list, the section on an agent's page, the review on a job's page, the stars drawn and never a character, and nothing of it with no engine", async () => {
  const list = await get("/agents");
  assert.match(text(list.html), /4\.6 from 2 paid reviews/);
  const page = await get("/agents/lumen-07");
  const t = text(page.html).replace(/<!-- -->/g, "");
  assert.match(t, /What its customers say ?\./);
  assert.match(t, /4\.6 from 2 paid reviews/);
  assert.match(t, /Forty pages down to one/);
  assert.match(t, /lumen-07 answered/);
  assert.match(t, /Also on ERC-8004 · entry 31/);
  assert.match(t, /The most one job weighs/);
  assert.match(page.html, /href="\/jobs\/0412"/);
  // a review left out of the average says so, and why
  const quill = text((await get("/agents/quill-02")).html).replace(/<!-- -->/g, "");
  assert.match(quill, /Self-dealing · not in the average/);
  assert.match(quill, /Left out because the wallet that runs the agent on Factor/);
  // the job's page: the review, its reply, and the version before it
  const job = text((await get("/jobs/0407")).html).replace(/<!-- -->/g, "");
  assert.match(job, /The customer's review/);
  assert.match(job, /changed once/);
  assert.match(job, /The version before/);
  // a job not paid has no review block
  assert.doesNotMatch(text((await get("/jobs/0414")).html), /The customer's review/);
  // stars are drawn: no star, check or arrow character anywhere in what the pages send
  for (const html of [list.html, page.html, (await get("/jobs/0412")).html]) assert.doesNotMatch(html, /[\u{2605}\u{2606}\u{2B50}\u{2705}\u{2714}\u{2197}\u{FE0F}]|[\u{1F300}-\u{1FAFF}]/u);
  // the reads, as the site's door passes them
  const a = await (await fetch(`${BASE}/api/v1/reviews/agent/lumen-07`)).json();
  assert.equal(a.average, 4.6);
  assert.equal(a.items.length, 2);
  assert.equal((await fetch(`${BASE}/api/v1/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 503);
  // the docs, the security page, the log and Copilot's page say how it works
  const docs = text((await get("/docs")).html).replace(/<!-- -->/g, "");
  assert.match(docs, /Paid reviews Only the wallet that paid reviews ?\./);
  assert.match(docs, /factor_reviews/);
  assert.match(docs, /factorReview/);
  assert.match(text((await get("/security")).html).replace(/<!-- -->/g, ""), /Paid reviews Only who paid can review ?\./);
  assert.match(text((await get("/log")).html), /Paid reviews Only the wallet that paid for a job can review it/);
  assert.match(text((await get("/copilot")).html), /Review a job you paid for/);
  // with no engine: nothing of reviews anywhere
  for (const path of ["/agents", "/jobs/0412", "/docs", "/copilot"]) assert.doesNotMatch(text((await get(path, BARE)).html), /paid review|customer's review|Only who paid|Review a job you paid for/i, path);
  assert.doesNotMatch(text((await get("/security", BARE)).html), /Only who paid can review/);
});

test("verifiers: the page under Agents with how a verified job goes, the numbers, the clock, the makers, Factor's own, every verifier and the open cases, and the form to join; nothing to send on the sample", async () => {
  const page = await get("/verifiers");
  const t = plain(page.html);
  assert.match(t, /Work checked before it is paid ?\./);
  assert.match(t, /How a verified job goes .*You hire with a verifier .*The agent delivers .*One verifier checks it .*Either side may dispute it .*The desk carries it out/);
  // the numbers are the contract's rules, as the engine reads them
  assert.match(t, /The verification fee .* 0\.0001 ETH to the price/);
  assert.match(t, /A verifier's bond to join .* 0\.01 ETH or more/);
  assert.match(t, /A wrong verdict loses 50 ?% of its stake A panel seat never revealed loses all of its stake/);
  assert.match(t, /On a 0\.01 ETH job .*What a verifier stakes on its verdict 0\.002 ETH .*What a dispute costs 0\.001 ETH/);
  // the clock, drawn: every window, on the desk's 24 hours
  assert.match(t, /The first check one verifier, by 4 h A dispute within 2 h of the verdict Panel seats and strikes from the dispute until 14 h Reveals 14 h to 18 h/);
  assert.match(page.html, /class="vclock"/);
  // the makers as marks drawn in SVG, each with how many verifiers declare it
  assert.match(t, /Anthropic Claude 1 verifier Google Gemini 1 verifier OpenAI GPT 1 verifier/);
  assert.match(t, /MiniMax MiniMax none yet/);
  assert.equal((page.html.match(/<svg class="mk/g) ?? []).length >= 15, true);
  // Factor's own, marked as such, and every verifier with its record
  assert.match(t, /Factor's own verifiers Ordinary verifiers, with bonds of their own ?\./);
  assert.match(t, /factor-claude Anthropic · anthropic\/claude-haiku-4\.5/);
  assert.match(t, /The verifiers · 6/);
  assert.match(t, /factor-claude Factor's own Anthropic · standing since/);
  assert.match(t, /kimi-reads Moonshot · no standing: bond under the least/);
  assert.match(page.html, new RegExp(`href="/verifiers/${CLAUDE}"`));
  // the open cases, each to its job's page, and the ones ended lately
  assert.match(t, /Open cases · 5/);
  assert.match(t, /A plain reading of a supplier contract job 0424 .* Waiting for a check/);
  assert.match(t, /Release notes for version 2\.4 .* Panel seating/);
  assert.match(t, /A landing page for a bike repair shop .* Panel revealing/);
  assert.match(t, /Chart the October sales sheet .* The customer decides/);
  assert.match(t, /Ended lately/);
  assert.match(page.html, /href="\/jobs\/0424#verifiers"/);
  // the form to join: the makers, the bond, and nothing to send on the sample
  assert.match(t, /Become a verifier/);
  assert.match(t, /The maker of the model you run on/);
  assert.match(t, /Your bond, in ETH/);
  assert.match(t, /Not open yet/);
  assert.doesNotMatch(page.html, />CONNECT</);
  assert.match(t, /joinAsVerifier/);
  // drawn, never a character, and no long dash
  assert.doesNotMatch(page.html, /[\u{2605}\u{2606}\u{2B50}\u{2705}\u{2714}\u{2716}\u{274C}\u{2197}\u{FE0F}]|[\u{1F300}-\u{1FAFF}]/u);
  assert.doesNotMatch(t, /—/);
});

test("verifiers: a verifier's own page, the job page's check, verdicts, dispute and panel in every state, hiring with a verifier, an agent's verified jobs, the Factor Score's verified income, the docs, the security page, the protocol and the log", async () => {
  // a verifier's own page
  const v = plain((await get(`/verifiers/${CLAUDE}`)).html);
  assert.match(v, /factor-claude Factor's own/);
  assert.match(v, /A verifier on Anthropic, running anthropic\/claude-haiku-4\.5\. It has had its standing since/);
  assert.match(v, /89 ?% right, of 9 calls judged/);
  assert.match(v, /Free what it can stake, or take out 0\.0812 ETH/);
  assert.match(v, /Its cases · 4/);
  assert.match(v, /Summarise a 30-page supply agreement job 0419 .* Panel seat 1 Accept (receipt checked )?Accepted Paid 0\.00115 ETH/);
  const kimi = plain((await get("/verifiers/0x71d3d3cca211b6d6daa735d19eb9c7a82f2231d3")).html);
  assert.match(kimi, /It has no standing: its bond is under 0\.01 ETH/);
  assert.match(kimi, /First check Reject (model declared )?Accepted Lost 0\.0010 ETH/);
  assert.equal((await get(`/verifiers/0x${"12".repeat(20)}`)).status, 404);
  // the job page: waiting for its first check
  const w = plain((await get("/jobs/0424")).html);
  assert.match(w, /Hired with a verifier\./);
  assert.match(w, /The customer through the verifier contract/);
  assert.match(w, /Checked by verifiers How verifiers work → Waiting for its first check ?\./);
  assert.match(w, /Nobody has checked it yet\. One verifier will, by/);
  // checked, open to the customer's dispute: the reasons with the tests it ran
  const c = plain((await get("/jobs/0423")).html);
  assert.match(c, /The first check says accept ?\. The customer may dispute it until .* for a bond of 0\.0005 ETH/);
  assert.match(c, /Passed NVDA within 0\.1% of its Chainlink feed/);
  assert.match(c, /Anthropic, anthropic\/claude-haiku-4\.5/);
  // disputed and seating: the seats, what ties one to a side, a strike, an open seat
  const d = plain((await get("/jobs/0422")).html);
  assert.match(d, /Disputed\. A panel decides ?\./);
  assert.match(d, /Failed the brief lists eleven changes; nine are in the notes/);
  assert.match(d, /Disputed by the agent, quill-02, .* with a bond of 0\.0015 ETH/);
  assert.match(d, /Seat 1 factor-gemini Factor's own Sealed/);
  assert.match(d, /What Factor sees tying it to a side the wallet that verified the agent's owner sent it ETH/);
  assert.match(d, /Seat 3 Open until/);
  assert.match(d, /Struck by the customer: orbit-ops/);
  // revealing: a revealed vote with its reasons beside a sealed one
  const r = plain((await get("/jobs/0421")).html);
  assert.match(r, /Seat 1 factor-gemini Factor's own Reject/);
  assert.match(r, /Failed the button to book leads nowhere/);
  assert.match(r, /Seat 3 0xd39c…0a68 Sealed/);
  assert.match(r, /Its vote is sealed until the reveals/);
  // back with the customer, and ended by the panel and by the first check
  assert.match(text((await get("/jobs/0420")).html), /Back in the customer's hands ?\. Nobody checked it in the first 4 hours/);
  const p = plain((await get("/jobs/0419")).html);
  assert.match(p, /Accepted, by the panel ?, 2 to 1 ?\./);
  assert.match(p, /The dispute won: its bond went back to the agent/);
  assert.match(p, /Dispute bond back to the agent the dispute won 0\.0010 ETH/);
  // a seat says when it sat, and the verifier's standing apart from it
  assert.match(p, /Anthropic · seated 13 Oct, 16:02 UTC · standing since 2 Oct/);
  assert.match(p, /Paid to factor-claude added to its free bond 0\.00115 ETH Paid to second-look added to its free bond 0\.00115 ETH Lost by kimi-reads judged wrong: half of its stake 0\.0010 ETH/);
  assert.match(p, /The panel · accept, 2 to accept and 1 to reject/);
  const f = plain((await get("/jobs/0418")).html);
  assert.match(f, /Rejected, by the first check ?\. The job settled at half: 0\.0040 ETH went back to the customer/);
  // the sample has no verifier contract: nothing to dispute, strike or step from it
  for (const t of [c, d, p]) assert.doesNotMatch(t, /Dispute it: |Strike |Take the step/);
  assert.match(d, /The customer and the agent act on it here once the verifier contract is live/);
  // an ordinary job has no such section
  assert.doesNotMatch(text((await get("/jobs/0412")).html), /Checked by verifiers/);
  // hiring with a verifier: the fourth way on the form, the fee, the stake and the dispute bond from the price
  const once = text((await get("/hire")).html);
  assert.match(once, /One job (Monthly )?In stages With a verifier/);
  assert.match(once, /A job with a verifier is one job whose work is checked before it is paid/);
  const h = plain((await get("/hire?agent=price-desk&verifier=1")).html);
  assert.match(h, /The verification fee, in ETH/);
  assert.match(h, /A verifier stakes on its verdict .* 0\.002 ETH A dispute costs .* 0\.001 ETH You send now the price and the fee 0\.0103 ETH/);
  assert.match(h, /The verifier checks the work against these words/);
  assert.match(h, /Not open yet/);
  // an agent's verified jobs, its record as a verifier, and the Factor Score's income from them
  const lumen = plain((await get("/agents/lumen-07")).html);
  assert.match(lumen, /Verifiers How verifiers work → Work checked before it was paid ?\./);
  assert.match(lumen, /Hired with a verifier 2 Accepted paid in full 2/);
  assert.match(lumen, /Verified jobs hired with a verifier, who checked the work before it was paid 2 0 0\.0250 ETH 0\.0005 ETH/);
  assert.match(lumen, /Hire with a verifier/);
  const orbit = plain((await get("/agents/orbit-ops")).html);
  assert.match(orbit, /It checks other agents' work ?\./);
  assert.match(orbit, /A verifier on DeepSeek/);
  assert.doesNotMatch(text((await get("/agents/tally-bot")).html), /Work checked before it was paid|It checks other agents/);
  // the docs, the security page, the protocol and the log
  const docs = plain((await get("/docs")).html);
  assert.match(docs, /Verifiers The verifiers → Work checked before it is paid, by a verifier with a bond on it ?\./);
  assert.match(docs, /hireWithVerifier/);
  assert.match(docs, /api\/v1\/verifiers\/terms/);
  assert.match(docs, /\{(&quot;|")title(&quot;|"):\.\.\.,(&quot;|")brief(&quot;|"):\.\.\.\}/);
  assert.match(docs, /21 tools, from factor_verifiers_about to factor_verified_8004_request and factor_verifier_8004_respond/);
  const sec = plain((await get("/security")).html);
  assert.match(sec, /The verifier contract No owner, no admin, no switch ?\./);
  assert.match(sec, /What can be stopped\. Only what Factor runs beside it/);
  assert.match(sec, /The verifiers verification fees, verifiers' bonds and stakes/);
  const protocol = plain((await get("/protocol")).html);
  assert.match(protocol, /Verifiers The verifiers → A verdict with a bond on it, carried out by the desk ?\./);
  assert.match(protocol, /0\.002 ETH on a 0\.01 ETH job/);
  assert.match(text((await get("/log")).html), /Verifiers A customer can hire an agent with a verifier/);
  // drawn marks, never a character
  for (const path of ["/jobs/0423", "/jobs/0422", `/verifiers/${CLAUDE}`]) assert.doesNotMatch((await get(path)).html, /[\u{2605}\u{2606}\u{2B50}\u{2705}\u{2714}\u{2716}\u{274C}\u{2197}\u{FE0F}]|[\u{1F300}-\u{1FAFF}]/u, path);
});

test("verifiers: the door passes the reads and the two writes, and with no engine the page explains and opens once the contract is live", async () => {
  const about = await (await fetch(`${BASE}/api/v1/verifiers/about`)).json();
  assert.equal(about.enabled, true);
  assert.equal(about.contract, null);
  assert.equal(about.makers.length, 15);
  assert.deepEqual([about.rules.minFeeEth, about.rules.minBondEth, about.rules.stakePct, about.rules.disputePct, about.rules.revealH], [0.0001, 0.01, 20, 10, 18]);
  assert.equal((await (await fetch(`${BASE}/api/v1/verifiers`)).json()).items.length, 6);
  assert.equal((await (await fetch(`${BASE}/api/v1/verifiers?maker=1`)).json()).items.length, 1);
  assert.equal((await (await fetch(`${BASE}/api/v1/verifiers/cases?show=check`)).json()).items[0].id, 8);
  assert.equal((await (await fetch(`${BASE}/api/v1/verifiers/cases?show=open`)).json()).items.length, 5);
  assert.equal((await (await fetch(`${BASE}/api/v1/verifiers/case/3`)).json()).case.decided.votesAccept, 2);
  assert.equal((await (await fetch(`${BASE}/api/v1/verifiers/job/422`)).json()).case.state, "disputed");
  assert.equal((await fetch(`${BASE}/api/v1/verifiers/job/412`)).status, 404);
  assert.equal((await (await fetch(`${BASE}/api/v1/verifiers/${CLAUDE}`)).json()).verifier.house, true);
  for (const path of ["verifiers/admin", "verifiers/case/x", "verifiers/0x12"]) assert.equal((await fetch(`${BASE}/api/v1/${path}`)).status, 404, path);
  const post = (path, body) => fetch(`${BASE}/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // the words of a job and a verifier's reasons go through to the engine; the sample has none to take them
  assert.equal((await post("verifiers/terms", { id: 1, terms: "{\"title\":\"abc\",\"brief\":\"x\"}" })).status, 503);
  assert.equal((await post("verifiers/reason", { id: 1, verifier: CLAUDE, reason: "x" })).status, 503);
  assert.equal((await post("verifiers/check", {})).status, 404);
  // with no engine: the page explains and says when it opens, and nothing of it elsewhere
  const bare = await get("/verifiers", BARE);
  assert.equal(bare.status, 200);
  const t = plain(bare.html);
  assert.match(t, /Verifiers open once their contract is live/);
  assert.match(t, /Staked on one verdict .* 20 ?%, at least 0\.001 ETH/);
  assert.match(t, /Joining opens once the verifier contract is live/);
  assert.doesNotMatch(t, /factor-claude|kimi-reads|Open cases · /);
  assert.doesNotMatch(bare.html, />CONNECT</);
  assert.doesNotMatch(text((await get("/hire", BARE)).html), /With a verifier/);
  for (const path of ["/docs", "/security", "/protocol"]) assert.doesNotMatch(text((await get(path, BARE)).html), /The verifier contract|Work checked before it is paid, by a verifier/, path);
  assert.equal((await get(`/verifiers/${CLAUDE}`, BARE)).status, 404);
});

test("verifiers: model receipts beside every verdict, checked or declared, a receipt's own page, and verdicts on ERC-8004 on the job page, the agent page, the Verifiers page, the docs, the security page, the protocol and the log", async () => {
  const SECOND = "0x972d66a024324294ffd0f4b087f06f0bfd9bbb92";
  // the job page: each verdict's model, and where the verdict stands on ERC-8004
  const p = plain((await get("/jobs/0419")).html);
  assert.match(p, /Seat 1 factor-claude Factor's own Accept .* Model receipt checked Anthropic anthropic\/claude-haiku-4\.5 through OpenRouter · call gen-/);
  assert.match(p, /Seat 2 second-look Accept .* Model declared OpenAI openai\/gpt-5\.1 through OpenAI · call gen-[0-9a-f]+ · \d+ in, \d+ out · its own receipt, as given: not checked/);
  assert.match(p, /Seat 3 orbit-ops .* Model declared DeepSeek No receipt: only the maker it declared/);
  assert.match(p, /What a model receipt shows/);
  assert.match(p, /On ERC-8004 · Requested, waiting for the answer/);
  assert.match(p, /Only the validator the request names can answer, under the tag factorVerify/);
  assert.match(p, /The agent's identity # ?211/);
  assert.match(p, /keccak256 of the file.s UTF-8 text: 0x[0-9a-f]{64}/);
  const job = (await get("/jobs/0419")).html;
  assert.match(job, /href="\/api\/v1\/verifiers\/file\/3"/);
  assert.match(job, new RegExp(`href="/verifiers/receipt/3/${CLAUDE}"`));
  assert.match(job, /href="https:\/\/robinhoodchain\.blockscout\.com\/address\/0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58"/);
  assert.match(plain((await get("/jobs/0417")).html), /On ERC-8004 · Answered .* under the tag factorVerify: 100: accept/);
  const prepared = plain((await get("/jobs/0418")).html);
  assert.match(prepared, /On ERC-8004 · Ready to request The case file is written\. The owner of agent identity #377, or a wallet it approved, can ask for validation on the registry\. The validator is set by rule: the verifier whose verdict was carried out/);
  assert.match(prepared, /The validator the verifier whose verdict was carried out, the only wallet that may answer 0xf8f5…9427/);
  assert.match(plain((await get("/jobs/0424")).html), /On ERC-8004 · Waiting for the outcome/);
  // a receipt's own page: the call, the hashes, the texts; an outside verifier's is shown as given
  const rc = plain((await get(`/verifiers/receipt/3/${CLAUDE}`)).html);
  assert.match(rc, /A model receipt ?\./);
  assert.match(rc, /Model receipt checked Anthropic/);
  assert.match(rc, /Factor checked it at the provider/);
  assert.match(rc, /The model that answered as the provider reports it anthropic\/claude-haiku-4\.5/);
  assert.match(rc, /request 0x[0-9a-f]{64} answer 0x[0-9a-f]{64}/);
  assert.match(rc, /Nobody but Factor can read the provider's own record of the call/);
  assert.match(rc, /The request .* The answer .* The provider's record/);
  const outside = plain((await get(`/verifiers/receipt/3/${SECOND}`)).html);
  assert.match(outside, /Factor did not check this one, so its model stays declared/);
  assert.match(outside, /Model declared OpenAI/);
  assert.doesNotMatch(outside, /The provider's record/);
  assert.equal((await get(`/verifiers/receipt/3/0x${"12".repeat(20)}`)).status, 404);
  // the counts on a verifier's page and in the list
  assert.match(plain((await get(`/verifiers/${CLAUDE}`)).html), /Model receipts checked by Factor at the provider, or the maker only declared 9 checked · 0 declared/);
  const list = plain((await get("/verifiers")).html);
  assert.match(list, /factor-claude Factor's own Anthropic · standing since \d+ \w+ model receipts: 9 checked · 0 declared/);
  assert.match(list, /Model receipts and ERC-8004 What a verdict carries with it ?\./);
  assert.match(list, /What a checked receipt shows\. The verifier's reasons, whose hash has been on the chain since its verdict, name one call at the model provider/);
  assert.match(list, /Verdicts on ERC-8004 Once a verified job has its outcome, Factor writes its case file/);
  // the agent's verified jobs on ERC-8004
  assert.match(plain((await get("/agents/lumen-07")).html), /Verified jobs on ERC-8004 answered on the Validation Registry, tag factorVerify: 100 accept, 0 reject 1 · average 100/);
  // the docs, the security page, the protocol and the log
  assert.match(plain((await get("/docs")).html), /Model receipts\. Each verdict carries model: mark is checked or declared/);
  assert.match(plain((await get("/docs")).html), /On ERC-8004\. A case with its outcome has a case file/);
  assert.match(plain((await get("/security")).html), /Model receipts\. A checked receipt says what Factor saw at the provider/);
  assert.match(plain((await get("/security")).html), /On ERC-8004\. Factor sends nothing for the request/);
  assert.match(plain((await get("/protocol")).html), /Beside each verdict, its model: a receipt Factor checked at the provider, or a maker only declared/);
  assert.match(plain((await get("/log")).html), /Model receipt checked when the verifier's reasons name one call at the model provider/);
  // never a word of proof
  for (const path of ["/jobs/0419", `/verifiers/receipt/3/${CLAUDE}`, `/verifiers/${CLAUDE}`, "/verifiers", "/security", "/protocol", "/log", "/agents/lumen-07"]) assert.doesNotMatch(plain((await get(path)).html), /\bprov(en|es|e)\b/i, path);
  const docsAll = plain((await get("/docs")).html);
  assert.doesNotMatch(docsAll.slice(docsAll.indexOf("Verifiers The verifiers")), /\bprov(en|es|e)\b/i);
  // the door: where a verdict stands, the case file as its own text, a receipt with its texts
  const e = await (await fetch(`${BASE}/api/v1/verifiers/erc8004/1`)).json();
  assert.equal(e.state, "answered");
  assert.equal(e.response, 100);
  const file = await fetch(`${BASE}/api/v1/verifiers/file/1`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(JSON.parse(await file.text()).case, 1);
  assert.equal((await fetch(`${BASE}/api/v1/verifiers/file/8`)).status, 404);
  const receipt = await (await fetch(`${BASE}/api/v1/verifiers/receipt/3/${CLAUDE}`)).json();
  assert.equal(receipt.receipt.by, "factor");
  assert.ok(typeof receipt.request === "string" && typeof receipt.output === "string" && receipt.providerRecord.model);
  for (const path of ["verifiers/erc8004/x", "verifiers/file/x", "verifiers/receipt/3/0x12"]) assert.equal((await fetch(`${BASE}/api/v1/${path}`)).status, 404, path);
  // with no engine: no receipt and no ERC-8004 anywhere
  assert.equal((await get(`/verifiers/receipt/3/${CLAUDE}`, BARE)).status, 404);
  for (const path of ["/docs", "/security", "/protocol"]) assert.doesNotMatch(plain((await get(path, BARE)).html), /Model receipts\.|On ERC-8004\./, path);
});

test("credit reports: the leaderboard, a lookup, a report with its flags and its claim, its card and badge, and the log", async () => {
  const board = plain((await get("/reports")).html);
  assert.match(board, /We scored every AI agent on the chain\./);
  assert.match(board, /Look up any agent/);
  assert.match(board, /ledger-reader/);
  assert.match(board, /factor-report\/1\.1\.0/);
  assert.match(board, /Factor's own agents · ranked apart/);
  assert.match(board, /What it does not reward/);
  const loop = plain((await get("/reports/467")).html);
  assert.match(loop, /Many small loans in a loop/);
  assert.match(loop, /Borrowed and returned unused/);
  assert.match(loop, /Effect: In each 30 days the biggest repayment counts in full/);
  assert.match(loop, /Is this your agent ?\?/);
  assert.match(loop, /Put it on the Factor desk/);
  const desk = plain((await get("/reports/486")).html);
  assert.match(desk, /1st of 416 agents scored on Robinhood Chain/);
  assert.match(desk, /Points by source/);
  assert.match(desk, /What others wrote of it on ERC-8004/);
  // its score on ERC-8004: since when, with the transaction
  assert.match(desk, /On ERC-8004 since 11 Nov 2026/);
  assert.match(desk, /tag factorReport, written by Factor/);
  assert.match(desk, /getSummary\(486, \[Factor\], (&quot;|")factorReport(&quot;|"), (&quot;|"){2}\)/);
  assert.match(board, /On ERC-8004 416 Reports written to the ERC-8004 reputation registry on Robinhood Chain since 11 Nov 2026/);
  assert.equal((await get("/reports/999999")).status, 404);
  const card = await fetch(`${BASE}/api/v1/reports/486/card.png`);
  assert.equal(card.status, 200);
  assert.match(card.headers.get("content-type") ?? "", /image\/png/);
  const badge = await fetch(`${BASE}/api/v1/reports/486/badge.svg`);
  assert.match(await badge.text(), /Factor credit report: 538 of 1000/);
  const found = await (await fetch(`${BASE}/api/v1/reports/find?q=ledger`)).json();
  assert.equal(found.items[0].agentId, "486");
  assert.equal((await fetch(`${BASE}/api/v1/reports/claim`, { method: "GET" })).status, 404);
  assert.match(plain((await get("/log")).html), /Factor Credit Reports We scored every AI agent on the chain\./);
  assert.match(plain((await get("/log")).html), /Credit scores on ERC-8004 Every ranked agent's credit report score is now written to the ERC-8004 reputation registry/);
  assert.match(plain((await get("/docs")).html), /A credit report for every agent on the chain\./);
  // with nothing set, no sample figure: the reports rest
  const bareBoard = plain((await get("/reports", BARE)).html);
  assert.match(bareBoard, /Credit reports are resting just now/);
  // while reports are off, nothing leads to them: not the header, not the menu, not the log, not the docs
  for (const path of ["/", "/agents", "/log", "/docs"]) {
    const { html } = await get(path, BARE);
    assert.doesNotMatch(html, /href="\/reports"/, `${path} leads to the reports while they are off`);
    assert.doesNotMatch(plain(html), /Credit reports|Factor Credit Reports|Credit scores on ERC-8004/, `${path} speaks of the reports while they are off`);
  }
  assert.doesNotMatch(bareBoard, /ledger-reader/);
  assert.equal((await get("/reports/486", BARE)).status, 404);
});

test("vouching: the page, an agent's vouches, a line's and a cover's co-signers, the docs, the protocol and the log", async () => {
  const page = plain((await get("/vouching")).html);
  assert.match(page, /Strong agents stand behind newer ones\./);
  assert.match(page, /A voucher's score the desk's own, as the guarantee contract reads it 300 or more/);
  assert.match(page, /The line defaults with 0\.006 still owed to the line pool: 0\.0002 from the fee, 0\.0058 from the bond 0\.006 ETH/);
  assert.match(page, /Kept into the voucher's bond, and to the burn 0\.0001 · 0\.0001 ETH/);
  assert.match(page, /Factor's own, ranked apart/);
  assert.match(page, /lumen-07/);
  assert.match(page, /co-signs orbit-ops's credit line|co-signs its credit line/);
  assert.doesNotMatch(page, /sample|demo/i);
  // orbit-ops: two vouches on its line, one that counts and one of Factor's own; an offer waiting; its own vouch as a voucher
  const orbit = plain((await get("/agents/orbit-ops")).html);
  assert.match(orbit, /Vouched for How vouching works → One vouch behind it, 0\.0200 ETH\./);
  assert.match(orbit, /Not counted Factor's own: shown, not counted\./);
  assert.match(orbit, /Waiting for orbit-ops to accept it/);
  assert.match(orbit, /As a voucher/);
  assert.match(orbit, /Co-signed by .*lumen-07 for 0\.0200 ETH, until [^:]+: paid to the line pool if the line defaults/);
  assert.match((await get("/agents/orbit-ops")).html, /href="#vouching"/);
  // an agent nobody vouched for: an empty state that says so
  assert.match(plain((await get("/agents/quill-02")).html), /Vouched for How vouching works → No vouch yet\. .*Nobody has vouched for quill-02 yet\./);
  // the covered job: its co-signer
  assert.match(plain((await get("/jobs/0412")).html), /Co-signed by orbit-ops for 0\.0100 ETH: delivered, kept/);
  assert.match(plain((await get("/docs")).html), /A strong agent co-signs a newer one, with its own bond\./);
  assert.match(plain((await get("/docs")).html), /factor_vouch_settle/);
  assert.match(plain((await get("/protocol")).html), /The vouching/);
  assert.match(plain((await get("/security")).html), /The vouching/);
  assert.match(plain((await get("/log")).html), /Vouching An agent with a strong score can now stand behind a newer one\./);
  const engine = await (await fetch(`${BASE}/api/v1/vouches`)).json();
  assert.equal(engine.enabled, true);
  assert.equal(engine.factorOwn.length, 2);
  assert.equal((await (await fetch(`${BASE}/api/v1/vouches/agent/orbit-ops`)).json()).agent.standing, 1);
  // with nothing set: no page, no link, no word of it
  assert.equal((await get("/vouching", BARE)).status, 404);
  for (const path of ["/", "/agents", "/log", "/docs", "/protocol", "/security"]) {
    const { html } = await get(path, BARE);
    assert.doesNotMatch(html, /href="\/vouching"/, `${path} leads to vouching while it is off`);
    // the home page's roadmap names the phase as planned; nothing else speaks of it
    if (path !== "/") assert.doesNotMatch(plain(html), /Vouching|Vouched for|vouch/i, `${path} speaks of vouching while it is off`);
  }
});
