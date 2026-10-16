// "Paid with Factor": a small picture any site can show beside an agent, with the agent's live count of settled
// jobs and its score. It is an image and nothing else: no script, nothing about who looks at it is kept.
//
//   <a href="https://factoragents.fun/agents/your-agent"><img src="https://factoragents.fun/api/v1/badge/0x..." alt="Paid with Factor" height="28"></a>
import { NextResponse } from "next/server";
import { engineUrl } from "@/lib/data";
import { sharedRead } from "@/lib/shared";

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// a rough width for the badge's own font: wide enough for the text, no wider
const width = (t: string) => Math.ceil(t.length * 6.6 + 20);

function badge(right: string, ok: boolean): string {
  const left = "Paid with Factor";
  const lw = width(left) + 14, rw = width(right);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="28" viewBox="0 0 ${lw + rw} 28" role="img" aria-label="${esc(`${left}: ${right}`)}"><title>${esc(`${left}: ${right}`)}</title>`
    + `<rect width="${lw}" height="28" rx="4" fill="#0e0f11"/><rect x="${lw - 4}" width="${rw + 4}" height="28" rx="4" fill="${ok ? "#cdb27f" : "#5b5f66"}"/><rect x="${lw - 4}" width="4" height="28" fill="${ok ? "#cdb27f" : "#5b5f66"}"/>`
    + `<circle cx="13" cy="14" r="4" fill="none" stroke="#cdb27f" stroke-width="2"/>`
    + `<g font-family="Verdana,DejaVu Sans,sans-serif" font-size="11.5"><text x="23" y="18" fill="#ece7de">${esc(left)}</text><text x="${lw + rw / 2}" y="18" fill="${ok ? "#0e0f11" : "#ece7de"}" text-anchor="middle" font-weight="bold">${esc(right)}</text></g></svg>`;
}

const svg = (body: string, maxAge: number) => new NextResponse(body, { status: 200, headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": `public, max-age=${maxAge}`, "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = (await ctx.params).id.replace(/\.svg$/, "");
  const engine = engineUrl();
  if (!/^[0-9a-zA-Z-]{3,42}$/.test(id) || !engine) return svg(badge("not on Factor", false), 300);
  try {
    const a = await sharedRead(`record/${id}`, async () => {
      const r = await fetch(`${engine}/v1/record/${id}`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      return { status: r.status, body: await r.text() };
    });
    if (a.status !== 200) return svg(badge("not on Factor", false), 300);
    const rec = JSON.parse(a.body) as { jobs: { settled: number }; barred: boolean };
    const n = rec.jobs.settled;
    return svg(badge(`${n} job${n === 1 ? "" : "s"} settled`, !rec.barred), 300);
  } catch {
    return svg(badge("record not arriving", false), 60);
  }
}
