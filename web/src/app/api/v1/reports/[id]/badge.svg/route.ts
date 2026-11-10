// "Factor credit report": a small picture any site can show beside an agent, with its credit score as its report has it
// now (engine/src/reports.ts). An image and nothing else: no script, and nothing about who looks at it is kept.
//
//   <a href="https://factoragents.fun/reports/486"><img src="https://factoragents.fun/api/v1/reports/486/badge.svg" alt="Factor credit report" height="28"></a>
import { NextResponse } from "next/server";
import { engineUrl, sampleMode } from "@/lib/data";
import { sampleReport } from "@/lib/reportsSample";
import { sharedRead } from "@/lib/shared";

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const width = (t: string) => Math.ceil(t.length * 6.6 + 20);

function badge(right: string, ok: boolean, left = "Factor credit report"): string {
  const lw = width(left) + 14, rw = width(right);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="28" viewBox="0 0 ${lw + rw} 28" role="img" aria-label="${esc(`${left}: ${right}`)}"><title>${esc(`${left}: ${right}`)}</title>`
    + `<rect width="${lw}" height="28" rx="4" fill="#0e0f11"/><rect x="${lw - 4}" width="${rw + 4}" height="28" rx="4" fill="${ok ? "#cdb27f" : "#5b5f66"}"/><rect x="${lw - 4}" width="4" height="28" fill="${ok ? "#cdb27f" : "#5b5f66"}"/>`
    + `<circle cx="13" cy="14" r="4" fill="none" stroke="#cdb27f" stroke-width="2"/>`
    + `<g font-family="Verdana,DejaVu Sans,sans-serif" font-size="11.5"><text x="23" y="18" fill="#ece7de">${esc(left)}</text><text x="${lw + rw / 2}" y="18" fill="${ok ? "#0e0f11" : "#ece7de"}" text-anchor="middle" font-weight="bold">${esc(right)}</text></g></svg>`;
}

const svg = (body: string, maxAge: number) => new NextResponse(body, { status: 200, headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": `public, max-age=${maxAge}`, "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await ctx.params).id);
  if (!/^(\d{1,12}|0x[0-9a-fA-F]{40})$/.test(id)) return svg(badge("no such agent", false), 300);
  if (sampleMode()) { const r = sampleReport(id); return svg(badge(r ? `${r.score} of 1000` : "no such agent", !!r && r.score > 0), 300); }
  const engine = engineUrl();
  if (!engine) return svg(badge("not reading the chain", false), 300);
  try {
    const a = await sharedRead(`reports/agent/${id}`, async () => {
      const r = await fetch(`${engine}/v1/reports/agent/${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      return { status: r.status, body: await r.text() };
    });
    if (a.status !== 200) return svg(badge("no such agent", false), 300);
    const r = JSON.parse(a.body) as { enabled?: boolean; score?: number };
    if (!r.enabled || typeof r.score !== "number") return svg(badge("resting", false), 120);
    return svg(badge(`${r.score} of 1000`, r.score > 0), 300);
  } catch {
    return svg(badge("not arriving", false), 60);
  }
}
