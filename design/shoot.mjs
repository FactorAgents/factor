// Screen-sized pictures of the design system page, on a desktop and on a phone, in both themes.
//   node shoot.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(new URL("../engine/package.json", import.meta.url));
const WebSocket = require("ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9987, FILE = new URL("./system.html", import.meta.url).href;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--hide-scrollbars", "--allow-file-access-from-files", `--user-data-dir=/tmp/factor-shoot-${Date.now()}`, "about:blank"], { stdio: "ignore" });
let page; for (let i = 0; i < 100 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page"); } catch { await sleep(150); } }
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 1e9 }); await new Promise((r) => ws.on("open", r));
let id = 0; const wait = new Map();
const send = (method, params = {}) => new Promise((r) => { const n = ++id; wait.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
ws.on("message", (m) => { const x = JSON.parse(m); if (x.id && wait.has(x.id)) { wait.get(x.id)(x); wait.delete(x.id); } });
const run = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Page.enable");
const VIEWS = [["desktop", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }], ["phone", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }]];
for (const theme of ["dark", "light"]) for (const [name, metrics] of VIEWS) {
  await send("Emulation.setDeviceMetricsOverride", metrics);
  await send("Page.navigate", { url: FILE + (theme === "light" ? "#light" : "") }); await sleep(1500);
  await run(`document.documentElement.dataset.theme = "${theme}"; document.fonts.ready.then(() => 1)`);
  const tall = await run("document.documentElement.scrollHeight"), wide = await run("document.documentElement.scrollWidth");
  console.log(theme, name, "page", wide, "x", tall, wide > metrics.width + 1 ? "TOO WIDE" : "fits");
  const stops = theme === "light" ? [0, Math.round(tall * 0.45)] : [...Array(Math.ceil(tall / metrics.height)).keys()].map((i) => Math.min(i * metrics.height, tall - metrics.height));
  for (const [i, y] of [...new Set(stops)].entries()) {
    await run(`window.scrollTo(0, ${y})`); await sleep(250);
    const p = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(new URL(`./shots/${theme}-${name}-${i + 1}.png`, import.meta.url), Buffer.from(p.result.data, "base64"));
  }
}
chrome.kill(); process.exit(0);
