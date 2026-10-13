// The engine's database: one SQLite file. Everything that is an amount goes in and comes out as wei in text;
// everything that is an address is lowercase. Times are unix seconds, the chain's own clock, unless a column says ms.

import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

/** The engine's one file (or ":memory:" in a test), set up the way every table here expects. */
export function open(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

const SCHEMA = `
-- Small facts kept between passes: the last reading of the chain, switches.
CREATE TABLE IF NOT EXISTS engine_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
-- How far each watcher has read. The next pass starts one block further.
CREATE TABLE IF NOT EXISTS engine_cursors (watcher TEXT PRIMARY KEY, block INTEGER NOT NULL, updated_at INTEGER NOT NULL);
-- The hash of the block each pass ended on, the newest few kept. A hash that no longer matches the chain is a
-- reorg: the watchers go back to the newest one that still does.
CREATE TABLE IF NOT EXISTS engine_blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL);
-- One attempt at an action at a time.
CREATE TABLE IF NOT EXISTS engine_locks (name TEXT PRIMARY KEY, holder TEXT NOT NULL, taken_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
-- Everything the engine sent, would have sent (dry), or could not send: what, why, and how it ended.
CREATE TABLE IF NOT EXISTS engine_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                -- sweep, claim_token, burn, settle_job, refund_job, collect, return_compute, unstick
  ref TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL,                -- dry or live
  status TEXT NOT NULL,              -- dry, signed, sent, done, failed, replaced
  detail TEXT NOT NULL DEFAULT '{}', -- JSON: the trigger and the numbers (amounts in wei, as text)
  tx_hash TEXT,
  nonce INTEGER,
  gas_limit TEXT,
  max_fee_wei TEXT,
  gas_used TEXT,
  block INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,       -- ms
  updated_at INTEGER NOT NULL        -- ms
);
CREATE INDEX IF NOT EXISTS engine_actions_kind ON engine_actions (kind, id);
CREATE INDEX IF NOT EXISTS engine_actions_open ON engine_actions (status) WHERE status IN ('signed', 'sent');
-- Every log of the three contracts and the token's mint, once: the transaction and the log's place in it are the
-- key, so a stretch of blocks read twice writes nothing twice.
CREATE TABLE IF NOT EXISTS chain_events (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block INTEGER NOT NULL,
  at INTEGER NOT NULL,
  contract TEXT NOT NULL,            -- splitter, burnPot, desk, token
  event TEXT NOT NULL,
  args TEXT NOT NULL,                -- JSON, numbers as text
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_events_block ON chain_events (block);
CREATE INDEX IF NOT EXISTS chain_events_kind ON chain_events (contract, event);
-- The splitter: each split and where its three parts went.
CREATE TABLE IF NOT EXISTS chain_splits (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block INTEGER NOT NULL,
  at INTEGER NOT NULL,
  amount TEXT NOT NULL,
  to_admin TEXT NOT NULL,
  to_burn TEXT NOT NULL,
  to_pool TEXT NOT NULL DEFAULT '0',
  admin_pushed INTEGER NOT NULL,
  burn_pushed INTEGER NOT NULL,
  pool_pushed INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_splits_block ON chain_splits (block);
-- The burn pot: each burn, with the ETH price when the engine first saw it.
CREATE TABLE IF NOT EXISTS chain_burns (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block INTEGER NOT NULL,
  at INTEGER NOT NULL,
  n INTEGER NOT NULL,                -- the pot's own count
  caller TEXT NOT NULL,
  eth_in TEXT NOT NULL,
  tokens_burned TEXT NOT NULL,
  via_curve INTEGER NOT NULL,
  eth_usd8 TEXT,                     -- null when no price was known
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_burns_block ON chain_burns (block);
-- The ledger the site prints: one line for each thing that happened on the desk, to the pool or in the burn pot.
-- A log can make more than one line (a refund that left an advance unpaid makes two), so the kind is in the key.
CREATE TABLE IF NOT EXISTS ledger (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- locked, advanced, delivered, settled, half, declined, refunded, not_repaid, burned, bond, pool_in
  block INTEGER NOT NULL,
  at INTEGER NOT NULL,
  job_id INTEGER,
  agent TEXT,
  amount TEXT NOT NULL,              -- wei, or tokens for a burn
  note TEXT NOT NULL DEFAULT '',     -- what the line's wording needs: the advance's kind, who filled the pool
  UNIQUE (tx_hash, log_index, kind)
);
CREATE INDEX IF NOT EXISTS ledger_block ON ledger (block);
CREATE INDEX IF NOT EXISTS ledger_kind ON ledger (kind, n);
CREATE INDEX IF NOT EXISTS ledger_job ON ledger (job_id, n);
CREATE INDEX IF NOT EXISTS ledger_agent ON ledger (agent, n);
-- Each draw of an advance.
CREATE TABLE IF NOT EXISTS desk_advances (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block INTEGER NOT NULL,
  at INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  kind INTEGER NOT NULL,             -- 0 early, 1 pool, 2 compute
  amount TEXT NOT NULL,
  fee TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS desk_advances_block ON desk_advances (block);
CREATE INDEX IF NOT EXISTS desk_advances_job ON desk_advances (job_id);
-- A job as the desk holds it. What it IS is read from the desk itself (job(id)) whenever a log says it changed:
-- dirty marks a row that is waiting to be read. What it was PAID when it closed comes from the closing log.
CREATE TABLE IF NOT EXISTS desk_jobs (
  id INTEGER PRIMARY KEY,
  dirty INTEGER NOT NULL DEFAULT 1,
  locked_block INTEGER NOT NULL,
  locked_at INTEGER NOT NULL,
  locked_tx TEXT NOT NULL DEFAULT '',
  customer TEXT NOT NULL,
  agent TEXT NOT NULL,
  price TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  allow_early INTEGER NOT NULL,
  state INTEGER NOT NULL DEFAULT 1,  -- the desk's own numbers: 1 locked, 2 advanced, 3 delivered, 4 settled, 5 settled at half, 6 declined, 7 refunded
  early TEXT NOT NULL DEFAULT '0',
  from_pool TEXT NOT NULL DEFAULT '0',
  delivered_at INTEGER NOT NULL DEFAULT 0,
  late INTEGER NOT NULL DEFAULT 0,
  proof TEXT NOT NULL DEFAULT '',
  closed_at INTEGER NOT NULL DEFAULT 0,
  paid TEXT NOT NULL DEFAULT '0',    -- to the agent when it closed
  back TEXT NOT NULL DEFAULT '0',    -- to the customer when it closed
  fee TEXT NOT NULL DEFAULT '0',     -- the job fee it paid into the pool
  not_repaid TEXT NOT NULL DEFAULT '0'
);
CREATE INDEX IF NOT EXISTS desk_jobs_agent ON desk_jobs (agent, id);
CREATE INDEX IF NOT EXISTS desk_jobs_customer ON desk_jobs (customer, id);
CREATE INDEX IF NOT EXISTS desk_jobs_state ON desk_jobs (state);
CREATE INDEX IF NOT EXISTS desk_jobs_dirty ON desk_jobs (dirty) WHERE dirty = 1;
-- An agent as the desk holds it: its record, read from the desk (agent(address)) whenever a log says it changed.
CREATE TABLE IF NOT EXISTS desk_agents (
  address TEXT PRIMARY KEY,
  dirty INTEGER NOT NULL DEFAULT 1,
  registered_block INTEGER NOT NULL,
  registered_at INTEGER NOT NULL,
  record TEXT NOT NULL DEFAULT '{}'  -- JSON of the desk's own record, numbers as text
);
CREATE INDEX IF NOT EXISTS desk_agents_dirty ON desk_agents (dirty) WHERE dirty = 1;
-- What the chain does not hold: the name an agent goes by and what it does, and what a job is about. Each is
-- written by its own wallet's signature (see profiles.ts) and is never touched by a reindex.
CREATE TABLE IF NOT EXISTS agent_profiles (
  address TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,     -- the name in lowercase: one agent to a name
  does TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);
-- Compute credit (../compute.ts). A lot is one compute advance: the ETH the gateway was paid, what that was in dollars,
-- and how much of it has been spent on model calls. Lots are never taken back by a reindex: what was spent is real.
CREATE TABLE IF NOT EXISTS compute_lots (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block INTEGER NOT NULL,
  at INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  wei TEXT NOT NULL,                 -- what reached the gateway: the advance less its fee
  usd_micro INTEGER,                 -- millionths of a dollar; null until an ETH price is known
  spent_micro INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open',-- open: the job is not closed. kept: the agent's own. closed: all taken back
  back_wei TEXT NOT NULL DEFAULT '0',-- unspent ETH the pool took back when the job was refunded at a loss
  back_tx TEXT,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS compute_lots_agent ON compute_lots (agent, block);
CREATE INDEX IF NOT EXISTS compute_lots_job ON compute_lots (job_id);
-- Each model call: who, which model, how many tokens, what it cost. Never what was asked or answered.
CREATE TABLE IF NOT EXISTS compute_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,               -- ms
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cost_micro INTEGER NOT NULL,
  unpaid_micro INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL,
  request_id TEXT NOT NULL DEFAULT '',
  ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS compute_usage_agent ON compute_usage (agent, id);
-- The keys agents call the gateway with: only their hashes.
CREATE TABLE IF NOT EXISTS compute_keys (hash TEXT PRIMARY KEY, agent TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS compute_keys_agent ON compute_keys (agent, created_at);
-- Accounts for people without a wallet (../accounts.ts). The engine's own notes, not the chain's: an account and its
-- first key as it was asked for, and whether the chain has it yet. Never taken back by a reindex.
CREATE TABLE IF NOT EXISTS accounts (
  address TEXT PRIMARY KEY,
  kind INTEGER NOT NULL,             -- 1 a wallet's address, 2 a passkey
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  credential TEXT NOT NULL DEFAULT '0x', -- a passkey's own id, so a browser finds its account again
  created_at INTEGER NOT NULL,       -- ms
  caller TEXT NOT NULL DEFAULT '',   -- who asked for it, for the limit on new accounts; empty when the chain told us
  deployed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS accounts_created ON accounts (created_at);
CREATE TABLE IF NOT EXISTS account_keys (
  account TEXT NOT NULL,
  kind INTEGER NOT NULL,
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  credential TEXT NOT NULL DEFAULT '0x',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (account, kind, a, b)
);
CREATE INDEX IF NOT EXISTS account_keys_credential ON account_keys (credential);
-- Orders the gas wallet sends for accounts: making one, or carrying out what its owner signed.
CREATE TABLE IF NOT EXISTS relays (
  id TEXT PRIMARY KEY,               -- 32 random bytes: what the caller asks after
  account TEXT NOT NULL,
  kind TEXT NOT NULL,                -- create | execute
  payload TEXT NOT NULL,             -- JSON: the key, or the calls with their deadline and signature
  status TEXT NOT NULL,              -- queued | sent | done | failed
  tx_hash TEXT,
  error TEXT,
  refused TEXT,                      -- JSON: the contract's own error, by name, when that is why
  gas_wei TEXT NOT NULL DEFAULT '0', -- what it cost the gas wallet
  logs TEXT,                         -- JSON: the logs of the transaction, once it is mined
  deadline INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  caller TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS relays_status ON relays (status, created_at);
CREATE INDEX IF NOT EXISTS relays_account ON relays (account, created_at);
-- What a customer wants done, in their own words and at length: signed by the wallet that locked the job, like its
-- title. Shown to everybody on the job's page, and what an agent works from.
CREATE TABLE IF NOT EXISTS job_briefs (
  job_id INTEGER PRIMARY KEY,
  brief TEXT NOT NULL,
  by TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);
-- The work itself, when its agent chose to show it. It is taken only when its fingerprint is the proof the desk
-- holds for the job, so what is shown here is what was delivered on the chain.
CREATE TABLE IF NOT EXISTS job_deliveries (
  job_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                -- text | html
  body TEXT NOT NULL,
  at INTEGER NOT NULL,               -- ms
  hidden INTEGER NOT NULL DEFAULT 0
);
-- The house agents' own notes on the jobs locked for them (../house/house.ts): where each one stands, the work once
-- it is done (so a restart never pays for it twice), what it cost, and why one was declined.
CREATE TABLE IF NOT EXISTS house_jobs (
  job_id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  state TEXT NOT NULL,               -- worked | delivering | delivered | declining | declined | gave_up
  kind TEXT NOT NULL DEFAULT 'text',
  work TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',     -- said on the job's page: why it was declined
  relay TEXT,                        -- the order that delivers or declines it
  tries INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,-- ms: not looked at again before
  cost_micro INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS job_titles (
  job_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  by TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);
`;

export type ActionKind = "sweep" | "claim_token" | "burn" | "settle_job" | "refund_job" | "collect" | "return_compute" | "relay" | "unstick";
export type ActionStatus = "dry" | "signed" | "sent" | "done" | "failed" | "replaced";

export interface ActionRow {
  id: number;
  kind: ActionKind;
  ref: string;
  mode: "dry" | "live";
  status: ActionStatus;
  detail: string;
  tx_hash: string | null;
  nonce: number | null;
  gas_limit: string | null;
  max_fee_wei: string | null;
  gas_used: string | null;
  block: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  tx_hash: string;
  log_index: number;
  block: number;
  at: number;
  contract: string;
  event: string;
  args: Record<string, string | boolean>;
}

// The tables a stretch of blocks writes to, all keyed by block: what a reorg or a reindex takes back.
const BY_BLOCK = ["chain_events", "chain_splits", "chain_burns", "ledger", "desk_advances"];

export class EngineDb {
  readonly holder = randomBytes(6).toString("hex"); // this process, for the locks
  private statements = new Map<string, Database.Statement>();

  constructor(
    readonly db: Database.Database,
    readonly now: () => number = Date.now,
  ) {
    db.exec(SCHEMA);
  }

  private sql(text: string): Database.Statement {
    let s = this.statements.get(text);
    if (!s) this.statements.set(text, (s = this.db.prepare(text)));
    return s;
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- small facts ----

  get(key: string): string | null {
    return (this.sql("SELECT value FROM engine_state WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  }

  set(key: string, value: string): void {
    this.sql("INSERT INTO engine_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, value, this.now());
  }

  unset(key: string): void {
    this.sql("DELETE FROM engine_state WHERE key = ?").run(key);
  }

  getJson<T>(key: string): T | null {
    const raw = this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }

  // ---- cursors and the way back after a reorg ----

  cursor(watcher: string): bigint | null {
    const row = this.sql("SELECT block FROM engine_cursors WHERE watcher = ?").get(watcher) as { block: number } | undefined;
    return row ? BigInt(row.block) : null;
  }

  cursors(): { watcher: string; block: number; updated_at: number }[] {
    return this.sql("SELECT watcher, block, updated_at FROM engine_cursors ORDER BY watcher").all() as { watcher: string; block: number; updated_at: number }[];
  }

  setCursor(watcher: string, block: bigint): void {
    this.sql("INSERT INTO engine_cursors (watcher, block, updated_at) VALUES (?, ?, ?) ON CONFLICT(watcher) DO UPDATE SET block = excluded.block, updated_at = excluded.updated_at").run(watcher, Number(block), this.now());
  }

  checkpoint(number: bigint, hash: string, keep: number): void {
    this.sql("INSERT INTO engine_blocks (number, hash) VALUES (?, ?) ON CONFLICT(number) DO UPDATE SET hash = excluded.hash").run(Number(number), hash);
    this.sql("DELETE FROM engine_blocks WHERE number NOT IN (SELECT number FROM engine_blocks ORDER BY number DESC LIMIT ?)").run(keep);
  }

  // Newest first.
  checkpoints(): { number: bigint; hash: string }[] {
    return (this.sql("SELECT number, hash FROM engine_blocks ORDER BY number DESC").all() as { number: number; hash: string }[]).map((r) => ({ number: BigInt(r.number), hash: r.hash }));
  }

  // Take back everything read above `block`: the rows, the checkpoints, and every cursor that had gone further.
  // Returns how many rows went.
  rewind(block: bigint): number {
    const n = Number(block);
    return this.tx(() => {
      let gone = 0;
      for (const t of BY_BLOCK) gone += this.db.prepare(`DELETE FROM ${t} WHERE block > ?`).run(n).changes;
      // jobs and agents that first appeared above the block are gone; every other one is read from the desk again
      gone += this.sql("DELETE FROM desk_jobs WHERE locked_block > ?").run(n).changes;
      gone += this.sql("DELETE FROM desk_agents WHERE registered_block > ?").run(n).changes;
      this.sql("UPDATE desk_jobs SET dirty = 1").run();
      this.sql("UPDATE desk_agents SET dirty = 1").run();
      this.sql("DELETE FROM engine_blocks WHERE number > ?").run(n);
      this.sql("UPDATE engine_cursors SET block = ?, updated_at = ? WHERE block > ?").run(n, this.now(), n);
      return gone;
    });
  }

  // Forget everything the chain can give back, so it is read again from the deploy block. What it cannot give
  // back stays: the record of what the engine did, and the names and titles people signed.
  forgetChain(): void {
    this.tx(() => {
      for (const t of [...BY_BLOCK, "desk_jobs", "desk_agents"]) this.db.prepare(`DELETE FROM ${t}`).run();
      // the ledger's lines are numbered from one again, so the chain read a second time gives each line its old number
      this.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'ledger'").run();
      this.db.prepare("DELETE FROM engine_cursors").run();
      this.db.prepare("DELETE FROM engine_blocks").run();
    });
  }

  // ---- one attempt at a time ----

  // True when the lock is ours now. A lock nobody released (the process died holding it) is free again once it
  // has run out.
  lock(name: string, ms: number): boolean {
    const at = this.now();
    return this.tx(() => {
      const held = this.sql("SELECT holder, expires_at FROM engine_locks WHERE name = ?").get(name) as { holder: string; expires_at: number } | undefined;
      if (held && held.expires_at > at) return false;
      this.sql("INSERT INTO engine_locks (name, holder, taken_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, taken_at = excluded.taken_at, expires_at = excluded.expires_at").run(name, this.holder, at, at + ms);
      return true;
    });
  }

  unlock(name: string): void {
    this.sql("DELETE FROM engine_locks WHERE name = ? AND holder = ?").run(name, this.holder);
  }

  locks(): { name: string; holder: string; taken_at: number; expires_at: number }[] {
    return this.sql("SELECT name, holder, taken_at, expires_at FROM engine_locks").all() as { name: string; holder: string; taken_at: number; expires_at: number }[];
  }

  // ---- what the engine did ----

  addAction(a: { kind: ActionKind; ref?: string; mode: "dry" | "live"; status: ActionStatus; detail?: unknown; error?: string | null; nonce?: number; gasLimit?: bigint; maxFeeWei?: bigint }): number {
    const at = this.now();
    const r = this.sql(
      "INSERT INTO engine_actions (kind, ref, mode, status, detail, error, nonce, gas_limit, max_fee_wei, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(a.kind, a.ref ?? "", a.mode, a.status, JSON.stringify(a.detail ?? {}), a.error ?? null, a.nonce ?? null, a.gasLimit?.toString() ?? null, a.maxFeeWei?.toString() ?? null, at, at);
    return Number(r.lastInsertRowid);
  }

  updateAction(id: number, f: { status?: ActionStatus; txHash?: string; gasUsed?: bigint; block?: bigint; error?: string | null; detail?: unknown }): void {
    const row = this.action(id);
    if (!row) return;
    this.sql("UPDATE engine_actions SET status = ?, tx_hash = ?, gas_used = ?, block = ?, error = ?, detail = ?, updated_at = ? WHERE id = ?").run(
      f.status ?? row.status,
      f.txHash ?? row.tx_hash,
      f.gasUsed?.toString() ?? row.gas_used,
      f.block !== undefined ? Number(f.block) : row.block,
      f.error === undefined ? row.error : f.error,
      f.detail === undefined ? row.detail : JSON.stringify(f.detail),
      this.now(),
      id,
    );
  }

  action(id: number): ActionRow | null {
    return (this.sql("SELECT * FROM engine_actions WHERE id = ?").get(id) as ActionRow | undefined) ?? null;
  }

  // Signed or sent and not yet known to have landed, oldest first.
  openActions(): ActionRow[] {
    return this.sql("SELECT * FROM engine_actions WHERE status IN ('signed', 'sent') ORDER BY id").all() as ActionRow[];
  }

  lastAction(kind: ActionKind, ref?: string): ActionRow | null {
    if (ref === undefined) return (this.sql("SELECT * FROM engine_actions WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind) as ActionRow | undefined) ?? null;
    return (this.sql("SELECT * FROM engine_actions WHERE kind = ? AND ref = ? ORDER BY id DESC LIMIT 1").get(kind, ref) as ActionRow | undefined) ?? null;
  }

  // How many times in a row the newest attempts at one thing failed.
  failsInARow(kind: ActionKind, ref: string): number {
    const rows = this.sql("SELECT status FROM engine_actions WHERE kind = ? AND ref = ? ORDER BY id DESC LIMIT 16").all(kind, ref) as { status: string }[];
    let n = 0;
    while (n < rows.length && rows[n].status === "failed") n++;
    return n;
  }

  actions(kind?: ActionKind, limit = 50): ActionRow[] {
    if (kind) return this.sql("SELECT * FROM engine_actions WHERE kind = ? ORDER BY id DESC LIMIT ?").all(kind, limit) as ActionRow[];
    return this.sql("SELECT * FROM engine_actions ORDER BY id DESC LIMIT ?").all(limit) as ActionRow[];
  }

  countActions(kind: ActionKind, status: ActionStatus): number {
    return (this.sql("SELECT COUNT(*) AS n FROM engine_actions WHERE kind = ? AND status = ?").get(kind, status) as { n: number }).n;
  }

  // ---- what the chain said ----

  // Write a log down. False when it was there already: nothing more is to be done for it.
  addEvent(e: EventRow): boolean {
    return this.sql("INSERT OR IGNORE INTO chain_events (tx_hash, log_index, block, at, contract, event, args) VALUES (?, ?, ?, ?, ?, ?, ?)").run(e.tx_hash, e.log_index, e.block, e.at, e.contract, e.event, JSON.stringify(e.args)).changes === 1;
  }

  events(contract?: string, event?: string): EventRow[] {
    const rows = (
      contract && event
        ? this.sql("SELECT * FROM chain_events WHERE contract = ? AND event = ? ORDER BY block, log_index").all(contract, event)
        : contract
          ? this.sql("SELECT * FROM chain_events WHERE contract = ? ORDER BY block, log_index").all(contract)
          : this.sql("SELECT * FROM chain_events ORDER BY block, log_index").all()
    ) as (Omit<EventRow, "args"> & { args: string })[];
    return rows.map((r) => ({ ...r, args: JSON.parse(r.args) }));
  }

  addSplit(e: EventRow): void {
    const a = e.args;
    this.sql("INSERT OR IGNORE INTO chain_splits (tx_hash, log_index, block, at, amount, to_admin, to_burn, to_pool, admin_pushed, burn_pushed, pool_pushed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      e.tx_hash, e.log_index, e.block, e.at, a.amount, a.toAdmin, a.toBurn, a.toPool, a.adminPushed ? 1 : 0, a.burnPushed ? 1 : 0, a.poolPushed ? 1 : 0,
    );
  }

  addBurn(e: EventRow, ethUsd8: string | null): void {
    const a = e.args;
    this.sql("INSERT OR IGNORE INTO chain_burns (tx_hash, log_index, block, at, n, caller, eth_in, tokens_burned, via_curve, eth_usd8) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      e.tx_hash, e.log_index, e.block, e.at, Number(a.n), String(a.caller).toLowerCase(), a.ethIn, a.tokensBurned, a.viaCurve ? 1 : 0, ethUsd8,
    );
  }

  /** Burns, newest first: the newest `limit`, or those before the pot's burn number `before`. */
  burns(limit: number, before?: number): { tx_hash: string; block: number; at: number; n: number; caller: string; eth_in: string; tokens_burned: string; via_curve: number; eth_usd8: string | null }[] {
    const rows = before === undefined
      ? this.sql("SELECT tx_hash, block, at, n, caller, eth_in, tokens_burned, via_curve, eth_usd8 FROM chain_burns ORDER BY block DESC, log_index DESC LIMIT ?").all(limit)
      : this.sql("SELECT tx_hash, block, at, n, caller, eth_in, tokens_burned, via_curve, eth_usd8 FROM chain_burns WHERE n < ? ORDER BY block DESC, log_index DESC LIMIT ?").all(before, limit);
    return rows as {
      tx_hash: string;
      block: number;
      at: number;
      n: number;
      caller: string;
      eth_in: string;
      tokens_burned: string;
      via_curve: number;
      eth_usd8: string | null;
    }[];
  }

  splits(limit: number): { tx_hash: string; block: number; at: number; amount: string; to_admin: string; to_burn: string; to_pool: string; admin_pushed: number; burn_pushed: number; pool_pushed: number }[] {
    return this.sql("SELECT tx_hash, block, at, amount, to_admin, to_burn, to_pool, admin_pushed, burn_pushed, pool_pushed FROM chain_splits ORDER BY block DESC, log_index DESC LIMIT ?").all(limit) as never;
  }

  // ---- the desk: see ../desk.ts for what is written here and why ----

  /** A prepared statement, kept. For the desk's and the profiles' own queries. */
  q(text: string): Database.Statement {
    return this.sql(text);
  }

  count(table: string): number {
    if (!/^[a-z_]+$/.test(table)) throw new Error("not a table");
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
}
