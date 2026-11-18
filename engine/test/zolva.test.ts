// The Replay-verified mark with Zolva (src/zolva.ts): read from Zolva's public answers, shown only on Zolva's own
// identity, only while every public agent matches and the reading is fresh, off unless ZOLVA=on.
import { describe, expect, it } from "vitest";
import { readZolva, ZolvaReplay } from "../src/zolva.js";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fakeFetch(statuses: string[], hours = 10) {
  return (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/api/public/v1/agents")) return new Response(JSON.stringify({ agents: statuses.map((_, i) => ({ id: ID(i) })), count: statuses.length }));
    const m = u.match(/agents\/([0-9a-f-]{36})\/verify$/);
    if (m) {
      const i = Number(m[1].slice(-12));
      return new Response(JSON.stringify({ status: statuses[i], hoursVerified: hours, verifiedSince: i === 0 ? "2026-11-14T00:00:00Z" : "2026-11-15T00:00:00Z" }));
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}
const on = readZolva({ ZOLVA: "on" });

describe("the Replay-verified mark", () => {
  it("is off unless ZOLVA=on and names Zolva's identity 25650 by default", () => {
    expect(readZolva({}).enabled).toBe(false);
    expect(on.agentId).toBe("25650");
  });

  it("shows on Zolva's report while every public agent matches, with the totals", async () => {
    let now = 1_000_000;
    const z = new ZolvaReplay(on, { fetch: fakeFetch(["match", "match", "match"]), now: () => now, log: () => {} });
    expect(await z.refresh()).toBe("3 of 3 public agents match, 30 hours verified");
    const m = z.of("25650")!;
    expect(m.line).toBe("3 of 3 public agents, every checkable hour matches");
    expect(m.hoursVerified).toBe(30);
    expect(m.verifiedSince).toBe("2026-11-14T00:00:00Z");
    expect(z.of("25651")).toBeNull();
    expect(z.of(null)).toBeNull();
    now += 2 * 3600_000 + 1;
    expect(z.of("25650")).toBeNull();
  });

  it("shows nothing when one agent differs or does not answer", async () => {
    const z = new ZolvaReplay(on, { fetch: fakeFetch(["match", "differ", "match"]), now: () => 1, log: () => {} });
    await z.refresh();
    expect(z.of("25650")).toBeNull();
    const broken = new ZolvaReplay(on, { fetch: fakeFetch(["match", "match"]), now: () => 1, log: () => {} });
    const f = fakeFetch(["match", "match"]);
    const flaky = (async (u: string) => (String(u).includes(ID(1)) ? new Response("no", { status: 500 }) : f(u))) as unknown as typeof fetch;
    const z2 = new ZolvaReplay(on, { fetch: flaky, now: () => 1, log: () => {} });
    await z2.refresh();
    expect(z2.of("25650")).toBeNull();
    expect(broken.of("25650")).toBeNull();
  });

  it("reads nothing while it is off", async () => {
    const z = new ZolvaReplay(readZolva({}), { fetch: fakeFetch(["match"]), now: () => 1, log: () => {} });
    expect(await z.refresh()).toBe("off");
    expect(z.of("25650")).toBeNull();
  });
});
