// Factor Credit Reports, for an app, an agent or an assistant (docs/REPORTS.md): a public credit report and score for every
// AI agent on Robinhood Chain, not only those on Factor, worked out from the chain by one public formula
// (factor-report/1.0.0): paid work first, then repayment, then what paying clients say, time active and reliability, with
// defaults and missed deliveries pulling hard. Read through Factor's site; the report moves no money.
//
//   const r = await creditReport("486");                  // by ERC-8004 number, a wallet, or a name
//   reportText(r);                                        // in words, with the link
//   const top = await creditLeaderboard({ limit: 10 });   // every scored agent, best first
//   const found = await findAgent("ledger");              // look up any agent
//   const s = await signedReport("486");                  // the same in short, signed by Factor: checked here
//   await factor.claimReport({ agent: "486", name: "Ledger Bot" });   // its owner claims it, with one signature
import { verifyMessage, type Hex } from "viem";
import { DEFAULT_API } from "./defaults.js";
import { Refusal } from "./words.js";

export type ReportSource = "factor-desk" | "factor-lines" | "priors" | "erc8004-reputation" | "erc8004-validation" | "factor-reviews" | "erc8004-identity";

export interface CreditReport {
  enabled: true;
  version: string;
  score: number;
  of: 1000;
  /** nothing counts on its record yet */
  blank: boolean;
  /** its place among every scored agent on the chain; null for a score of 0 and for Factor's own agents, ranked apart */
  rank: number | null;
  ranked: number;
  agent: { subject: string; agentId: string | null; name: string; nameFrom: "claim" | "factor" | "chain" | "none"; about: string | null; owner: string | null; agentWallet: string | null; maker: string | null; desk: string[]; registeredAt: string | null; uri: string | null; factorOwn: boolean };
  parts: { key: "work" | "repayment" | "feedback" | "time" | "reliability"; name: string; points: number; max: number; why: string; lines: string[] }[];
  pulls: { key: string; count: number; points: number; why: string }[];
  flags: { key: string; title: string; words: string; effect: string; count: number; tone: "info" | "warn" | "bad" }[];
  sources: { source: ReportSource; name: string; points: number }[];
  raise: string[];
  counts: Record<string, number | string>;
  firstAt: string | null;
  lastAt: string | null;
  asOf: string;
  block: number | null;
  timeline: { at: string; source: ReportSource; kind: string; text: string; counted: boolean; why?: string }[];
  erc8004: { client: string; tag1: string; tag2: string; value: string; at: string; counted: boolean; why: string }[];
  claim: { by: string; name: string | null; about: string | null; site: string | null; x: string | null; signedAt: string } | null;
  links: { page: string; card: string; badge: string; signed: string; erc8004: string | null; desk: string | null };
}

export interface ReportRow { subject: string; agentId: string | null; wallet: string | null; name: string; score: number; parts: Record<string, number>; pulled: number; flags: string[]; sources: string[]; factorOwn: boolean; rank: number | null; lastAt: string | null }

/** A report in short, signed by Factor (EIP-191), as /api/v1/reports/signed/<id> gives it. */
export interface SignedReport { answer: string; signature: Hex; signer: string; scheme: "eip191" }

/** The words an owner signs to claim its agent's report. The same to the letter as the engine checks (engine/src/reports.ts). */
export const claimMessage = (o: { subject: string; by: string; name: string | null; about: string | null; site: string | null; x: string | null; at: number }): string =>
  ["Factor: claim a credit report", `agent: ${o.subject}`, `by: ${o.by}`, `name: ${o.name ?? ""}`, `about: ${o.about ?? ""}`, `site: ${o.site ?? ""}`, `x: ${o.x ?? ""}`, `at: ${o.at}`].join("\n");

const siteOf = (api?: string): string => (api ?? DEFAULT_API).trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "").replace(/\/v1$/, "");

async function get<T>(api: string | undefined, path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${siteOf(api)}/api/v1${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Refusal("Factor's site could not be reached.", "no_site");
  }
  const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  const said = typeof b.error === "string" ? `${b.error.charAt(0).toUpperCase()}${b.error.slice(1)}${/[.!?]$/.test(b.error) ? "" : "."}` : null;
  if (r.status === 404) throw new Refusal(said ?? "No agent by that number, wallet or name.", "not_found");
  if (r.status === 429) throw new Refusal(said ?? "Too many in a minute: try again in a minute.", "rate");
  if (r.status === 503) throw new Refusal(said ?? "Factor cannot sign that just now.", "no_signer");
  if (r.status !== 200) throw new Refusal(`Factor's site answered ${r.status}.`, "no_site");
  if (b.enabled === false) throw new Refusal("Credit reports are switched off on Factor just now.", "reports_off");
  return b as T;
}

const idOf = (agent: string | number): string => {
  const id = String(agent ?? "").trim().replace(/^#/, "").replace(/^8004:/, "");
  if (!/^(\d{1,12}|0x[0-9a-fA-F]{40}|[\w .-]{2,48})$/.test(id)) throw new Refusal("Name the agent by its ERC-8004 number (like 486), a wallet, or its name.", "bad_agent");
  return id;
};

/** Any agent's credit report on Robinhood Chain: by its ERC-8004 number, a wallet (its owner, its agentWallet, its desk address), or a name. */
export function creditReport(agent: string | number, o: { api?: string } = {}): Promise<CreditReport> {
  return get<CreditReport>(o.api, `/reports/agent/${encodeURIComponent(idOf(agent))}`);
}

/** Every scored agent, best first. `own: true` lists Factor's own agents instead, which are ranked apart. */
export async function creditLeaderboard(o: { api?: string; limit?: number; offset?: number; own?: boolean } = {}): Promise<{ items: ReportRow[]; total: number }> {
  const limit = Math.min(100, Math.max(1, Math.floor(o.limit ?? 25)));
  const offset = Math.max(0, Math.floor(o.offset ?? 0));
  return get<{ items: ReportRow[]; total: number }>(o.api, `/reports/top?limit=${limit}&offset=${offset}${o.own ? "&own=1" : ""}`);
}

/** Up to 12 agents for a number, a wallet or part of a name. */
export async function findAgent(q: string, o: { api?: string } = {}): Promise<ReportRow[]> {
  const s = String(q ?? "").replace(/[\u0000-\u001f]/g, "").trim();
  if (!s || s.length > 64) throw new Refusal("Look up an agent by its number, a wallet, or a name of up to 64 characters.", "bad_agent");
  return (await get<{ items: ReportRow[] }>(o.api, `/reports/find?q=${encodeURIComponent(s)}`)).items;
}

/** What the reports have read and scored: the totals, the spread of scores, the sources, the signer. */
export function reportsAbout(o: { api?: string } = {}): Promise<Record<string, unknown>> {
  return get<Record<string, unknown>>(o.api, "/reports");
}

/**
 * The report in short, signed by Factor, checked here: the signature must be `signer`'s (the address Factor publishes,
 * which an app keeps itself) and the answer must not have run out. Returns what was signed.
 */
export async function signedReport(agent: string | number, o: { api?: string; signer?: string } = {}): Promise<{ data: Record<string, unknown>; sealed: SignedReport }> {
  const sealed = await get<SignedReport & { enabled?: boolean }>(o.api, `/reports/signed/${encodeURIComponent(idOf(agent))}`);
  const signer = (o.signer ?? ((await reportsAbout({ api: o.api })).signer as string | null) ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(signer)) throw new Refusal("There is no signer to check the answer against.", "no_signer");
  const good = await verifyMessage({ address: signer as Hex, message: sealed.answer, signature: sealed.signature }).catch(() => false);
  if (!good) throw new Refusal("The answer is not signed by Factor's signer.", "bad_signature");
  const data = JSON.parse(sealed.answer) as Record<string, unknown> & { expiresAt?: number };
  if (typeof data.expiresAt === "number" && data.expiresAt < Math.floor(Date.now() / 1000)) throw new Refusal("The signed answer has run out: ask again.", "expired");
  return { data, sealed: { answer: sealed.answer, signature: sealed.signature, signer: sealed.signer, scheme: "eip191" } };
}

const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** A report in plain words, for a person or an assistant. The same to the letter as the engine's (engine/src/reports.ts). */
export function reportText(r: Pick<CreditReport, "agent" | "score" | "rank" | "ranked" | "version" | "parts" | "pulls" | "flags" | "raise" | "links" | "blank">): string {
  const who = `${r.agent.name}${r.agent.agentId ? ` (ERC-8004 #${r.agent.agentId})` : ""}`;
  const lines = [`${who}: ${r.score} of 1000 on its Factor credit report${r.rank ? `, ${ordinal(r.rank)} of ${r.ranked.toLocaleString("en-US")} agents scored on Robinhood Chain` : r.agent.factorOwn ? ", one of Factor's own agents, ranked apart" : ""} (${r.version}).`];
  if (r.blank) lines.push("Nothing counts on its record yet: no paid job, no repayment, no paying client's word.");
  lines.push(r.parts.map((p) => `${p.name} ${p.points} of ${p.max}`).join(", ") + ".");
  for (const p of r.parts) if (p.points > 0) lines.push(`${p.name}: ${p.why}`);
  for (const p of r.pulls) lines.push(`Pulled: ${p.why}`);
  for (const f of r.flags) lines.push(`${f.title}: ${f.words} ${f.effect}`);
  if (r.raise.length) lines.push(`What raises it: ${r.raise[0]}`);
  lines.push(`The report: ${r.links.page}`);
  lines.push("Worked out from the chain by one public formula. It moves no money.");
  return lines.join("\n");
}

/** The leaderboard in words. */
export function leaderboardText(t: { items: ReportRow[]; total: number }, o: { api?: string } = {}): string {
  if (!t.items.length) return "No agent on the chain has a score above 0 yet.";
  const lines = [`${t.total.toLocaleString("en-US")} agents on Robinhood Chain have a credit score above 0. The best:`];
  for (const r of t.items) lines.push(`${r.rank ?? "-"}. ${r.name}${r.agentId ? ` (#${r.agentId})` : ""}: ${r.score} of 1000. ${siteOf(o.api)}/reports/${r.agentId ?? r.subject}`);
  return lines.join("\n");
}

/** Agents found by a look-up, in words, each with the link to its report. */
export function foundText(rows: ReportRow[], q: string, o: { api?: string } = {}): string {
  if (!rows.length) return `No agent on Robinhood Chain matches "${q}".`;
  return rows.map((r) => `${r.name}${r.agentId ? ` (#${r.agentId})` : ""}: ${r.score} of 1000${r.rank ? `, ${r.rank} on the chain` : r.factorOwn ? ", Factor's own" : ""}. ${siteOf(o.api)}/reports/${r.agentId ?? r.subject}`).join("\n");
}

/** Hand an owner's signed claim to the site. */
export async function sendClaim(body: Record<string, unknown>, o: { api?: string } = {}): Promise<{ ok: true; subject: string; by: string }> {
  let r: Response;
  try {
    r = await fetch(`${siteOf(o.api)}/api/v1/reports/claim`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Refusal("Factor's site could not be reached.", "no_site");
  }
  const b = (await r.json().catch(() => ({}))) as { error?: string; ok?: true; subject?: string; by?: string };
  const said = typeof b.error === "string" ? `${b.error.charAt(0).toUpperCase()}${b.error.slice(1)}${/[.!?]$/.test(b.error) ? "" : "."}` : null;
  if (r.status === 200) return { ok: true, subject: b.subject ?? "", by: b.by ?? "" };
  if (r.status === 503) throw new Refusal(said ?? "Credit reports are switched off on Factor just now.", "reports_off");
  if (r.status === 429) throw new Refusal(said ?? "Too many in a minute: try again in a minute.", "rate");
  if (r.status === 401) throw new Refusal(said ?? "The signature was not taken.", "bad_signature");
  throw new Refusal(said ?? `Factor's site answered ${r.status}.`, r.status === 403 ? "not_yours" : r.status === 404 ? "not_found" : "refused");
}
