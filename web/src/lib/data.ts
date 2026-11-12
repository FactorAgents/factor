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
import { sampleAgent, sampleAutoApply, sampleBounties, sampleBounty, sampleMilestoneOfJob, sampleCoin, sampleCoins, sampleFirm, sampleJobs, sampleLedger, sampleOpenJob, sampleOpenJobs, samplePlan, sampleState } from "./sample";
import { sampleCase, sampleCaseOfJob, sampleJobPage, sampleReceipt, sampleVerifierCases, sampleVerifierList, sampleVerifierPage, sampleVerifiersAbout, withVerifiers } from "./verifiersSample";
import type { Agent, AgentPage, AutoApplyStatus, BountyList, BountyPage, MilestonePlan, Coin, FactorState, FirmPage, HeyAgent, Job, JobPage, LedgerEvent, OpenJobList, OpenJobPage, Page, Params, PlanPage, ReceiptPage, VerifiedStatus, VerifierCase, VerifierList, VerifierPage, VerifiersAbout, VouchList } from "./types";
import type { PayInfo, PublishedLink } from "./pay";
import type { CoinsAbout } from "./coins";
import { liveGen } from "./live";
import type { Report, ReportRow, ReportsAbout } from "./reports";
import { sampleReport, sampleReportsAbout, sampleReportsTop } from "./reportsSample";
import { sampleVouchList, withCoverVouches, withVouching, withVouchingState } from "./vouchingSample";

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
  compute: { enabled: false, markupPct: 0, maxTokens: 0, models: [], router: { enabled: false, models: 0 }, limits: { callUsd: 0, agentDayUsd: 0 } },
  accounts: { enabled: false, factory: null, ordersPerDay: 0 },
  paused: null,
  pay: { enabled: false, burnBps: 100, deals: 0, burnedEth: 0 },
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

// Every page a visitor opens needs the whole state, and a page that is looked at reads it again every twenty seconds.
// One read is shared by every visitor for SHARE_MS: requests that come in meanwhile get the same answer, and those
// that arrive while a read is on its way wait for that read rather than starting another. So the engine answers once
// every couple of seconds however many people are looking. When the engine does not answer (it restarts with every
// deploy), the last good answer is shown for up to STALE_MS rather than an empty desk, with its own time on it.
const SHARE_MS = Math.max(0, Number(process.env.FACTOR_STATE_SHARE_MS ?? 2_000) || 0);
const STALE_MS = 120_000;
// A read is also not shared past a change the engine told of (lib/live.ts): the page that reads itself because of the
// change must see it.
let shared: { at: number; gen: number; read: Promise<FactorState> } | null = null;
let lastGood: { at: number; state: FactorState } | null = null;

async function readState(): Promise<FactorState> {
  try {
    const s = await ask<Omit<FactorState, "reached">>("/v1/state");
    if (!s) return empty("engine", false);
    const state: FactorState = { ...s, reached: true };
    lastGood = { at: Date.now(), state };
    return state;
  } catch {
    if (lastGood && Date.now() - lastGood.at < STALE_MS) return lastGood.state;
    return empty("engine", false);
  }
}

export const getState = cache(async (): Promise<FactorState> => {
  await connection(); // read when the page is asked for, never baked in when the site is built
  if (SAMPLE) return withVouchingState(sampleState());
  if (!ENGINE) return empty("none", true);
  const now = Date.now();
  const gen = liveGen();
  if (!shared || now - shared.at >= SHARE_MS || shared.gen !== gen) shared = { at: now, gen, read: readState() };
  return shared.read;
});

const AGENT_ID = /^[0-9a-zA-Z-]{3,42}$/;

/** One agent by its address or its name. null: there is none. "down": the engine did not answer. */
export const getAgent = cache(async (id: string): Promise<AgentPage | null | "down"> => {
  await connection();
  if (!AGENT_ID.test(id)) return null;
  if (SAMPLE) return withVouching(withVerifiers(sampleAgent(id)));
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
  if (SAMPLE) return withCoverVouches(sampleJobPage(Number(id)));
  if (!ENGINE) return null;
  try {
    return await ask<JobPage>(`/v1/jobs/${Number(id)}`);
  } catch {
    return "down";
  }
});

/** One firm by its short name: its members, record, jobs and links. null: there is none. "down": the engine did not answer. */
export const getFirm = cache(async (slug: string): Promise<FirmPage | null | "down"> => {
  await connection();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/.test(slug)) return null;
  if (SAMPLE) return sampleFirm(slug);
  if (!ENGINE) return null;
  try {
    return await ask<FirmPage>(`/v1/firms/${slug}`);
  } catch {
    return "down";
  }
});

/** One monthly plan by its number: its months, what comes next, what can be drawn. null: there is none. "down": the engine did not answer. */
export const getPlan = cache(async (id: string): Promise<PlanPage | null | "down"> => {
  await connection();
  if (!/^0x[0-9a-f]{64}$/.test(id)) return null;
  if (SAMPLE) return samplePlan(id);
  if (!ENGINE) return null;
  try {
    return await ask<PlanPage>(`/v1/plans/${id}`);
  } catch {
    return "down";
  }
});

/** One open job by its number, with every applicant ranked by Factor Score. null: there is none. "down": the engine did not answer. */
export const getOpenJob = cache(async (id: string): Promise<OpenJobPage | null | "down"> => {
  await connection();
  if (!/^0x[0-9a-f]{64}$/.test(id)) return null;
  if (SAMPLE) return sampleOpenJob(id);
  if (!ENGINE) return null;
  try {
    return await ask<OpenJobPage>(`/v1/openjobs/${id}`);
  } catch {
    return "down";
  }
});

/** One bounty by its number, with its entries once they are public. null: there is none. "down": the engine did not answer. */
export const getBounty = cache(async (id: string): Promise<BountyPage | null | "down"> => {
  await connection();
  if (!/^\d{1,9}$/.test(id)) return null;
  if (SAMPLE) return sampleBounty(Number(id));
  if (!ENGINE) return null;
  try {
    return await ask<BountyPage>(`/v1/bounties/${id}`);
  } catch {
    return "down";
  }
});

/** The job in stages a desk job is a stage of, with every stage. null: it is not one, or milestones are off. */
export const getStagePlan = cache(async (job: number): Promise<MilestonePlan | null> => {
  await connection();
  if (SAMPLE) return sampleMilestoneOfJob(job);
  if (!ENGINE) return null;
  try {
    return await ask<MilestonePlan>(`/v1/milestones/job/${job}`);
  } catch {
    return null;
  }
});

/** What verifiers are: on or not, the contract, the rules, the makers, the totals, Factor's own. null: no engine, or it said nothing. "down": it did not answer. */
export const getVerifiersAbout = cache(async (): Promise<VerifiersAbout | null | "down"> => {
  await connection();
  if (SAMPLE) return sampleVerifiersAbout();
  if (!ENGINE) return null;
  try {
    return await ask<VerifiersAbout>(`/v1/verifiers/about`);
  } catch {
    return "down";
  }
});
/** The same, for a page that only shows something while verifiers are on: null unless they are. */
export async function verifiersOn(): Promise<VerifiersAbout | null> {
  const a = await getVerifiersAbout();
  return a && a !== "down" && a.enabled ? a : null;
}

/** Every verifier, oldest standing first, with the about answer. "down": the engine did not answer. */
export async function getVerifiers(): Promise<VerifierList | null | "down"> {
  await connection();
  if (SAMPLE) return sampleVerifierList();
  if (!ENGINE) return null;
  try {
    return await ask<VerifierList>(`/v1/verifiers`);
  } catch {
    return "down";
  }
}

/** One verifier by its address, with its newest cases. `verifier` null: that wallet never joined. "down": the engine did not answer. */
export const getVerifier = cache(async (address: string): Promise<VerifierPage | null | "down"> => {
  await connection();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  if (SAMPLE) return sampleVerifierPage(address.toLowerCase());
  if (!ENGINE) return null;
  try {
    return await ask<VerifierPage>(`/v1/verifiers/${address.toLowerCase()}`);
  } catch {
    return "down";
  }
});

/** Verified jobs by where they stand: check, seats, reveal, open (not ended) or all (the latest 50). "down": the engine did not answer. */
export async function getVerifierCases(show: "check" | "seats" | "reveal" | "open" | "all"): Promise<{ items: VerifierCase[] } | null | "down"> {
  await connection();
  if (SAMPLE) return sampleVerifierCases(show);
  if (!ENGINE) return null;
  try {
    return await ask<{ items: VerifierCase[] }>(`/v1/verifiers/cases?show=${show}`);
  } catch {
    return "down";
  }
}

/** One verified job by its case number. null: there is none. "down": the engine did not answer. */
export const getVerifierCase = cache(async (id: string): Promise<VerifierCase | null | "down"> => {
  await connection();
  if (!/^\d{1,9}$/.test(id)) return null;
  if (SAMPLE) return sampleCase(Number(id));
  if (!ENGINE) return null;
  try {
    return (await ask<{ case: VerifierCase }>(`/v1/verifiers/case/${Number(id)}`))?.case ?? null;
  } catch {
    return "down";
  }
});

/** A verdict's model receipt with the texts it hashes. null: none. "down": the engine did not answer. */
export async function getReceipt(id: string, verifier: string): Promise<ReceiptPage | null | "down"> {
  await connection();
  if (!/^\d{1,9}$/.test(id) || !/^0x[0-9a-fA-F]{40}$/.test(verifier)) return null;
  if (SAMPLE) return sampleReceipt(Number(id), verifier.toLowerCase());
  if (!ENGINE) return null;
  try {
    return await ask<ReceiptPage>(`/v1/verifiers/receipt/${Number(id)}/${verifier.toLowerCase()}`);
  } catch {
    return "down";
  }
}

/** The verified job a desk job belongs to. null: it is not one, or verifiers are off. */
export const getCaseOfJob = cache(async (job: number): Promise<VerifierCase | null> => {
  await connection();
  if (SAMPLE) return sampleCaseOfJob(job);
  if (!ENGINE) return null;
  try {
    return (await ask<{ case: VerifierCase }>(`/v1/verifiers/job/${job}`))?.case ?? null;
  } catch {
    return null;
  }
});

/** The board of bounties. show "open": taking entries, being chosen or waiting for the winner. "down": the engine did not answer. */
export async function getBounties(o: { show?: "open" | "all"; poster?: string; agent?: string } = {}): Promise<BountyList | "down" | null> {
  await connection();
  if (SAMPLE) return sampleBounties(o.show ?? "all");
  if (!ENGINE) return null;
  const q = [o.show ? `show=${o.show}` : "", o.poster ? `poster=${o.poster}` : "", o.agent ? `agent=${o.agent}` : ""].filter(Boolean).join("&");
  try {
    return await ask<BountyList>(`/v1/bounties${q ? `?${q}` : ""}`);
  } catch {
    return "down";
  }
}

/** The board: open jobs taking applications or waiting on their customer, newest first. "down": the engine did not answer. */
export async function getOpenJobs(o: { show?: "open" | "all"; verified?: boolean } = {}): Promise<OpenJobList | "down"> {
  await connection();
  if (SAMPLE) return sampleOpenJobs();
  if (!ENGINE) return { enabled: false, items: [] };
  const q = [o.show === "all" ? "show=all" : "", o.verified ? "verified=1" : ""].filter(Boolean).join("&");
  try {
    return (await ask<OpenJobList>(`/v1/openjobs${q ? `?${q}` : ""}`)) ?? { enabled: false, items: [] };
  } catch {
    return "down";
  }
}

/** An agent's verified owner and the wallets that may verify it. null: owners are not checked, or nothing to show. */
export async function getVerified(agent: string): Promise<VerifiedStatus | null> {
  await connection();
  if (SAMPLE || !ENGINE || !/^0x[0-9a-f]{40}$/.test(agent)) return null;
  try {
    const v = await ask<VerifiedStatus>(`/v1/verified/${agent}`);
    return v?.enabled ? v : null;
  } catch {
    return null;
  }
}

/** An agent's link to its maker's project on HEY and that project's builder record (lib/hey.ts). null: HEY records are off, or nothing to show. */
export async function getHey(agent: string): Promise<HeyAgent | null> {
  await connection();
  if (SAMPLE || !ENGINE || !/^0x[0-9a-f]{40}$/.test(agent)) return null;
  try {
    const v = await ask<HeyAgent>(`/v1/hey/agent/${agent}`);
    return v?.enabled ? v : null;
  } catch {
    return null;
  }
}

/** Every listed agent coin, by what its fees have paid to its agent's compute or newest first. "down": the engine did not answer. */
export async function getCoins(sort: "fees" | "new" = "fees"): Promise<{ enabled: boolean; items: Coin[] } | "down"> {
  await connection();
  if (SAMPLE) return sampleCoins(sort);
  if (!ENGINE) return { enabled: false, items: [] };
  try {
    return (await ask<{ enabled: boolean; items: Coin[] }>(`/v1/coins${sort === "new" ? "?sort=new" : ""}`)) ?? { enabled: false, items: [] };
  } catch {
    return "down";
  }
}

/** One coin, by its agent's name or address or its own address. null: none is listed. "down": the engine did not answer. */
export const getCoin = cache(async (id: string): Promise<Coin | null | "down"> => {
  await connection();
  if (!AGENT_ID.test(id)) return null;
  if (SAMPLE) return sampleCoin(id);
  if (!ENGINE) return null;
  try {
    return await ask<Coin>(`/v1/coins/${id}`);
  } catch {
    return "down";
  }
});

/** Whether coins can be launched now, the launcher, and what a launch costs. */
export async function getCoinsAbout(): Promise<CoinsAbout | null> {
  await connection();
  if (SAMPLE || !ENGINE) return null;
  try {
    return await ask<CoinsAbout>(`/v1/coins/about`);
  } catch {
    return null;
  }
}

/** An agent's auto-apply: its rules, what it did on its own, and the jobs that fit it now. null: none to show. */
export async function getAutoApply(agent: string): Promise<AutoApplyStatus | null> {
  await connection();
  if (SAMPLE) return sampleAutoApply(agent);
  if (!ENGINE || !/^0x[0-9a-f]{40}$/.test(agent)) return null;
  try {
    return await ask<AutoApplyStatus>(`/v1/autoapply/${agent}`);
  } catch {
    return null;
  }
}

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
/** Factor's contracts as a page knows them, for Copilot's check in the browser (lib/copilot.ts): from the server, never from a reply. */
export const knownOf = (s: FactorState): { desk: string | null; guarantee: string | null; bounty: string | null; milestones: string | null; mostEth: string } => ({
  desk: deskOf(s),
  guarantee: s.guarantees?.enabled ? s.guarantees.contract : null,
  bounty: s.bounties?.enabled ? s.bounties.contract : null,
  milestones: s.milestones?.enabled ? s.milestones.contract : null,
  mostEth: s.copilot?.mostEth ?? "0.1",
});

/** An agent in the first page's list, by its address. */
export const agentIn = (s: FactorState, address: string): Agent | undefined => s.agents.find((a) => a.address === address.toLowerCase());
/** The engine's address, for the site's own proxy (app/api/v1). Empty when there is none. */
export const engineUrl = (): string => ENGINE;
export const sampleMode = (): boolean => SAMPLE;

/**
 * What a Pay with Factor link says, checked by the engine: the link, or the engine's own words for why it cannot be
 * paid (changed, expired, not a link). "down": the engine did not answer.
 */
export async function getPayLink(token: string): Promise<{ ok: true; info: PayInfo } | { ok: false; status: number; error: string } | "down"> {
  await connection();
  if (!/^[A-Za-z0-9_-]{20,6000}\.[A-Za-z0-9_-]{80,3000}$/.test(token)) return { ok: false, status: 400, error: "that is not a Pay with Factor link" };
  if (!ENGINE) return "down";
  try {
    const r = await fetch(`${ENGINE}/v1/pay/link/${token}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
    const body = (await r.json()) as PayInfo & { error?: string };
    if (r.status === 200) return { ok: true, info: body };
    if (r.status >= 500) return "down";
    return { ok: false, status: r.status, error: body.error ?? "this link cannot be paid" };
  } catch {
    return "down";
  }
}

/** Credit reports (lib/reports.ts): whether they are on, what has been read, the totals. null: no engine. "down": it did not answer. */
export const getReportsAbout = cache(async (): Promise<ReportsAbout | null | "down"> => {
  await connection();
  if (SAMPLE) return sampleReportsAbout();
  if (!ENGINE) return null;
  try {
    return await ask<ReportsAbout>("/v1/reports");
  } catch {
    return "down";
  }
});

/** The leaderboard: every scored agent on the chain, best first; `own` for Factor's own agents, ranked apart. */
export async function getReportsTop(o: { offset?: number; limit?: number; own?: boolean } = {}): Promise<{ items: ReportRow[]; total: number } | null | "down"> {
  await connection();
  const offset = Math.max(0, Math.floor(o.offset ?? 0)), limit = Math.min(100, Math.max(1, Math.floor(o.limit ?? 50)));
  if (SAMPLE) return sampleReportsTop(offset, o.own);
  if (!ENGINE) return null;
  try {
    const t = await ask<{ enabled: boolean; items?: ReportRow[]; total?: number }>(`/v1/reports/top?limit=${limit}&offset=${offset}${o.own ? "&own=1" : ""}`);
    return t?.enabled ? { items: t.items ?? [], total: t.total ?? 0 } : null;
  } catch {
    return "down";
  }
}

/** One agent's credit report: by its ERC-8004 number, a wallet, or a name. null: none, or reports are off. "down": the engine did not answer. */
export const getReport = cache(async (id: string): Promise<Report | null | "down"> => {
  await connection();
  const raw = decodeURIComponent(id).trim();
  if (!/^(?:#?\d{1,12}|0x[0-9a-fA-F]{40}|[\w.-]{2,48})$/.test(raw)) return null;
  if (SAMPLE) return sampleReport(raw);
  if (!ENGINE) return null;
  try {
    const r = await ask<Report | { enabled: false }>(`/v1/reports/agent/${encodeURIComponent(raw)}`);
    return r && r.enabled ? (r as Report) : null;
  } catch {
    return "down";
  }
});

/** The links an agent shows on its page. */
export async function getPayLinks(agent: string): Promise<PublishedLink[]> {
  await connection();
  if (!ENGINE || !/^0x[0-9a-f]{40}$/.test(agent)) return [];
  try {
    return (await ask<{ items: PublishedLink[] }>(`/v1/pay/links/${agent}`))?.items ?? [];
  } catch {
    return [];
  }
}

/** The vouches: the rules, the totals, the vouchers (Factor's own apart) and the latest. null: no engine. "down": it did not answer. */
export async function getVouches(o: { state?: string } = {}): Promise<VouchList | null | "down"> {
  await connection();
  if (SAMPLE) return sampleVouchList(o);
  if (!ENGINE) return null;
  try {
    return await ask<VouchList>(`/v1/vouches${o.state ? `?state=${encodeURIComponent(o.state)}` : ""}`);
  } catch {
    return "down";
  }
}
