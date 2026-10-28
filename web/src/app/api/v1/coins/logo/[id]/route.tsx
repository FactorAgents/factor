// An agent coin's picture: the agent's seal, its initials in a ring on Factor's dark ground. Every coin's launch writes
// this address into the coin on Pons, so it answers for as long as the site does, with the agent's name as it is now.
//
//   https://factoragents.fun/api/v1/coins/logo/<the agent's address>
import { ImageResponse } from "next/og";
import { engineUrl } from "@/lib/data";
import { initials } from "@/lib/format";
import { sharedRead } from "@/lib/shared";

const SIZE = 512;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = (await ctx.params).id.replace(/\.png$/, "");
  let name = /^0x[0-9a-fA-F]{40}$/.test(id) ? id.slice(2) : id;
  const engine = engineUrl();
  if (engine && /^[0-9a-zA-Z-]{3,42}$/.test(id)) {
    try {
      const a = await sharedRead(`agents/${id}`, async () => {
        const r = await fetch(`${engine}/v1/agents/${id}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
        return { status: r.status, body: await r.text() };
      });
      if (a.status === 200) {
        const got = JSON.parse(a.body) as { agent?: { name?: string; named?: boolean } };
        if (got.agent?.named && got.agent.name) name = got.agent.name;
      }
    } catch {
      // the seal of the address, then: still the agent's own
    }
  }
  const image = new ImageResponse(
    (
      <div style={{ width: SIZE, height: SIZE, display: "flex", alignItems: "center", justifyContent: "center", background: "#0e0f11" }}>
        <div style={{ width: 400, height: 400, borderRadius: 400, border: "6px solid #cdb27f", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 352, height: 352, borderRadius: 352, border: "2px solid rgba(236,231,222,0.3)", display: "flex", alignItems: "center", justifyContent: "center", color: "#ece7de", fontSize: 150, letterSpacing: -4 }}>{initials(name)}</div>
        </div>
      </div>
    ),
    { width: SIZE, height: SIZE },
  );
  image.headers.set("cache-control", "public, max-age=3600");
  image.headers.set("access-control-allow-origin", "*");
  image.headers.set("cross-origin-resource-policy", "cross-origin");
  return image;
}
