// Proof that the receipt prints: the home page read four times, a few seconds apart. Each read says what the
// newest line on the receipt is, where the paper sits, and how many of the page's parts have come up.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9990;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--hide-scrollbars", `--user-data-dir=/tmp/factor-alive-${Date.now()}`, "about:blank"], { stdio: "ignore" });
let page; for (let i = 0; i < 100 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page"); } catch { await sleep(150); } }
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const wait = new Map();
const send = (method, params = {}) => new Promise((r) => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
ws.addEventListener("message", (m) => { const x = JSON.parse(m.data); if (x.id && wait.has(x.id)) { wait.get(x.id)(x); wait.delete(x.id); } });
const run = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://localhost:3600/" }); await sleep(2500);
const read = () => run(`JSON.stringify({ blocks: document.querySelectorAll(".receipt .block").length, newest: [...document.querySelectorAll(".receipt .block")][0]?.querySelector("text.k")?.textContent + " " + [...document.querySelectorAll(".receipt .block")][0]?.querySelector("text.a")?.textContent, second: [...document.querySelectorAll(".receipt .block")][1]?.style.transform, printing: !!document.querySelector(".receipt .block.new"), shown: document.querySelectorAll(".rv.in").length + "/" + document.querySelectorAll(".rv").length })`);
const seen = [];
for (let i = 0; i < 4; i++) { const r = await read(); seen.push(r); console.log(r); const p = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`/tmp/factor-alive-${i}.png`, Buffer.from(p.result.data, "base64")); await sleep(3900); }
console.log(new Set(seen.map((s) => JSON.parse(s).newest)).size > 1 ? "the receipt prints" : "THE RECEIPT DID NOT PRINT");
// further down, the parts of the page come up as they are reached
await run("window.scrollTo(0, 1600)"); await sleep(1500);
const shown = await run(`document.querySelectorAll(".rv.in").length + "/" + document.querySelectorAll(".rv").length`);
console.log(`after scrolling: ${shown} parts shown`);
chrome.kill(); process.exit(0);
