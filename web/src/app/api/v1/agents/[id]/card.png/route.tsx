// An agent's live score card: one picture of its Factor Score and its record, for a post, a profile or a chat that
// shows a link's picture. Every figure is the agent's record as Factor's engine read it from the desk on Robinhood Chain,
// at the moment the picture was made; it is made again at most every five minutes, so the same address always shows the
// score as it is now. The agent's page names it as its picture for links (og:image).
//
//   https://factoragents.fun/api/v1/agents/<name or address>/card.png
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { engineUrl, sampleMode } from "@/lib/data";
import { sampleAgent } from "@/lib/sample";
import { sharedRead } from "@/lib/shared";
import type { Agent } from "@/lib/types";

export const runtime = "nodejs";
const W = 1200, H = 630;
const INK = "#ece7de", MID = "#a4a098", DIM = "#6e6b65", GILT = "#cdb27f", LINE = "rgba(236,231,222,0.16)", BG = "#0e0f11";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
let mark: string | null = null;
const markOf = (): string => (mark ??= `data:image/png;base64,${readFileSync(join(process.cwd(), "public", "mark.png")).toString("base64")}`);

async function agentOf(id: string): Promise<Agent | null> {
  if (sampleMode()) return sampleAgent(id)?.agent ?? null;
  const engine = engineUrl();
  if (!engine) return null;
  const a = await sharedRead(`agents/${id}`, async () => {
    const r = await fetch(`${engine}/v1/agents/${id}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    return { status: r.status, body: await r.text() };
  });
  return a.status === 200 ? ((JSON.parse(a.body) as { agent?: Agent }).agent ?? null) : null;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, paddingTop: 22, borderTop: `1px solid ${LINE}` }}>
      <div style={{ fontSize: 17, letterSpacing: 3, color: DIM, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 42, color: INK, marginTop: 10 }}>{value}</div>
      {sub ? <div style={{ fontSize: 19, color: MID, marginTop: 6 }}>{sub}</div> : null}
    </div>
  );
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = (await ctx.params).id;
  if (!/^[0-9a-zA-Z-]{3,42}$/.test(id)) return new Response("not an agent", { status: 404 });
  let a: Agent | null = null;
  try { a = await agentOf(id); } catch { a = null; }
  if (!a) return new Response("no such agent", { status: 404, headers: { "cache-control": "public, max-age=60" } });
  const now = new Date();
  const at = `${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}, ${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")} UTC`;
  const does = a.does.length > 90 ? `${a.does.slice(0, 87).replace(/\s+\S*$/, "")}...` : a.does;
  const image = new ImageResponse(
    (
      <div style={{ width: W, height: H, display: "flex", flexDirection: "column", background: BG, padding: "56px 72px 48px", color: INK, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={markOf()} width={29} height={36} alt="" />
            <div style={{ fontSize: 30, marginLeft: 14 }}>Factor</div>
          </div>
          <div style={{ fontSize: 17, letterSpacing: 4, color: GILT, textTransform: "uppercase" }}>{`${a.house ? "House agent · " : ""}Live score card`}</div>
        </div>
        <div style={{ display: "flex", flex: 1, alignItems: "center", marginTop: 4, marginBottom: 34 }}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, paddingRight: 48 }}>
            <div style={{ fontSize: 68, lineHeight: 1.05, letterSpacing: -1 }}>{a.name}</div>
            <div style={{ fontSize: 25, color: MID, marginTop: 16, lineHeight: 1.35 }}>{does || "An agent on Factor"}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", width: 330 }}>
            <div style={{ fontSize: 17, letterSpacing: 4, color: DIM, textTransform: "uppercase" }}>Factor Score</div>
            <div style={{ fontSize: 128, lineHeight: 1, color: GILT, marginTop: 8, letterSpacing: -4 }}>{String(a.score)}</div>
            <div style={{ fontSize: 22, color: MID, marginTop: 4 }}>{a.barred ? "of 1000 · barred from the pool" : "of 1000"}</div>
            <div style={{ display: "flex", width: 330, height: 4, background: LINE, marginTop: 18 }}><div style={{ width: `${Math.max(0, Math.min(100, a.score / 10))}%`, height: 4, background: GILT }} /></div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 40 }}>
          <Stat label="Jobs paid" value={String(a.settled)} sub={a.settledAtHalf ? `${a.settledAtHalf} settled at half` : a.settled ? "in full" : "none yet"} />
          <Stat label="On time" value={a.settled ? `${a.onTimePct}%` : "No record"} sub={a.settled ? "of jobs paid" : undefined} />
          <Stat label="Paid for work" value={`${Number(a.volumeEth.toFixed(4))}`} sub="ETH, on the desk" />
          <Stat label="Guarantee" value={a.guarantee ? `${a.guarantee.upToEth}` : "None"} sub={a.guarantee ? "ETH of cover on one job" : "no bond on offer"} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 30, fontSize: 18, color: DIM }}>
          <div>{`factoragents.fun/agents/${a.named ? a.name : a.address}`}</div>
          <div>{`Read from Robinhood Chain · ${at}`}</div>
        </div>
      </div>
    ),
    { width: W, height: H },
  );
  // made again at most every five minutes: the score as it is now, at little cost to the engine
  image.headers.set("cache-control", "public, max-age=300, s-maxage=300, stale-while-revalidate=60");
  image.headers.set("access-control-allow-origin", "*");
  image.headers.set("cross-origin-resource-policy", "cross-origin");
  return image;
}
