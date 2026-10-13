// Accounts for people without a wallet, and for agents whose key holds no ETH.
//
// An account is a small contract of its own (contracts/src/FactorAccount.sol). It obeys a key only its owner holds:
// a passkey (the key a phone or a laptop keeps behind a fingerprint, a face or a PIN) or an ordinary wallet key.
// The owner signs what the account should do; anyone may hand that signature to the chain, and whoever does pays
// the gas. This is the part of the engine that does: it takes signed orders, checks them, and sends them from the
// gas wallet.
//
//   POST /v1/accounts            an account for a key (made on the chain by the gas wallet)
//   GET  /v1/accounts/<address>  what is in it, its keys, how many orders it has had paid for today
//   GET  /v1/accounts/by-credential/<id>   the account a passkey belongs to, so a browser finds it again
//   POST /v1/accounts/check      would these calls go through, as this account? Asked before anything is signed
//   POST /v1/accounts/call       a read of the desk, as this account's "node" (a browser here talks to the site only)
//   POST /v1/accounts/relay      a signed order: queued, then sent by the gas wallet
//   GET  /v1/accounts/relay/<id> how it went
//
// What the engine never has: a key of anybody's. It cannot move an account's ETH, change its keys or sign for it.
// The worst it can do is decline to pay for an order, and then the owner (or anyone) sends the same signature
// themselves.
//
// What it pays for, and no more: the desk's own calls, taking ETH out of the account, and the account's own keys.
// Each account has a number of paid orders a day, each caller a number of new accounts a day, and the gas wallet a
// sum it spends on all of this in a day. Past any of them the answer is "not today", and nothing is lost.

import { createHash, randomBytes } from "node:crypto";
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, hashMessage, keccak256, toFunctionSelector, type Abi, type AbiFunction, type Hex } from "viem";
import { factorAccountAbi, factorAccountsAbi, factorDeskAbi } from "./abi/index.js";
import { normalizeAddress } from "./chain/address.js";
import { nodeBusy, reason, revertOf, type Chain, type ChainLog, type Receipt } from "./chain/chain.js";
import type { EngineDb } from "./chain/db.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export interface AccountsConfig {
  /** ACCOUNTS_MODE=on and the maker of accounts is known. Orders are sent only while the engine is live. */
  enabled: boolean;
  factory: string | null; // FACTOR_ACCOUNTS
  newPerCallerDay: number; // ACCOUNTS_NEW_PER_CALLER_DAY
  newPerDay: number; // ACCOUNTS_NEW_DAY
  ordersPerAccountDay: number; // ACCOUNTS_ORDERS_DAY
  gasDayWei: bigint; // ACCOUNTS_GAS_DAY_ETH: what the gas wallet spends on accounts in a day (UTC), at most
  perPass: number; // orders sent in one pass of the engine at most
  maxCalls: number; // calls one order may hold
  orderTtlS: number; // how long an order is good for, from the check
  note: string | null;
}

export function readAccounts(env: Env, problems: string[] = []): AccountsConfig {
  const on = (env.ACCOUNTS_MODE ?? "").trim().toLowerCase() === "on";
  const raw = env.FACTOR_ACCOUNTS?.trim() ?? "";
  const factory = raw ? normalizeAddress(raw) : null;
  if (raw && !factory) problems.push(`FACTOR_ACCOUNTS is not an address: "${raw}"`);
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const v = env[name]?.trim();
    if (!v) return fallback;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}: it is "${v}"`);
      return fallback;
    }
    return Number(v);
  };
  let gasDayWei = 10n ** 16n; // 0.01 ETH
  const g = env.ACCOUNTS_GAS_DAY_ETH?.trim();
  if (g) {
    if (/^\d{1,3}(\.\d{1,18})?$/.test(g)) {
      const [whole, frac = ""] = g.split(".");
      gasDayWei = BigInt(whole!) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
    } else problems.push(`ACCOUNTS_GAS_DAY_ETH must be an amount of ETH like 0.01: it is "${g}"`);
  }
  return {
    enabled: on && !!factory,
    factory,
    newPerCallerDay: int("ACCOUNTS_NEW_PER_CALLER_DAY", 3, 1, 1000),
    newPerDay: int("ACCOUNTS_NEW_DAY", 300, 1, 1_000_000),
    ordersPerAccountDay: int("ACCOUNTS_ORDERS_DAY", 40, 1, 10_000),
    gasDayWei,
    perPass: 8,
    maxCalls: 4,
    orderTtlS: 600,
    note: on && !factory ? "ACCOUNTS_MODE is on and FACTOR_ACCOUNTS is not set: there is nothing to make accounts with (contracts/deploy.sh writes it)." : null,
  };
}

// ---------- keys ----------

export const KIND = { wallet: 1, passkey: 2 } as const;
export interface Key { kind: number; a: Hex; b: Hex }
export interface Call { to: string; value: bigint; data: Hex }

const HEX32 = /^0x[0-9a-f]{64}$/;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const word = (v: unknown): Hex | null => (typeof v === "string" && HEX32.test(v.toLowerCase()) ? (v.toLowerCase() as Hex) : null);

/** The first key of an account, as a caller gave it, or why it is not one. */
export function keyOf(body: Record<string, unknown>): { key: Key; credential: Hex } | string {
  if (body.kind === "wallet") {
    const address = normalizeAddress(body.address);
    if (!address || /^0x0{40}$/.test(address)) return "address is not an address";
    return { key: { kind: KIND.wallet, a: `0x${"0".repeat(24)}${address.slice(2)}` as Hex, b: ZERO32 }, credential: "0x" };
  }
  if (body.kind === "passkey") {
    const x = word(body.x), y = word(body.y);
    if (!x || !y) return "a passkey's public key is x and y, 32 bytes of hex each";
    const credential = typeof body.credential === "string" && /^0x([0-9a-fA-F]{2}){1,1023}$/.test(body.credential) ? (body.credential.toLowerCase() as Hex) : null;
    if (!credential) return "credential is the passkey's own id, as hex";
    return { key: { kind: KIND.passkey, a: x, b: y }, credential };
  }
  return 'kind is "passkey" or "wallet"';
}

// ---------- the books ----------

export interface AccountRow { address: string; kind: number; a: string; b: string; credential: string; created_at: number; caller: string; deployed: number }
export interface RelayRow { id: string; account: string; kind: "create" | "execute"; payload: string; status: "queued" | "sent" | "done" | "failed"; tx_hash: string | null; error: string | null; refused: string | null; gas_wei: string; logs: string | null; deadline: number; created_at: number; updated_at: number; caller: string }

export class AccountStore {
  constructor(private db: EngineDb) {}

  get(address: string): AccountRow | null {
    return (this.db.q("SELECT * FROM accounts WHERE address = ?").get(address) as AccountRow | undefined) ?? null;
  }

  add(address: string, key: Key, credential: string, caller: string): void {
    this.db.q("INSERT OR IGNORE INTO accounts (address, kind, a, b, credential, created_at, caller) VALUES (?, ?, ?, ?, ?, ?, ?)").run(address, key.kind, key.a, key.b, credential, this.db.now(), caller);
    this.db.q("INSERT OR IGNORE INTO account_keys (account, kind, a, b, credential, added_at) VALUES (?, ?, ?, ?, ?, ?)").run(address, key.kind, key.a, key.b, credential, this.db.now());
  }

  /** The chain says the account exists (a log of the maker's, or a receipt of ours). Written whoever made it. */
  seen(address: string, key: Key, credential: string): void {
    this.add(address, key, credential, "");
    this.db.q("UPDATE accounts SET deployed = 1 WHERE address = ?").run(address);
  }

  keys(address: string): { kind: number; a: string; b: string; credential: string }[] {
    return this.db.q("SELECT kind, a, b, credential FROM account_keys WHERE account = ? ORDER BY added_at, rowid").all(address) as { kind: number; a: string; b: string; credential: string }[];
  }

  keyAdded(address: string, key: Key, credential: string): void {
    this.db.q("INSERT OR IGNORE INTO account_keys (account, kind, a, b, credential, added_at) VALUES (?, ?, ?, ?, ?, ?)").run(address, key.kind, key.a, key.b, credential, this.db.now());
  }

  keyRemoved(address: string, key: Pick<Key, "kind" | "a" | "b">): void {
    this.db.q("DELETE FROM account_keys WHERE account = ? AND kind = ? AND a = ? AND b = ?").run(address, key.kind, key.a, key.b);
  }

  byCredential(credential: string): string | null {
    return (this.db.q("SELECT account FROM account_keys WHERE credential = ? ORDER BY added_at LIMIT 1").get(credential) as { account: string } | undefined)?.account ?? null;
  }

  private dayStart(): number {
    const now = this.db.now();
    return now - (now % 86_400_000);
  }

  newToday(caller?: string): number {
    return caller === undefined
      ? (this.db.q("SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ? AND caller != ''").get(this.dayStart()) as { n: number }).n
      : (this.db.q("SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ? AND caller = ?").get(this.dayStart(), caller) as { n: number }).n;
  }

  ordersToday(account: string): number {
    return (this.db.q("SELECT COUNT(*) AS n FROM relays WHERE account = ? AND kind = 'execute' AND created_at >= ? AND status != 'failed'").get(account, this.dayStart()) as { n: number }).n;
  }

  /** What the gas wallet has spent on accounts since midnight UTC, and what the orders on their way could cost. */
  gasToday(): bigint {
    const rows = this.db.q("SELECT gas_wei FROM relays WHERE created_at >= ?").all(this.dayStart()) as { gas_wei: string }[];
    return rows.reduce((n, r) => n + BigInt(r.gas_wei), 0n);
  }

  open(account: string): RelayRow | null {
    return (this.db.q("SELECT * FROM relays WHERE account = ? AND status IN ('queued', 'sent') ORDER BY created_at LIMIT 1").get(account) as RelayRow | undefined) ?? null;
  }

  queue(account: string, kind: "create" | "execute", payload: unknown, deadline: number, caller: string): string {
    const id = `0x${randomBytes(32).toString("hex")}`;
    const now = this.db.now();
    this.db.q("INSERT INTO relays (id, account, kind, payload, status, deadline, created_at, updated_at, caller) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)").run(id, account, kind, JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), deadline, now, now, caller);
    return id;
  }

  queued(limit: number): RelayRow[] {
    return this.db.q("SELECT * FROM relays WHERE status = 'queued' ORDER BY created_at, rowid LIMIT ?").all(limit) as RelayRow[];
  }

  relay(id: string): RelayRow | null {
    return (this.db.q("SELECT * FROM relays WHERE id = ?").get(id) as RelayRow | undefined) ?? null;
  }

  mark(id: string, patch: Partial<Pick<RelayRow, "status" | "tx_hash" | "error" | "refused" | "gas_wei" | "logs">>): void {
    const sets = Object.keys(patch).map((k) => `${k} = ?`);
    this.db.q(`UPDATE relays SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...Object.values(patch), this.db.now(), id);
  }

  totals(): { accounts: number; deployed: number; orders: number; failed: number; waiting: number; gasTodayWei: string } {
    const a = this.db.q("SELECT COUNT(*) AS n, COALESCE(SUM(deployed), 0) AS d FROM accounts").get() as { n: number; d: number };
    const r = this.db.q("SELECT COALESCE(SUM(status = 'done'), 0) AS done, COALESCE(SUM(status = 'failed'), 0) AS failed, COALESCE(SUM(status IN ('queued', 'sent')), 0) AS waiting FROM relays").get() as { done: number; failed: number; waiting: number };
    return { accounts: a.n, deployed: a.d, orders: r.done, failed: r.failed, waiting: r.waiting, gasTodayWei: this.gasToday().toString() };
  }
}

// ---------- what the engine pays for ----------

const DESK = factorDeskAbi as Abi;
const ACCOUNT = factorAccountAbi as Abi;
const FACTORY = factorAccountsAbi as Abi;
const selectorsOf = (abi: Abi, names: string[]): Set<string> => new Set((abi.filter((f) => f.type === "function" && names.includes(f.name)) as AbiFunction[]).map((f) => toFunctionSelector(f)));
// what a customer or an agent does on the desk. Closing a job whose time is up is the engine's own to do.
const DESK_PAID = selectorsOf(DESK, ["register", "addBond", "takeBond", "lock", "draw", "deliver", "decline", "accept", "reject"]);
const ACCOUNT_PAID = selectorsOf(ACCOUNT, ["addKey", "removeKey"]);
const ERRORS = [...DESK, ...ACCOUNT].filter((x) => x.type === "error") as Abi;
const ERC1271_VALID = "0x1626ba7e";

export interface Refused { status: number; error: string; refused?: { name: string; args: string[] } }
const no = (status: number, error: string, refused?: { name: string; args: readonly unknown[] }): Refused => ({ status, error, ...(refused ? { refused: { name: refused.name, args: refused.args.map(String) } } : {}) });

/** The calls of an order as a caller sent them, or why they are not calls. */
export function callsOf(raw: unknown, most: number): Call[] | string {
  if (!Array.isArray(raw) || raw.length < 1) return "calls is a list of at least one call";
  if (raw.length > most) return `an order holds ${most} calls at most`;
  const out: Call[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    const to = normalizeAddress(c?.to);
    if (!to) return "a call's to is not an address";
    const data = typeof c.data === "string" && /^0x([0-9a-fA-F]{2})*$/.test(c.data) && c.data.length <= 2 + 2 * 2048 ? (c.data.toLowerCase() as Hex) : c.data === undefined ? ("0x" as Hex) : null;
    if (data === null) return "a call's data is hex, 2048 bytes at most";
    let value: bigint;
    try {
      value = typeof c.value === "string" && /^\d{1,30}$/.test(c.value) ? BigInt(c.value) : c.value === undefined ? 0n : -1n;
    } catch {
      value = -1n;
    }
    if (value < 0n) return "a call's value is wei, as text";
    out.push({ to, value, data });
  }
  return out;
}

export class Accounts {
  readonly store: AccountStore;
  private addresses = new Map<string, string>();

  constructor(
    readonly cfg: AccountsConfig,
    private db: EngineDb,
    private chain: Chain,
    private desk: string,
    private live: () => boolean, // the engine has a gas wallet and may send
    private kick: () => void, // an order is waiting: do not wait for the next pass
    private log: (line: string) => void,
  ) {
    this.store = new AccountStore(db);
  }

  about(): { enabled: boolean; factory: string | null; ordersPerDay: number } {
    return { enabled: this.cfg.enabled && this.live() && !stopped(this.db, "accounts") && !stopped(this.db, "keeper"), factory: this.cfg.factory, ordersPerDay: this.cfg.ordersPerAccountDay };
  }

  private off(): Refused | null {
    if (!this.cfg.enabled || !this.cfg.factory) return no(503, "accounts are not switched on yet");
    // the owner's switch (./switches.ts): nothing new is taken while it is off. What is in an account stays its
    // owner's, who can send a signed order to the chain without Factor
    if (stopped(this.db, "accounts") || stopped(this.db, "keeper")) return no(503, "accounts are paused for now. Nothing in an account is touched by that");
    if (!this.live()) return no(503, "the engine is not sending transactions right now");
    return null;
  }

  /** What is paid for. Anything else an owner sends from a wallet of their own, added to the account as a key. */
  private allowed(account: string, calls: Call[]): string | null {
    for (const c of calls) {
      const selector = c.data.slice(0, 10);
      if (c.to === this.desk) {
        if (!DESK_PAID.has(selector)) return "Factor pays the gas for hiring, taking and closing jobs on the desk. That call is not one of them.";
      } else if (c.to === account) {
        if (c.value !== 0n || !ACCOUNT_PAID.has(selector)) return "On the account itself, Factor pays for adding and removing keys.";
      } else if (c.data !== "0x") {
        return "Factor pays the gas for the desk's calls and for taking ETH out of the account. Other calls can be sent from a wallet added to the account as a key.";
      } else if (c.value === 0n) {
        return "A payment of nothing is not sent.";
      }
    }
    return null;
  }

  // ---- for the engine's own agents (./house/house.ts): the same road, without the limits meant for strangers ----

  /** Where the account of a key is. */
  addressOfKey(key: Key): Promise<string> {
    return this.addressOf(key);
  }

  /** An account of the engine's own, made by the gas wallet like anybody's. */
  makeOwn(address: string, key: Key): void {
    if (this.store.get(address)) return;
    this.store.add(address, key, "0x", "");
    this.store.queue(address, "create", { key, credential: "0x" }, 0, "");
    this.kick();
  }

  /**
   * An order of one of the engine's own accounts, signed by its key. Null when the account's last order is still
   * on its way; throws what the chain says when the order would not go through.
   */
  async orderAs(account: string, calls: Call[], sign: (typed: ReturnType<typeof orderTypedData>) => Promise<Hex>): Promise<string | null> {
    if (!this.cfg.factory || !this.live()) return null;
    const row = this.store.get(account);
    if (!row?.deployed || this.store.open(account)) return null;
    const [nonce, head, chainId] = await Promise.all([this.chain.read<bigint>({ to: account, abi: ACCOUNT, functionName: "nonce" }), this.chain.head(), this.chain.chainId()]);
    const deadline = head.timestamp + this.cfg.orderTtlS;
    const signature = await sign(orderTypedData(account, chainId, calls, Number(nonce), deadline));
    await this.chain.simulate(executeCall(account, calls, deadline, signature), this.sender());
    const id = this.store.queue(account, "execute", { calls, deadline, signature }, deadline, "");
    this.kick();
    return id;
  }

  private async addressOf(key: Key): Promise<string> {
    const id = `${key.kind}:${key.a}:${key.b}`;
    let at = this.addresses.get(id);
    if (!at) {
      at = normalizeAddress(await this.chain.read<string>({ to: this.cfg.factory!, abi: FACTORY, functionName: "addressOf", args: [key] }))!;
      this.addresses.set(id, at);
      if (this.addresses.size > 5000) this.addresses.delete(this.addresses.keys().next().value!);
    }
    return at;
  }

  /**
   * Who is asking, as it is written down: not their address on the network but a mark made from it and today's
   * date. Enough to count how many accounts came from one place today, and nothing that says where anybody was.
   */
  private mark(caller: string): string {
    return createHash("sha256").update(`${caller}|${new Date(this.db.now()).toISOString().slice(0, 10)}`).digest("hex").slice(0, 20);
  }

  /** An account for a key. The same key is always the same account: asked twice, it is found, not made again. */
  async create(body: Record<string, unknown>, from: string): Promise<{ address: string; deployed: boolean; relay: string | null } | Refused> {
    const off = this.off();
    if (off) return off;
    const caller = this.mark(from);
    const k = keyOf(body);
    if (typeof k === "string") return no(400, k);
    const address = await this.addressOf(k.key);
    const had = this.store.get(address);
    if (had) return { address, deployed: had.deployed === 1, relay: this.store.open(address)?.id ?? null };
    // made by somebody else already (the maker is open to anyone): it is taken down as it is
    if ((await this.chain.code(address)) !== "0x") {
      this.store.seen(address, k.key, k.credential);
      return { address, deployed: true, relay: null };
    }
    if (this.store.newToday(caller) >= this.cfg.newPerCallerDay) return no(429, `${this.cfg.newPerCallerDay} new accounts a day can be made from one place. Try again tomorrow.`);
    if (this.store.newToday() >= this.cfg.newPerDay || this.store.gasToday() >= this.cfg.gasDayWei) return no(429, "No more new accounts today. Try again tomorrow, or use a wallet.");
    this.store.add(address, k.key, k.credential, caller);
    const relay = this.store.queue(address, "create", { key: k.key, credential: k.credential }, 0, caller);
    this.kick();
    return { address, deployed: false, relay };
  }

  /** What an account holds and obeys. Any address may be asked about: one that is no account says so. */
  async account(address: string): Promise<Record<string, unknown> | null> {
    const row = this.store.get(address);
    if (!row) return null;
    const [balance, nonce] = await Promise.all([
      this.chain.balance(address),
      row.deployed ? this.chain.read<bigint>({ to: address, abi: ACCOUNT, functionName: "nonce" }).catch(() => 0n) : Promise.resolve(0n),
    ]);
    const open = this.store.open(address);
    return {
      address, deployed: row.deployed === 1, balanceWei: balance.toString(), nonce: Number(nonce),
      keys: this.store.keys(address).map((k) => (k.kind === KIND.wallet ? { kind: "wallet", address: `0x${k.a.slice(26)}` } : { kind: "passkey", x: k.a, y: k.b, credential: k.credential })),
      ordersToday: this.store.ordersToday(address), ordersPerDay: this.cfg.ordersPerAccountDay, busy: open ? open.id : null,
    };
  }

  /** Would these calls go through, made by this account right now? Asked before the owner is shown anything to sign. */
  async check(body: Record<string, unknown>): Promise<{ ok: true; nonce: number; deadline: number; chainId: number } | Refused> {
    const off = this.off();
    if (off) return off;
    const account = normalizeAddress(body.account);
    const row = account ? this.store.get(account) : null;
    if (!account || !row) return no(404, "that is not an account made here");
    const calls = callsOf(body.calls, this.cfg.maxCalls);
    if (typeof calls === "string") return no(400, calls);
    const why = this.allowed(account, calls);
    if (why) return no(400, why);
    if (!row.deployed) return no(409, "the account is still being made: a few seconds more");
    if (this.store.open(account)) return no(409, "your last action is still on its way: a few seconds more");
    if (this.store.ordersToday(account) >= this.cfg.ordersPerAccountDay) return no(429, `Factor pays the gas for ${this.cfg.ordersPerAccountDay} actions a day on one account. More can be sent from a wallet added to it as a key.`);
    if (this.store.gasToday() >= this.cfg.gasDayWei) return no(429, "Factor has paid all the gas it pays for accounts today. Try again tomorrow, or send it from a wallet added to the account as a key.");
    // each call, as the account would make it (an order of several is tried whole once it is signed)
    for (const c of calls) {
      const refused = await this.tried(account, c);
      if (refused) return refused;
    }
    const [nonce, head, chainId] = await Promise.all([this.chain.read<bigint>({ to: account, abi: ACCOUNT, functionName: "nonce" }), this.chain.head(), this.chain.chainId()]);
    return { ok: true, nonce: Number(nonce), deadline: head.timestamp + this.cfg.orderTtlS, chainId };
  }

  /** A read of the desk, for a browser that has no node of its own to ask. Reads only: nothing is sent. */
  async call(body: Record<string, unknown>): Promise<{ result: Hex } | Refused> {
    const to = normalizeAddress(body.to);
    const from = normalizeAddress(body.from) ?? "0x0000000000000000000000000000000000000000";
    const data = typeof body.data === "string" && /^0x([0-9a-fA-F]{2})*$/.test(body.data) && body.data.length <= 2 + 2 * 4096 ? (body.data as Hex) : null;
    if (!to || data === null) return no(400, "to is an address and data is hex");
    if (to !== this.desk && !this.store.get(to) && to !== this.cfg.factory) return no(400, "only the desk and accounts are read here");
    if (body.code === true) return { result: (await this.chain.code(to)) as Hex };
    let value = 0n;
    if (typeof body.value === "string" && /^\d{1,30}$/.test(body.value)) value = BigInt(body.value);
    try {
      return { result: await this.chain.call({ from, to, data, value }, ERRORS) };
    } catch (e) {
      const refused = await this.whyNot(from, value, e);
      if (refused) return refused;
      throw e;
    }
  }

  /** One call, as the account would make it right now: null when it would go through, or why it would not. */
  private async tried(account: string, c: Call): Promise<Refused | null> {
    try {
      await this.chain.call({ from: account, to: c.to, data: c.data, value: c.value }, ERRORS);
      return null;
    } catch (e) {
      const refused = await this.whyNot(account, c.value, e);
      if (refused) return refused;
      throw e;
    }
  }

  /** A call that would not go through, as an answer: the contract's own reason, or the account being short of ETH. */
  private async whyNot(from: string, value: bigint, e: unknown): Promise<Refused | null> {
    const r = revertOf(e);
    if (r) return no(400, reason(e), r);
    const said = `${(e as { shortMessage?: string }).shortMessage ?? ""} ${(e as { details?: string }).details ?? ""} ${(e as Error).message ?? ""}`;
    if (/insufficient funds|exceeds the balance|insufficient balance|out of funds/i.test(said)) return no(400, "the account does not hold enough ETH for that", { name: "AccountShort", args: [(await this.chain.balance(from)).toString(), value.toString()] });
    return null;
  }

  /** A signed order. Tried whole before it is queued, so what is queued is what the chain would take right now. */
  async relay(body: Record<string, unknown>, from: string): Promise<{ id: string } | Refused> {
    const off = this.off();
    if (off) return off;
    const caller = this.mark(from);
    const account = normalizeAddress(body.account);
    const row = account ? this.store.get(account) : null;
    if (!account || !row) return no(404, "that is not an account made here");
    const calls = callsOf(body.calls, this.cfg.maxCalls);
    if (typeof calls === "string") return no(400, calls);
    const why = this.allowed(account, calls);
    if (why) return no(400, why);
    const deadline = typeof body.deadline === "number" && Number.isSafeInteger(body.deadline) ? body.deadline : 0;
    const head = await this.chain.head();
    if (deadline <= head.timestamp || deadline > head.timestamp + 3600) return no(400, "the order's deadline is past, or more than an hour away: sign it again");
    const signature = typeof body.signature === "string" && /^0x([0-9a-fA-F]{2}){65,2048}$/.test(body.signature) ? (body.signature as Hex) : null;
    if (!signature) return no(400, "signature is hex");
    if (!row.deployed) return no(409, "the account is still being made: a few seconds more");
    if (this.store.open(account)) return no(409, "your last action is still on its way: a few seconds more");
    if (this.store.ordersToday(account) >= this.cfg.ordersPerAccountDay) return no(429, `Factor pays the gas for ${this.cfg.ordersPerAccountDay} actions a day on one account. More can be sent from a wallet added to it as a key.`);
    if (this.store.gasToday() >= this.cfg.gasDayWei) return no(429, "Factor has paid all the gas it pays for accounts today. Try again tomorrow, or send it from a wallet added to the account as a key.");
    try {
      await this.chain.simulate(executeCall(account, calls, deadline, signature), this.sender());
    } catch (e) {
      const r = revertOf(e);
      if (!r) throw e;
      if (r.name === "BadSignature") return no(401, "the signature is not one of this account's keys', or it is for another order", r);
      return no(400, reason(e), r);
    }
    const id = this.store.queue(account, "execute", { calls, deadline, signature }, deadline, caller);
    this.kick();
    return { id };
  }

  private sender(): string {
    return this.cfg.factory!; // any address will do to try an order as: who sends it does not matter to the account
  }

  status(id: string): Record<string, unknown> | null {
    const r = /^0x[0-9a-f]{64}$/.test(id) ? this.store.relay(id) : null;
    if (!r) return null;
    return {
      id: r.id, account: r.account, kind: r.kind, status: r.status, hash: r.tx_hash, error: r.error,
      ...(r.refused ? { refused: JSON.parse(r.refused) as unknown } : {}),
      ...(r.status === "done" && r.logs ? { logs: JSON.parse(r.logs) as unknown } : {}),
    };
  }

  byCredential(raw: string): { address: string } | null {
    if (!/^0x([0-9a-f]{2}){1,1023}$/.test(raw)) return null;
    const address = this.store.byCredential(raw);
    return address ? { address } : null;
  }

  /**
   * Whether `address` signed `message`: a wallet by its own signature, an account by asking the account itself
   * (ERC-1271), which answers for whichever of its keys signed. A node that does not answer is not a no: it throws.
   */
  async signed(address: string, message: string, signature: unknown): Promise<boolean> {
    if (typeof signature !== "string" || !/^0x([0-9a-fA-F]{2}){65,2048}$/.test(signature)) return false;
    if (!this.store.get(address)) return false;
    try {
      const answer = await this.chain.read<string>({ to: address, abi: ACCOUNT, functionName: "isValidSignature", args: [hashMessage(message), signature] });
      return answer === ERC1271_VALID;
    } catch (e) {
      if (nodeBusy(e)) throw e;
      return false;
    }
  }
}

export const createCall = (factory: string, key: Key, credential: string) => ({ to: factory, abi: FACTORY, functionName: "create", args: [key, credential] });
export const executeCall = (account: string, calls: Call[], deadline: number, signature: string) => ({ to: account, abi: ACCOUNT, functionName: "execute", args: [calls.map((c) => ({ to: c.to, value: c.value, data: c.data })), BigInt(deadline), signature] });

/** The call a queued order is, as the gas wallet will send it. */
export function callOfRelay(r: RelayRow, factory: string) {
  const p = JSON.parse(r.payload) as { key?: Key; credential?: string; calls?: { to: string; value: string; data: Hex }[]; deadline?: number; signature?: string };
  if (r.kind === "create") return createCall(factory, p.key!, p.credential ?? "0x");
  return executeCall(r.account, p.calls!.map((c) => ({ to: c.to, value: BigInt(c.value), data: c.data })), p.deadline!, p.signature!);
}

/** What a mined order changes in the books: the account exists, a key came or went, what it cost. */
export function landedRelay(store: AccountStore, r: RelayRow, receipt: Receipt, hash: string): void {
  const cost = (receipt.gasUsed * (receipt.gasPrice ?? 0n)).toString();
  if (!receipt.ok) {
    store.mark(r.id, { status: "failed", tx_hash: hash, gas_wei: cost, error: "the chain refused it when it was sent: nothing changed" });
    return;
  }
  if (r.kind === "create") {
    const row = store.get(r.account);
    if (row) store.seen(r.account, { kind: row.kind, a: row.a as Hex, b: row.b as Hex }, row.credential);
  }
  for (const l of receipt.logs) {
    if (l.address !== r.account) continue;
    const e = keyEvent(l);
    if (e?.name === "KeyAdded") store.keyAdded(r.account, e.key, e.credential);
    if (e?.name === "KeyRemoved") {
      const gone = store.keys(r.account).find((k) => keyId(k as Key) === e.id);
      if (gone) store.keyRemoved(r.account, gone as Key);
    }
  }
  store.mark(r.id, { status: "done", tx_hash: hash, gas_wei: cost, logs: JSON.stringify(receipt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data }))) });
}

export const keyId = (k: Pick<Key, "kind" | "a" | "b">): Hex => keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }], [k.kind, k.a as Hex, k.b as Hex]));

function keyEvent(l: ChainLog): { name: "KeyAdded"; key: Key; credential: string; id: Hex } | { name: "KeyRemoved"; id: Hex } | null {
  try {
    const d = decodeEventLog({ abi: ACCOUNT, topics: l.topics as [Hex, ...Hex[]], data: l.data }) as unknown as { eventName: string; args: Record<string, unknown> };
    if (d.eventName === "KeyAdded") return { name: "KeyAdded", id: d.args.id as Hex, key: { kind: Number(d.args.kind), a: d.args.a as Hex, b: d.args.b as Hex }, credential: String(d.args.credential) };
    if (d.eventName === "KeyRemoved") return { name: "KeyRemoved", id: d.args.id as Hex };
  } catch {
    // not one of the account's own logs
  }
  return null;
}

/**
 * What a key signs for an order, as EIP-712 typed data: the same on the site, in the kit and in the contract
 * (FactorAccount.digest). A wallet shows its owner the calls; a passkey signs the hash of it.
 */
export function orderTypedData(account: string, chainId: number, calls: Call[], nonce: number, deadline: number) {
  return {
    domain: { name: "Factor Account", version: "1", chainId, verifyingContract: account as Hex },
    types: {
      Execute: [{ name: "calls", type: "Call[]" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
      Call: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }],
    },
    primaryType: "Execute" as const,
    message: { calls: calls.map((c) => ({ to: c.to as Hex, value: c.value, data: c.data })), nonce: BigInt(nonce), deadline: BigInt(deadline) },
  };
}

// used by the tests and the scripts: an order's calls, as data
export const deskCall = (desk: string, functionName: string, args: readonly unknown[] = [], value = 0n): Call => ({ to: desk, value, data: encodeFunctionData({ abi: DESK, functionName, args } as never) });
export const decodeDeskCall = (data: Hex) => decodeFunctionData({ abi: DESK, data });
