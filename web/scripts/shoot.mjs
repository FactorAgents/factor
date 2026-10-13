// Screen-sized pictures of every page, on a desktop and on a phone, and whether any page is wider than its screen.
//   node scripts/shoot.mjs [base]
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
const BASE = process.argv[2] ?? "http://localhost:3600";
const OUT = new URL("../../docs/shots/", import.meta.url).pathname; mkdirSync(OUT, { recursive: true });
const PAGES = [["home", "/"], ["ledger", "/ledger"], ["agents", "/agents"], ["agent", "/agents/lumen-07"], ["job-open", "/jobs/0414"], ["job", "/jobs/0412"], ["job-page", "/jobs/0408"], ["job-text", "/jobs/0411"], ["own-agent", "/agents/page-smith"], ["hire-own", "/hire?agent=plain-reader"], ["job-bad", "/jobs/0406"], ["job-half", "/jobs/0404"], ["job-declined", "/jobs/0403"], ["hire", "/hire"], ["work", "/work"], ["protocol", "/protocol"], ["token", "/token"], ["docs", "/docs"], ["log", "/log"]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9989;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--hide-scrollbars", `--user-data-dir=/tmp/factor-site-${Date.now()}`, "about:blank"], { stdio: "ignore" });
let page; for (let i = 0; i < 100 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page"); } catch { await sleep(150); } }
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const wait = new Map(); const errors = [];
const send = (method, params = {}) => new Promise((r) => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
ws.addEventListener("message", (m) => { const x = JSON.parse(m.data); if (x.id && wait.has(x.id)) { wait.get(x.id)(x); wait.delete(x.id); } if (x.method === "Runtime.exceptionThrown") errors.push(String(x.params.exceptionDetails?.exception?.description ?? x.params.exceptionDetails?.text).slice(0, 160)); if (x.method === "Runtime.consoleAPICalled" && x.params.type === "error") errors.push("console: " + x.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 160)); });
const run = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Page.enable"); await send("Runtime.enable");
const VIEWS = [["desktop", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }], ["phone", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }]];
for (const [view, metrics] of VIEWS) for (const [name, path] of PAGES) {
  await send("Emulation.setDeviceMetricsOverride", metrics);
  await send("Page.navigate", { url: BASE + path }); await sleep(1500);
  await run("document.fonts.ready.then(() => 1)");
  const tall = await run("document.documentElement.scrollHeight"), wide = await run("document.documentElement.scrollWidth");
  const stops = [0, ...(tall > metrics.height * 1.6 ? [Math.round((tall - metrics.height) / 2)] : []), ...(tall > metrics.height * 1.2 ? [tall - metrics.height] : [])];
  for (const [i, y] of stops.entries()) { await run(`window.scrollTo(0, ${y})`); await sleep(1700); const p = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}${view}-${name}-${i + 1}.png`, Buffer.from(p.result.data, "base64")); }
  console.log(`${view.padEnd(8)}${name.padEnd(11)}${String(wide).padStart(5)} x ${String(tall).padEnd(6)}${wide > metrics.width + 1 ? "TOO WIDE" : "fits"}`);
}
if (errors.length) console.log("ERRORS", JSON.stringify([...new Set(errors)]));
chrome.kill(); process.exit(0);
