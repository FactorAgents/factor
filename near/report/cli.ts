// The credit report of an agent on the NEAR desk, read-only.
//
//   node report/cli.ts factor-scout.testnet                  one report, in the terminal
//   node report/cli.ts factor-scout.testnet --html out.html  and as a page
//   node report/cli.ts --all                                 every agent on the desk, ranked
//   node report/cli.ts factor-scout.testnet --json           the whole report as JSON

import { writeFileSync } from "node:fs";
import { relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreReport, FORMULA, VERSION, type Report } from "./score.ts";
import { snapshot, sameHandFrom, type Snapshot } from "./read.ts";
import { gilt, dim, ink } from "../agent/say.ts";
import { accountLink } from "../lib/near.ts";

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

export function reportFor(agent: string, s: Snapshot): Report {
  return scoreReport({
    agent,
    jobs: s.jobs,
    sameHand: sameHandFrom(s.facts),
    own: s.own,
    carriers: s.carriers,
    nearPerUnit: s.nearPerUnit,
    createdMs: s.facts.get(agent)?.createdMs,
    nowMs: s.readAt,
  });
}

function bar(points: number, max: number, width = 24): string {
  const n = Math.round((points / max) * width);
  return gilt("█".repeat(n)) + dim("·".repeat(width - n));
}

function printReport(r: Report, s: Snapshot) {
  console.log("");
  console.log(`${dim("FACTOR CREDIT REPORT")}  ${dim(s.network.toUpperCase())}  ${dim(r.version)}`);
  console.log(`${ink(r.agent)}`);
  console.log(`${gilt(String(r.score).padStart(4))} ${dim("/ 1000")}`);
  console.log("");
  for (const p of r.parts) console.log(`  ${ink(p.name.padEnd(20))}${bar(p.points, p.max)} ${String(p.points).padStart(4)} ${dim("/ " + p.max)}  ${dim(p.why)}`);
  for (const p of r.pulls) console.log(`  ${ink(("less: " + p.key).padEnd(20))}${" ".repeat(25)}-${String(p.points).padStart(3)}        ${dim(`${p.count} × ${p.why}`)}`);
  console.log("");
  for (const j of r.jobs) {
    const mark = j.counted ? gilt("counted ") : dim("left out");
    console.log(`  ${mark}  ${dim(("#" + j.id).padEnd(5))}${(j.role === "agent" ? "for " : "hired ") + j.counterparty}`.padEnd(70) + dim(`${j.status.padEnd(9)} ${j.why}`));
  }
  if (r.flags.length) console.log("");
  for (const f of r.flags) console.log(`  ${gilt(f.key.padEnd(10))}${dim(f.words)}`);
  console.log("");
  console.log(dim(`  read: ${s.sources.join("; ")}`));
  console.log("");
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/** The report as one page, in Factor's look. Fonts come from the repo's site so the page needs nothing online. */
export function reportHtml(r: Report, s: Snapshot, out: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const fonts = relative(dirname(resolve(out)), resolve(here, "../../web/public/fonts"));
  const parts = r.parts
    .map(
      (p) => `<div class="part"><div class="pn">${esc(p.name)}</div><div class="track"><i style="width:${(100 * p.points) / p.max}%"></i></div><div class="pts">${p.points}<span>/ ${p.max}</span></div><div class="why">${esc(p.why)}</div></div>`,
    )
    .join("");
  const pulls = r.pulls.map((p) => `<div class="part pull"><div class="pn">Less: ${esc(p.key)}</div><div></div><div class="pts">-${p.points}</div><div class="why">${p.count} × ${esc(p.why)}</div></div>`).join("");
  const jobs = r.jobs
    .map(
      (j) =>
        `<tr class="${j.counted ? "in" : "out"}"><td class="m">${j.counted ? "counted" : "left out"}</td><td class="mono">#${j.id}</td><td>${j.role === "agent" ? "for" : "hired"} <span class="mono">${esc(j.counterparty)}</span></td><td class="mono">${j.status}</td><td class="mono">${j.valueNear.toFixed(2)} NEAR</td><td class="w">${esc(j.why)}</td></tr>`,
    )
    .join("");
  const flags = r.flags.map((f) => `<div class="flag"><span class="mono">${esc(f.key)}</span>${esc(f.words)}</div>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Factor credit report</title>
<style>
@font-face{font-family:"Newsreader";src:url("${fonts}/Newsreader.woff2") format("woff2")}
@font-face{font-family:"Newsreader";font-style:italic;src:url("${fonts}/NewsreaderItalic.woff2") format("woff2")}
@font-face{font-family:"Instrument Sans";src:url("${fonts}/InstrumentSans.woff2") format("woff2");font-weight:400 700}
@font-face{font-family:"IBM Plex Mono";src:url("${fonts}/PlexMono.woff2") format("woff2")}
:root{--bg:#0e0f11;--paper:#15161a;--line:rgba(236,231,222,.13);--line2:rgba(236,231,222,.3);--ink:#ece7de;--mid:#a4a098;--dim:#6e6b65;--gilt:#cdb27f;--gilt-soft:rgba(205,178,127,.1);--bad:#c98b7f}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font-family:"Instrument Sans",Arial,sans-serif;font-size:15.5px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:40px 40px 56px}
.mono{font-family:"IBM Plex Mono",monospace}
.top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:18px}
.logo{font-family:"Newsreader",serif;font-size:26px}
.label{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
.label.g{color:var(--gilt)}
.head{display:grid;grid-template-columns:1fr auto;gap:40px;align-items:end;padding:38px 0 30px;border-bottom:1px solid var(--line)}
h1{font-family:"Newsreader",serif;font-weight:400;font-size:52px;line-height:1.04;letter-spacing:-.01em;margin-top:10px}
h1 em{font-style:italic;color:var(--gilt)}
.score{text-align:right}.score b{font-family:"Newsreader",serif;font-weight:400;font-size:112px;line-height:.9;color:var(--gilt)}.score span{font-family:"IBM Plex Mono",monospace;color:var(--dim);font-size:15px;margin-left:8px}
.parts{padding:22px 0;border-bottom:1px solid var(--line)}
.part{display:grid;grid-template-columns:200px 1fr 110px;grid-template-rows:auto auto;column-gap:22px;padding:11px 0}
.pn{font-family:"Newsreader",serif;font-size:21px}
.track{height:6px;background:var(--line);align-self:center;border-radius:3px;overflow:hidden}.track i{display:block;height:100%;background:var(--gilt)}
.pts{font-family:"IBM Plex Mono",monospace;text-align:right;font-size:17px}.pts span{color:var(--dim);font-size:12px;margin-left:6px}
.why{grid-column:2/4;color:var(--mid);font-size:13.5px}
.pull .pts{color:var(--bad)}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13.5px}
td{padding:9px 10px 9px 0;border-bottom:1px solid var(--line);vertical-align:top}
td.m{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;white-space:nowrap}
tr.in td.m{color:var(--gilt)} tr.out td.m{color:var(--bad)} tr.out td{color:var(--mid)}
td.w{color:var(--mid)}
.sec{padding-top:26px}
.flag{display:flex;gap:14px;padding:10px 14px;background:var(--gilt-soft);border:1px solid var(--line);border-radius:8px;margin-top:10px;font-size:14px;color:var(--mid)}
.flag .mono{color:var(--gilt);font-size:12px;letter-spacing:.08em;white-space:nowrap}
.foot{margin-top:28px;color:var(--dim);font-size:12.5px;font-family:"IBM Plex Mono",monospace;line-height:1.7}
</style></head><body><div class="wrap">
<div class="top"><div class="logo">Factor</div><div class="label">Credit report · NEAR ${esc(s.network)} · ${esc(r.version)}</div></div>
<div class="head"><div><div class="label g">Agent on the NEAR desk</div><h1>${esc(r.agent)}</h1></div><div class="score"><b>${r.score}</b><span>/ 1000</span></div></div>
<div class="parts">${parts}${pulls}</div>
<div class="sec"><div class="label">Every job, and whether it counts</div><table>${jobs}</table></div>
${flags ? `<div class="sec"><div class="label">Flags</div>${flags}</div>` : ""}
<div class="foot">Read only: ${esc(s.sources.join("; "))}.<br>Desk ${esc(s.desk)} · ${esc(accountLink(r.agent))} · formula ${esc(VERSION)} · paid work ${FORMULA.parts.paidWork.max}, repaid ${FORMULA.parts.repayment.max}, on time ${FORMULA.parts.reliability.max}, hiring ${FORMULA.parts.hiring.max}, time ${FORMULA.parts.time.max}</div>
</div></body></html>`;
}

async function main() {
  const s = await snapshot();
  if (args.includes("--all")) {
    const agents = [...new Set(s.jobs.map((j) => j.agent).filter(Boolean))] as string[];
    const rows = agents.map((a) => reportFor(a, s)).sort((a, b) => b.score - a.score);
    console.log("");
    rows.forEach((r, i) => console.log(`  ${dim(String(i + 1).padStart(2))}  ${ink(r.agent.padEnd(34))}${gilt(String(r.score).padStart(4))}  ${dim(`${r.totals.counted} counted, ${r.totals.excluded} left out${s.own.has(r.agent) ? ", Factor's own" : ""}`)}`));
    console.log("");
    return;
  }
  const agent = args.find((a) => !a.startsWith("--") && a !== flag("html"));
  if (!agent) {
    console.log("usage: node report/cli.ts <account> [--html out.html] [--json] | --all");
    return;
  }
  const r = reportFor(agent, s);
  if (args.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else printReport(r, s);
  const html = flag("html");
  if (html) {
    writeFileSync(html, reportHtml(r, s, html));
    console.log(dim(`  page: ${html}`));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`stopped: ${e?.message ?? e}`);
    process.exit(1);
  });
}
