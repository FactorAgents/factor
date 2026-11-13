// Selling locked pay (docs/LOCKED-PAY.md; contracts/src/FactorClaims.sol): an agent working from its pay account lists the
// claim on a job's locked payment for a price at most 10% under what the job pays it, another agent or firm buys it and pays
// the seller at once, and when the job ends the payment goes to whoever holds the claim. If the job pays the holder less than
// the buyer paid, the difference is the pay account's debt to the holder, paid first out of everything the account holds.
//
// What the engine does with them:
//
//   reads     the claims contract's Opened, Listed, Unlisted, Bought, Given, Paid and Repaid into chain_events and the
//             tables here. What a claim IS (its state, holder, what was paid and what is still owed) is read from claim(id),
//             and where its desk job stands from the desk's job(id), the stalest first; a pay account's debt, ETH and desk
//             bond likewise
//   sweeps    a pay account whose claimed job has ended, or can be ended (a delivery past its 24 hours of review, a job
//             past its due time and 12 hours of grace), or which owes a holder and holds ETH or bond to pay it: sweep(account),
//             which ends the job on the desk first, pays every ended claim's holder and the debts. Anyone may; the keeper
//             does it on time
//   shows     each claim on its job's page and on the seller's and the holder's agent pages, with whether the seller or the
//             buyer is one of Factor's own: those are shown, marked, and not counted in the totals
//
//   GET  /v1/claims/about             whether selling locked pay is on, the contract, the rules and the totals
//   GET  /v1/claims                   the latest claims (?state=listed|sold|paid|closed, ?limit=)
//   GET  /v1/claims/<n>               one claim
//   GET  /v1/claims/job/<n>           the claims on one desk job
//   GET  /v1/claims/agent/<address>   a key's or pay account's claims and debt, and the claims an address bought or holds
//
// Switches: LOCKED_PAY=on (off unless it is said), with FACTOR_CLAIMS and FACTOR_CLAIMS_BLOCK; and the owner's "lockedpay"
// switch (./switches.ts), which hides every claim and stops the keeper's sweeps at once. Nothing a seller or a buyer does on
// the chain depends on either: every call of the contract is open to everybody.

import { formatEther, type Abi } from "viem";
import { factorClaimsAbi, factorDeskAbi } from "./abi/index.js";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import { readLogs, type CallSpec, type Chain, type ChainLog, type Head } from "./chain/chain.js";
import type { Ctx } from "./chain/context.js";
import type { EngineDb, EventRow } from "./chain/db.js";
import { decode } from "./chain/watch.js";
import { STATE, STATE_NAME } from "./desk.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export interface ClaimsConfig {
  /** LOCKED_PAY=on: off unless it is said */
  enabled: boolean;
  /** FACTOR_CLAIMS: the claims contract, once deployed (contracts/deploy-claims.sh writes it) */
  contract: string | null;
  /** FACTOR_CLAIMS_BLOCK: the block to read claims from */
  fromBlock: bigint | null;
  /** LOCKED_PAY_PER_PASS: how many pay accounts the keeper sweeps in one pass */
  perPass: number;
  /** why it is on and cannot run, when it cannot */
  note: string | null;
}

export function readClaims(env: Env, problems: string[] = []): ClaimsConfig {
  const on = (env.LOCKED_PAY ?? "").trim().toLowerCase() === "on";
  const raw = env.FACTOR_CLAIMS?.trim();
  const contract = raw ? normalizeAddress(raw) : null;
  if (raw && !contract) problems.push(`FACTOR_CLAIMS is not an address: "${raw}"`);
  const rawBlock = env.FACTOR_CLAIMS_BLOCK?.trim();
  let fromBlock: bigint | null = null;
  if (rawBlock) {
    if (/^\d+$/.test(rawBlock)) fromBlock = BigInt(rawBlock);
    else problems.push(`FACTOR_CLAIMS_BLOCK must be a block number: it is "${rawBlock}"`);
  }
  const rawPer = env.LOCKED_PAY_PER_PASS?.trim();
  let perPass = 5;
  if (rawPer) {
    if (/^\d+$/.test(rawPer) && Number(rawPer) >= 1 && Number(rawPer) <= 100) perPass = Number(rawPer);
    else problems.push(`LOCKED_PAY_PER_PASS must be a whole number from 1 to 100: it is "${rawPer}"`);
  }
  let note: string | null = null;
  if (on && !contract) note = "LOCKED_PAY is on and FACTOR_CLAIMS is not set: there is no claims contract to read yet";
  else if (on && fromBlock === null) note = "LOCKED_PAY is on and FACTOR_CLAIMS_BLOCK is not set: the block to read claims from";
  return { enabled: on, contract, fromBlock, perPass, note };
}

/** The rules, as the contract has them (FactorClaims' constants and the desk's clocks): what the site says. */
export const CLAIM_RULES = {
  maxDiscountBps: 1000, minFace: "500000000000000", maxOpen: 10, review: 24 * 3600, grace: 12 * 3600,
} as const;

const CT = factorClaimsAbi as Abi;
const STATES = ["none", "listed", "sold", "paid", "closed"] as const;
export type ClaimState = Exclude<(typeof STATES)[number], "none">;
export const CLAIM_STATES: ClaimState[] = ["listed", "sold", "paid", "closed"];

export interface ClaimRow {
  id: number; block: number; at: number; tx_hash: string; job: number; account: string; seller: string | null;
  face: string; price: string; state: ClaimState; holder: string | null; buyer: string | null; paid: string; owing: string;
  sold_at: number | null; bought_tx: string | null; ended_at: number | null; paid_tx: string | null;
  job_state: number; due_at: number; delivered_at: number; read_at: number;
}

interface AccountRow { account: string; key: string; block: number; at: number; tx_hash: string; debt: string; balance: string; bond: string; advanced: string; state_at: number }

export interface ClaimsDeps {
  cfg: ClaimsConfig;
  db: EngineDb;
  chain: Chain;
  chainId: number;
  /** the chain's clock, seconds */
  nowS: () => number;
  /** the wall clock, ms */
  now: () => number;
  log: (line: string) => void;
  /** agents' names */
  names: () => Map<string, { name: string; hidden?: number }>;
  /** one of Factor's own wallets: its house agents, its test agents and demo wallets */
  factorOwn: (address: string) => boolean;
}

/** One claim as the site and the API show it. Amounts are wei in text, with the same in ETH beside them. */
export interface ClaimView {
  id: number; job: number; account: string; seller: string | null; sellerName: string;
  state: ClaimState; face: string; price: string; faceEth: number; priceEth: number; discountBps: number;
  holder: string | null; holderName: string | null; buyer: string | null;
  paid: string; owing: string; paidEth: number; owingEth: number;
  listedAt: string; soldAt: string | null; endedAt: string | null;
  listedTx: string; boughtTx: string | null; paidTx: string | null;
  jobState: string; dueAt: string | null;
  /** the seller or the buyer is one of Factor's own: shown, and not counted in the totals */
  factorOwn: boolean;
}

export interface ClaimsAbout {
  enabled: boolean; contract: string | null; fromBlock: string | null; chainId: number;
  rules: { maxDiscountBps: number; minFace: string; maxOpen: number; review: number; grace: number };
  totals: { claims: number; listed: number; sold: number; faceSold: string; priceSold: string; paid: string; owedBack: string; repaid: string; factorOwn: number } | null;
}

export interface AgentClaimsJson {
  /** the pay account, and the key that runs it */
  account: string | null; key: string | null;
  /** what the pay account owes holders, wei */
  debt: string;
  /** claims on the pay account's jobs */
  claims: ClaimView[];
  /** claims this address bought or holds */
  bought: ClaimView[];
}

export class Claims {
  constructor(readonly d: ClaimsDeps) {}

  /** Reading the chain: switched on and a contract to read. */
  reading(): boolean {
    return this.d.cfg.enabled && !!this.d.cfg.contract && this.d.cfg.fromBlock !== null;
  }

  /** Shown and kept: reading, and the owner has not stopped it. */
  on(): boolean {
    return this.reading() && !stopped(this.d.db, "lockedpay");
  }

  // ---------- the books ----------

  claim(id: number): ClaimRow | null {
    return (this.d.db.q("SELECT * FROM claims_claims WHERE id = ?").get(id) as ClaimRow | undefined) ?? null;
  }

  claims(o: { state?: ClaimState; job?: number; account?: string; party?: string; limit?: number } = {}): ClaimRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (o.state) { where.push("state = ?"); args.push(o.state); }
    if (o.job !== undefined) { where.push("job = ?"); args.push(o.job); }
    if (o.account) { where.push("account = ?"); args.push(o.account); }
    if (o.party) { where.push("(holder = ? OR buyer = ?)"); args.push(o.party, o.party); }
    return this.d.db.q(`SELECT * FROM claims_claims ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(Math.max(o.limit ?? 30, 1), 100)) as ClaimRow[];
  }

  private account(account: string): AccountRow | null {
    return (this.d.db.q("SELECT * FROM claims_accounts WHERE account = ?").get(account) as AccountRow | undefined) ?? null;
  }

  /** The pay account of a key, or the account itself. */
  accountOf(address: string): AccountRow | null {
    return this.account(address) ?? ((this.d.db.q("SELECT * FROM claims_accounts WHERE key = ?").get(address) as AccountRow | undefined) ?? null);
  }

  private name(address: string): string {
    const p = this.d.names().get(address);
    if (p && !p.hidden) return p.name;
    const key = this.account(address)?.key;
    const k = key ? this.d.names().get(key) : undefined;
    return k && !k.hidden ? k.name : shortAddress(address);
  }

  /** One of Factor's own: the wallet, or the key of its pay account. */
  own(address: string | null): boolean {
    if (!address) return false;
    const key = this.account(address)?.key;
    return this.d.factorOwn(address) || (!!key && this.d.factorOwn(key));
  }

  // ---------- reading the chain ----------

  /** One log of the claims contract's, written down. Returns a line for the engine's log, when it is worth one. Exported for the tests. */
  apply(log: ChainLog, at: number): string | null {
    const e = decode({ name: "claims" as never, abi: CT }, log, at);
    if (!e) return null;
    e.contract = "claims";
    if (!this.d.db.addEvent(e)) return null;
    return this.effect(e);
  }

  private effect(e: EventRow): string | null {
    const db = this.d.db;
    const a = e.args;
    const id = a.id !== undefined ? Number(a.id) : 0;
    if (e.event === "Opened") {
      const key = normalizeAddress(a.key)!, account = normalizeAddress(a.account)!;
      db.q("INSERT OR IGNORE INTO claims_accounts (account, key, block, at, tx_hash) VALUES (?, ?, ?, ?, ?)").run(account, key, e.block, e.at, e.tx_hash);
      return `${this.name(key)} opened its pay account ${shortAddress(account)}`;
    }
    if (e.event === "Listed") {
      const account = normalizeAddress(a.account)!;
      const seller = this.account(account)?.key ?? null;
      db.q("INSERT OR IGNORE INTO claims_claims (id, block, at, tx_hash, job, account, seller, face, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id, e.block, e.at, e.tx_hash, Number(a.job), account, seller, String(a.face), String(a.price),
      );
      return `claim ${id}: ${this.name(account)} lists the pay of job ${Number(a.job)}, ${ethText(String(a.face))} ETH, for ${ethText(String(a.price))} ETH`;
    }
    if (e.event === "Unlisted") {
      db.q("UPDATE claims_claims SET state = 'closed', ended_at = ?, read_at = 0 WHERE id = ? AND state = 'listed'").run(e.at, id);
      return `claim ${id}: off sale`;
    }
    if (e.event === "Bought") {
      const buyer = normalizeAddress(a.buyer)!;
      db.q("UPDATE claims_claims SET state = 'sold', holder = ?, buyer = ?, sold_at = ?, bought_tx = ?, seller = COALESCE(seller, ?), read_at = 0 WHERE id = ?").run(buyer, buyer, e.at, e.tx_hash, normalizeAddress(a.seller), id);
      return `claim ${id}: ${this.name(buyer)} bought it for ${ethText(String(a.price))} ETH`;
    }
    if (e.event === "Given") {
      db.q("UPDATE claims_claims SET holder = ?, read_at = 0 WHERE id = ?").run(normalizeAddress(a.to), id);
      return `claim ${id}: handed to ${shortAddress(normalizeAddress(a.to) ?? "")}`;
    }
    if (e.event === "Paid") {
      db.q("UPDATE claims_claims SET state = 'paid', paid = ?, owing = ?, ended_at = ?, paid_tx = ?, read_at = 0 WHERE id = ?").run(String(a.paid), String(a.owing), e.at, e.tx_hash, id);
      const c = this.claim(id);
      if (c) db.q("UPDATE claims_accounts SET state_at = 0 WHERE account = ?").run(c.account);
      return `claim ${id}: job ${Number(a.job)} ended, ${ethText(String(a.paid))} ETH to its holder${BigInt(String(a.owing)) > 0n ? `, ${ethText(String(a.owing))} ETH owed by the pay account` : ""}`;
    }
    if (e.event === "Repaid") {
      db.q("UPDATE claims_claims SET owing = ?, read_at = 0 WHERE id = ?").run(String(a.owing), id);
      const c = this.claim(id);
      if (c) db.q("UPDATE claims_accounts SET state_at = 0 WHERE account = ?").run(c.account);
      return `claim ${id}: ${ethText(String(a.amount))} ETH of its debt repaid to the holder`;
    }
    if (e.event === "Owed") return `${ethText(String(a.amount))} ETH waits in the claims contract for ${shortAddress(normalizeAddress(a.who) ?? "")}, who refused it`;
    return null;
  }

  /** One pass of the claims contract's logs, from where the last stopped to the safe head. Returns the lines worth logging. */
  async watch(ctx: Ctx, head: Head): Promise<string[]> {
    if (!this.reading()) return [];
    const { db, chain } = this.d;
    const safe = head.number - BigInt(ctx.params.confirmations);
    const start = (db.cursor("claims") ?? this.d.cfg.fromBlock! - 1n) + 1n;
    if (start > safe) return [];
    const lines: string[] = [];
    const span = BigInt(ctx.params.logSpan);
    let from = start;
    for (let n = 0; n < ctx.params.spansPerPass && from <= safe; n++) {
      const to = from + span - 1n > safe ? safe : from + span - 1n;
      let logs: ChainLog[] = [];
      await readLogs(chain, from, to, { address: [this.d.cfg.contract!] }, to - from + 1n, (got) => { logs = got; }, 1);
      logs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
      const missing = [...new Set(logs.filter((l) => l.timestamp === undefined && !ctx.blockTimes.has(l.blockNumber)).map((l) => l.blockNumber))];
      for (let i = 0; i < missing.length; i += 10) {
        const blocks = await Promise.all(missing.slice(i, i + 10).map((b) => chain.block(b)));
        blocks.forEach((b, k) => ctx.blockTimes.set(missing[i + k]!, b?.timestamp ?? 0));
      }
      db.tx(() => {
        for (const l of logs) {
          const line = this.apply(l, l.timestamp ?? ctx.blockTimes.get(l.blockNumber) ?? 0);
          if (line) lines.push(line);
        }
        db.setCursor("claims", to);
      });
      from = to + 1n;
    }
    for (const l of lines) this.d.log(`[lockedpay] ${l}`);
    return lines;
  }

  /**
   * What is read rather than logged: each claim that has not ended (and each one still owed) from claim(id), with its desk
   * job, every minute at most, the stalest first; each pay account with a claim open or a debt, its debt, ETH and desk bond.
   */
  async refresh(): Promise<void> {
    if (!this.reading()) return;
    const { db, chain } = this.d;
    const cc = this.d.cfg.contract!;
    const now = this.d.now();
    const desk = await this.desk();
    const open = db.q("SELECT * FROM claims_claims WHERE (state IN ('listed', 'sold') OR owing != '0' OR read_at = 0) AND ? - read_at > 60000 ORDER BY read_at LIMIT 25").all(now) as ClaimRow[];
    await Promise.all(open.map(async (c) => {
      const [x, j] = await Promise.all([
        chain.read<{ state: number | bigint; holder: string; buyer: string; seller: string; paid: bigint; owing: bigint }>({ to: cc, abi: CT, functionName: "claim", args: [BigInt(c.id)] }),
        chain.read<{ state: number | bigint; dueAt: number | bigint; deliveredAt: number | bigint }>({ to: desk, abi: factorDeskAbi as Abi, functionName: "job", args: [BigInt(c.job)] }),
      ]);
      const state = STATES[Number(x.state)] ?? c.state;
      const addr = (s: string) => { const n = normalizeAddress(s); return n && n !== ZERO ? n : null; };
      db.q("UPDATE claims_claims SET state = ?, holder = COALESCE(?, holder), buyer = COALESCE(?, buyer), seller = COALESCE(?, seller), paid = ?, owing = ?, job_state = ?, due_at = ?, delivered_at = ?, read_at = ? WHERE id = ?").run(
        state === "none" ? c.state : state, addr(x.holder), addr(x.buyer), addr(x.seller), x.paid.toString(), x.owing.toString(), Number(j.state), Number(j.dueAt), Number(j.deliveredAt), now, c.id,
      );
    }));
    const accounts = db.q("SELECT a.* FROM claims_accounts a WHERE (a.state_at = 0 OR ? - a.state_at > 60000) AND (a.debt != '0' OR a.state_at = 0 OR EXISTS (SELECT 1 FROM claims_claims c WHERE c.account = a.account AND (c.state IN ('listed', 'sold') OR c.owing != '0'))) ORDER BY a.state_at LIMIT 25").all(now) as AccountRow[];
    await Promise.all(accounts.map(async (a) => {
      const [debt, balance, ag] = await Promise.all([
        chain.read<bigint>({ to: cc, abi: CT, functionName: "debtOf", args: [a.account] }),
        chain.balance(a.account),
        chain.read<{ bond?: bigint; advancedNow?: bigint }>({ to: desk, abi: factorDeskAbi as Abi, functionName: "agent", args: [a.account] }),
      ]);
      db.q("UPDATE claims_accounts SET debt = ?, balance = ?, bond = ?, advanced = ?, state_at = ? WHERE account = ?").run(
        debt.toString(), balance.toString(), (ag.bond ?? 0n).toString(), (ag.advancedNow ?? 0n).toString(), now, a.account,
      );
    }));
  }

  private async desk(): Promise<string> {
    const known = this.d.db.getJson<{ desk: string }>("claims:wiring");
    if (known) return known.desk;
    const desk = normalizeAddress(await this.d.chain.read<string>({ to: this.d.cfg.contract!, abi: CT, functionName: "desk", args: [] }))!;
    this.d.db.setJson("claims:wiring", { desk });
    return desk;
  }

  // ---------- the keeper ----------

  /** Whether sweep() would end something for this claim now, by the contract's own rule, from what was last read. */
  due(c: ClaimRow, t: number): "ended" | "settle" | "refund" | null {
    if (c.state !== "listed" && c.state !== "sold") return null;
    const s = c.job_state;
    if (s === STATE.settled || s === STATE.half || s === STATE.declined || s === STATE.refunded) return "ended";
    if (s === STATE.delivered && c.delivered_at > 0 && t >= c.delivered_at + CLAIM_RULES.review) return "settle";
    if ((s === STATE.locked || s === STATE.advanced) && c.due_at > 0 && t > c.due_at + CLAIM_RULES.grace) return "refund";
    return null;
  }

  /** The pay accounts a sweep would do something for now, and why, sold claims and debts first. */
  sweepable(t: number): { account: string; why: string; weight: number }[] {
    const out = new Map<string, { account: string; why: string; weight: number }>();
    for (const c of this.d.db.q("SELECT * FROM claims_claims WHERE state IN ('listed', 'sold') ORDER BY id").all() as ClaimRow[]) {
      const how = this.due(c, t);
      if (!how) continue;
      const why = how === "ended" ? `claim ${c.id}'s job ended` : how === "settle" ? `claim ${c.id}'s job is past its review` : `claim ${c.id}'s job is past its due time`;
      const weight = c.state === "sold" ? 2 : 1;
      const prev = out.get(c.account);
      if (!prev || prev.weight < weight) out.set(c.account, { account: c.account, why, weight });
    }
    for (const a of this.d.db.q("SELECT * FROM claims_accounts WHERE debt != '0'").all() as AccountRow[]) {
      const canPay = BigInt(a.balance) > 0n || (BigInt(a.bond) > 0n && BigInt(a.advanced) === 0n);
      if (canPay && !out.has(a.account)) out.set(a.account, { account: a.account, why: `its debt to a holder can be paid`, weight: 3 });
    }
    return [...out.values()].sort((a, b) => b.weight - a.weight);
  }

  /**
   * The keeper's turn (./chain/act.ts calls it as the step "claims"): a pay account whose claimed job ended or can be ended,
   * or which owes a holder and can pay, is swept. A few a pass.
   */
  async step(ctx: Ctx, head: Head, attempt: (kind: "claims", ref: string, call: CallSpec, detail: Record<string, unknown>, feeCap: bigint) => Promise<{ status: string; why: string; hash?: string }>): Promise<string> {
    if (!this.reading()) return "selling locked pay is not switched on";
    if (stopped(this.d.db, "lockedpay")) return "selling locked pay is stopped by the owner";
    const db = this.d.db;
    const said: string[] = [];
    let n = 0;
    for (const s of this.sweepable(head.timestamp)) {
      if (n >= this.d.cfg.perPass || ctx.stopping()) break;
      const ref = `sweep:${s.account}`;
      const prev = db.lastAction("claims", ref);
      if (prev) {
        if (prev.status === "signed" || prev.status === "sent") continue;
        if (prev.status === "done" && this.d.now() - prev.updated_at <= 120_000) continue;
        if (prev.status === "failed" && this.d.now() - prev.updated_at <= 600_000) continue;
        if (prev.status === "dry" && this.d.now() - prev.created_at <= 1_800_000) continue;
      }
      n++;
      const words = `sweep pay account ${shortAddress(s.account)} (${s.why})`;
      const out = await attempt("claims", ref, { to: this.d.cfg.contract!, abi: CT, functionName: "sweep", args: [s.account] }, { account: s.account, why: s.why }, ctx.params.maxGasWei);
      said.push(`${out.status === "dry" ? `would ${words}` : out.status === "done" ? words : `${words}: ${out.status}`}${out.status === "failed" || out.status === "skipped" ? ` (${out.why})` : ""}`);
      if (out.status === "done") {
        db.q("UPDATE claims_claims SET read_at = 0 WHERE account = ?").run(s.account);
        db.q("UPDATE claims_accounts SET state_at = 0 WHERE account = ?").run(s.account);
      }
      if (db.openActions().length > 0) break;
    }
    return said.length ? said.join("; ") : "no pay account needs sweeping";
  }

  // ---------- what the site reads ----------

  about(): ClaimsAbout {
    const on = this.on();
    const c = this.d.cfg;
    let totals: ClaimsAbout["totals"] = null;
    if (on) {
      const rows = this.d.db.q("SELECT * FROM claims_claims").all() as ClaimRow[];
      const counted = rows.filter((r) => !this.own(r.seller ?? r.account) && !this.own(r.buyer));
      const sum = (xs: ClaimRow[], f: (r: ClaimRow) => bigint) => xs.reduce((n, r) => n + f(r), 0n).toString();
      const bought = counted.filter((r) => r.buyer);
      const shortfall = (r: ClaimRow) => (r.state === "paid" && BigInt(r.price) > BigInt(r.paid) ? BigInt(r.price) - BigInt(r.paid) : 0n);
      totals = {
        claims: counted.length,
        listed: counted.filter((r) => r.state === "listed").length,
        sold: counted.filter((r) => r.state === "sold").length,
        faceSold: sum(bought, (r) => BigInt(r.face)),
        priceSold: sum(bought, (r) => BigInt(r.price)),
        paid: sum(counted, (r) => BigInt(r.paid)),
        owedBack: sum(counted, shortfall),
        repaid: sum(counted, (r) => { const s = shortfall(r); const o = BigInt(r.owing); return s > o ? s - o : 0n; }),
        factorOwn: rows.length - counted.length,
      };
    }
    return {
      enabled: on, contract: c.contract, fromBlock: c.fromBlock === null ? null : c.fromBlock.toString(), chainId: this.d.chainId,
      rules: { maxDiscountBps: CLAIM_RULES.maxDiscountBps, minFace: CLAIM_RULES.minFace, maxOpen: CLAIM_RULES.maxOpen, review: CLAIM_RULES.review, grace: CLAIM_RULES.grace },
      totals,
    };
  }

  /** One claim as the site shows it. */
  json(c: ClaimRow): ClaimView {
    const face = BigInt(c.face), price = BigInt(c.price);
    return {
      id: c.id, job: c.job, account: c.account, seller: c.seller, sellerName: this.name(c.seller ?? c.account),
      state: c.state, face: c.face, price: c.price, faceEth: ethNum(c.face), priceEth: ethNum(c.price),
      discountBps: face > 0n ? Number(((face - price) * 10_000n) / face) : 0,
      holder: c.holder, holderName: c.holder ? this.name(c.holder) : null, buyer: c.buyer,
      paid: c.paid, owing: c.owing, paidEth: ethNum(c.paid), owingEth: ethNum(c.owing),
      listedAt: iso(c.at), soldAt: c.sold_at ? iso(c.sold_at) : null, endedAt: c.ended_at ? iso(c.ended_at) : null,
      listedTx: c.tx_hash, boughtTx: c.bought_tx, paidTx: c.paid_tx,
      jobState: STATE_NAME[c.job_state] ?? "none", dueAt: c.due_at ? iso(c.due_at) : null,
      factorOwn: this.own(c.seller ?? c.account) || this.own(c.buyer),
    };
  }

  list(o: { state?: ClaimState; limit?: number } = {}): ClaimView[] {
    if (!this.on()) return [];
    return this.claims(o).map((c) => this.json(c));
  }

  /** The claims on one desk job, newest first. */
  onJob(job: number): ClaimView[] {
    if (!this.on()) return [];
    return this.claims({ job }).map((c) => this.json(c));
  }

  /** The latest claim on a job that was not taken off sale, for the job's page; null while off or none. */
  latestOnJob(job: number): ClaimView | null {
    if (!this.on()) return null;
    const rows = this.claims({ job, limit: 10 });
    const shown = rows.find((r) => r.state !== "closed" || r.buyer) ?? null;
    return shown ? this.json(shown) : null;
  }

  /** A key's or pay account's claims and debt, and the claims an address bought or holds; null while off or it has none. */
  agentJson(address: string): AgentClaimsJson | null {
    if (!this.on()) return null;
    const acct = this.accountOf(address);
    const claims = acct ? this.claims({ account: acct.account }).map((c) => this.json(c)) : [];
    const parties = [...new Set([address, acct?.key, acct?.account].filter((x): x is string => !!x))];
    const seen = new Set<number>();
    const bought: ClaimView[] = [];
    for (const p of parties) for (const c of this.claims({ party: p })) if (!seen.has(c.id)) { seen.add(c.id); bought.push(this.json(c)); }
    if (!acct && !bought.length) return null;
    return { account: acct?.account ?? null, key: acct?.key ?? null, debt: acct?.debt ?? "0", claims, bought: bought.sort((a, b) => b.id - a.id) };
  }

  /** For the owner's health answer. */
  health(): Record<string, unknown> {
    const count = (state: string) => (this.d.db.q("SELECT COUNT(*) AS n FROM claims_claims WHERE state = ?").get(state) as { n: number }).n;
    const accounts = (this.d.db.q("SELECT COUNT(*) AS n FROM claims_accounts").get() as { n: number }).n;
    const owing = (this.d.db.q("SELECT COUNT(*) AS n FROM claims_accounts WHERE debt != '0'").get() as { n: number }).n;
    return { reading: this.reading(), on: this.on(), contract: this.d.cfg.contract, accounts, listed: count("listed"), sold: count("sold"), paid: count("paid"), accountsOwing: owing, note: this.d.cfg.note };
  }
}

const ZERO = "0x0000000000000000000000000000000000000000";
const iso = (s: number): string => new Date(s * 1000).toISOString();
const ethNum = (wei: string): number => Number(formatEther(BigInt(wei)));
const ethText = (wei: string): string => {
  const n = ethNum(wei);
  return n >= 0.01 ? n.toFixed(4) : n.toFixed(6);
};
