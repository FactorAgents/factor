import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Live, livePushOn } from "../src/live.js";
import { Engine } from "../src/engine.js";
import { open } from "../src/chain/db.js";

/** A state that can be changed by hand, and a count of writes that can be moved by hand. */
function world() {
  const w = { state: { asOf: "t0", pulse: [{ block: 1 }], events: [1, 2] } as Record<string, unknown>, writes: 0, built: 0, forgot: 0, t: 1_000 };
  const live = new Live({ state: () => (w.built++, w.state), writes: () => w.writes, changed: () => w.forgot++, now: () => w.t, fullEveryMs: 15_000 });
  return { w, live };
}

describe("the live stream: what counts as a change", () => {
  it("sends nothing for the first look, then one state message when what the site shows changes", () => {
    const { w, live } = world();
    expect(live.look()).toBeNull();
    w.writes++;
    expect(live.look()).toBeNull(); // written, but nothing the site shows is different
    w.state = { ...w.state, events: [1, 2, 3] };
    w.writes++;
    const m = live.look();
    expect(m).toMatchObject({ seq: 1, kind: "state" });
    expect(w.forgot).toBe(1); // the engine's kept answers are forgotten before the change goes out
    w.writes++;
    expect(live.look()).toBeNull(); // the same state again
  });

  it("does not count the state's own time or the blocks as a change", () => {
    const { w, live } = world();
    live.look();
    w.state = { ...w.state, asOf: "t1", pulse: [{ block: 2 }] };
    w.writes++;
    expect(live.look()).toBeNull();
  });

  it("works the state out only after a write, or when it has not for a while", () => {
    const { w, live } = world();
    live.look();
    const built = w.built;
    for (let i = 0; i < 10; i++) { w.t += 1_000; live.look(); }
    expect(w.built).toBe(built); // ten looks, no write, under 15 s: the state was not worked out again
    w.t += 6_000;
    w.state = { ...w.state, paused: "for a minute" }; // something that changes without a write
    expect(live.look()).toMatchObject({ kind: "state" });
    expect(w.built).toBe(built + 1);
  });

  it("counts a signed write as a change, and a burst of them as one", () => {
    const { live } = world();
    live.look();
    live.poke(); live.poke(); live.poke();
    expect(live.look()).toMatchObject({ seq: 1, kind: "state" });
    expect(live.look()).toBeNull();
  });

  it("sends each new block with the block itself, and numbers every message in order", () => {
    const { live } = world();
    expect(live.beat({ block: 93_272_637, gwei: 0.02, at: Date.parse("2026-10-20T07:18:51.374Z") })).toEqual({ seq: 1, kind: "pulse", block: 93_272_637, gwei: 0.02, at: "2026-10-20T07:18:51.374Z" });
    live.poke();
    expect(live.look()?.seq).toBe(2);
  });

  it("is on unless LIVE_PUSH=off", () => {
    expect(livePushOn({})).toBe(true);
    expect(livePushOn({ LIVE_PUSH: "on" })).toBe(true);
    expect(livePushOn({ LIVE_PUSH: " OFF " })).toBe(false);
  });
});

describe("the live stream over HTTP", () => {
  let server: Server | null = null;
  let live: Live | null = null;
  afterEach(async () => {
    live?.stop();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = live = null;
  });

  async function serve(o: { most?: number; heartbeatMs?: number } = {}) {
    let state = { n: 1 };
    let writes = 0;
    live = new Live({ state: () => state, writes: () => writes, everyMs: 20, heartbeatMs: o.heartbeatMs ?? 60_000, most: o.most });
    live.start();
    server = createServer((req, res) => {
      if (!live!.subscribe(res)) { res.writeHead(503); res.end(); }
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/live`;
    return { url, change: () => { state = { n: state.n + 1 }; writes++; } };
  }

  /** Reads the stream until `want` is in it. */
  async function until(body: ReadableStream<Uint8Array>, want: RegExp, ms = 3_000): Promise<string> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let got = "";
    const stop = setTimeout(() => void reader.cancel(), ms);
    try {
      while (!want.test(got)) {
        const { value, done } = await reader.read();
        if (done) break;
        got += dec.decode(value, { stream: true });
      }
    } finally {
      clearTimeout(stop);
      reader.releaseLock();
    }
    return got;
  }

  it("answers as an event stream that nothing buffers, says hello, then sends a change as it happens", async () => {
    const { url, change } = await serve();
    const ac = new AbortController();
    const r = await fetch(url, { signal: ac.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(r.headers.get("cache-control")).toContain("no-transform");
    expect(r.headers.get("x-accel-buffering")).toBe("no");
    const [a, b] = r.body!.tee();
    expect(await until(a, /event: hello/)).toMatch(/event: hello\ndata: \{"seq":0/);
    const t0 = Date.now();
    change();
    const got = await until(b, /event: state/);
    expect(got).toMatch(/id: 1\nevent: state\ndata: \{"seq":1,"kind":"state"/);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(live!.open).toBe(1);
    ac.abort();
    await new Promise((res) => setTimeout(res, 50));
    expect(live!.open).toBe(0); // a stream that is closed is let go
  });

  it("keeps the stream open with a comment line now and then", async () => {
    const { url } = await serve({ heartbeatMs: 40 });
    const ac = new AbortController();
    const r = await fetch(url, { signal: ac.signal });
    expect(await until(r.body!, /: still here/)).toContain(": still here\n\n");
    ac.abort();
  });

  it("turns away streams past the most it holds", async () => {
    const { url } = await serve({ most: 1 });
    const ac = new AbortController();
    const first = await fetch(url, { signal: ac.signal });
    expect(first.status).toBe(200);
    expect((await fetch(url)).status).toBe(503);
    ac.abort();
  });
});

describe("the engine and the live stream", () => {
  it("offers it by default, and not with LIVE_PUSH=off", async () => {
    const on = new Engine(open(":memory:"), { env: {}, log: () => {} });
    on.start();
    expect(on.live).not.toBeNull();
    await on.stop();
    const off = new Engine(open(":memory:"), { env: { LIVE_PUSH: "off" }, log: () => {} });
    off.start();
    expect(off.live).toBeNull();
    await off.stop();
  });

  it("sees a write the site shows, and lets a refused write pass as no change", async () => {
    const sqlite = open(":memory:");
    const e = new Engine(sqlite, { env: {}, log: () => {} });
    e.start();
    const live = e.live!;
    expect(live.look()).toBeNull();
    // a write the API refuses changes nothing
    expect((await e.post("/v1/agents/profile", { nonsense: true }, "1.2.3.4"))!.status).toBeGreaterThanOrEqual(400);
    expect(live.look()).toBeNull();
    // an agent signed up for the launch is on the site's first page: the next look sends it as a change
    sqlite.prepare("INSERT INTO launch_agents (kind, name, does, owner, signed_at, created_at) VALUES ('own', 'test-agent', 'tests things', '0x0000000000000000000000000000000000000001', 1, 1)").run();
    expect(live.look()).toMatchObject({ kind: "state" });
    expect(live.look()).toBeNull();
    await e.stop();
  });
});
