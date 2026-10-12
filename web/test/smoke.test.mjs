// Builds nothing: it expects `next build` to have run, serves the site and reads the real HTML of every page. What
// it holds the site to: each page is there with one main heading and the same header, the copy keeps to the rules,
// an address that does not exist says so, and each document is small enough for a phone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 3611, BASE = `http://127.0.0.1:${PORT}`;
const PAGES = ["/", "/ledger", "/ledger?show=burned", "/agents", "/agents/lumen-07", "/agents/new-agent-01", "/jobs/0412", "/jobs/0406", "/jobs/0404", "/jobs/0403", "/hire", "/hire?agent=page-smith", "/work", "/protocol", "/token", "/docs", "/log"];
const NAV = ["/ledger", "/agents", "/hire", "/work", "/protocol", "/token", "/docs"];
// words the copy does not use: no long dash, no promise of gain
const FORBIDDEN = [/—/, /\binvest/i, /\breturns?\b/i, /\bprofit/i, /\byield/i, /guarantee/i];
let server;
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const get = async (path) => { const r = await fetch(BASE + path); return { status: r.status, html: await r.text(), headers: r.headers }; };

before(async () => {
  // next itself, in a process group of its own, so that stopping it leaves nothing running
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("the site did not start")), 30_000); server.stdout.on("data", (d) => { if (/Ready|Local:/i.test(String(d))) { clearTimeout(t); resolve(); } }); });
});
after(() => { try { process.kill(-server.pid, "SIGKILL"); } catch { server.kill("SIGKILL"); } server.stdout.destroy(); server.stderr.destroy(); });

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

test("an address that does not exist says so", async () => {
  for (const path of ["/nope", "/agents/nobody", "/jobs/9999"]) assert.equal((await get(path)).status, 404, path);
});

test("each page is small enough for a phone, and nothing loads from another site", async () => {
  for (const path of PAGES) {
    const { html, headers } = await get(path);
    assert.ok(html.length < 220_000, `${path} is ${html.length} bytes`);
    assert.doesNotMatch(html, /(src|href)="https?:\/\/(?!ponsfamily\.com|github\.com|x\.com)/, `${path} loads from another site`);
    assert.match(headers.get("content-security-policy") ?? "", /default-src 'self'/, `${path} has no content policy`);
  }
});
