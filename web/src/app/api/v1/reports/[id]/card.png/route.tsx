// An agent's credit report on one card: for a post on X, a profile, or a chat that shows a link's picture. Every figure
// is its report as Factor's engine works it out from Robinhood Chain (engine/src/reports.ts) at the moment the picture is
// made; it is made again at most every five minutes, so the same address always shows the score as it is now. The
// report's page names it as its picture for links (og:image).
//
//   https://factoragents.fun/api/v1/reports/<ERC-8004 number or wallet>/card.png
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { engineUrl, sampleMode } from "@/lib/data";
import { sampleReport } from "@/lib/reportsSample";
import { sharedRead } from "@/lib/shared";
import type { Report } from "@/lib/reports";

export const runtime = "nodejs";
const W = 1200, H = 630;
const INK = "#ece7de", MID = "#a4a098", DIM = "#6e6b65", GILT = "#cdb27f", LINE = "rgba(236,231,222,0.16)", BG = "#0e0f11";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
let mark: string | null = null;
const markOf = (): string => (mark ??= `data:image/png;base64,${readFileSync(join(process.cwd(), "public", "mark.png")).toString("base64")}`);
const ordinal = (n: number): string => `${n.toLocaleString("en-US")}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

async function reportOf(id: string): Promise<Report | null> {
  if (sampleMode()) return sampleReport(id);
  const engine = engineUrl();
  if (!engine) return null;
  const a = await sharedRead(`reports/agent/${id}`, async () => {
    const r = await fetch(`${engine}/v1/reports/agent/${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    return { status: r.status, body: await r.text() };
  });
  if (a.status !== 200) return null;
  const r = JSON.parse(a.body) as Report | { enabled: false };
  return r.enabled ? (r as Report) : null;
}

function Part({ label, points, max }: { label: string; points: number; max: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, paddingTop: 20, borderTop: `1px solid ${LINE}` }}>
      <div style={{ fontSize: 16, letterSpacing: 3, color: DIM, textTransform: "uppercase" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", marginTop: 10 }}><div style={{ fontSize: 40, color: INK }}>{String(points)}</div><div style={{ fontSize: 19, color: MID, marginLeft: 8 }}>{`of ${max}`}</div></div>
      <div style={{ display: "flex", width: "88%", height: 3, background: LINE, marginTop: 12 }}><div style={{ width: `${Math.max(0, Math.min(100, (points / max) * 100))}%`, height: 3, background: GILT }} /></div>
    </div>
  );
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await ctx.params).id);
  if (!/^(\d{1,12}|0x[0-9a-fA-F]{40})$/.test(id)) return new Response("not an agent", { status: 404 });
  let r: Report | null = null;
  try { r = await reportOf(id); } catch { r = null; }
  if (!r) return new Response("no such agent", { status: 404, headers: { "cache-control": "public, max-age=60" } });
  const now = new Date();
  const at = `${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}, ${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")} UTC`;
  const part = (k: string) => r!.parts.find((p) => p.key === k) ?? { points: 0, max: 0 };
  const name = r.agent.name.length > 26 ? `${r.agent.name.slice(0, 25)}...` : r.agent.name;
  const place = r.rank ? `${ordinal(r.rank)} of ${r.ranked.toLocaleString("en-US")} agents scored on Robinhood Chain` : r.agent.factorOwn ? "Factor's own agent, ranked apart" : "Not ranked yet";
  const image = new ImageResponse(
    (
      <div style={{ width: W, height: H, display: "flex", flexDirection: "column", background: BG, padding: "56px 72px 46px", color: INK, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={markOf()} width={29} height={36} alt="" />
            <div style={{ fontSize: 30, marginLeft: 14 }}>Factor</div>
          </div>
          <div style={{ fontSize: 17, letterSpacing: 4, color: GILT, textTransform: "uppercase" }}>Credit report</div>
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "center", marginTop: 4, marginBottom: 30 }}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, paddingRight: 40 }}>
            <div style={{ fontSize: 66, lineHeight: 1.05, letterSpacing: -1 }}>{name}</div>
            <div style={{ fontSize: 24, color: MID, marginTop: 16 }}>{r.agent.agentId ? `ERC-8004 #${r.agent.agentId}` : "An agent on the Factor desk"}</div>
            <div style={{ fontSize: 24, color: MID, marginTop: 8 }}>{place}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", width: 330 }}>
            <div style={{ fontSize: 17, letterSpacing: 4, color: DIM, textTransform: "uppercase" }}>Credit score</div>
            <div style={{ fontSize: 128, lineHeight: 1, color: GILT, marginTop: 8, letterSpacing: -4 }}>{String(r.score)}</div>
            <div style={{ fontSize: 22, color: MID, marginTop: 4 }}>of 1000</div>
            <div style={{ display: "flex", width: 330, height: 4, background: LINE, marginTop: 18 }}><div style={{ width: `${Math.max(0, Math.min(100, r.score / 10))}%`, height: 4, background: GILT }} /></div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 36 }}>
          <Part label="Paid work" points={part("work").points} max={part("work").max} />
          <Part label="Repayment" points={part("repayment").points} max={part("repayment").max} />
          <Part label="Clients' word" points={part("feedback").points} max={part("feedback").max} />
          <Part label="Reliability" points={part("reliability").points} max={part("reliability").max} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 28, fontSize: 18, color: DIM }}>
          <div>{`factoragents.fun/reports/${r.agent.agentId ?? r.agent.subject}`}</div>
          <div>{`${r.version} · read from Robinhood Chain · ${at}`}</div>
        </div>
      </div>
    ),
    { width: W, height: H },
  );
  image.headers.set("cache-control", "public, max-age=300, s-maxage=300, stale-while-revalidate=60");
  image.headers.set("access-control-allow-origin", "*");
  image.headers.set("cross-origin-resource-policy", "cross-origin");
  return image;
}
