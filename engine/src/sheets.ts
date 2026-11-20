// Live balance sheets (docs/SHEETS.md; contracts/src/FactorSheets.sol): every agent on Factor gets open books. What it
// holds and what it owes on Factor's contracts, each line read from the contract that holds it, with the contract and
// the view call named so anyone can read the same number themselves.
//
//   holds     locked pay waiting for it at the desk, its desk bond, its treasury, its guarantee bond, its vouching bond,
//             locked pay it bought from other agents, and its compute share of its coin's fees not split yet
//   owes      its credit line, the covers it sold (the part of its guarantee bond held for them), the vouches it gave
//             (the part of its vouching bond held for them) and the locked pay it sold (what its pay account owes holders)
//   net       holds minus owes. Solvent while the net is zero or more. It changes no score
//
// Every hour the engine hashes each agent's sheet (a leaf), puts the leaves in one Merkle tree (sorted pairs), signs the
// root with Factor's answer key and the keeper writes it to the seal contract, where a root is written once per poster
// and hour and can never be changed. Any sheet of a sealed hour comes with its proof: anyone can hash the sheet, walk the
// proof to the root and compare it with the contract's rootOf(keeper, hour), or ask the contract's proves().
//
//   GET  /v1/sheets/about             whether it is on, the contract, the keeper, what is counted and how a leaf is made
//   GET  /v1/sheets                   the latest seal and the agents' sheets, the largest first
//   GET  /v1/sheets/<agent>           one agent's sheet now, and as sealed in the latest hour with its proof
//   GET  /v1/sheets/seal/<hour>       one sealed hour: the root, the signature, the transaction
//
// Switches: SHEETS=on (off unless it is said), with FACTOR_SHEETS and FACTOR_SHEETS_BLOCK; and the owner's "sheets"
// switch (./switches.ts), which hides the sheets and stops the keeper's seals at once. Reading the numbers needs no
// contract: without FACTOR_SHEETS the sheets still show, signed, and are not written on chain.

import { encodePacked, formatEther, keccak256, toBytes, type Abi, type Hex } from "viem";
import { factorSheetsAbi } from "./abi/index.js";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import type { CallSpec, Chain, Head } from "./chain/chain.js";
import type { Ctx } from "./chain/context.js";
import type { EngineDb } from "./chain/db.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export interface SheetsConfig {
  /** SHEETS=on: off unless it is said */
  enabled: boolean;
  /** FACTOR_SHEETS: the seal contract, once deployed (contracts/deploy-sheets.sh writes it) */
  contract: string | null;
  /** FACTOR_SHEETS_BLOCK: the block the seal contract was deployed after */
  fromBlock: bigint | null;
  /** SHEETS_MAX: the most sheets put in one hour's tree */
  max: number;
}

export function readSheets(env: Env, problems: string[] = []): SheetsConfig {
  const on = (env.SHEETS ?? "").trim().toLowerCase() === "on";
  const raw = env.FACTOR_SHEETS?.trim();
  const contract = raw ? normalizeAddress(raw) : null;
  if (raw && !contract) problems.push(`FACTOR_SHEETS is not an address: "${raw}"`);
  const rawBlock = env.FACTOR_SHEETS_BLOCK?.trim();
  let fromBlock: bigint | null = null;
  if (rawBlock) {
    if (/^\d+$/.test(rawBlock)) fromBlock = BigInt(rawBlock);
    else problems.push(`FACTOR_SHEETS_BLOCK must be a block number: it is "${rawBlock}"`);
  }
  let max = 5000;
  const m = env.SHEETS_MAX?.trim();
  if (m) {
    if (/^\d+$/.test(m) && Number(m) >= 1 && Number(m) <= 100_000) max = Number(m);
    else problems.push(`SHEETS_MAX must be a whole number from 1 to 100000: it is "${m}"`);
  }
  return { enabled: on, contract, fromBlock, max };
}

const ST = factorSheetsAbi as Abi;
/** The text a seal's signature is over. */
export const sealMessage = (hour: number, root: string, sheets: number): string => `Factor balance sheets\nhour: ${hour}\nroot: ${root}\nsheets: ${sheets}`;

/** Where one line's number is read: the contract and the view call, so anyone can read it again. */
export interface SheetSource { contract: string | null; call: string }
export interface SheetLine { key: LineKey; label: string; wei: string; eth: number; source: SheetSource; detail?: string }
export type LineKey = "lockedPay" | "deskBond" | "treasury" | "guaranteeBond" | "vouchBond" | "payBought" | "coinFees" | "creditLine" | "coversSold" | "vouchesGiven" | "paySold";

export const HOLDS: LineKey[] = ["lockedPay", "deskBond", "treasury", "guaranteeBond", "vouchBond", "payBought", "coinFees"];
export const OWES: LineKey[] = ["creditLine", "coversSold", "vouchesGiven", "paySold"];
export const LABELS: Record<LineKey, string> = {
  lockedPay: "Locked pay", deskBond: "Desk bond", treasury: "Treasury", guaranteeBond: "Guarantee bond", vouchBond: "Vouching bond",
  payBought: "Locked pay bought", coinFees: "Coin fees for compute", creditLine: "Credit line", coversSold: "Covers sold",
  vouchesGiven: "Vouches given", paySold: "Locked pay sold",
};

export interface SheetJson {
  agent: string; name: string; parties: string[];
  holds: SheetLine[]; owes: SheetLine[];
  holdsWei: string; owesWei: string; netWei: string; holdsEth: number; owesEth: number; netEth: number;
  solvent: boolean; at: string;
}

/** What is hashed for a sheet: the agent, the hour and every line's key and amount in wei, in a fixed order. */
export function canonical(agent: string, hour: number, holds: Pick<SheetLine, "key" | "wei">[], owes: Pick<SheetLine, "key" | "wei">[]): string {
  const part = (keys: LineKey[], lines: Pick<SheetLine, "key" | "wei">[]) => keys.map((k) => `${k}=${lines.find((l) => l.key === k)?.wei ?? "0"}`).join(",");
  return `factor-sheet-v1|${agent.toLowerCase()}|${hour}|holds:${part(HOLDS, holds)}|owes:${part(OWES, owes)}`;
}
export const leafOf = (text: string): Hex => keccak256(toBytes(text));
const pair = (a: Hex, b: Hex): Hex => (BigInt(a) < BigInt(b) ? keccak256(encodePacked(["bytes32", "bytes32"], [a, b])) : keccak256(encodePacked(["bytes32", "bytes32"], [b, a])));

/** The Merkle tree of sorted pairs the contract's proves() walks: an odd node at the end goes up as it is. */
export function merkle(leaves: Hex[]): { root: Hex; proofOf: (i: number) => Hex[] } {
  if (!leaves.length) throw new Error("no leaves");
  const levels: Hex[][] = [leaves.slice()];
  while (levels[levels.length - 1]!.length > 1) {
    const cur = levels[levels.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? pair(cur[i]!, cur[i + 1]!) : cur[i]!);
    levels.push(next);
  }
  return {
    root: levels[levels.length - 1]![0]!,
    proofOf: (index: number) => {
      const out: Hex[] = [];
      let i = index;
      for (let l = 0; l < levels.length - 1; l++) {
        const cur = levels[l]!;
        const sib = i % 2 === 0 ? i + 1 : i - 1;
        if (sib < cur.length) out.push(cur[sib]!);
        i = Math.floor(i / 2);
      }
      return out;
    },
  };
}
/** Walks a proof from a leaf: the root it reaches. */
export function walk(leaf: Hex, proof: Hex[]): Hex {
  return proof.reduce<Hex>((h, p) => pair(h, p), leaf);
}

export interface SheetsDeps {
  cfg: SheetsConfig;
  db: EngineDb;
  chain: Chain;
  chainId: number;
  explorer: string | null;
  now: () => number;
  log: (line: string) => void;
  names: () => Map<string, { name: string; hidden?: boolean }>;
  /** the contracts the numbers are read from, null while one is not on */
  contracts: () => { desk: string | null; line: string | null; guarantee: string | null; vouch: string | null; claims: string | null; treasury: string | null };
  /** Factor's answer key, which signs each hour's root */
  signer: () => { address: string; sign: (text: string) => Promise<Hex> } | null;
  /** the keeper's wallet, which writes the roots: the poster a reader trusts */
  keeper: () => string | null;
  /** Factor's own wallets, whose sheets are shown and not ranked */
  factorOwn: (a: string) => boolean;
}

interface SealRow { hour: number; root: string; sheets: number; leaves: string; signature: string | null; signer: string | null; tx: string | null; block: number | null; at: number; written_at: number | null }

const big = (s: string | null | undefined): bigint => {
  try { return s ? BigInt(s) : 0n; } catch { return 0n; }
};
const json = <T>(s: string | null | undefined): Partial<T> => {
  try { return s ? (JSON.parse(s) as Partial<T>) : {}; } catch { return {}; }
};
const ethNum = (wei: bigint): number => Number(formatEther(wei));
const iso = (ms: number): string => new Date(ms).toISOString();

export class Sheets {
  constructor(private d: SheetsDeps) {}

  on(): boolean {
    return this.d.cfg.enabled && !stopped(this.d.db, "sheets");
  }
  writing(): boolean {
    return this.on() && !!this.d.cfg.contract;
  }

  private name(a: string): string {
    const p = this.d.names().get(a);
    return p && !p.hidden ? p.name : shortAddress(a);
  }

  /** Every address that is part of an agent: itself, its line's key and account, its pay account and its key. */
  parties(address: string): string[] {
    const a = normalizeAddress(address);
    if (!a) return [];
    const out = new Set<string>([a]);
    const line = this.d.db.q("SELECT account, key FROM lines WHERE account = ? OR key = ?").get(a, a) as { account: string; key: string } | undefined;
    if (line) { out.add(line.account); out.add(line.key); }
    for (const p of [...out]) {
      const pay = this.d.db.q("SELECT account, key FROM claims_accounts WHERE account = ? OR key = ?").get(p, p) as { account: string; key: string } | undefined;
      if (pay) { out.add(pay.account); out.add(pay.key); }
    }
    return [...out].filter((x) => !!normalizeAddress(x));
  }

  /** Every agent with anything on a sheet: on the desk, a line, a bond, a treasury, a pay account or a coin. */
  agents(): string[] {
    const db = this.d.db;
    const set = new Set<string>();
    const add = (sql: string) => { for (const r of db.q(sql).all() as { a: string }[]) if (r.a) set.add(r.a); };
    add("SELECT address AS a FROM desk_agents");
    add("SELECT key AS a FROM lines");
    add("SELECT agent AS a FROM guarantee_bonds");
    add("SELECT voucher AS a FROM vouch_vouchers");
    add("SELECT agent AS a FROM treasury_agents");
    add("SELECT key AS a FROM claims_accounts");
    add("SELECT agent AS a FROM coins");
    // one sheet per agent: an address that is another's line account or pay account is counted under its key
    const accounts = new Set<string>([
      ...(db.q("SELECT account FROM lines").all() as { account: string }[]).map((r) => r.account),
      ...(db.q("SELECT account FROM claims_accounts").all() as { account: string }[]).map((r) => r.account),
    ]);
    return [...set].filter((a) => !accounts.has(a)).sort();
  }

  /** One agent's sheet, read from what the engine last read of each contract. */
  sheet(address: string): SheetJson | null {
    const a = normalizeAddress(address);
    if (!a) return null;
    const db = this.d.db;
    const c = this.d.contracts();
    const ps = this.parties(a);
    const inList = ps.map(() => "?").join(",");
    const holds: SheetLine[] = [];
    const owes: SheetLine[] = [];
    const put = (to: SheetLine[], key: LineKey, wei: bigint, source: SheetSource, detail?: string) => {
      if (wei <= 0n) return;
      const prev = to.find((l) => l.key === key);
      if (prev) { const w = big(prev.wei) + wei; prev.wei = w.toString(); prev.eth = ethNum(w); return; }
      to.push({ key, label: LABELS[key], wei: wei.toString(), eth: ethNum(wei), source, ...(detail ? { detail } : {}) });
    };

    // the desk: pay locked for its open jobs (less what it was paid early), and its bond
    if (c.desk) {
      const jobs = db.q(`SELECT price, early FROM desk_jobs WHERE agent IN (${inList}) AND state IN (1, 2, 3)`).all(...ps) as { price: string; early: string }[];
      const locked = jobs.reduce((s, j) => s + (big(j.price) > big(j.early) ? big(j.price) - big(j.early) : 0n), 0n);
      put(holds, "lockedPay", locked, { contract: c.desk, call: "job(id): price - early, for its jobs locked, advanced or delivered" }, `${jobs.length} open job${jobs.length === 1 ? "" : "s"}, before the desk's fee`);
      for (const p of ps) {
        const r = db.q("SELECT record FROM desk_agents WHERE address = ?").get(p) as { record: string | null } | undefined;
        if (r) put(holds, "deskBond", big(json<{ bond: string }>(r.record).bond), { contract: c.desk, call: `agent(${p}).bond` });
      }
    }
    // the agent treasury
    if (c.treasury) for (const p of ps) {
      const r = db.q("SELECT balance FROM treasury_agents WHERE agent = ?").get(p) as { balance: string } | undefined;
      if (r) put(holds, "treasury", big(r.balance), { contract: c.treasury, call: `balanceOf(${p})` });
    }
    // the guarantee bond, and the part of it held for covers it sold
    if (c.guarantee) for (const p of ps) {
      const r = db.q("SELECT state FROM guarantee_bonds WHERE agent = ?").get(p) as { state: string } | undefined;
      if (!r) continue;
      const s = json<{ bond: string; reserved: string; covers: number }>(r.state);
      put(holds, "guaranteeBond", big(s.bond), { contract: c.guarantee, call: `bondOf(${p}).bond` });
      put(owes, "coversSold", big(s.reserved), { contract: c.guarantee, call: `bondOf(${p}).reserved` });
    }
    // the vouching bond, and the part of it held for vouches it gave
    if (c.vouch) for (const p of ps) {
      const r = db.q("SELECT state FROM vouch_vouchers WHERE voucher = ?").get(p) as { state: string } | undefined;
      if (!r) continue;
      const s = json<{ bond: string; held: string }>(r.state);
      put(holds, "vouchBond", big(s.bond), { contract: c.vouch, call: `voucherOf(${p}).bond` });
      put(owes, "vouchesGiven", big(s.held), { contract: c.vouch, call: `voucherOf(${p}).held` });
    }
    // locked pay: what its pay account owes holders it sold to, and what holders' claims it bought still owe it
    if (c.claims) {
      for (const p of ps) {
        const r = db.q("SELECT debt FROM claims_accounts WHERE account = ?").get(p) as { debt: string } | undefined;
        if (r) put(owes, "paySold", big(r.debt), { contract: c.claims, call: `debtOf(${p})` });
      }
      const bought = db.q(`SELECT owing FROM claims_claims WHERE holder IN (${inList}) AND state = 'sold'`).all(...ps) as { owing: string }[];
      put(holds, "payBought", bought.reduce((s, b) => s + big(b.owing), 0n), { contract: c.claims, call: "claim(id).owing, for the claims it holds" }, `${bought.length} claim${bought.length === 1 ? "" : "s"}`);
    }
    // the credit line
    if (c.line) for (const p of ps) {
      const r = db.q("SELECT account, state FROM lines WHERE account = ?").get(p) as { account: string; state: string } | undefined;
      if (r) put(owes, "creditLine", big(json<{ debt: string }>(r.state).debt), { contract: c.line, call: `line(${r.account}).debt` });
    }
    // its coin: its compute share of the fees waiting in the coin's splitter, at the share its fees have gone at so far
    for (const p of ps) {
      const r = db.q("SELECT splitter, state FROM coins WHERE agent = ?").get(p) as { splitter: string; state: string } | undefined;
      if (!r) continue;
      const s = json<{ unsplit: string; escrow: string; totalSplit: string; toCompute: string }>(r.state);
      const waiting = big(s.unsplit) + big(s.escrow);
      const split = big(s.totalSplit);
      if (waiting > 0n && split > 0n) put(holds, "coinFees", (waiting * big(s.toCompute)) / split, { contract: r.splitter, call: "unsplit() + escrow, times totalToCompute() / totalSplit()" });
    }

    const holdsWei = holds.reduce((s, l) => s + big(l.wei), 0n);
    const owesWei = owes.reduce((s, l) => s + big(l.wei), 0n);
    if (!holds.length && !owes.length) return null;
    const order = (keys: LineKey[]) => (x: SheetLine, y: SheetLine) => keys.indexOf(x.key) - keys.indexOf(y.key);
    holds.sort(order(HOLDS)); owes.sort(order(OWES));
    const net = holdsWei - owesWei;
    return {
      agent: a, name: this.name(a), parties: ps, holds, owes,
      holdsWei: holdsWei.toString(), owesWei: owesWei.toString(), netWei: net.toString(), holdsEth: ethNum(holdsWei), owesEth: ethNum(owesWei), netEth: ethNum(net),
      solvent: net >= 0n, at: iso(this.d.now()),
    };
  }

  /** Every sheet, the largest first. */
  all(): SheetJson[] {
    return this.agents().map((a) => this.sheet(a)).filter((s): s is SheetJson => !!s).sort((x, y) => (big(y.holdsWei) + big(y.owesWei) > big(x.holdsWei) + big(x.owesWei) ? 1 : -1));
  }

  // ---------- the hourly seal ----------

  private seal(hour: number): SealRow | null {
    return (this.d.db.q("SELECT * FROM sheets_seals WHERE hour = ?").get(hour) as SealRow | undefined) ?? null;
  }
  latest(): SealRow | null {
    return (this.d.db.q("SELECT * FROM sheets_seals ORDER BY hour DESC LIMIT 1").get() as SealRow | undefined) ?? null;
  }

  /** Makes the seal of the hour that just began, once: every sheet hashed, the tree's root signed. Returns a line for the log. */
  async sealNow(): Promise<string | null> {
    if (!this.on()) return null;
    const hour = Math.floor(this.d.now() / 3_600_000);
    if (this.seal(hour)) return null;
    const sheets = this.all().slice(0, this.d.cfg.max);
    if (!sheets.length) return null;
    const leaves = sheets
      .map((s) => ({ agent: s.agent, text: canonical(s.agent, hour, s.holds, s.owes) }))
      .map((x) => ({ ...x, leaf: leafOf(x.text) }))
      .sort((x, y) => (x.agent < y.agent ? -1 : 1));
    const { root } = merkle(leaves.map((l) => l.leaf));
    const signer = this.d.signer();
    const signature = signer ? await signer.sign(sealMessage(hour, root, leaves.length)).catch(() => null) : null;
    this.d.db.q("INSERT OR IGNORE INTO sheets_seals (hour, root, sheets, leaves, signature, signer, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(hour, root, leaves.length, JSON.stringify(leaves.map((l) => [l.agent, l.text])), signature, signer?.address ?? null, this.d.now());
    // a week of hours is kept with every sheet in it; older hours keep only their root
    this.d.db.q("UPDATE sheets_seals SET leaves = '[]' WHERE hour < ? AND leaves != '[]'").run(hour - 24 * 7);
    return `sealed ${leaves.length} balance sheet${leaves.length === 1 ? "" : "s"} for hour ${hour}: root ${root.slice(0, 10)}…`;
  }

  /** One agent's sheet as sealed in an hour, with the proof to that hour's root. */
  proofOf(address: string, hour?: number): { hour: number; text: string; leaf: Hex; proof: Hex[]; root: string; signature: string | null; signer: string | null; tx: string | null; written: boolean } | null {
    const a = normalizeAddress(address);
    if (!a) return null;
    const s = hour === undefined ? this.latest() : this.seal(hour);
    if (!s) return null;
    const leaves = JSON.parse(s.leaves) as [string, string][];
    const i = leaves.findIndex(([x]) => x === a);
    if (i < 0) return null;
    const tree = merkle(leaves.map(([, t]) => leafOf(t)));
    return { hour: s.hour, text: leaves[i]![1], leaf: leafOf(leaves[i]![1]), proof: tree.proofOf(i), root: s.root, signature: s.signature, signer: s.signer, tx: s.tx, written: !!s.tx };
  }

  /** What is read back of the seal contract: a written root that the chain does not show yet is checked again. */
  async refresh(): Promise<void> {
    if (!this.writing()) return;
    const keeper = this.d.keeper();
    if (!keeper) return;
    const open = this.d.db.q("SELECT * FROM sheets_seals WHERE tx IS NOT NULL AND written_at IS NULL ORDER BY hour DESC LIMIT 5").all() as SealRow[];
    for (const s of open) {
      const root = await this.d.chain.read<Hex>({ to: this.d.cfg.contract!, abi: ST, functionName: "rootOf", args: [keeper, BigInt(s.hour)] }).catch(() => null);
      if (root && root.toLowerCase() === s.root.toLowerCase()) this.d.db.q("UPDATE sheets_seals SET written_at = ? WHERE hour = ?").run(this.d.now(), s.hour);
    }
  }

  /** The keeper's turn (./chain/act.ts, step "sheets"): the latest hour's root written to the seal contract, once. */
  async step(ctx: Ctx, _head: Head, attempt: (kind: "sheets", ref: string, call: CallSpec, detail: Record<string, unknown>, feeCap: bigint) => Promise<{ status: string; why: string; hash?: string }>): Promise<string> {
    if (!this.on()) return "live balance sheets are not switched on";
    const made = await this.sealNow();
    const prev = this.d.db.lastAction("sheets");
    if (prev && (prev.status === "signed" || prev.status === "sent")) return made ?? "a root is on its way";
    if (!this.d.cfg.contract) return made ?? "no seal contract: the sheets are signed and not written on chain";
    const s = this.latest();
    if (!s) return made ?? "no balance sheet to seal yet";
    if (s.tx) return made ?? `hour ${s.hour} is already written`;
    const ref = `seal:${s.hour}`;
    const out = await attempt("sheets", ref, { to: this.d.cfg.contract, abi: ST, functionName: "seal", args: [BigInt(s.hour), s.root as Hex, s.sheets] }, { hour: s.hour, root: s.root, sheets: s.sheets }, ctx.params.maxGasWei);
    if (out.status === "done" && out.hash) this.d.db.q("UPDATE sheets_seals SET tx = ? WHERE hour = ?").run(out.hash, s.hour);
    const words = `write hour ${s.hour}'s root of ${s.sheets} balance sheets`;
    return [made, out.status === "dry" ? `would ${words}` : out.status === "done" ? words : `${words}: ${out.status} (${out.why})`].filter(Boolean).join("; ");
  }

  // ---------- what the site reads ----------

  about(): SheetsAbout {
    const s = this.latest();
    return {
      enabled: this.on(), contract: this.d.cfg.contract, chainId: this.d.chainId, keeper: this.d.keeper(), signer: this.d.signer()?.address ?? null,
      holds: HOLDS.map((k) => ({ key: k, label: LABELS[k] })), owes: OWES.map((k) => ({ key: k, label: LABELS[k] })),
      leaf: "keccak256 of the text factor-sheet-v1|<agent, lowercase>|<hour>|holds:<key=wei,...>|owes:<key=wei,...>, every key always present in the order above",
      tree: "sorted pairs: keccak256(abi.encodePacked(min(a, b), max(a, b))), an odd node at the end of a level goes up as it is; leaves ordered by agent address",
      message: sealMessage(0, "<root>", 0).replace("hour: 0", "hour: <hour>").replace("sheets: 0", "sheets: <count>"),
      latest: s ? this.sealJson(s) : null,
    };
  }

  sealJson(s: SealRow): SealJson {
    return {
      hour: s.hour, from: iso(s.hour * 3_600_000), root: s.root, sheets: s.sheets, signature: s.signature, signer: s.signer,
      tx: s.tx, txUrl: s.tx && this.d.explorer ? `${this.d.explorer.replace(/\/$/, "")}/tx/${s.tx}` : null, onChain: !!s.written_at || !!s.tx, madeAt: iso(s.at),
    };
  }

  sealOf(hour: number): SealJson | null {
    const s = this.seal(hour);
    return s ? this.sealJson(s) : null;
  }

  health(): Record<string, unknown> {
    const s = this.latest();
    return { on: this.on(), contract: this.d.cfg.contract, latestHour: s?.hour ?? null, sheets: s?.sheets ?? 0, written: !!s?.tx };
  }
}

export interface SealJson { hour: number; from: string; root: string; sheets: number; signature: string | null; signer: string | null; tx: string | null; txUrl: string | null; onChain: boolean; madeAt: string }
export interface SheetsAbout {
  enabled: boolean; contract: string | null; chainId: number; keeper: string | null; signer: string | null;
  holds: { key: LineKey; label: string }[]; owes: { key: LineKey; label: string }[];
  leaf: string; tree: string; message: string; latest: SealJson | null;
}
