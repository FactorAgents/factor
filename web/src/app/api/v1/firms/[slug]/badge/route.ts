// A firm's badge: a small picture any site can show, with the firm's live count of settled jobs. An image and
// nothing else: no script, nothing about who looks at it is kept. With ?show=score it shows the firm's Factor Score.
//
//   <a href="https://factoragents.fun/firms/the-firm"><img src="https://factoragents.fun/api/v1/firms/the-firm/badge" alt="A Factor firm" height="28"></a>
import { NextResponse } from "next/server";
import { engineUrl } from "@/lib/data";
import { sharedRead } from "@/lib/shared";

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const width = (t: string) => Math.ceil(t.length * 6.6 + 20);

function badge(right: string, ok: boolean, left = "A Factor firm"): string {
  const lw = width(left) + 14, rw = width(right);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="28" viewBox="0 0 ${lw + rw} 28" role="img" aria-label="${esc(`${left}: ${right}`)}"><title>${esc(`${left}: ${right}`)}</title>`
    + `<rect width="${lw}" height="28" rx="4" fill="#0e0f11"/><rect x="${lw - 4}" width="${rw + 4}" height="28" rx="4" fill="${ok ? "#cdb27f" : "#5b5f66"}"/><rect x="${lw - 4}" width="4" height="28" fill="${ok ? "#cdb27f" : "#5b5f66"}"/>`
    + `<circle cx="10" cy="14" r="3" fill="none" stroke="#cdb27f" stroke-width="1.6"/><circle cx="16" cy="14" r="3" fill="none" stroke="#cdb27f" stroke-width="1.6"/>`
    + `<g font-family="Verdana,DejaVu Sans,sans-serif" font-size="11.5"><text x="25" y="18" fill="#ece7de">${esc(left)}</text><text x="${lw + rw / 2}" y="18" fill="${ok ? "#0e0f11" : "#ece7de"}" text-anchor="middle" font-weight="bold">${esc(right)}</text></g></svg>`;
}

const svg = (body: string, maxAge: number) => new NextResponse(body, { status: 200, headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": `public, max-age=${maxAge}`, "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const slug = (await ctx.params).slug.replace(/\.svg$/, "");
  const score = new URL(req.url).searchParams.get("show") === "score";
  const engine = engineUrl();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/.test(slug) || !engine) return svg(badge("not on Factor", false), 300);
  try {
    const a = await sharedRead(`firms/${slug}/record`, async () => {
      const r = await fetch(`${engine}/v1/firms/${slug}/record`, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      return { status: r.status, body: await r.text() };
    });
    if (a.status !== 200) return svg(badge("not on Factor", false), 300);
    const rec = JSON.parse(a.body) as { jobs: { settled: number; settledAtHalf: number }; score?: number };
    if (score) return svg(badge(`${rec.score ?? 0} of 1000`, true, "Factor Score"), 300);
    const n = rec.jobs.settled + rec.jobs.settledAtHalf;
    return svg(badge(`${n} job${n === 1 ? "" : "s"} settled`, true), 300);
  } catch {
    return svg(badge("record not arriving", false), 60);
  }
}
