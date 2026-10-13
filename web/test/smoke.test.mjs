// Builds nothing: it expects `next build` to have run, serves the site and reads the real HTML of every page. What
// it holds the site to: each page is there with one main heading and the same header, the copy keeps to the rules,
// an address that does not exist says so, and each document is small enough for a phone.
//
// Two servers: one on the sample (FACTOR_SAMPLE=1, every page with something in it), and one with nothing set, which
// must show an empty desk and never a sample figure. The site on a real engine is tested by scripts/flows.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 3611, BASE = `http://127.0.0.1:${PORT}`, BARE = `http://127.0.0.1:${PORT + 1}`;
const PAGES = ["/", "/ledger", "/ledger?show=burned", "/agents", "/agents/lumen-07", "/jobs/0412", "/jobs/0406", "/jobs/0404", "/jobs/0403", "/hire", "/hire?agent=page-smith", "/work", "/protocol", "/token", "/docs", "/log"];
const NAV = ["/ledger", "/agents", "/hire", "/work", "/protocol", "/token", "/docs"];
// words the copy does not use: no long dash, no promise of gain
const FORBIDDEN = [/—/, /\binvest/i, /\breturns?\b/i, /\bprofit/i, /\byield/i, /guarantee/i];
let server, bare;
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const get = async (path, base = BASE) => { const r = await fetch(base + path); return { status: r.status, html: await r.text(), headers: r.headers }; };
// next itself, in a process group of its own, so that stopping it leaves nothing running
const start = (port, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, FACTOR_ENGINE_URL: "", FACTOR_SAMPLE: "", ...env } });
  const t = setTimeout(() => reject(new Error("the site did not start")), 30_000);
  child.stdout.on("data", (d) => { if (/Ready|Local:/i.test(String(d))) { clearTimeout(t); resolve(child); } });
});
const stop = (child) => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } child.stdout.destroy(); child.stderr.destroy(); };

before(async () => {
  [server, bare] = await Promise.all([start(PORT, { FACTOR_SAMPLE: "1" }), start(PORT + 1, {})]);
});
after(() => { stop(server); stop(bare); });

test("every page answers, with one main heading and the header that leads to the others", async () => {
  for (const path of PAGES) {
    const { status, html } = await get(path);
    assert.equal(status, 200, path);
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, `${path} has one main heading`);
    for (const to of NAV) assert.match(html, new RegExp(`href="${to}"`), `${path} does not lead to ${to}`);
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
  assert.match(bad, /Can draw nothing yet/);
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

test("with no engine the site shows an empty desk, and never a sample figure", async () => {
  for (const path of ["/", "/ledger", "/agents", "/hire", "/work", "/protocol", "/token", "/docs", "/log"]) {
    const { status, html } = await get(path, BARE);
    assert.equal(status, 200, path);
    const t = text(html);
    assert.doesNotMatch(t, /lumen-07|page-smith|4,120,553|0\.62 ETH/, `${path} shows a sample figure`);
    assert.match(html, /NOT LIVE YET/, path);
    assert.doesNotMatch(html, />CONNECT</, `${path} offers a wallet with nothing to send to`);
  }
  assert.match(text((await get("/", BARE)).html), /No agent has registered yet/);
  assert.match(text((await get("/", BARE)).html), /Nothing has happened on the desk yet/);
  assert.match(text((await get("/hire", BARE)).html), /Nothing is live yet/);
  assert.match(text((await get("/protocol", BARE)).html), /not deployed yet/);
  assert.equal((await get("/agents/lumen-07", BARE)).status, 404);
  assert.equal((await get("/jobs/0412", BARE)).status, 404);
  assert.equal((await fetch(`${BARE}/api/v1/state`)).status, 503);
});

test("the docs show the kit as it is: the install, an agent, a customer, and the assistant's tools with its caps", async () => {
  const t = text((await get("/docs")).html);
  assert.match(t, /npm install factor-kit/);
  assert.match(t, /for await \(const job of factor\.jobsForMe \(\)\)|for await \(const job of factor\. ?jobsForMe ?\(\)\)/);
  assert.match(t, /await factor\. ?hire ?\(\{/);
  assert.match(t, /FACTOR_MAX_JOB_ETH/);
  assert.match(t, /Two caps you set, which it cannot lift/);
  assert.match(t, /It never sees the key/);
  assert.match(t, /canDrawOn ?\(jobId\) view/);
});

test("an address that does not exist says so", async () => {
  for (const path of ["/nope", "/agents/nobody", "/jobs/9999"]) assert.equal((await get(path)).status, 404, path);
});

test("each page is small enough for a phone, and nothing loads from another site", async () => {
  for (const path of PAGES) {
    const { html, headers } = await get(path);
    assert.ok(html.length < 220_000, `${path} is ${html.length} bytes`);
    assert.doesNotMatch(html, /(src|href)="https?:\/\/(?!ponsfamily\.com|github\.com|x\.com|robinhoodchain\.blockscout\.com\/(tx|address)\/0x)/, `${path} loads from another site`);
    assert.match(headers.get("content-security-policy") ?? "", /default-src 'self'/, `${path} has no content policy`);
  }
});
