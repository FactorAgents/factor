// The Replay-verified mark with Zolva: Zolva replays each of its public agents on the exact prices the agent saw, hour
// by hour, and compares every trade and the hourly value with the record (zolvaagent.app, its open engine). This reads
// Zolva's public answer for every public agent, read only, every ZOLVA_EVERY_S (1800), and gives the credit report of
// Zolva's own identity (ZOLVA_AGENT, 25650) the mark while every public agent reads "match":
//
//   Replay-verified: N of N public agents, every checkable hour matches
//
// Hours from before Zolva stored the prices its agents saw are unverifiable and decide nothing, as Zolva says. The
// mark shows only while EVERY public agent matches and the reading is fresh (2 hours); otherwise nothing is shown. It
// changes no score. Off unless ZOLVA=on.

export interface ZolvaConfig {
  enabled: boolean;
  agentId: string;
  base: string;
  everyS: number;
}

export function readZolva(env: Record<string, string | undefined>): ZolvaConfig {
  return {
    enabled: env.ZOLVA === "on",
    agentId: (env.ZOLVA_AGENT ?? "25650").trim(),
    base: (env.ZOLVA_BASE ?? "https://zolvaagent.app").replace(/\/$/, ""),
    everyS: Math.max(300, Number(env.ZOLVA_EVERY_S ?? 1800) || 1800),
  };
}

export const REPLAY_WORDS = "Every public agent is replayed by Zolva on the exact prices it saw, and every checkable hour matches its record.";

export interface ReplayJson {
  by: "Zolva";
  agents: number;
  matching: number;
  hoursVerified: number;
  verifiedSince: string | null;
  checkedAt: string;
  page: string;
  line: string;
}

interface Reading { at: number; agents: number; matching: number; hoursVerified: number; verifiedSince: string | null }

export class ZolvaReplay {
  private last: Reading | null = null;
  constructor(
    private cfg: ZolvaConfig,
    private d: { fetch: typeof fetch; now: () => number; log: (s: string) => void },
  ) {}

  on(): boolean { return this.cfg.enabled; }
  everyS(): number { return this.cfg.everyS; }

  private async json(path: string): Promise<unknown> {
    const r = await this.d.fetch(`${this.cfg.base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`${path} answered ${r.status}`);
    return r.json();
  }

  /** One reading: the public list, then each agent's verify answer, one after another. */
  async refresh(): Promise<string> {
    if (!this.cfg.enabled) return "off";
    const list = (await this.json("/api/public/v1/agents")) as { agents?: { id?: string }[] };
    const ids = (list.agents ?? []).map((a) => a.id).filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x));
    if (ids.length === 0) { this.last = null; return "no public agents listed"; }
    let matching = 0, hours = 0;
    let since: string | null = null;
    for (const id of ids) {
      try {
        const v = (await this.json(`/api/public/v1/agents/${id}/verify`)) as { status?: string; hoursVerified?: number; verifiedSince?: string | null };
        if (v.status === "match") matching++;
        if (typeof v.hoursVerified === "number" && v.hoursVerified >= 0) hours += v.hoursVerified;
        if (typeof v.verifiedSince === "string" && (since === null || v.verifiedSince < since)) since = v.verifiedSince;
      } catch { /* an agent that does not answer counts as not matching */ }
    }
    this.last = { at: this.d.now(), agents: ids.length, matching, hoursVerified: hours, verifiedSince: since };
    return `${matching} of ${ids.length} public agents match, ${hours} hours verified`;
  }

  /** The mark for an identity: only Zolva's own, only while every public agent matches and the reading is fresh. */
  of(agentId: string | null): ReplayJson | null {
    if (!this.cfg.enabled || !agentId || agentId !== this.cfg.agentId) return null;
    const r = this.last;
    if (!r || r.agents === 0 || r.matching !== r.agents) return null;
    if (this.d.now() - r.at > 2 * 3600_000) return null;
    return {
      by: "Zolva",
      agents: r.agents,
      matching: r.matching,
      hoursVerified: r.hoursVerified,
      verifiedSince: r.verifiedSince,
      checkedAt: new Date(r.at).toISOString(),
      page: this.cfg.base,
      line: `${r.matching} of ${r.agents} public agents, every checkable hour matches`,
    };
  }

  /** for tests: put a reading in place */
  setReading(r: Reading | null): void { this.last = r; }
}
