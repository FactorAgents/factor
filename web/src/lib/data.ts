// Where the pages get their figures: the engine, asked from the server. The browser never talks to the engine or
// to a node itself; it talks to this site only (see app/api/v1).
//
//   FACTOR_ENGINE_URL   the engine's address. Not set: the site shows an empty desk and says nothing is live.
//   FACTOR_SAMPLE=1     made-up figures instead (lib/sample.ts), for building and testing the site. Never on the
//                       real site: it is refused when FACTOR_ENGINE_URL is set as well.
//
// An engine that does not answer is not an empty desk: the page says the figures are on their way back.
import "server-only";
import { cache } from "react";
import { connection } from "next/server";
import { sampleAgent, sampleJob, sampleJobs, sampleLedger, sampleState } from "./sample";
import type { Agent, AgentPage, FactorState, Job, JobPage, LedgerEvent, Page, Params } from "./types";

const ENGINE = (process.env.FACTOR_ENGINE_URL ?? "").trim().replace(/\/+$/, "");
const SAMPLE = process.env.FACTOR_SAMPLE === "1" && !ENGINE;
// The engine answers from its own database in a few milliseconds. Twelve seconds is for the bad minute, not the rule.
const TIMEOUT_MS = 12_000;

/** The rulebook's numbers, for a page drawn before any engine has answered (docs/RULEBOOK.md, section 9). */
export const RULES: Params = { advanceMaxPct: 50, advanceFeePct: 1, jobFeePct: 2, graceHours: 12, reviewHours: 24, rejectedPct: 50, reserveMinPct: 20, minJobEth: 0.001 };
/** The ledger's filters, as the page names them, and the kinds of line each shows (the engine's own list). */
export const SHOW: Record<string, string[]> = { locked: ["locked"], advanced: ["advanced"], delivered: ["delivered"], settled: ["settled", "half"], refunded: ["refunded", "not_repaid", "declined"], burned: ["burned"], pool: ["pool_in"], bond: ["bond"] };

const empty = (source: FactorState["source"], reached: boolean): FactorState => ({
  source, reached, asOf: new Date().toISOString(), launched: false, links: { pons: null, github: null, x: null },
  stats: { advancedEth: 0, settledJobs: 0, jobs: 0, poolEth: 0, reserveEth: 0, outEth: 0, heldEth: 0, burnedTokens: 0, supplyLeft: 1_000_000_000, agents: 0, lostEth: 0 },
  params: RULES, agents: [], jobs: [], events: [], burns: [], contracts: { desk: null, splitter: null, burnPot: null, token: null, explorer: "https://robinhoodchain.blockscout.com" },
  compute: { enabled: false, markupPct: 0, maxTokens: 0, models: [] },
  accounts: { enabled: false, factory: null, ordersPerDay: 0 },
});

class Unreachable extends Error {}

/** One of the engine's answers, or null when it says there is no such thing. Throws Unreachable when it does not answer. */
async function ask<T>(path: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${ENGINE}${path}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  } catch {
    throw new Unreachable();
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Unreachable();
  try {
    return (await res.json()) as T;
  } catch {
    throw new Unreachable();
  }
}

export const getState = cache(async (): Promise<FactorState> => {
  await connection(); // read when the page is asked for, never baked in when the site is built
  if (SAMPLE) return sampleState();
  if (!ENGINE) return empty("none", true);
  try {
    const s = await ask<Omit<FactorState, "reached">>("/v1/state");
    return s ? { ...s, reached: true } : empty("engine", false);
  } catch {
    return empty("engine", false);
  }
});

const AGENT_ID = /^[0-9a-zA-Z-]{3,42}$/;

/** One agent by its address or its name. null: there is none. "down": the engine did not answer. */
export const getAgent = cache(async (id: string): Promise<AgentPage | null | "down"> => {
  await connection();
  if (!AGENT_ID.test(id)) return null;
  if (SAMPLE) return sampleAgent(id);
  if (!ENGINE) return null;
  try {
    return await ask<AgentPage>(`/v1/agents/${id}`);
  } catch {
    return "down";
  }
});

/** One job by its number, with or without its leading zeros. */
export const getJob = cache(async (id: string): Promise<JobPage | null | "down"> => {
  await connection();
  if (!/^\d{1,9}$/.test(id)) return null;
  if (SAMPLE) return sampleJob(Number(id));
  if (!ENGINE) return null;
  try {
    return await ask<JobPage>(`/v1/jobs/${Number(id)}`);
  } catch {
    return "down";
  }
});

const none = <T,>(): Page<T> => ({ total: 0, more: false, items: [] });

export async function getLedger(o: { show?: string; before?: number; limit?: number }): Promise<Page<LedgerEvent>> {
  await connection();
  const limit = o.limit ?? 50, show = o.show && SHOW[o.show] ? o.show : undefined;
  if (SAMPLE) return sampleLedger(limit, o.before, show ? SHOW[show] : undefined);
  if (!ENGINE) return none();
  const q = new URLSearchParams({ limit: String(limit), ...(show ? { show } : {}), ...(o.before ? { before: String(o.before) } : {}) });
  try {
    return (await ask<Page<LedgerEvent>>(`/v1/ledger?${q}`)) ?? none();
  } catch {
    return none();
  }
}

export async function getJobs(o: { agent?: string; customer?: string }): Promise<Page<Job>> {
  await connection();
  if (SAMPLE) return sampleJobs(o);
  if (!ENGINE) return none();
  const q = new URLSearchParams({ limit: "50", ...(o.agent ? { agent: o.agent } : {}), ...(o.customer ? { customer: o.customer } : {}) });
  try {
    return (await ask<Page<Job>>(`/v1/jobs?${q}`)) ?? none();
  } catch {
    return none();
  }
}

/**
 * The desk a visitor's wallet may send to: the real one, read from the engine, and nothing else. The sample's
 * addresses are made up, and money sent to a made-up address is gone, so with the sample on (or no engine) there is
 * no desk to send to and every button that would send says so instead.
 */
export const deskOf = (s: FactorState): string | null => (s.source === "engine" && s.reached ? s.contracts.desk : null);

/** An agent in the first page's list, by its address. */
export const agentIn = (s: FactorState, address: string): Agent | undefined => s.agents.find((a) => a.address === address.toLowerCase());
/** The engine's address, for the site's own proxy (app/api/v1). Empty when there is none. */
export const engineUrl = (): string => ENGINE;
export const sampleMode = (): boolean => SAMPLE;
