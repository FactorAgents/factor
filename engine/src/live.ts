// Live: the engine says the moment what it shows has changed, so the site does not have to keep asking.
//
//   GET /v1/live    a stream of Server-Sent Events, for the site's server only (the engine has no public address).
//                   `hello` when it opens, then one small message per change, each with a number that goes up by one:
//                     event: pulse   a new block read (./pulse.ts), with the block itself
//                     event: state   something the site shows changed: a job, a line of the ledger, a burn, an
//                                    agent, a sign-up, a note of the Desk, a name or a title signed
//                   and a comment line every 15 s, so proxies keep the stream open.
//   LIVE_PUSH=off   no stream (404) and nothing is looked at: the site reads on its own timers, as before.
//
// What changed is found by looking once a second, which costs next to nothing: the state the site reads is worked
// out again only when the database was written since the last look (and at least every 15 s, for what changes
// without a write), and a fingerprint of it, without its own time and the blocks, is compared with the last one.
// A signed write taken through the API always counts as a change. Nothing here reads the chain or writes anything.

import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Beat } from "./pulse.js";

export interface LiveOptions {
  /** what the site reads (/v1/state), worked out afresh */
  state: () => unknown;
  /** how many rows the database has had written since it opened: a look that finds the same number skips the state */
  writes: () => number;
  /** what else a page shows that the state does not carry: a few counts, compared as they are */
  extra?: () => string;
  /** called just before a change is sent, so the engine's own short cache of answers is not older than the change */
  changed?: () => void;
  everyMs?: number;
  /** the state is looked at this often even when nothing was written */
  fullEveryMs?: number;
  heartbeatMs?: number;
  /** the most streams open at once; the site keeps one per server, so a handful is plenty */
  most?: number;
  now?: () => number;
}

export interface LiveMessage { seq: number; kind: "pulse" | "state"; at: string; block?: number; gwei?: number | null }

/** Whether the engine offers the stream at all. */
export const livePushOn = (env: Record<string, string | undefined>): boolean => (env.LIVE_PUSH ?? "on").trim().toLowerCase() !== "off";

export class Live {
  seq = 0;
  private clients = new Set<ServerResponse>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private lastWrites = -1;
  private lastFull = 0;
  private print: string | null = null;
  private poked = false;
  private readonly everyMs: number;
  private readonly fullEveryMs: number;
  private readonly heartbeatMs: number;
  private readonly most: number;
  private readonly now: () => number;

  constructor(private o: LiveOptions) {
    this.everyMs = o.everyMs ?? 1_000;
    this.fullEveryMs = o.fullEveryMs ?? 15_000;
    this.heartbeatMs = o.heartbeatMs ?? 15_000;
    this.most = o.most ?? 50;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.look(); // the first fingerprint, so the first look after it does not count as a change
    this.timer = setInterval(() => this.look(), this.everyMs);
    this.timer.unref?.();
    this.beatTimer = setInterval(() => this.write(": still here\n\n"), this.heartbeatMs);
    this.beatTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.timer = this.beatTimer = null;
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  /** How many streams are open. */
  get open(): number {
    return this.clients.size;
  }

  /** One look: the state's fingerprint against the last one. A change is sent and returned; nothing otherwise. */
  look(): LiveMessage | null {
    const writes = this.o.writes();
    const t = this.now();
    const poked = this.poked;
    if (!poked && writes === this.lastWrites && t - this.lastFull < this.fullEveryMs) return null;
    this.poked = false;
    this.lastWrites = writes;
    this.lastFull = t;
    let print: string;
    try {
      const s = this.o.state() as Record<string, unknown>;
      const { asOf: _asOf, pulse: _pulse, ...rest } = s;
      print = createHash("sha1").update(JSON.stringify(rest)).update(this.o.extra?.() ?? "").digest("base64url");
    } catch {
      return null; // a state that cannot be worked out right now is looked at again next time
    }
    const first = this.print === null;
    if (print === this.print && !poked) return null;
    this.print = print;
    return first && !poked ? null : this.send({ kind: "state" });
  }

  /**
   * A signed write was taken: whatever it changed is a change, whether or not the state shows it. Sent on the next
   * look, so a burst of writes is one message.
   */
  poke(): void {
    this.poked = true;
  }

  /** A new block read by the pulse. */
  beat(b: Beat): LiveMessage {
    return this.send({ kind: "pulse", block: b.block, gwei: b.gwei, at: new Date(b.at).toISOString() });
  }

  private send(m: { kind: LiveMessage["kind"]; block?: number; gwei?: number | null; at?: string }): LiveMessage {
    if (m.kind === "state") this.o.changed?.();
    const msg: LiveMessage = { seq: ++this.seq, kind: m.kind, at: m.at ?? new Date(this.now()).toISOString(), ...(m.block !== undefined ? { block: m.block, gwei: m.gwei ?? null } : {}) };
    this.write(`id: ${msg.seq}\nevent: ${msg.kind}\ndata: ${JSON.stringify(msg)}\n\n`);
    return msg;
  }

  private write(chunk: string): void {
    for (const res of this.clients) {
      try {
        res.write(chunk);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /** Opens a stream on `res`. False when there are already as many as are allowed. */
  subscribe(res: ServerResponse): boolean {
    if (this.clients.size >= this.most) return false;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ seq: this.seq, at: new Date(this.now()).toISOString() })}\n\n`);
    this.clients.add(res);
    const drop = () => this.clients.delete(res);
    res.on("close", drop);
    res.on("error", drop);
    return true;
  }
}
