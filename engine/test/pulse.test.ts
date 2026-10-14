import { describe, it, expect } from "vitest";
import { Pulse, pulseOn } from "../src/pulse.js";

/** A node that answers the block numbers it is given, one per ask, and a gas price. */
function node(blocks: (number | null)[], gasWei = 20_012_000) {
  let i = 0;
  const asked: string[] = [];
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body) as { method: string };
    asked.push(method);
    if (method === "eth_gasPrice") return new Response(JSON.stringify({ result: `0x${gasWei.toString(16)}` }));
    const b = blocks[Math.min(i++, blocks.length - 1)];
    return b === null ? new Response("busy", { status: 503 }) : new Response(JSON.stringify({ result: `0x${b.toString(16)}` }));
  }) as unknown as typeof fetch;
  return { fetchFn, asked };
}

describe("the pulse", () => {
  it("keeps each new block with the time it was read and the gas price, newest first", async () => {
    let t = 1_000;
    const n = node([88_227_276, 88_227_300, 88_227_340]);
    const p = new Pulse(["https://node.example"], { fetchFn: n.fetchFn, now: () => (t += 6_000) });
    for (let i = 0; i < 3; i++) await p.beat();
    expect(p.latest().map((b) => b.block)).toEqual([88_227_340, 88_227_300, 88_227_276]);
    expect(p.latest()[2]).toMatchObject({ gwei: 0.02, at: 7_000 });
    expect(n.asked.filter((m) => m === "eth_gasPrice")).toHaveLength(1); // the gas price now and then, not every beat
  });

  it("keeps no line for a block it already has, and none when the node does not answer", async () => {
    const p = new Pulse(["https://node.example"], { fetchFn: node([5, 5, null, 4]).fetchFn });
    expect(await p.beat()).toMatchObject({ block: 5 });
    expect(await p.beat()).toBeNull();
    expect(await p.beat()).toBeNull();
    expect(await p.beat()).toBeNull();
    expect(p.latest()).toHaveLength(1);
  });

  it("asks the next node when one fails, and keeps at most a few readings", async () => {
    let b = 100;
    const fetchFn = (async (url: string, init: { body: string }) => {
      if (url.includes("down")) throw new Error("refused");
      const { method } = JSON.parse(init.body) as { method: string };
      return new Response(JSON.stringify({ result: method === "eth_gasPrice" ? "0x1" : `0x${(b++).toString(16)}` }));
    }) as unknown as typeof fetch;
    const p = new Pulse(["https://down.example", "https://up.example"], { fetchFn, keep: 3 });
    for (let i = 0; i < 5; i++) await p.beat();
    expect(p.latest().map((x) => x.block)).toEqual([104, 103, 102]);
  });

  it("can be switched off, and never reads faster than every two seconds", () => {
    expect(pulseOn({ ENGINE_PULSE: "off" })).toBe(false);
    expect(pulseOn({})).toBe(true);
    expect(new Pulse(["x"], { everyMs: 10 }).everyMs).toBe(2_000);
  });
});
