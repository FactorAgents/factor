// Proof that the page moves: the same part of the home page pictured three times, a few seconds apart, and how
// much changed between the pictures.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(new URL("../../engine/package.json", import.meta.url));
const WebSocket = require("ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9990;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--hide-scrollbars", `--user-data-dir=/tmp/factor-alive-${Date.now()}`, "about:blank"], { stdio: "ignore" });
let page; for (let i = 0; i < 100 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page"); } catch { await sleep(150); } }
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 1e9 }); await new Promise((r) => ws.on("open", r));
let id = 0; const wait = new Map();
const send = (method, params = {}) => new Promise((r) => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
ws.on("message", (m) => { const x = JSON.parse(m); if (x.id && wait.has(x.id)) { wait.get(x.id)(x); wait.delete(x.id); } });
const run = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://localhost:3600/" }); await sleep(2500);
const read = () => run(`JSON.stringify({ block: document.querySelector(".liveblock span")?.textContent, say: document.querySelector(".flow-say")?.textContent, bar: document.querySelector(".flow .split i")?.style.width, first: document.querySelector(".ledger .row .time")?.textContent, fresh: document.querySelectorAll(".row.fresh").length, tape: getComputedStyle(document.querySelector(".run")).transform, shown: document.querySelectorAll(".rv.in").length + "/" + document.querySelectorAll(".rv").length })`);
for (let i = 0; i < 4; i++) { console.log(await read()); const p = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`/tmp/factor-alive-${i}.png`, Buffer.from(p.result.data, "base64")); await sleep(2600); }
chrome.kill(); process.exit(0);
