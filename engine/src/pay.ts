// Pay with Factor: any agent, anywhere, sells its work with Factor's protection.
//
// A payment link is a few facts about a job (the agent, the price, a title and a brief, how long the agent has, and
// whether it may start with part of the payment) signed by the agent itself, so nobody can change them on the way.
// The link holds everything: Factor keeps no copy unless the agent publishes it on its page.
//
//   GET  /v1/pay/link/<token>    what a link says, checked: its agent's signature, its expiry, the agent's record
//   POST /v1/pay/deal            a job locked through a link: { link, job, lockTx, burnTx?, plan? }. Checked against
//                                the chain (the lock's own log) and kept, so the job shows as paid with Factor. With
//                                a plan (./subjobs.ts), the buyer bought it for a job it is doing: linked under that job
//   POST /v1/pay/links           an agent publishes a link on its page: { link }
//   GET  /v1/pay/links/<agent>   the links an agent published that have not expired
//   GET|POST /v1/x402/<token>    the same link for another agent's program, over x402: a 402 that says how to pay,
//                                and once the lock is on the chain, the job's number (see x402())
//
// Every deal also adds to $FACTOR's burn: the buyer sends a small amount to the burn pot beside the lock (the burn
// pot takes plain ETH from anybody, and its next burn spends all of it on $FACTOR). An account does both in one
// order; a wallet sends two transactions. The engine checks the transfer on the chain before it counts it.
//
// Nothing here moves money and nothing here needs a key: the buyer locks and sends from their own wallet, and the
// engine only reads the chain and says what it found.

import { decodeEventLog, decodeFunctionData, formatEther, keccak256, toHex, type Abi, type Hex } from "viem";
import { factorAccountAbi, factorAccountsAbi, factorDeskAbi } from "./abi/index.js";
import { normalizeAddress } from "./chain/address.js";
import type { Chain } from "./chain/chain.js";
import type { EngineDb } from "./chain/db.js";
import { briefText, oneLine } from "./profiles.js";
import type { Firms } from "./firms.js";
import type { Subjobs } from "./subjobs.js";

type Env = Record<string, string | undefined>;
const DESK = factorDeskAbi as Abi;
const ACCOUNT = factorAccountAbi as Abi;

export const LINK_VERSION = 1;
/** A link's brief is shorter than a job's: it travels inside the link's address. */
export const LINK_BRIEF_MOST = 2000;
export const MIN_JOB_WEI = 10n ** 15n;
export const MAX_LINK_WEI = 1000n * 10n ** 18n;
/** A link is good for a year at most. */
export const LINK_LIFE_MOST_S = 366 * 86_400;
/** How far a lock's due time may be from the one its link asks for: the buyer's clock and the chain's differ. */
export const DUE_SLACK_S = 900;
export const X402_SCHEME = "factor-lock";
export const X402_NETWORK = "robinhood-chain";

export interface PayConfig {
  /** PAY=off turns Pay with Factor off: links are refused and nothing is kept */
  enabled: boolean;
  /** PAY_BURN_BPS: what every deal adds to the burn, in hundredths of a percent of the price, paid by the buyer on top */
  burnBps: number;
  /** PAY_LINKS_PER_AGENT: the most links one agent keeps on its page */
  linksPerAgent: number;
  /** the site, for the addresses a link and a 402 answer carry */
  site: string;
}

export function readPay(env: Env, problems: string[] = []): PayConfig {
  const off = (env.PAY ?? "").trim().toLowerCase() === "off";
  const raw = env.PAY_BURN_BPS?.trim();
  let burnBps = 100;
  if (raw) {
    if (/^\d{1,4}$/.test(raw) && Number(raw) <= 1000) burnBps = Number(raw);
    else problems.push(`PAY_BURN_BPS must be a whole number from 0 to 1000 (hundredths of a percent): it is "${raw}"`);
  }
  const per = Number(env.PAY_LINKS_PER_AGENT?.trim() || 20);
  const site = (env.FACTOR_SITE_URL?.trim() || "https://factoragents.fun").replace(/\/+$/, "");
  return { enabled: !off, burnBps, linksPerAgent: Number.isSafeInteger(per) && per > 0 && per <= 200 ? per : 20, site };
}

/**
 * What a link says. `price` is wei as text; `due` is hours from the lock; `exp` is when the link stops, in unix seconds.
 * `firm`, when there is one: the agent leads that firm and sells the firm's work with this link (./firms.ts).
 */
export interface PayLink {
  v: 1;
  agent: string;
  price: string;
  title: string;
  brief: string;
  due: number;
  early: boolean;
  exp: number;
  id: string;
  firm?: string;
  /** a subscribe link: a monthly plan of this many months at `price` each month (../plans.ts); `due` is then 720, a month */
  months?: number;
}

/**
 * The text an agent signs for a link: readable, so a wallet shows its owner exactly what they sell. The same to the
 * letter in the kit (packages/kit/src/pay.ts) and on the site (web/src/lib/pay.ts).
 */
export function payLinkMessage(l: PayLink): string {
  return [
    "Factor: Pay with Factor link",
    `agent: ${l.agent}`,
    // only a link for a firm says so: every other link signs the same words it always did
    ...(l.firm ? [`firm: ${l.firm}`] : []),
    `price: ${formatEther(BigInt(l.price))} ETH`,
    // only a subscribe link says so: every other link signs the same words it always did
    ...(l.months ? [`monthly: ${l.months} months, this price each month`] : []),
    `title: ${l.title}`,
    `brief: ${l.brief ? keccak256(toHex(l.brief)) : "none"}`,
    `due: ${l.due} hours after it is paid`,
    `early: ${l.early ? "up to half may be drawn before delivery" : "nothing before delivery"}`,
    `expires: ${l.exp}`,
    `id: ${l.id}`,
  ].join("\n");
}

/** A link's own number: the fingerprint of what was signed. Two links that say the same thing are the same link. */
export const payLinkId = (l: PayLink): Hex => keccak256(toHex(payLinkMessage(l)));

/** What a deal adds to the burn: a share of the price, rounded up, paid by the buyer beside the lock. */
export const dealBurnWei = (priceWei: bigint, bps: number): bigint => (priceWei * BigInt(bps) + 9_999n) / 10_000n;

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string): string => Buffer.from(s, "base64url").toString("utf8");

/** A link and its signature as one piece of text that goes into an address: `<facts>.<signature>`. */
export function encodePayLink(l: PayLink, signature: Hex): string {
  const facts = JSON.stringify({ v: l.v, agent: l.agent, price: l.price, title: l.title, brief: l.brief, due: l.due, early: l.early, exp: l.exp, id: l.id, ...(l.firm ? { firm: l.firm } : {}), ...(l.months ? { months: l.months } : {}) });
  return `${b64(facts)}.${Buffer.from(signature.slice(2), "hex").toString("base64url")}`;
}

const TOKEN = /^[A-Za-z0-9_-]{20,6000}\.[A-Za-z0-9_-]{80,3000}$/;

/** A link out of its text, with its signature, or why it is not one. Says nothing yet of whether the signature is the agent's. */
export function decodePayLink(token: unknown): { link: PayLink; signature: Hex } | string {
  if (typeof token !== "string" || !TOKEN.test(token)) return "that is not a Pay with Factor link";
  const [facts, sig] = token.split(".") as [string, string];
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(unb64(facts)) as Record<string, unknown>;
  } catch {
    return "that is not a Pay with Factor link";
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "that is not a Pay with Factor link";
  const link: PayLink = { v: raw.v as 1, agent: String(raw.agent ?? ""), price: String(raw.price ?? ""), title: String(raw.title ?? ""), brief: String(raw.brief ?? ""), due: raw.due as number, early: raw.early as boolean, exp: raw.exp as number, id: String(raw.id ?? ""), ...(raw.firm !== undefined ? { firm: String(raw.firm) } : {}), ...(raw.months !== undefined ? { months: raw.months as number } : {}) };
  const problem = linkProblem(link);
  if (problem) return problem;
  const signature = `0x${Buffer.from(sig, "base64url").toString("hex")}` as Hex;
  if (signature.length < 132) return "the link's signature is cut short";
  return { link, signature };
}

/** Why the facts of a link are not ones Factor takes, or null. Expiry is checked apart, against the chain's clock. */
export function linkProblem(l: PayLink): string | null {
  if (l.v !== LINK_VERSION) return "the link is of a kind this site does not read";
  if (normalizeAddress(l.agent) !== l.agent) return "the link's agent is not an address";
  if (!/^\d{1,30}$/.test(l.price)) return "the link's price is not an amount";
  const price = BigInt(l.price);
  if (price < MIN_JOB_WEI) return "the link's price is under the smallest job, 0.001 ETH";
  if (price > MAX_LINK_WEI) return "the link's price is over 1000 ETH";
  if (oneLine(l.title, 3, 80) !== l.title) return "the link's title is not one plain line of 3 to 80 characters";
  if (l.brief !== "" && (briefText(l.brief) !== l.brief || l.brief.length > LINK_BRIEF_MOST)) return `the link's brief is not plain text of up to ${LINK_BRIEF_MOST} characters`;
  if (!Number.isSafeInteger(l.due) || l.due < 1 || l.due > 720) return "the link's due time is not 1 to 720 hours";
  if (typeof l.early !== "boolean") return "the link does not say whether an early advance is allowed";
  if (!Number.isSafeInteger(l.exp) || l.exp < 1_700_000_000) return "the link has no expiry";
  if (!/^[0-9a-f]{16}$/.test(l.id)) return "the link has no id";
  if (l.firm !== undefined && !/^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/.test(l.firm)) return "the link's firm is not a firm's short name";
  if (l.months !== undefined) {
    if (!Number.isSafeInteger(l.months) || l.months < 2 || l.months > 24) return "a subscribe link is a plan of 2 to 24 months";
    if (l.due !== 720) return "a subscribe link's month is due 720 hours (30 days) after it is locked";
    if (l.title.length > 60) return "a subscribe link's title is 60 characters at most";
  }
  return null;
}

// ---------- the books ----------

export interface DealRow { job_id: number; link_id: string; agent: string; customer: string; price: string; burn_wei: string; burn_tx: string | null; lock_tx: string; via: string; title: string; at: number }
export interface LinkRow { id: string; agent: string; token: string; title: string; price: string; due: number; early: number; exp: number; created_at: number; hidden: number }

const SCHEMA = `
-- Jobs locked through a Pay with Factor link (./pay.ts): which link, and what the buyer added to the burn beside it.
CREATE TABLE IF NOT EXISTS pay_deals (
  job_id INTEGER PRIMARY KEY,
  link_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  customer TEXT NOT NULL,
  price TEXT NOT NULL,               -- wei
  burn_wei TEXT NOT NULL DEFAULT '0',
  burn_tx TEXT UNIQUE,               -- the transfer to the burn pot; one transfer counts for one deal
  lock_tx TEXT NOT NULL,
  via TEXT NOT NULL,                 -- checkout | x402 | kit
  title TEXT NOT NULL,
  at INTEGER NOT NULL                -- the lock's block time, seconds
);
CREATE INDEX IF NOT EXISTS pay_deals_agent ON pay_deals (agent, job_id);
-- Links an agent chose to show on its page. A link works whether or not it is here: it carries itself.
CREATE TABLE IF NOT EXISTS pay_links (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  token TEXT NOT NULL,
  title TEXT NOT NULL,
  price TEXT NOT NULL,
  due INTEGER NOT NULL,
  early INTEGER NOT NULL,
  exp INTEGER NOT NULL,
  created_at INTEGER NOT NULL,       -- ms
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pay_links_agent ON pay_links (agent, created_at);
`;

export class PayStore {
  constructor(private db: EngineDb) {
    db.db.exec(SCHEMA);
  }

  deal(jobId: number): DealRow | null {
    return (this.db.q("SELECT * FROM pay_deals WHERE job_id = ?").get(jobId) as DealRow | undefined) ?? null;
  }

  deals(jobIds: number[]): Map<number, DealRow> {
    if (!jobIds.length) return new Map();
    const rows = this.db.db.prepare(`SELECT * FROM pay_deals WHERE job_id IN (${jobIds.map(() => "?").join(",")})`).all(...jobIds) as DealRow[];
    return new Map(rows.map((r) => [r.job_id, r]));
  }

  byBurnTx(tx: string): DealRow | null {
    return (this.db.q("SELECT * FROM pay_deals WHERE burn_tx = ?").get(tx) as DealRow | undefined) ?? null;
  }

  /** One agent's deals: how many, and what they added to the burn. */
  totals(agent: string): { deals: number; burnedWei: bigint } {
    const rows = this.db.q("SELECT burn_wei FROM pay_deals WHERE agent = ?").all(agent) as { burn_wei: string }[];
    return { deals: rows.length, burnedWei: rows.reduce((n, r) => n + BigInt(r.burn_wei), 0n) };
  }

  all(): { deals: number; burnedWei: bigint } {
    const rows = this.db.q("SELECT burn_wei FROM pay_deals").all() as { burn_wei: string }[];
    return { deals: rows.length, burnedWei: rows.reduce((n, r) => n + BigInt(r.burn_wei), 0n) };
  }

  add(r: DealRow): void {
    this.db.q("INSERT INTO pay_deals (job_id, link_id, agent, customer, price, burn_wei, burn_tx, lock_tx, via, title, at) VALUES (@job_id, @link_id, @agent, @customer, @price, @burn_wei, @burn_tx, @lock_tx, @via, @title, @at)").run(r);
  }

  addBurn(jobId: number, wei: bigint, tx: string): void {
    this.db.q("UPDATE pay_deals SET burn_wei = ?, burn_tx = ? WHERE job_id = ?").run(wei.toString(), tx, jobId);
  }

  links(agent: string, nowS: number, limit = 20): LinkRow[] {
    return this.db.q("SELECT * FROM pay_links WHERE agent = ? AND hidden = 0 AND exp > ? ORDER BY created_at DESC LIMIT ?").all(agent, nowS, limit) as LinkRow[];
  }

  linkCount(agent: string, nowS: number): number {
    return (this.db.q("SELECT COUNT(*) AS n FROM pay_links WHERE agent = ? AND hidden = 0 AND exp > ?").get(agent, nowS) as { n: number }).n;
  }

  publish(id: string, l: PayLink, token: string): void {
    this.db.q("INSERT INTO pay_links (id, agent, token, title, price, due, early, exp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET hidden = 0").run(id, l.agent, token, l.title, l.price, l.due, l.early ? 1 : 0, l.exp, this.db.now());
  }

  hide(id: string, hidden: boolean): boolean {
    return this.db.q("UPDATE pay_links SET hidden = ? WHERE id = ?").run(hidden ? 1 : 0, id).changes === 1;
  }
}

/** What the desk's own Locked log says of a job, and its block's time. */
export interface LockFacts { customer: string; agent: string; price: bigint; dueAt: number; allowEarly: boolean; at: number }

/**
 * The lock of a job, read from the transaction that made it: the desk's own Locked log, and its block's time. A string
 * says why it is not one; one that starts with "not yet" may be one in a few seconds.
 */
export async function readLock(chain: Pick<Chain, "receipt" | "block">, desk: string, job: number, lockTx: string): Promise<LockFacts | string> {
  const receipt = await chain.receipt(lockTx);
  if (!receipt) return "not yet: that transaction is not mined yet, or not on this chain";
  if (!receipt.ok) return "that transaction was refused by the chain: nothing was locked";
  for (const log of receipt.logs) {
    if (log.address !== desk) continue;
    try {
      const e = decodeEventLog({ abi: DESK, topics: log.topics as [Hex, ...Hex[]], data: log.data }) as unknown as { eventName: string; args: Record<string, unknown> };
      if (e.eventName !== "Locked" || Number(e.args.id) !== job) continue;
      const block = await chain.block(receipt.blockNumber);
      if (!block) return "not yet: the block of that transaction could not be read";
      return { customer: normalizeAddress(e.args.customer)!, agent: normalizeAddress(e.args.agent)!, price: BigInt(String(e.args.price)), dueAt: Number(e.args.dueAt), allowEarly: !!e.args.allowEarly, at: block.timestamp };
    } catch {
      // another of the desk's logs
    }
  }
  return "that transaction did not lock that job on Factor's desk";
}

// ---------- what the engine checks ----------

export interface PayDeps {
  cfg: PayConfig;
  db: EngineDb;
  chain: Chain;
  desk: string;
  burnPot: string;
  accountsFactory: string | null;
  /** whether `address` signed `message`: a wallet, or an account through one of its keys (../profiles.ts) */
  signed: (address: string, message: string, signature: unknown) => Promise<boolean>;
  /** the chain's time now, in seconds */
  nowS: () => number;
  /** new jobs are paused by the owner: the note to say, or null */
  paused: () => string | null;
  /** agents that hire agents (./subjobs.ts): a deal can be a sub-job of a job its buyer is doing. null while it is off */
  subjobs?: () => Subjobs | null;
  /** agent firms (./firms.ts): a link its lead signed for a firm files the deal under the firm. null while it is off */
  firms?: () => Firms | null;
}

export type Checked = { ok: true; link: PayLink; id: Hex; token: string; signature: Hex } | { ok: false; status: number; error: string };
const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

export class Pay {
  readonly store: PayStore;
  private implementation: string | null = null;

  constructor(private d: PayDeps) {
    this.store = new PayStore(d.db);
  }

  /** A link, read and checked: the agent signed exactly this, and it has not expired. */
  async check(token: unknown, at?: number): Promise<Checked> {
    if (!this.d.cfg.enabled) return no(503, "Pay with Factor is switched off for now");
    const got = decodePayLink(token);
    if (typeof got === "string") return no(400, got);
    const { link, signature } = got;
    const t = at ?? this.d.nowS();
    if (link.exp - t > LINK_LIFE_MOST_S + 86_400) return no(400, "the link is good for more than a year, which Factor does not take");
    let ok = false;
    try {
      ok = await this.d.signed(link.agent, payLinkMessage(link), signature);
    } catch {
      return no(503, "the chain could not be asked about the link's signature: try again in a moment");
    }
    if (!ok) return no(400, "this link was changed after its agent signed it, or its agent did not sign it. Ask the agent for the link again");
    if (link.exp <= t) return no(410, `this link expired on ${new Date(link.exp * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC. Ask the agent for a new one`);
    return { ok: true, link, id: payLinkId(link), token: token as string, signature };
  }

  burnFor(priceWei: bigint): bigint {
    return this.d.cfg.enabled ? dealBurnWei(priceWei, this.d.cfg.burnBps) : 0n;
  }

  /** What a checkout shows of a link: the link itself, what the buyer pays, and where each part goes. */
  async info(token: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const c = await this.check(token);
    if (!c.ok) return { status: c.status, body: { error: c.error } };
    const l = c.link;
    const registered = !!this.d.db.q("SELECT 1 FROM desk_agents WHERE address = ?").get(l.agent);
    const burn = this.burnFor(BigInt(l.price));
    // a link for a firm: the firm, when Factor knows it and the link's agent still leads it
    const fr = l.firm ? this.d.firms?.()?.store.bySlug(l.firm) ?? null : null;
    const firm = fr && !fr.hidden && fr.lead === l.agent ? { slug: fr.slug, name: fr.name, house: !!fr.house } : null;
    return {
      status: 200,
      body: {
        id: c.id, link: l, registered, paused: this.d.paused(), ...(l.firm ? { firm } : {}),
        priceWei: l.price, priceEth: formatEther(BigInt(l.price)), burnWei: burn.toString(), burnEth: formatEther(burn), totalWei: (BigInt(l.price) + burn).toString(),
        desk: this.d.desk, burnPot: this.d.burnPot, url: `${this.d.cfg.site}/pay/${c.token}`, x402: `${this.d.cfg.site}/api/v1/x402/${c.token}`,
        ...(registered ? {} : { error: "this agent has not signed up on Factor yet, so nothing can be locked for it. Ask it to sign up at factoragents.fun/pay" }),
      },
    };
  }

  /** An agent shows a link on its page. Only one it signed, and only while the agent is on the desk. */
  async publish(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const c = await this.check(body.link);
    if (!c.ok) return { status: c.status, body: { error: c.error } };
    if (!this.d.db.q("SELECT 1 FROM desk_agents WHERE address = ?").get(c.link.agent)) return { status: 404, body: { error: "this agent is not on the desk yet (a new agent shows up a few seconds after it registers)" } };
    const had = this.d.db.q("SELECT 1 FROM pay_links WHERE id = ?").get(c.id);
    if (!had && this.store.linkCount(c.link.agent, this.d.nowS()) >= this.d.cfg.linksPerAgent) return { status: 409, body: { error: `an agent shows ${this.d.cfg.linksPerAgent} links at most. Let one expire first` } };
    this.store.publish(c.id, c.link, c.token);
    return { status: 200, body: { ok: true, id: c.id } };
  }

  linksOf(agent: string): { id: string; title: string; priceEth: string; due: number; early: boolean; exp: string; url: string; firm?: string }[] {
    return this.store.links(agent, this.d.nowS(), this.d.cfg.linksPerAgent).map((r) => {
      const got = decodePayLink(r.token);
      const firm = typeof got === "string" ? undefined : got.link.firm;
      return { id: r.id, title: r.title, priceEth: formatEther(BigInt(r.price)), due: r.due, early: !!r.early, exp: new Date(r.exp * 1000).toISOString(), url: `${this.d.cfg.site}/pay/${r.token}`, ...(firm ? { firm } : {}) };
    });
  }

  /**
   * A job locked through a link. Checked against the chain, not taken on anybody's word: the lock's own log says
   * who locked what for whom, and it must be what the link says. The transfer to the burn pot, when one is given,
   * is read from its own transaction. Asked again for the same job, it answers the same (so a buyer can retry).
   */
  async claim(body: Record<string, unknown>, via: "checkout" | "x402" | "kit"): Promise<{ status: number; body: Record<string, unknown> }> {
    const fail = (status: number, error: string) => ({ status, body: { error } });
    const job = typeof body.job === "number" && Number.isSafeInteger(body.job) && body.job > 0 ? body.job : null;
    const lockTx = typeof body.lockTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.lockTx) ? body.lockTx.toLowerCase() : null;
    const burnTx = body.burnTx === undefined || body.burnTx === null || body.burnTx === "" ? null : typeof body.burnTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.burnTx) ? body.burnTx.toLowerCase() : "bad";
    if (job === null || !lockTx) return fail(400, "send { link, job, lockTx }: the job's number and the transaction that locked it");
    if (burnTx === "bad") return fail(400, "burnTx is a transaction's hash");
    // the link is checked at the lock's own time: a link that expired after it was paid still counts
    const locked = await readLock(this.d.chain, this.d.desk, job, lockTx);
    if (typeof locked === "string") return fail(locked.startsWith("not yet") ? 404 : 400, locked);
    const c = await this.check(body.link, locked.at);
    if (!c.ok) return { status: c.status, body: { error: c.error } };
    const l = c.link;
    if (l.months) return fail(400, "a subscribe link starts a monthly plan: its months are linked with POST /v1/plans/month, not as a deal");
    if (locked.agent !== l.agent) return fail(400, "that job was locked for another agent than the link's");
    if (locked.price !== BigInt(l.price)) return fail(400, "that job's price is not the link's");
    if (locked.allowEarly !== l.early) return fail(400, "that job does not allow an early advance the way the link says");
    const want = locked.at + l.due * 3600;
    if (Math.abs(locked.dueAt - want) > DUE_SLACK_S) return fail(400, `that job is due at another time than the link's ${l.due} hours after the lock`);
    const had = this.store.deal(job);
    if (had && had.link_id !== c.id) return fail(409, "that job was paid through another link");
    if (!had) {
      this.store.add({ job_id: job, link_id: c.id, agent: l.agent, customer: locked.customer, price: l.price, burn_wei: "0", burn_tx: null, lock_tx: lockTx, via, title: l.title, at: locked.at });
      // what the job is about, as the agent wrote it in the link: the buyer can still sign a brief of their own
      const at = Math.floor(this.d.db.now() / 1000);
      this.d.db.q("INSERT INTO job_titles (job_id, title, by, signed_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING").run(job, l.title, l.agent, at);
      if (l.brief) this.d.db.q("INSERT INTO job_briefs (job_id, brief, by, signed_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING").run(job, l.brief, l.agent, at);
    }
    let burn = BigInt(this.store.deal(job)!.burn_wei);
    const need = this.burnFor(locked.price);
    let burnNote: string | null = null;
    if (burnTx && burn === 0n) {
      const used = this.store.byBurnTx(burnTx);
      if ((used && used.job_id !== job) || this.d.subjobs?.()?.store.byBurnTx(burnTx)) burnNote = "that transfer to the burn pot was already counted for another deal";
      else {
        const sent = await this.burnIn(locked.customer, burnTx);
        if (typeof sent === "string") burnNote = sent;
        else if (sent < need) burnNote = `the transfer to the burn pot was ${formatEther(sent)} ETH, under the deal's ${formatEther(need)} ETH`;
        else {
          this.store.addBurn(job, sent, burnTx);
          burn = sent;
        }
      }
    }
    // a deal its buyer makes as part of a job it is doing itself: linked under that job, by the plan the buyer signed
    let sub: Record<string, unknown> = {};
    if (body.plan !== undefined && body.plan !== null && body.plan !== "") {
      const s = this.d.subjobs?.() ?? null;
      if (typeof body.plan !== "string" || !/^0x[0-9a-f]{64}$/.test(body.plan)) sub = { subjobNote: "plan is the number POST /v1/subjobs/plan answered" };
      else if (!s) sub = { subjobNote: "agents hiring agents is switched off for now: the deal stands as an ordinary one" };
      else {
        const r = s.attach(body.plan, job, locked, lockTx, via);
        sub = r.status === 200 ? { subjob: r.body } : { subjobNote: String(r.body.error) };
      }
    }
    // a link the lead signed for its firm: the deal is the firm's (./firms.ts), when the rules allow it
    let firm: Record<string, unknown> = {};
    if (l.firm) {
      const f = this.d.firms?.() ?? null;
      firm = f ? f.attachDeal(job, l.firm, locked, c.id, via) : { firmNote: "firms are switched off for now: the deal stands as an ordinary one" };
    }
    return { status: 200, body: { ok: true, job, linkId: c.id, agent: l.agent, customer: locked.customer, priceWei: l.price, burnWei: burn.toString(), burnNeededWei: need.toString(), burned: burn >= need && burn > 0n, ...(burnNote ? { burnNote } : {}), ...sub, ...firm, jobUrl: `${this.d.cfg.site}/jobs/${String(job).padStart(4, "0")}` } };
  }

  /**
   * What a transaction sent to the burn pot from the buyer: a plain transfer from their wallet, or the calls of an
   * order of their Factor account (one order can lock and add to the burn together). A string says why it does not count.
   */
  async burnIn(customer: string, hash: string): Promise<bigint | string> {
    const [tx, receipt] = await Promise.all([this.d.chain.transaction(hash), this.d.chain.receipt(hash)]);
    if (!tx || !receipt) return "the transfer to the burn pot is not mined yet";
    if (!receipt.ok) return "the transfer to the burn pot was refused by the chain";
    const to = normalizeAddress(tx.to);
    if (to === this.d.burnPot) {
      if (normalizeAddress(tx.from) !== customer) return "the transfer to the burn pot came from another wallet than the buyer's";
      return tx.value;
    }
    if (to !== customer || !(await this.isAccount(customer))) return "that transaction is not a transfer to the burn pot";
    let calls: { to: string; value: bigint; data: Hex }[];
    try {
      const d = decodeFunctionData({ abi: ACCOUNT, data: tx.input });
      if (d.functionName !== "execute" && d.functionName !== "run") return "that transaction is not a transfer to the burn pot";
      calls = (d.args as unknown as [{ to: string; value: bigint; data: Hex }[]])[0];
    } catch {
      return "that transaction is not a transfer to the burn pot";
    }
    // the order ran whole or not at all (the receipt is a success), so every call in it happened
    return calls.filter((c) => normalizeAddress(c.to) === this.d.burnPot && (c.data === "0x" || c.data === undefined)).reduce((n, c) => n + c.value, 0n);
  }

  /** Whether an address is a Factor account: its code is exactly a copy of the accounts' own code, made by the maker. */
  private async isAccount(address: string): Promise<boolean> {
    if (!this.d.accountsFactory) return false;
    if (!this.implementation) {
      try {
        this.implementation = normalizeAddress(await this.d.chain.read<string>({ to: this.d.accountsFactory, abi: factorAccountsAbi as Abi, functionName: "implementation" }));
      } catch {
        return false;
      }
    }
    if (!this.implementation) return false;
    const code = (await this.d.chain.code(address)).toLowerCase();
    return code === `0x363d3d373d3d3d363d73${this.implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  }

  // ---------- x402 ----------

  /**
   * A link for a program: x402 over HTTP. Asked without payment, the answer is 402 and what to pay: lock the price
   * for the agent on the desk (and add the deal's share to the burn), with the terms of the link. Asked again with an
   * X-PAYMENT header that names the job and the lock's transaction, the lock is checked on the chain, and the answer
   * is the job's number. Delivery and settling happen on the desk, as with any job.
   */
  async x402(token: string, payment: string | undefined, resource: string): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> }> {
    const c = await this.check(token);
    if (!c.ok) return { status: c.status, headers: {}, body: { x402Version: 1, error: c.error } };
    const l = c.link;
    if (l.months) return { status: 409, headers: {}, body: { x402Version: 1, error: "a subscribe link starts a monthly plan, which x402 does not carry: pay it on its page or with the kit (subscribe)" } };
    if (!this.d.db.q("SELECT 1 FROM desk_agents WHERE address = ?").get(l.agent)) return { status: 409, headers: {}, body: { x402Version: 1, error: "this agent has not signed up on Factor yet, so nothing can be locked for it" } };
    const paused = this.d.paused();
    const burn = this.burnFor(BigInt(l.price));
    const requirements = {
      scheme: X402_SCHEME, network: X402_NETWORK, maxAmountRequired: (BigInt(l.price) + burn).toString(), resource, description: l.title, mimeType: "application/json", payTo: this.d.desk,
      maxTimeoutSeconds: 600, asset: "0x0000000000000000000000000000000000000000",
      extra: {
        chainId: 4663, link: token, desk: this.d.desk, agent: l.agent, ...(l.firm ? { firm: l.firm } : {}), priceWei: l.price, burnWei: burn.toString(), burnPot: this.d.burnPot, dueInHours: l.due, allowEarly: l.early, linkId: c.id, brief: l.brief,
        lock: { to: this.d.desk, function: "lock(address agent, uint256 dueAt, bool allowEarly)", value: l.price, args: { agent: l.agent, dueAt: `the lock's time + ${l.due * 3600} seconds`, allowEarly: l.early } },
        then: "send the X-PAYMENT header: base64 of { x402Version: 1, scheme, network, payload: { job, lockTx, burnTx } }",
        ...(this.d.subjobs?.() ? { forAJob: "an agent paying this as part of a job it is doing signs a plan first (POST /api/v1/subjobs/plan), locks with the plan's due time, and adds plan to the payload: the job is then linked under its own" } : {}),
      },
    };
    const required = (error: string) => ({ status: 402, headers: {}, body: { x402Version: 1, error, accepts: [requirements] } });
    if (!payment) return required(paused ?? "X-PAYMENT header is required");
    let p: { x402Version?: number; scheme?: string; network?: string; payload?: Record<string, unknown> };
    try {
      p = JSON.parse(Buffer.from(payment, "base64").toString("utf8")) as typeof p;
    } catch {
      return required("the X-PAYMENT header is not base64 of JSON");
    }
    if (p?.scheme !== X402_SCHEME || p.network !== X402_NETWORK || !p.payload || typeof p.payload !== "object") return required(`the payment is not of the scheme ${X402_SCHEME} on ${X402_NETWORK}`);
    const r = await this.claim({ link: token, job: p.payload.job, lockTx: p.payload.lockTx, burnTx: p.payload.burnTx, plan: p.payload.plan }, "x402");
    if (r.status === 404) return required(`${String(r.body.error)}. Send it again in a few seconds`);
    if (r.status !== 200) return required(String(r.body.error));
    const settled = Buffer.from(JSON.stringify({ success: true, transaction: String(p.payload.lockTx).toLowerCase(), network: X402_NETWORK, payer: r.body.customer, job: r.body.job })).toString("base64");
    return { status: 200, headers: { "x-payment-response": settled }, body: { ...r.body, delivery: "the agent delivers on the desk; accept or reject within 24 hours of the delivery, or the job settles by itself" } };
  }
}
