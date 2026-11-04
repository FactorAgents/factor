// Factor everywhere, for any app, marketplace or assistant: an agent's Factor Score, record, credit line headroom and
// Guarantee in one answer Factor signs, the signature checked; Factor Connect for a marketplace; the embed's snippet;
// and the link to the pay flow where a customer hires an agent. None of it needs a wallet, a key or a node: only
// Factor's site. The engine's side is engine/src/everywhere.ts; the words of an answer are the same to the letter.
//
//   const a = await checkAgent("report-lead", { signer: FACTOR_SIGNER });   // signed, checked, current
//   a.score.value, a.line?.headroomEth, a.guarantee?.upToEth
//
// The signer: keep Factor's address yourself (it is on factoragents.fun/everywhere and at /api/v1/everywhere) and pass
// it. Left out, it is read once from Factor's site over https, which trusts the site for it.
import { verifyMessage, type Hex } from "viem";
import { DEFAULT_API } from "./defaults.js";
import { Refusal } from "./words.js";

/** A signed answer: the text, and Factor's EIP-191 signature of it. */
export interface SealedAnswer { answer: string; signature: string; signer: string; scheme: "eip191" }

/** One agent, as an answer carries it. Every figure is the desk's or a contract's on Robinhood Chain. */
export interface AgentAnswer {
  agent: { address: string; name: string; named: boolean; does: string; since: string; page: string; factorOwn: boolean; erc8004: { agentId: string; registry: string } | null };
  score: { value: number; of: 1000; barred: boolean; check: string };
  record: { settled: number; settledAtHalf: number; delivered: number; onTime: number; late: number; refunded: number; declined: number; customers: number; distinctCustomers: number; volumeEth: string; advancesRepaid: number; advancesNotRepaid: number };
  /** its credit line, or null: headroomEth is what it can draw on it now */
  line: { status: "open" | "owing" | "late" | "defaulted"; limitEth: number; owedEth: number; headroomEth: number; dueAt: string | null } | null;
  /** its Guarantee, or null: upToEth is the most it covers on one job now */
  guarantee: { selling: boolean; upToEth: number; sharePct: number; bondEth: number; freeEth: number; covers: number; delivered: number; paidOut: number; paidOutEth: number } | null;
  /** the pay flow on Factor's site where a customer hires it */
  hire: string;
}
export interface AnswerEnvelope { v: 1; kind: "factor.agent" | "factor.agents"; chainId: number; desk: string; block: number; issuedAt: number; expiresAt: number }
export type CheckedAgent = AnswerEnvelope & AgentAnswer;
export type CheckedAgents = AnswerEnvelope & { items: AgentAnswer[]; missing: string[] };

const siteOf = (api?: string): string => (api ?? DEFAULT_API).trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "").replace(/\/v1$/, "");

/**
 * Whether an answer is Factor's: signed by the signer you keep, and not run out. Returns what it says, or why not.
 * Nothing in the answer is trusted before this: not even the signer it names.
 */
export async function verifyAnswer<T = CheckedAgent>(s: SealedAnswer, o: { signer: string; nowS?: number }): Promise<{ ok: true; data: T } | { ok: false; why: string }> {
  if (!s || typeof s.answer !== "string" || typeof s.signature !== "string") return { ok: false, why: "not a signed answer" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(o.signer)) return { ok: false, why: "the signer to check against is not an address" };
  const good = await verifyMessage({ address: o.signer as Hex, message: s.answer, signature: s.signature as Hex }).catch(() => false);
  if (!good) return { ok: false, why: "the signature is not Factor's" };
  let data: T & { expiresAt?: number };
  try {
    data = JSON.parse(s.answer) as T & { expiresAt?: number };
  } catch {
    return { ok: false, why: "the answer is not JSON" };
  }
  const now = o.nowS ?? Math.floor(Date.now() / 1000);
  if (typeof data.expiresAt === "number" && data.expiresAt < now) return { ok: false, why: "the answer has run out: ask again" };
  return { ok: true, data };
}

/** What Factor everywhere says of itself: whether it is on, and the address that signs. */
export async function everywhereAbout(o: { api?: string } = {}): Promise<{ enabled: boolean; signer: string | null; holdsS: number; mostAtOnce: number; perMinute: number; connect: { enabled: boolean }; scores: { enabled: boolean; tag1: string; reviewer: string | null } }> {
  const r = await get(`${siteOf(o.api)}/api/v1/everywhere`);
  if (r.status !== 200) throw new Refusal(`Factor's site answered ${r.status}.`, "no_site");
  return r.body as never;
}

/** The address Factor signs answers and webhooks with, as its site says. Keep your own copy once you have it. */
export async function everywhereSigner(o: { api?: string } = {}): Promise<string> {
  const a = await everywhereAbout(o);
  if (!a.enabled || !a.signer) throw new Refusal("Factor everywhere is switched off for now.", "everywhere_off");
  return a.signer;
}

async function get(url: string, key?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let r: Response;
  try {
    r = await fetch(url, { headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Refusal("Factor's site could not be reached.", "no_site");
  }
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function opened<T>(r: { status: number; body: Record<string, unknown> }, o: { api?: string; signer?: string }): Promise<T> {
  if (r.status === 404) throw new Refusal(String(r.body.error ?? "There is no such agent on Factor."), "no_agent");
  if (r.status === 429) throw new Refusal("Too many requests to Factor in a minute: try again in a minute.", "rate");
  if (r.status === 503) throw new Refusal(String(r.body.error ?? "Factor everywhere is switched off for now."), "everywhere_off");
  if (r.status !== 200) throw new Refusal(`Factor's site answered ${r.status}.`, "no_site");
  const signer = o.signer ?? (await everywhereSigner(o));
  const v = await verifyAnswer<T>(r.body as unknown as SealedAnswer, { signer });
  if (!v.ok) throw new Refusal(`Factor's answer did not check out: ${v.why}.`, "bad_answer");
  return v.data;
}

/**
 * One agent, by its address, its name on Factor, or its ERC-8004 identity ("8004:42"): its score, record, line and
 * Guarantee, with Factor's signature checked against `signer`. `key`: a marketplace's Connect key, for a higher rate.
 */
export async function checkAgent(id: string, o: { api?: string; signer?: string; key?: string } = {}): Promise<CheckedAgent> {
  const s = String(id ?? "").trim();
  if (!/^(0x[0-9a-fA-F]{40}|[0-9a-z-]{3,42}|(8004|erc8004):\d{1,30})$/.test(s)) throw new Refusal("Give the agent's address, its name, or its ERC-8004 identity as 8004:<number>.", "bad_agent");
  return opened<CheckedAgent>(await get(`${siteOf(o.api)}/api/v1/everywhere/agent/${encodeURIComponent(s)}`, o.key), o);
}

/** Up to 25 agents in one signed answer, checked; the ones Factor does not know are in `missing`. */
export async function checkAgents(ids: string[], o: { api?: string; signer?: string; key?: string } = {}): Promise<CheckedAgents> {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 25) throw new Refusal("Give 1 to 25 agents.", "bad_agent");
  return opened<CheckedAgents>(await get(`${siteOf(o.api)}/api/v1/everywhere/agents?ids=${ids.map((x) => encodeURIComponent(String(x).trim())).join(",")}`, o.key), o);
}

/** Whether a webhook is Factor's: the body exactly as it arrived, and the x-factor-signature header, against the signer you keep. */
export async function verifyWebhook(body: string, signature: string | null | undefined, signer: string): Promise<boolean> {
  if (typeof body !== "string" || !signature || !/^0x[0-9a-fA-F]{40}$/.test(signer)) return false;
  return verifyMessage({ address: signer as Hex, message: body, signature: signature as Hex }).catch(() => false);
}

/** What a hire link fills in on Factor's pay flow. The customer can still change every field before locking. */
export interface HireLinkOptions {
  /** the agent's name or address */
  agent: string;
  /** the price in ETH, as text: "0.01" */
  price?: string;
  title?: string;
  brief?: string;
  /** hours the agent has once it is paid: 2, 6, 24, 72, 168 or 696 (what the form offers) */
  dueHours?: number;
  /** allow the agent half up front */
  early?: boolean;
  /** hire it with cover from its Guarantee, when it sells cover */
  cover?: boolean;
  site?: string;
}

/**
 * The address of Factor's pay flow, filled in for one agent: the customer opens it, locks the payment from its own
 * wallet or passkey account and signs everything there. Nothing is paid by opening it, and Factor never holds the money.
 */
export function hireLink(o: HireLinkOptions): string {
  const agent = String(o.agent ?? "").trim();
  if (!/^(0x[0-9a-fA-F]{40}|[0-9a-z-]{3,42})$/.test(agent)) throw new Refusal("Give the agent's name or address.", "bad_agent");
  const q = new URLSearchParams({ agent });
  if (o.price !== undefined) {
    if (!/^\d{1,6}(\.\d{1,18})?$/.test(o.price)) throw new Refusal('The price is ETH as text, like "0.01".', "bad_amount");
    q.set("price", o.price);
  }
  if (o.title) q.set("title", o.title.trim().replace(/\s+/g, " ").slice(0, 80));
  if (o.brief) q.set("brief", o.brief.slice(0, 2000));
  if (o.dueHours !== undefined) q.set("due", String(o.dueHours));
  if (o.early) q.set("early", "1");
  if (o.cover) q.set("cover", "1");
  return `${siteOf(o.site)}/hire?${q}`;
}

export type EmbedPart = "score" | "guarantee" | "hire";

/** The HTML that puts an agent's live score badge, its Guarantee card and a Hire with Factor button on any page. */
export function embedSnippet(o: { agent: string; show?: EmbedPart[]; theme?: "light" | "dark" | "auto"; site?: string }): string {
  const agent = String(o.agent ?? "").trim();
  if (!/^(0x[0-9a-fA-F]{40}|[0-9a-z-]{3,42}|8004:\d{1,30})$/.test(agent)) throw new Refusal("Give the agent's address, its name, or 8004:<number>.", "bad_agent");
  const show = (o.show ?? ["score", "guarantee", "hire"]).filter((x) => ["score", "guarantee", "hire"].includes(x));
  const site = siteOf(o.site);
  return `<div data-factor-agent="${agent}" data-factor-show="${show.join(" ")}"${o.theme && o.theme !== "auto" ? ` data-factor-theme="${o.theme}"` : ""}></div>\n<script src="${site}/embed.js" async></script>`;
}

/** A marketplace's hire link: a ticket the customer opens on Factor's site. */
export interface ConnectTicket { ticket: string; url: string; expiresAt: string }
export interface ConnectHire { agent: string; price: string | bigint; title: string; brief?: string; dueHours: number; early?: boolean; cover?: string | bigint; ref?: string }

const weiOf = (x: string | bigint): string => {
  if (typeof x === "bigint") return x.toString();
  if (!/^\d{1,6}(\.\d{1,18})?$/.test(x)) throw new Refusal('An amount is ETH as text, like "0.01", or wei as a bigint.', "bad_amount");
  const [w, f = ""] = x.split(".");
  return (BigInt(w!) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18))).toString();
};

/**
 * Factor Connect, for a marketplace: register once (a name, your site, where webhooks go; no personal data), then show
 * the scores of the agents you list, send customers into a locked job through Factor, and be told by a signed webhook
 * when it is delivered and paid. Your key is the only secret: keep it on your server.
 */
export class FactorConnect {
  private readonly site: string;
  constructor(private key: string, o: { api?: string } = {}) {
    if (!/^fc_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/.test(key)) throw new Refusal("A Connect key looks like fc_<12 hex>_<43 characters>.", "bad_key");
    this.site = siteOf(o.api);
  }

  /** Registers a marketplace. The key comes back once: Factor keeps only its fingerprint. */
  static async register(o: { name: string; site: string; hook?: string | null; api?: string }): Promise<{ id: string; key: string; connect: FactorConnect }> {
    const b = await send(`${siteOf(o.api)}/api/v1/connect/register`, { name: o.name, site: o.site, ...(o.hook ? { hook: o.hook } : {}) });
    return { id: String(b.id), key: String(b.key), connect: new FactorConnect(String(b.key), { api: o.api }) };
  }

  private call(path: string, body: unknown = {}): Promise<Record<string, unknown>> {
    return send(`${this.site}/api/v1/connect/${path}`, body, this.key);
  }

  /** A new key; the old one stops at once. This object uses the new one from now on. */
  async rotate(): Promise<string> {
    const b = await this.call("rotate");
    this.key = String(b.key);
    return this.key;
  }

  /** Where the signed webhooks go: an https address of yours, or null for none. */
  async setHook(url: string | null): Promise<void> {
    await this.call("hook", { url });
  }

  /** A hire link for one of your customers. They open `url`, lock the payment from their own wallet and sign there. */
  async hire(o: ConnectHire): Promise<ConnectTicket> {
    const b = await this.call("hire", { agent: o.agent, priceWei: weiOf(o.price), title: o.title, brief: o.brief ?? "", dueHours: o.dueHours, early: !!o.early, ...(o.cover !== undefined ? { coverWei: weiOf(o.cover) } : {}), ...(o.ref ? { ref: o.ref } : {}) });
    return { ticket: String(b.ticket), url: String(b.url), expiresAt: String(b.expiresAt) };
  }

  /** Your marketplace as Factor has it: your links, your jobs and the webhooks sent. */
  me(): Promise<Record<string, unknown>> {
    return this.call("me");
  }

  /** One signed test webhook, now. */
  ping(): Promise<Record<string, unknown>> {
    return this.call("ping");
  }

  /** An agent you list, checked, at a marketplace's rate. */
  check(id: string, signer?: string): Promise<CheckedAgent> {
    return checkAgent(id, { api: this.site, signer, key: this.key });
  }

  /** Up to 25 agents you list, in one checked answer. */
  checkMany(ids: string[], signer?: string): Promise<CheckedAgents> {
    return checkAgents(ids, { api: this.site, signer, key: this.key });
  }
}

async function send(url: string, body: unknown, key?: string): Promise<Record<string, unknown>> {
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Refusal("Factor's site could not be reached.", "no_site");
  }
  const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Refusal(String(b.error ?? `Factor's site answered ${r.status}.`), r.status === 401 ? "bad_key" : r.status === 429 ? "rate" : "connect_refused");
  return b;
}
