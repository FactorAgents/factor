// The pulse: the desk reading the chain, block by block, for the site's receipt.
//
// Before the launch nothing happens on the desk, and the site makes nothing up. One thing is true all the same: the
// engine is watching Robinhood Chain. Every few seconds it asks the node for the newest block (and now and then the
// gas price) and keeps the last few readings. The site prints them on its receipt, between the ledger's own lines, so
// a visitor sees the desk at work and every line on it is something that really happened: block 88,227,276, read at
// 08:41:07 UTC. After the launch the jobs, advances and burns print between them.
//
// One small read every few seconds, on the nodes the engine already uses, and nothing else: no key, no write.
//   ENGINE_PULSE=off      no readings at all
//   ENGINE_PULSE_MS       how often the newest block is read (6000 when not set, never under 2000)

export interface Beat { block: number; gwei: number | null; at: number }

export interface PulseOptions {
  everyMs?: number;
  /** readings kept */
  keep?: number;
  /** the gas price is read on one beat in this many */
  gasEvery?: number;
  timeoutMs?: number;
  now?: () => number;
  fetchFn?: typeof fetch;
}

export class Pulse {
  private beats: Beat[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private n = 0;
  private busy = false;
  private gwei: number | null = null;
  readonly everyMs: number;
  private readonly keep: number;
  private readonly gasEvery: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;

  constructor(private urls: string[], o: PulseOptions = {}) {
    this.everyMs = Math.max(2_000, o.everyMs ?? 6_000);
    this.keep = o.keep ?? 24;
    this.gasEvery = o.gasEvery ?? 10;
    this.timeoutMs = o.timeoutMs ?? 4_000;
    this.now = o.now ?? Date.now;
    this.fetchFn = o.fetchFn ?? fetch;
  }

  start(): void {
    if (this.timer || !this.urls.length) return;
    void this.beat();
    this.timer = setInterval(() => void this.beat(), this.everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The newest readings first. */
  latest(limit = this.keep): Beat[] {
    return this.beats.slice(0, limit);
  }

  /** One JSON-RPC call, on the first node that answers. */
  private async ask(method: string): Promise<string | null> {
    for (const url of this.urls) {
      try {
        const r = await this.fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }), signal: AbortSignal.timeout(this.timeoutMs) });
        if (!r.ok) continue;
        const j = (await r.json()) as { result?: unknown };
        if (typeof j.result === "string" && /^0x[0-9a-f]+$/i.test(j.result)) return j.result;
      } catch {
        // the next node, if there is one
      }
    }
    return null;
  }

  /** One reading. A block that is not newer than the last one is not kept: every line is a new block. */
  async beat(): Promise<Beat | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const hex = await this.ask("eth_blockNumber");
      if (!hex) return null;
      const block = Number(BigInt(hex));
      if (this.n++ % this.gasEvery === 0) {
        const gas = await this.ask("eth_gasPrice");
        if (gas) this.gwei = Math.round(Number(BigInt(gas)) / 1e7) / 100; // to two places of a gwei
      }
      if (this.beats[0] && block <= this.beats[0].block) return null;
      const beat = { block, gwei: this.gwei, at: this.now() };
      this.beats = [beat, ...this.beats].slice(0, this.keep);
      return beat;
    } finally {
      this.busy = false;
    }
  }
}

/** Whether the engine should read the pulse at all. */
export const pulseOn = (env: Record<string, string | undefined>): boolean => (env.ENGINE_PULSE ?? "on").trim().toLowerCase() !== "off";
