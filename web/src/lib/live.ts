// Live: one stream from the engine per server, shared by every page that is open (app/api/live).
//
// The engine says the moment what it shows has changed (engine/src/live.ts). This server keeps ONE stream to it, however
// many people are looking, and passes on a few bytes to each open page, which then reads again only what it needs. With
// nobody looking for a minute the stream to the engine is closed; the first page to open starts it again.
//
//   LIVE_PUSH=off   no stream: every page reads itself again on its own timers, as before.
//
// Each page is told `since`: this server's own count of changes. A page whose `since` is not the newest one has missed
// something and reads itself again. Reads this server shares between visitors for a couple of seconds (lib/shared.ts,
// lib/data.ts) are dropped at every change, so the read a page makes right after one sees it.
import "server-only";
import { request as plain, type ClientRequest } from "node:http";
import { request as secure } from "node:https";
import { randomBytes } from "node:crypto";

type Send = (chunk: string) => void;
interface Hub {
  boot: string;            // this server's run: a page from before a restart has missed whatever happened meanwhile
  gen: number;             // changes seen since this server started
  up: boolean;             // the stream from the engine is open and has said hello
  everUp: boolean;
  subs: Set<Send>;
  running: boolean;
  wait: number;            // before the next try, after the stream from the engine broke
  req: ClientRequest | null;
  idle: ReturnType<typeof setTimeout> | null;
  beat: ReturnType<typeof setInterval> | null;
}

// on globalThis: a route and a page are bundled apart, and must still share the one stream and its count
const g = globalThis as typeof globalThis & { __factorLive?: Hub };
const hub: Hub = (g.__factorLive ??= { boot: randomBytes(4).toString("hex"), gen: 0, up: false, everUp: false, subs: new Set(), running: false, wait: 1_000, req: null, idle: null, beat: null });

const ENGINE = () => (process.env.FACTOR_ENGINE_URL ?? "").trim().replace(/\/+$/, "");
// a small message to every page this often, so the host's proxy keeps the stream open and the page knows it is alive
const HEARTBEAT_MS = 15_000;
// the engine sends a line at least every 15 s; nothing for this long and the stream is taken as broken
const SILENT_MS = 45_000;
const IDLE_MS = 60_000;
const WAIT_MOST_MS = 30_000;
// an engine that says it has no stream (LIVE_PUSH=off there) is asked again only now and then
const OFF_WAIT_MS = 60_000;
const MOST = 5_000;

/** Whether pages are told of changes as they happen: an engine to listen to, and LIVE_PUSH not off. */
export const livePushOn = (): boolean => (process.env.LIVE_PUSH ?? "on").trim().toLowerCase() !== "off" && !!ENGINE();
/** This server's count of changes: a read kept from before the last change is not used again. */
export const liveGen = (): number => g.__factorLive?.gen ?? 0;
/** What a page drawn now has seen. */
export const liveSince = (): string => `${hub.boot}:${hub.gen}`;

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function broadcast(chunk: string): void {
  for (const send of hub.subs) {
    try {
      send(chunk);
    } catch {
      hub.subs.delete(send);
    }
  }
}

function setDown(): void {
  if (!hub.up) return;
  hub.up = false;
  broadcast(frame("down", { since: liveSince() }));
}

// One block of the engine's stream: what it says, passed on.
function take(block: string): void {
  let event = "message", data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (event === "hello") {
    // back after a break: whatever changed meanwhile was not heard, so it counts as a change
    if (hub.everUp) hub.gen++;
    hub.up = hub.everUp = true;
    hub.wait = 1_000;
    broadcast(frame("up", { since: liveSince() }));
  } else if (event === "state") {
    hub.gen++;
    broadcast(frame("change", { since: liveSince() }));
  } else if (event === "pulse") {
    try {
      const m = JSON.parse(data) as { block?: unknown; gwei?: unknown; at?: unknown };
      if (typeof m.block === "number" && typeof m.at === "string") broadcast(frame("pulse", { block: m.block, gwei: typeof m.gwei === "number" ? m.gwei : null, at: m.at }));
    } catch {
      // a line that is not what it should be is let go
    }
  }
}

// The stream from the engine, once: resolves when it ends, whatever the reason. True when the engine has no stream.
function once(): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false, off = false, heard = Date.now();
    let url: URL;
    try {
      url = new URL(`${ENGINE()}/v1/live`);
    } catch {
      return resolve(true);
    }
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(watch);
      hub.req = null;
      setDown();
      resolve(off);
    };
    const req = (url.protocol === "https:" ? secure : plain)(url, { headers: { accept: "text/event-stream" } }, (res) => {
      if (res.statusCode !== 200) {
        off = res.statusCode === 404;
        res.resume();
        res.on("end", finish);
        res.on("error", finish);
        return;
      }
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (d: string) => {
        heard = Date.now();
        buf += d;
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          take(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
        if (buf.length > 65_536) buf = "";
      });
      res.on("end", finish);
      res.on("error", finish);
      res.on("close", finish);
    });
    const watch = setInterval(() => { if (Date.now() - heard > SILENT_MS) req.destroy(); }, 5_000);
    watch.unref?.();
    req.on("error", finish);
    req.end();
    hub.req = req;
  });
}

async function connect(): Promise<void> {
  if (hub.running) return;
  hub.running = true;
  try {
    while (hub.subs.size) {
      const off = await once();
      if (!hub.subs.size) break;
      const wait = off ? OFF_WAIT_MS : hub.wait;
      hub.wait = Math.min(hub.wait * 2, WAIT_MOST_MS);
      await new Promise((r) => setTimeout(r, wait * (0.75 + Math.random() * 0.5)));
    }
  } finally {
    hub.running = false;
  }
}

/** A page opens its stream: it is told where things stand at once, then every change. Returns how to close it, or null when this server holds as many as it takes. */
export function subscribe(send: Send): (() => void) | null {
  if (hub.subs.size >= MOST) return null;
  send(`retry: 5000\n${frame("hello", { up: hub.up, since: liveSince() })}`);
  hub.subs.add(send);
  if (hub.idle) {
    clearTimeout(hub.idle);
    hub.idle = null;
  }
  if (!hub.beat) {
    hub.beat = setInterval(() => broadcast(frame("ping", {})), HEARTBEAT_MS);
    hub.beat.unref?.();
  }
  void connect();
  return () => {
    hub.subs.delete(send);
    if (hub.subs.size || hub.idle) return;
    hub.idle = setTimeout(() => {
      hub.idle = null;
      if (hub.subs.size) return;
      if (hub.beat) clearInterval(hub.beat);
      hub.beat = null;
      hub.req?.destroy();
    }, IDLE_MS);
    hub.idle.unref?.();
  };
}
