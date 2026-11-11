// Factor Credit Reports on the site (engine/src/reports.ts, docs/REPORTS.md): the shapes the engine answers in, the words an
// owner signs to claim its agent's report (the same to the letter as the engine checks and the kit signs), and the small
// helpers the pages share. Every figure on a report page is the engine's: nothing is worked out here.
import { Refusal } from "./desk";
import { signText, type Provider } from "./wallet";

export type ReportSource = "factor-desk" | "factor-lines" | "priors" | "erc8004-reputation" | "erc8004-validation" | "factor-reviews" | "erc8004-identity";

export interface ReportPart { key: "work" | "repayment" | "feedback" | "time" | "reliability"; name: string; points: number; max: number; why: string; lines: string[] }
export interface ReportFlag { key: string; title: string; words: string; effect: string; count: number; tone: "info" | "warn" | "bad" }
export interface ReportAgent { subject: string; agentId: string | null; name: string; nameFrom: "claim" | "factor" | "chain" | "none"; about: string | null; owner: string | null; agentWallet: string | null; maker: string | null; desk: string[]; registeredAt: string | null; uri: string | null; factorOwn: boolean }

export interface Report {
  enabled: true;
  version: string;
  score: number;
  of: 1000;
  blank: boolean;
  rank: number | null;
  ranked: number;
  agent: ReportAgent;
  parts: ReportPart[];
  pulls: { key: string; count: number; points: number; why: string }[];
  flags: ReportFlag[];
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
  /** its score on the ERC-8004 reputation registry, written by Factor (engine/src/reportserc8004.ts); null with no identity */
  onChain?: ReportOnChain | null;
}

/** A report's place on ERC-8004: written (since when, the transaction, its file), or prepared and not yet written. */
export interface ReportOnChain { written: boolean; since: string | null; score: number | null; version: string | null; tx: string | null; txUrl: string | null; index: number | null; at: string | null; uri: string | null; entries: number; reviewer: string | null; registry: string; tag1: string; read: string; prepared: string | null }

/** How many reports Factor has written to ERC-8004, as /v1/reports says. */
export interface ReportsOnErc8004 { enabled: boolean; reports: number; entries: number; tag1: string; tag2: string; reviewer: string | null; everyH: number; since: string | null; firstTx: string | null; lastTx: string | null; lastTxUrl: string | null; lastAt: string | null; read: string }

export interface ReportRow { subject: string; agentId: string | null; wallet: string | null; name: string; score: number; parts: Record<string, number>; pulled: number; flags: string[]; sources: string[]; factorOwn: boolean; rank: number | null; lastAt: string | null }

export interface ReportsAbout {
  enabled: boolean;
  version?: string;
  chainId?: number;
  found?: number;
  identities?: number;
  scored?: number;
  ranked?: number;
  withRecord?: number;
  spread?: { from: number; to: number; n: number }[];
  bySource?: { source: ReportSource; name: string; agents: number }[];
  read?: {
    erc8004: { from: number; readDownTo: number | null; readUpTo: number | null; done: boolean; feedback: number; revoked: number; validationRequests: number; validationResponses: number };
    priors: { from: number; readDownTo: number | null; readUpTo: number | null; done: boolean; loans: number; repaid: number; defaulted: number; pools: string[] } | null;
    factor: { agents: number };
  };
  caughtUp?: boolean;
  scoredAt?: string | null;
  registries?: { identity: string; reputation: string; validation: string };
  signer?: string | null;
  /** the reports written to ERC-8004 */
  onErc8004?: ReportsOnErc8004 | null;
}

/** Where a report lives: an identity by its number, a desk agent with none by its wallet. */
export const reportHref = (r: { agentId: string | null; subject: string }): string => `/reports/${r.agentId ?? r.subject}`;

/** A source as a short mark on a row. */
export const SOURCE_SHORT: Record<ReportSource, string> = { "factor-desk": "Factor desk", "factor-lines": "Credit line", priors: "Priors loans", "erc8004-reputation": "ERC-8004 feedback", "erc8004-validation": "ERC-8004 checks", "factor-reviews": "Paid reviews", "erc8004-identity": "Identity" };

/** The weights of factor-report/1.1.0, as docs/REPORTS.md has them: for a page drawn before the engine answers. */
export const PARTS = [
  { key: "work", name: "Paid work", max: 400, line: "Jobs paid on the Factor desk by customers who are not its own hand: their value (full at 0.05 ETH), how many customers, how many jobs." },
  { key: "repayment", name: "Repayment", max: 250, line: "Factor advances repaid by their jobs, Factor credit lines repaid on time, loans repaid on Priors, each by its size and how long it was held." },
  { key: "feedback", name: "Paying clients' feedback", max: 150, line: "What clients that paid it said: Factor's paid reviews, and ERC-8004 entries from wallets that paid it. Each client once." },
  { key: "time", name: "Time active", max: 100, line: "The days from its first paid work, repayment that counts or paying client's word to its latest, all of it at 90." },
  { key: "reliability", name: "Reliability", max: 100, line: "The share delivered and repaid on time, and work a validator passed on ERC-8004." },
] as const;
export const PULLS = [
  { name: "A default", points: 300, line: "an advance or a loan not repaid, an early half kept, a credit line in default" },
  { name: "A job not delivered", points: 100, line: "refunded to the customer after its time" },
  { name: "A job settled at half", points: 25, line: "the customer rejected the delivery" },
  { name: "A credit line repaid late", points: 50, line: "after its due day" },
] as const;

/** The words an owner signs to claim its agent's report. The same to the letter as the engine checks (engine/src/reports.ts). */
export const claimMessage = (o: { subject: string; by: string; name: string | null; about: string | null; site: string | null; x: string | null; at: number }): string =>
  ["Factor: claim a credit report", `agent: ${o.subject}`, `by: ${o.by}`, `name: ${o.name ?? ""}`, `about: ${o.about ?? ""}`, `site: ${o.site ?? ""}`, `x: ${o.x ?? ""}`, `at: ${o.at}`].join("\n");

/** The owner signs its profile with the wallet that owns the identity (or is its agentWallet); Factor checks the chain. */
export async function signClaim(p: Provider, o: { subject: string; by: string; name: string | null; about: string | null; site: string | null; x: string | null; at: number }): Promise<void> {
  const signature = await signText(p, claimMessage(o), o.by);
  const r = await fetch("/api/v1/reports/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: o.subject.replace(/^8004:/, ""), by: o.by, name: o.name, about: o.about, site: o.site, x: o.x, at: o.at, signature }) });
  const b = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) { const t = b.error ?? "Factor could not take the claim"; throw new Refusal(t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".")); }
}

/** "3rd". */
export const ordinal = (n: number): string => `${n.toLocaleString("en-US")}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
