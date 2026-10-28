// Agent coins: every agent on the desk can have one coin of its own on Pons, and its trading fees pay for the agent
// (docs/RULEBOOK.md, "Agent coins"; contracts/src/AgentCoinLauncher.sol and AgentCoinSplitter.sol).
//
// What the engine does with them:
//
//   reads     the launcher's CoinLaunched (a coin, its agent, its maker, its splitter and curve, the opening buy), each
//             splitter's Split, ComputePaid and ComputeBurned, each coin's buys and sells on its curve, its swaps in
//             its pool after graduation, and its transfers (who holds it)
//   credits   ComputePaid: the agent's compute share reached the gateway. It becomes a lot of compute credit for that
//             agent (./compute.ts), the agent's own at once ('kept'), priced at the ETH price of the moment, spent on
//             models like any other credit and shown as paid by its coin
//   sweeps    the keeper sweeps a coin's splitter once what waits there (on its curve, in Pons' escrow, or sent to it)
//             is worth the gas: at least COINS_SWEEP_GAS_MULTIPLE times what the sweep costs, and never less than
//             COINS_MIN_SWEEP_WEI, and no more often than every COINS_SWEEP_EVERY_S for one coin. A share a wallet
//             refused is retried every few hours. The burn share goes to $FACTOR's burn pot, which burns as it always
//             does (./chain/act.ts)
//   signs     for an agent Factor runs (made on the site, or one of Factor's own), the agent's permission for its
//             maker to launch its coin, when that maker asks with its own signature. An agent with a wallet of its
//             own launches its coin itself, or signs the permission itself (the kit does)
//   lists     every coin whose name keeps the rule below, with its agent's record beside it
//
//   GET  /v1/coins               every listed coin: ?sort=fees (what its fees have paid to its compute) or new
//   GET  /v1/coins/about         whether it is on, the launcher, Pons' fee, the name rule, what a launch costs
//   GET  /v1/coins/<id>          one coin, by its agent's address or name or the coin's own address
//   POST /v1/coins/permission    the maker of an agent Factor runs asks for the agent's signed permission
//
// The name rule: a coin carries its agent's name or a clear short form of it (the same letters, or the first three
// or more of them), its ticker is 2 to 10 letters or digits taken in order from that name, and neither names another
// brand, person or project. The site checks it before the launch button shows; the engine checks it again before it
// signs for an agent, and a coin that breaks it is not listed (it trades on Pons all the same: nobody can stop that).
//
// Switches: AGENT_COINS=on (off unless it is said), and the owner's "coins" switch (./switches.ts), which hides every
// coin, stops the permissions and stops the keeper's sweeps at once. The chain is read either way, so nothing a coin
// paid into an agent's compute credit is ever missed. Anyone can sweep a coin themselves: sweep() is open to all.

import { encodeAbiParameters, keccak256, parseAbi, type Abi, type Hex } from "viem";
import { agentCoinLauncherAbi, agentCoinSplitterAbi } from "./abi/index.js";
import { normalizeAddress, shortAddress } from "./chain/address.js";
import { readLogs, revertOf, reason, type CallSpec, type Chain, type ChainLog, type Head } from "./chain/chain.js";
import { snapshotOf, type Ctx } from "./chain/context.js";
import type { EngineDb, EventRow } from "./chain/db.js";
import { decode } from "./chain/watch.js";
import { ponsFactoryAbi, phaseName } from "./chain/pons.js";
import { ComputeStore } from "./compute.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

export interface CoinsConfig {
  /** AGENT_COINS=on: off unless it is said */
  enabled: boolean;
  /** FACTOR_COIN_LAUNCHER: the launcher, once deployed (contracts/deploy-coins.sh writes it) */
  launcher: string | null;
  /** FACTOR_COIN_LAUNCHER_BLOCK: the block to read coins from */
  fromBlock: bigint | null;
  /** COINS_MIN_SWEEP_WEI: the least a sweep of one coin moves */
  minSweepWei: bigint;
  /** COINS_SWEEP_GAS_MULTIPLE: a sweep must move at least this many times its own gas */
  gasMultiple: number;
  /** COINS_SWEEP_EVERY_S: one coin is swept at most this often */
  sweepEveryS: number;
  /** COINS_CHECK_EVERY_S: how often the keeper asks what a sweep of one coin would move */
  checkEveryS: number;
  /** how many coins the keeper looks at in one pass */
  perPass: number;
  /** COINS_PERMISSION_MINUTES: how long a permission Factor signs is good for */
  permissionS: number;
  /** COINS_SITE_URL: where a coin's picture and its agent's page are, written into the coin */
  site: string;
  /** why it is on and cannot run, when it cannot */
  note: string | null;
}

export function readCoins(env: Env, problems: string[] = []): CoinsConfig {
  const on = (env.AGENT_COINS ?? "").trim().toLowerCase() === "on";
  const rawLauncher = env.FACTOR_COIN_LAUNCHER?.trim();
  const launcher = rawLauncher ? normalizeAddress(rawLauncher) : null;
  if (rawLauncher && !launcher) problems.push(`FACTOR_COIN_LAUNCHER is not an address: "${rawLauncher}"`);
  const rawBlock = env.FACTOR_COIN_LAUNCHER_BLOCK?.trim();
  let fromBlock: bigint | null = null;
  if (rawBlock) {
    if (/^\d+$/.test(rawBlock)) fromBlock = BigInt(rawBlock);
    else problems.push(`FACTOR_COIN_LAUNCHER_BLOCK must be a block number: it is "${rawBlock}"`);
  }
  const whole = (name: string, def: number, least: number, most: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    if (/^\d+$/.test(raw) && Number(raw) >= least && Number(raw) <= most) return Number(raw);
    problems.push(`${name} must be a whole number from ${least} to ${most}: it is "${raw}"`);
    return def;
  };
  const rawMin = env.COINS_MIN_SWEEP_WEI?.trim();
  let minSweepWei = 200_000_000_000_000n; // 0.0002 ETH
  if (rawMin) {
    if (/^\d+$/.test(rawMin)) minSweepWei = BigInt(rawMin);
    else problems.push(`COINS_MIN_SWEEP_WEI must be whole wei, as digits: it is "${rawMin}"`);
  }
  const site = (env.COINS_SITE_URL?.trim() || "https://factoragents.fun").replace(/\/+$/, "");
  if (!/^https:\/\/[^\s/]+$/.test(site)) problems.push("COINS_SITE_URL must be an https:// address with nothing after the host");
  let note: string | null = null;
  if (on && !launcher) note = "AGENT_COINS is on and FACTOR_COIN_LAUNCHER is not set: there is no launcher to read coins from yet";
  else if (on && fromBlock === null) note = "AGENT_COINS is on and FACTOR_COIN_LAUNCHER_BLOCK is not set: the block to read coins from";
  return {
    enabled: on, launcher, fromBlock, minSweepWei,
    gasMultiple: whole("COINS_SWEEP_GAS_MULTIPLE", 20, 1, 10_000),
    sweepEveryS: whole("COINS_SWEEP_EVERY_S", 3600, 0, 30 * 86_400),
    checkEveryS: whole("COINS_CHECK_EVERY_S", 600, 0, 86_400),
    perPass: whole("COINS_PER_PASS", 5, 1, 100),
    permissionS: whole("COINS_PERMISSION_MINUTES", 60, 5, 7 * 24 * 60) * 60,
    site, note,
  };
}

// ---------- the name rule, the words of a coin, and the permission ----------

/** Names no coin may carry, or contain: other brands, people and projects. A short one is refused only as the whole name. */
export const RESERVED = [
  "factor", "pons", "robinhood", "bitcoin", "ethereum", "ether", "solana", "binance", "coinbase", "uniswap", "metamask", "tether", "usdc", "usdt",
  "openai", "chatgpt", "anthropic", "claude", "gemini", "google", "apple", "tesla", "nvidia", "microsoft", "amazon", "deepseek", "grok", "xai",
  "elon", "musk", "trump", "biden", "vitalik", "satoshi", "doge", "pepe", "shiba", "bonk", "btc", "eth", "sol", "bnb", "gpt", "meta", "x",
];
const plain = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Why a coin's name and ticker break the rule for an agent of this name, or null when they keep it. */
export function coinNameProblem(agentName: string | null | undefined, name: string, symbol: string): string | null {
  if (!agentName) return "the agent has no name yet: it gives itself one first, and its coin carries it";
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 .-]{0,30}[A-Za-z0-9]$/.test(name)) return "the coin's name must be 2 to 32 letters, digits, spaces, dots or hyphens";
  if (typeof symbol !== "string" || !/^[A-Z0-9]{2,10}$/.test(symbol)) return "the ticker must be 2 to 10 capital letters or digits";
  const a = plain(agentName), n = plain(name), t = plain(symbol);
  if (!(n === a || (n.length >= 3 && a.startsWith(n)))) return `the coin carries the agent's name: "${suggestCoin(agentName).name}", or the first three or more of its letters`;
  let i = 0;
  for (const ch of t) {
    i = a.indexOf(ch, i);
    if (i < 0) return `the ticker is made of letters of the agent's name, in their order: "${suggestCoin(agentName).symbol}", for one`;
    i++;
  }
  for (const r of RESERVED) {
    const hit = r.length <= 4 ? n === r || t === r : n.includes(r) || t.includes(r);
    if (hit) return "a coin may not carry the name of another brand, person or project";
  }
  return null;
}

/** The coin an agent of this name carries unless its maker shortens it: its name in words, and its letters as the ticker. */
export function suggestCoin(agentName: string): { name: string; symbol: string } {
  const words = agentName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ").slice(0, 32).trim();
  // its first word when that is a ticker on its own (3 to 10 letters), and otherwise its letters run together
  const first = (words[0] ?? "").toUpperCase();
  const symbol = first.length >= 3 && first.length <= 10 ? first : plain(agentName).toUpperCase().slice(0, 10);
  return { name, symbol: symbol.length >= 2 ? symbol : `${symbol}${symbol}`.slice(0, 2) };
}

/** What a coin says about itself on Pons, fixed for every coin: no promise, and its own risk. */
export const coinDescription = (name: string): string =>
  `${name} is an AI agent on Factor. This coin's trading fees pay for the agent's compute, its maker and the $FACTOR burn. It pays its holders nothing and promises them nothing: buying it is at your own risk.`;

/** The coin's picture: the agent's seal, drawn by the site. */
export const coinLogo = (site: string, agent: string): string => `${site}/api/v1/coins/logo/${agent}`;

/** The words the maker of an agent Factor runs signs to ask for the agent's permission. The same on the site and in the kit. */
export const coinAskMessage = (o: { agent: string; maker: string; name: string; symbol: string; at: number }): string =>
  ["Factor: launch an agent's coin", `agent: ${o.agent}`, `maker: ${o.maker}`, `name: ${o.name}`, `ticker: ${o.symbol}`, `at: ${o.at}`].join("\n");

/** The permission an agent signs for its maker (AgentCoinLauncher.PERMISSION_TYPEHASH), as EIP-712 typed data. */
export function permissionTypedData(o: { chainId: number; launcher: string; agent: string; maker: string; name: string; symbol: string; logo: string; description: string; nonce: bigint; deadline: bigint }) {
  return {
    domain: { name: "Factor agent coins", version: "1", chainId: o.chainId, verifyingContract: o.launcher as Hex },
    types: { Permission: [{ name: "agent", type: "address" }, { name: "maker", type: "address" }, { name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "logo", type: "string" }, { name: "description", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Permission" as const,
    message: { agent: o.agent as Hex, maker: o.maker as Hex, name: o.name, symbol: o.symbol, logo: o.logo, description: o.description, nonce: o.nonce, deadline: o.deadline },
  };
}
export type PermissionTypedData = ReturnType<typeof permissionTypedData>;

// ---------- what is read from the chain ----------

// A coin's trades, by their first topic. Pons publishes no ABI for its curve: these were read from the real curve on a
// fork of the chain, and contracts/test/fork/AgentCoins.fork.t.sol holds them to it. A buy: (who, for whom; ETH in,
// tokens out, Pons' fee, the tax). A sell: (who, for whom; tokens in, ETH out, Pons' fee, the tax).
export const CURVE_BUY = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455";
export const CURVE_SELL = "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df";
// Uniswap v4's Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1, uint160, uint128, int24, uint24)
export const POOL_SWAP = keccak256(new TextEncoder().encode("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
export const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

const TOKEN_ABI = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function logo() view returns (string)"]) as Abi;
const PONS_MORE_ABI = parseAbi(["function poolManager() view returns (address)", "function memeHook() view returns (address)", "function launchFee() view returns (uint256)"]) as Abi;
const ESCROW_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]) as Abi;

const word = (data: string, i: number): bigint => BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64) || "0"}`);
const signed128 = (w: bigint): bigint => { const x = w & ((1n << 128n) - 1n); return x >= 1n << 127n ? x - (1n << 128n) : x; };
const topicAddress = (t: string | undefined): string => normalizeAddress(`0x${(t ?? "").slice(-40)}`) ?? ZERO;

export interface CoinRow {
  agent: string; coin: string; splitter: string; curve: string; maker: string; by_signature: number; opening_eth: string; opening_tokens: string;
  block: number; at: number; tx_hash: string; name: string | null; symbol: string | null; logo: string | null; listed: number;
  state: string; state_at: number; holders: number; holders_dirty: number; checked_at: number; swept_at: number; retried_at: number;
}

/** What the splitter, the escrow and Pons hold for a coin, read at the head. Amounts in wei, as text. */
export interface CoinState {
  phase: string; unsplit: string; pending: string; escrow: string; totalSplit: string; toCompute: string; toBurn: string;
  computePaid: string; computeBurned: string; coinBurned: string; poolFee?: number; tickSpacing?: number;
}

export interface CoinsDeps {
  cfg: CoinsConfig;
  db: EngineDb;
  chain: Chain;
  chainId: number;
  desk: string;
  /** the chain's clock, seconds */
  nowS: () => number;
  /** the wall clock, ms */
  now: () => number;
  log: (line: string) => void;
  /** agents' names */
  names: () => Map<string, { name: string; hidden?: number }>;
  /** whose permission an agent Factor runs takes: its maker, or Factor's admin wallet for Factor's own */
  setters: (agent: string) => string[];
  /** the key Factor holds for an agent it runs, which signs as that agent; null for an agent with a wallet of its own */
  signerFor: (agent: string) => { signTyped: (typed: PermissionTypedData) => Promise<Hex> } | null;
  /** whether `address` (a wallet, or an account's key) signed `message` */
  signed: (address: string, message: string, signature: unknown) => Promise<boolean>;
  /** an agent's record, for the coin's page and the list */
  record: (agent: string) => { score: number; settled: number; barred: boolean; house: boolean; hosted: boolean } | null;
}

export class Coins {
  private factoryAddr: string | null = null;
  private escrowAddr: string | null = null;
  private poolManager: string | null = null;
  private hook: string | null = null;
  private feeWei: bigint | null = null;
  private gasPrice: bigint | null = null;
  private costReadAt = 0;

  constructor(readonly d: CoinsDeps) {}

  /** Reading the chain: switched on and a launcher to read. */
  reading(): boolean {
    return this.d.cfg.enabled && !!this.d.cfg.launcher && this.d.cfg.fromBlock !== null;
  }

  /** Shown, signed for and swept: reading, and the owner has not stopped it. */
  on(): boolean {
    return this.reading() && !stopped(this.d.db, "coins");
  }

  // ---------- the books ----------

  all(): CoinRow[] {
    return this.d.db.q("SELECT * FROM coins ORDER BY block, rowid").all() as CoinRow[];
  }

  byAgent(agent: string): CoinRow | null {
    return (this.d.db.q("SELECT * FROM coins WHERE agent = ?").get(agent) as CoinRow | undefined) ?? null;
  }

  private byAny(id: string): CoinRow | null {
    const a = normalizeAddress(id);
    if (a) return this.byAgent(a) ?? ((this.d.db.q("SELECT * FROM coins WHERE coin = ?").get(a) as CoinRow | undefined) ?? null);
    for (const [address, p] of this.d.names()) if (p.name === id && !p.hidden) return this.byAgent(address);
    return null;
  }

  /** The addresses whose logs are a coin's: the launcher, then each coin's splitter, curve and the coin itself. */
  private addresses(): { all: string[]; kind: Map<string, { kind: "launcher" | "splitter" | "curve" | "coin"; agent: string }> } {
    const kind = new Map<string, { kind: "launcher" | "splitter" | "curve" | "coin"; agent: string }>();
    kind.set(this.d.cfg.launcher!, { kind: "launcher", agent: "" });
    for (const c of this.all()) {
      kind.set(c.splitter, { kind: "splitter", agent: c.agent });
      kind.set(c.curve, { kind: "curve", agent: c.agent });
      kind.set(c.coin, { kind: "coin", agent: c.agent });
    }
    return { all: [...kind.keys()], kind };
  }

  /** The pools of the coins that have graduated, by their id. */
  private pools(): Map<string, string> {
    const out = new Map<string, string>();
    if (!this.hook) return out;
    for (const c of this.all()) {
      const s = JSON.parse(c.state) as Partial<CoinState>;
      if (s.phase !== "pool" || s.poolFee === undefined || s.tickSpacing === undefined) continue;
      const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [ZERO, c.coin as Hex, s.poolFee, s.tickSpacing, this.hook as Hex]));
      out.set(id.toLowerCase(), c.agent);
    }
    return out;
  }

  /** One log of a coin's, written down. Returns a line for the engine's log, when it is worth one. Exported for the tests. */
  apply(log: ChainLog, at: number, kind: Map<string, { kind: string; agent: string }>, pools: Map<string, string>, ethUsd8: string | null): string | null {
    const db = this.d.db;
    const k = kind.get(log.address);
    const tx = log.transactionHash.toLowerCase();
    const t0 = (log.topics[0] ?? "").toLowerCase();
    if (pools.size && t0 === POOL_SWAP && log.topics[1] && pools.has(log.topics[1].toLowerCase())) {
      const agent = pools.get(log.topics[1].toLowerCase())!;
      const a0 = signed128(word(log.data, 0)), a1 = signed128(word(log.data, 1));
      const buy = a0 < 0n; // ETH went into the pool
      db.q("INSERT OR IGNORE INTO coin_trades (tx_hash, log_index, block, at, agent, side, eth, tokens, who, venue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pool')").run(tx, log.logIndex, Number(log.blockNumber), at, agent, buy ? "buy" : "sell", (a0 < 0n ? -a0 : a0).toString(), (a1 < 0n ? -a1 : a1).toString(), topicAddress(log.topics[2]));
      return null;
    }
    if (!k) return null;
    if (k.kind === "curve" && (t0 === CURVE_BUY || t0 === CURVE_SELL)) {
      const buy = t0 === CURVE_BUY;
      db.q("INSERT OR IGNORE INTO coin_trades (tx_hash, log_index, block, at, agent, side, eth, tokens, who, venue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'curve')").run(tx, log.logIndex, Number(log.blockNumber), at, k.agent, buy ? "buy" : "sell", (buy ? word(log.data, 0) : word(log.data, 1)).toString(), (buy ? word(log.data, 1) : word(log.data, 0)).toString(), topicAddress(log.topics[2]));
      return null;
    }
    if (k.kind === "coin" && t0 === TRANSFER && log.topics.length === 3) {
      const r = db.q("INSERT OR IGNORE INTO coin_transfers (tx_hash, log_index, block, agent, src, dst, value) VALUES (?, ?, ?, ?, ?, ?, ?)").run(tx, log.logIndex, Number(log.blockNumber), k.agent, topicAddress(log.topics[1]), topicAddress(log.topics[2]), word(log.data, 0).toString());
      if (r.changes) db.q("UPDATE coins SET holders_dirty = 1 WHERE agent = ?").run(k.agent);
      return null;
    }
    if (k.kind !== "launcher" && k.kind !== "splitter") return null;
    const e = decode({ name: "coins" as never, abi: (k.kind === "launcher" ? agentCoinLauncherAbi : agentCoinSplitterAbi) as Abi }, log, at);
    if (!e) return null;
    e.contract = k.kind === "launcher" ? "coins" : "coin";
    if (!db.addEvent(e)) return null;
    return this.effect(e, k.agent, ethUsd8);
  }

  private effect(e: EventRow, agent: string, ethUsd8: string | null): string | null {
    const db = this.d.db;
    const a = e.args;
    if (e.event === "CoinLaunched") {
      db.q("INSERT OR IGNORE INTO coins (agent, coin, splitter, curve, maker, by_signature, opening_eth, opening_tokens, block, at, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        String(a.agent), String(a.coin), String(a.splitter), String(a.curve), String(a.maker), a.bySignature ? 1 : 0, String(a.openingBuyEth), String(a.openingBuyTokens), e.block, e.at, e.tx_hash,
      );
      return `an agent's coin was launched: ${a.coin} for ${shortAddress(a.agent)}, by ${shortAddress(a.maker)}${a.bySignature ? " with the agent's permission" : ""}`;
    }
    if (e.event === "Split") {
      db.q("INSERT OR IGNORE INTO coin_splits (tx_hash, log_index, block, at, agent, amount, to_compute, to_maker, to_burn, to_owner, pushed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        e.tx_hash, e.log_index, e.block, e.at, agent, String(a.amount), String(a.toCompute), String(a.toMaker), String(a.toBurn), String(a.toOwner), a.computePushed && a.makerPushed && a.burnPushed && a.ownerPushed ? 1 : 0,
      );
      return `a coin's fees were split: ${ethText(String(a.amount))} ETH, ${shortAddress(agent)}'s coin`;
    }
    if (e.event === "ComputePaid") {
      // the agent's own credit, from the moment the ETH reached the gateway
      const fresh = new ComputeStore(db).addCoinLot(e, normalizeAddress(a.agent) ?? agent, BigInt(String(a.amount)), ethUsd8);
      return fresh ? `${shortAddress(a.agent)}'s coin paid ${ethText(String(a.amount))} ETH into its compute credit` : null;
    }
    if (e.event === "ComputeBurned") return `${shortAddress(a.agent)} is barred: its coin's compute share, ${ethText(String(a.amount))} ETH, went to the burn`;
    return null;
  }

  // ---------- reading the chain ----------

  /** One pass of the coins' logs, from where the last stopped to the safe head. Returns the lines worth logging. */
  async watch(ctx: Ctx, head: Head): Promise<string[]> {
    if (!this.reading()) return [];
    const { db, chain } = this.d;
    const safe = head.number - BigInt(ctx.params.confirmations);
    const start = (db.cursor("coins") ?? this.d.cfg.fromBlock! - 1n) + 1n;
    if (start > safe) return [];
    await this.learn();
    const lines: string[] = [];
    const span = BigInt(ctx.params.logSpan);
    let from = start;
    for (let n = 0; n < ctx.params.spansPerPass && from <= safe; n++) {
      const to = from + span - 1n > safe ? safe : from + span - 1n;
      const { all, kind } = this.addresses();
      const pools = this.pools();
      let logs = await this.read(from, to, all);
      // a coin launched in this stretch: its splitter, curve and coin were not asked for yet, so they are now
      const fresh = logs.filter((l) => kind.get(l.address)?.kind === "launcher" && (l.topics[0] ?? "").toLowerCase() === LAUNCHED);
      if (fresh.length) {
        const more: string[] = [];
        let first = to;
        for (const l of fresh) {
          const e = decode({ name: "coins" as never, abi: agentCoinLauncherAbi as Abi }, l, 0);
          if (!e) continue;
          const agent = normalizeAddress(e.args.agent) ?? "";
          for (const [field, k] of [["splitter", "splitter"], ["curve", "curve"], ["coin", "coin"]] as const) {
            const x = normalizeAddress(e.args[field]);
            if (x && !kind.has(x)) { kind.set(x, { kind: k, agent }); more.push(x); }
          }
          if (l.blockNumber < first) first = l.blockNumber;
        }
        if (more.length) logs = dedupe([...logs, ...(await this.read(first, to, more))]);
      }
      if (pools.size && this.poolManager) logs = dedupe([...logs, ...(await this.read(from, to, [this.poolManager], [POOL_SWAP as Hex, [...pools.keys()] as Hex[]]))]);
      logs.sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
      await this.times(ctx, logs);
      const ethUsd8 = snapshotOf(db)?.ethUsd8 ?? null;
      db.tx(() => {
        for (const l of logs) {
          const line = this.apply(l, l.timestamp ?? ctx.blockTimes.get(l.blockNumber) ?? 0, kind, pools, ethUsd8);
          if (line) lines.push(line);
        }
        db.setCursor("coins", to);
      });
      from = to + 1n;
    }
    for (const l of lines) this.d.log(`[coins] ${l}`);
    return lines;
  }

  private async read(from: bigint, to: bigint, address: string[], topics?: (Hex | Hex[] | null)[]): Promise<ChainLog[]> {
    let out: ChainLog[] = [];
    await readLogs(this.d.chain, from, to, { address, ...(topics ? { topics } : {}) }, to - from + 1n, (logs) => { out = logs; }, 1);
    return out;
  }

  private async times(ctx: Ctx, logs: ChainLog[]): Promise<void> {
    const missing = [...new Set(logs.filter((l) => l.timestamp === undefined && !ctx.blockTimes.has(l.blockNumber)).map((l) => l.blockNumber))];
    for (let i = 0; i < missing.length; i += 10) {
      const blocks = await Promise.all(missing.slice(i, i + 10).map((n) => this.d.chain.block(n)));
      blocks.forEach((b, k) => ctx.blockTimes.set(missing[i + k]!, b?.timestamp ?? 0));
    }
  }

  /** Pons' addresses, read once from the launcher and the factory. */
  private async learn(): Promise<void> {
    if (this.factoryAddr && this.poolManager) return;
    const read = <T>(to: string, abi: Abi, functionName: string) => this.d.chain.read<T>({ to, abi, functionName });
    this.factoryAddr = normalizeAddress(await read<string>(this.d.cfg.launcher!, agentCoinLauncherAbi as Abi, "factory"));
    this.escrowAddr = normalizeAddress(await read<string>(this.d.cfg.launcher!, agentCoinLauncherAbi as Abi, "escrow"));
    if (this.factoryAddr) {
      this.poolManager = normalizeAddress(await read<string>(this.factoryAddr, PONS_MORE_ABI, "poolManager").catch(() => null));
      this.hook = normalizeAddress(await read<string>(this.factoryAddr, PONS_MORE_ABI, "memeHook").catch(() => null));
    }
  }

  /**
   * What is read rather than logged: a new coin's name, ticker and picture (and whether they keep the rule), what each
   * coin's splitter, Pons' escrow and the factory hold for it, who holds it, and what a launch costs. A few coins a pass,
   * the stalest first.
   */
  async refresh(): Promise<void> {
    if (!this.reading()) return;
    const { db, chain } = this.d;
    await this.learn();
    const names = this.d.names();
    for (const c of db.q("SELECT * FROM coins WHERE name IS NULL LIMIT 20").all() as CoinRow[]) {
      const [name, symbol, logo] = await Promise.all(["name", "symbol", "logo"].map((f) => chain.read<string>({ to: c.coin, abi: TOKEN_ABI, functionName: f }).catch(() => "")));
      db.q("UPDATE coins SET name = ?, symbol = ?, logo = ?, listed = ? WHERE agent = ?").run(name, symbol, logo, coinNameProblem(names.get(c.agent)?.name, name ?? "", symbol ?? "") ? 0 : 1, c.agent);
    }
    // the rule against the agent's name as it is now: an agent that renames itself keeps its coin listed only if it still fits
    for (const c of db.q("SELECT agent, name, symbol, listed FROM coins WHERE name IS NOT NULL").all() as Pick<CoinRow, "agent" | "name" | "symbol" | "listed">[]) {
      const ok = coinNameProblem(names.get(c.agent)?.name, c.name ?? "", c.symbol ?? "") === null ? 1 : 0;
      if (ok !== c.listed) db.q("UPDATE coins SET listed = ? WHERE agent = ?").run(ok, c.agent);
    }
    const stale = db.q("SELECT * FROM coins ORDER BY state_at LIMIT 25").all() as CoinRow[];
    const S = agentCoinSplitterAbi as Abi;
    await Promise.all(stale.filter((c) => this.d.now() - c.state_at > 20_000).map(async (c) => {
      const r = <T>(fn: string) => chain.read<T>({ to: c.splitter, abi: S, functionName: fn });
      const [unsplit, pending, totalSplit, toCompute, toBurn, computePaid, computeBurned, coinBurned, escrow, info] = await Promise.all([
        r<bigint>("unsplit"), r<bigint>("pending"), r<bigint>("totalSplit"), r<bigint>("totalToCompute"), r<bigint>("totalToBurn"), r<bigint>("totalComputePaid"), r<bigint>("totalComputeBurned"), r<bigint>("totalCoinBurned"),
        this.escrowAddr ? chain.read<bigint>({ to: this.escrowAddr, abi: ESCROW_ABI, functionName: "balanceOf", args: [c.splitter] }) : Promise.resolve(0n),
        this.factoryAddr ? chain.read<{ phase: number; poolFee: number; tickSpacing: number }>({ to: this.factoryAddr, abi: ponsFactoryAbi as Abi, functionName: "getLaunchedToken", args: [c.coin] }).catch(() => null) : Promise.resolve(null),
      ]);
      const state: CoinState = {
        phase: info ? phaseName(Number(info.phase)) : "curve", unsplit: unsplit.toString(), pending: pending.toString(), escrow: escrow.toString(), totalSplit: totalSplit.toString(), toCompute: toCompute.toString(), toBurn: toBurn.toString(),
        computePaid: computePaid.toString(), computeBurned: computeBurned.toString(), coinBurned: coinBurned.toString(), ...(info ? { poolFee: Number(info.poolFee), tickSpacing: Number(info.tickSpacing) } : {}),
      };
      db.q("UPDATE coins SET state = ?, state_at = ? WHERE agent = ?").run(JSON.stringify(state), this.d.now(), c.agent);
    }));
    for (const c of db.q("SELECT * FROM coins WHERE holders_dirty = 1 LIMIT 20").all() as CoinRow[]) {
      db.q("UPDATE coins SET holders = ?, holders_dirty = 0 WHERE agent = ?").run(this.holdersOf(c), c.agent);
    }
    if (this.d.now() - this.costReadAt > 60_000 && this.d.cfg.launcher) {
      this.costReadAt = this.d.now();
      this.feeWei = await chain.read<bigint>({ to: this.d.cfg.launcher, abi: agentCoinLauncherAbi as Abi, functionName: "launchFee" }).catch(() => this.feeWei);
      this.gasPrice = await chain.fees().then((f) => f.maxFeePerGas).catch(() => this.gasPrice);
    }
  }

  /** The wallets that hold some of a coin, worked out from its transfers: Pons' curve and pool, the splitter and nobody left out. */
  holdersOf(c: CoinRow): number {
    const bal = new Map<string, bigint>();
    for (const t of this.d.db.q("SELECT src, dst, value FROM coin_transfers WHERE agent = ?").all(c.agent) as { src: string; dst: string; value: string }[]) {
      const v = BigInt(t.value);
      bal.set(t.src, (bal.get(t.src) ?? 0n) - v);
      bal.set(t.dst, (bal.get(t.dst) ?? 0n) + v);
    }
    const not = new Set([ZERO, DEAD, c.curve, c.splitter, c.coin, this.poolManager, this.escrowAddr, this.d.cfg.launcher].filter(Boolean) as string[]);
    let n = 0;
    for (const [a, v] of bal) if (v > 0n && !not.has(a)) n++;
    return n;
  }

  // ---------- the keeper ----------

  /**
   * The keeper's turn (./chain/act.ts calls it as the step "coin_sweep"): a few coins, the longest unlooked-at first.
   * For each, what a sweep would move right now is asked of the chain; it is swept once that is worth the gas and its
   * last sweep is long enough ago. A coin with a share a wallet refused is retried every few hours.
   */
  async step(ctx: Ctx, head: Head, attempt: (kind: "coin_sweep", ref: string, call: CallSpec, detail: Record<string, unknown>, feeCap: bigint, pre?: { gas: bigint; fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } }) => Promise<{ status: string; why: string; hash?: string }>): Promise<string> {
    if (!this.reading()) return "agent coins are not switched on";
    if (stopped(this.d.db, "coins")) return "agent coins are stopped by the owner";
    const cfg = this.d.cfg;
    const t = head.timestamp;
    const due = (this.d.db.q("SELECT * FROM coins WHERE checked_at <= ? ORDER BY checked_at LIMIT ?").all(this.d.now() - cfg.checkEveryS * 1000, cfg.perPass) as CoinRow[]);
    if (!due.length) return "no coin is due to be looked at";
    const said: string[] = [];
    for (const c of due) {
      if (ctx.stopping()) break;
      this.d.db.q("UPDATE coins SET checked_at = ? WHERE agent = ?").run(this.d.now(), c.agent);
      const S = { to: c.splitter, abi: agentCoinSplitterAbi as Abi };
      const state = JSON.parse(c.state) as Partial<CoinState>;
      // a share a wallet refused: retry() delivers it, every six hours at most
      if (BigInt(state.pending ?? "0") > 0n && t >= c.retried_at + 6 * 3600) {
        const r = await attempt("coin_sweep", `${c.agent}:retry`, { ...S, functionName: "retry" }, { coin: c.coin, pending: state.pending }, ctx.params.maxGasWei);
        if (r.status === "done" || r.status === "dry" || r.status === "sent") this.d.db.q("UPDATE coins SET retried_at = ? WHERE agent = ?").run(t, c.agent);
        said.push(`${c.symbol ?? shortAddress(c.coin)}: ${r.status === "dry" ? "would retry" : "retried"} a refused share`);
        if (ctx.db.openActions().length) break;
      }
      if (t < c.swept_at + cfg.sweepEveryS) { said.push(`${c.symbol ?? shortAddress(c.coin)}: swept ${t - c.swept_at} s ago`); continue; }
      const call: CallSpec = { ...S, functionName: "sweep" };
      let waiting: bigint;
      try {
        waiting = await ctx.chain.simulate<bigint>(call, ctx.facts.from!);
      } catch (e) {
        if (!revertOf(e)) throw e;
        said.push(`${c.symbol ?? shortAddress(c.coin)}: a sweep would fail (${reason(e)})`);
        continue;
      }
      if (waiting === 0n) { said.push(`${c.symbol ?? shortAddress(c.coin)}: nothing waits`); continue; }
      const [gas, fees] = await Promise.all([ctx.chain.estimateGas(call, ctx.facts.from!), ctx.chain.fees()]);
      const worth = gas * fees.maxFeePerGas * BigInt(cfg.gasMultiple);
      const floor = cfg.minSweepWei > worth ? cfg.minSweepWei : worth;
      if (waiting < floor) { said.push(`${c.symbol ?? shortAddress(c.coin)}: ${ethText(waiting.toString())} ETH waits, under ${ethText(floor.toString())}`); continue; }
      const r = await attempt("coin_sweep", c.agent, call, { coin: c.coin, waiting, minimum: floor }, ctx.params.maxGasWei, { gas, fees });
      if (r.status === "done" || r.status === "dry" || r.status === "sent") this.d.db.q("UPDATE coins SET swept_at = ? WHERE agent = ?").run(t, c.agent);
      if (r.status === "done") this.d.log(`[coins] ${ethText(waiting.toString())} ETH of ${c.symbol ?? c.coin}'s fees collected and split: ${r.hash}`);
      said.push(`${c.symbol ?? shortAddress(c.coin)}: ${r.status === "dry" ? "would sweep" : r.status === "done" ? "swept" : r.status} ${ethText(waiting.toString())} ETH${r.status === "failed" || r.status === "skipped" ? ` (${r.why})` : ""}`);
      if (ctx.db.openActions().length) break;
    }
    return said.join("; ");
  }

  // ---------- a permission, for an agent Factor runs ----------

  async permission(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const no = (status: number, error: string) => ({ status, body: { error } });
    if (!this.on()) return no(503, "agent coins are not switched on");
    const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const agent = normalizeAddress(b.agent), maker = normalizeAddress(b.maker);
    if (!agent || !maker) return no(400, "agent and maker must be addresses");
    const name = typeof b.name === "string" ? b.name.trim() : "", symbol = typeof b.symbol === "string" ? b.symbol.trim() : "";
    const at = Number(b.at);
    if (!Number.isSafeInteger(at) || Math.abs(this.d.nowS() - at) > 600) return no(400, "the signature's time is more than ten minutes from now: sign again");
    if (!this.d.record(agent)) return no(404, "that agent is not on the desk");
    if (this.byAgent(agent)) return no(409, "this agent has its coin already: one coin per agent, ever");
    const signer = this.d.signerFor(agent);
    if (!signer) return no(409, "Factor does not run this agent: its own wallet launches its coin, or signs the permission itself");
    if (!this.d.setters(agent).includes(maker)) return no(403, "only the agent's maker can ask for its permission");
    const problem = coinNameProblem(this.d.names().get(agent)?.name, name, symbol);
    if (problem) return no(400, problem);
    if (!(await this.d.signed(maker, coinAskMessage({ agent, maker, name, symbol, at }), b.signature))) return no(401, "the signature is not the maker's");
    const launcher = this.d.cfg.launcher!;
    const L = { to: launcher, abi: agentCoinLauncherAbi as Abi };
    const [nonce, existing] = await Promise.all([this.d.chain.read<bigint>({ ...L, functionName: "nonces", args: [agent] }), this.d.chain.read<string>({ ...L, functionName: "coinOf", args: [agent] })]);
    if (normalizeAddress(existing) !== ZERO) return no(409, "this agent has its coin already: one coin per agent, ever");
    const deadline = BigInt(this.d.nowS() + this.d.cfg.permissionS);
    const logo = coinLogo(this.d.cfg.site, agent), description = coinDescription(name);
    const typed = permissionTypedData({ chainId: this.d.chainId, launcher, agent, maker, name, symbol, logo, description, nonce, deadline });
    const signature = await signer.signTyped(typed);
    this.d.log(`[coins] signed ${shortAddress(agent)}'s permission for its maker ${shortAddress(maker)} to launch $${symbol}`);
    return { status: 200, body: { agent, maker, name, symbol, logo, description, nonce: nonce.toString(), deadline: deadline.toString(), signature, launcher, chainId: this.d.chainId } };
  }

  // ---------- what the site and the kit read ----------

  about(): Record<string, unknown> {
    const gas = 5_800_000n; // a launch, measured on a fork against the real Pons (contracts/test/fork/AgentCoins.fork.t.sol)
    const gasWei = this.gasPrice ? gas * this.gasPrice : null;
    return {
      enabled: this.on(), launcher: this.d.cfg.launcher, chainId: this.d.chainId, site: this.d.cfg.site,
      launchFeeWei: this.feeWei?.toString() ?? null, launchGas: gas.toString(), launchGasWei: gasWei?.toString() ?? null,
      coins: this.on() ? (this.d.db.q("SELECT COUNT(*) AS n FROM coins WHERE listed = 1").get() as { n: number }).n : 0,
      rule: "A coin carries its agent's name, or the first three or more of its letters; its ticker is 2 to 10 letters or digits of that name, in order; neither may name another brand, person or project.",
      tax: "3%", pair: "ETH",
    };
  }

  /** One coin as the site shows it, or null. `full` adds its latest trades and splits. */
  json(c: CoinRow, full = false): CoinJson {
    const s = JSON.parse(c.state) as Partial<CoinState>;
    const names = this.d.names();
    const rec = this.d.record(c.agent);
    const credit = new ComputeStore(this.d.db).coinCredit(c.agent);
    const t = this.d.db.q("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END), 0) AS buys FROM coin_trades WHERE agent = ?").get(c.agent) as { n: number; buys: number };
    const volume = (this.d.db.q("SELECT eth FROM coin_trades WHERE agent = ?").all(c.agent) as { eth: string }[]).reduce((n, x) => n + BigInt(x.eth), 0n);
    const p = names.get(c.agent);
    const out: CoinJson = {
      agent: { address: c.agent, name: p && !p.hidden ? p.name : shortAddress(c.agent), named: !!p && !p.hidden, score: rec?.score ?? 0, settled: rec?.settled ?? 0, barred: !!rec?.barred, house: !!rec?.house, hosted: !!rec?.hosted },
      coin: c.coin, name: c.name ?? "", symbol: c.symbol ?? "", splitter: c.splitter, curve: c.curve, maker: c.maker, bySignature: !!c.by_signature,
      launchedAt: new Date(c.at * 1000).toISOString(), tx: c.tx_hash, openingBuyEth: ethNum(c.opening_eth), listed: !!c.listed,
      phase: s.phase ?? "curve", pons: `https://ponsfamily.com/launchpad/${c.coin}`,
      paidFor: {
        computeEth: ethNum(s.computePaid ?? credit.wei), computeUsd: credit.grantedMicro / 1e6, computeUsedUsd: credit.spentMicro / 1e6,
        burnEth: ethNum((BigInt(s.toBurn ?? "0") + BigInt(s.computeBurned ?? "0")).toString()), coinsBurned: ethNum(s.coinBurned ?? "0"),
        jobsSettled: rec?.settled ?? 0,
      },
      waitingEth: ethNum((BigInt(s.unsplit ?? "0") + BigInt(s.escrow ?? "0")).toString()),
      volumeEth: ethNum(volume.toString()), trades: t.n, buys: t.buys, holders: c.holders,
    };
    if (full) {
      out.recent = (this.d.db.q("SELECT tx_hash, at, side, eth, tokens, venue FROM coin_trades WHERE agent = ? ORDER BY block DESC, log_index DESC LIMIT 12").all(c.agent) as { tx_hash: string; at: number; side: string; eth: string; tokens: string; venue: string }[])
        .map((x) => ({ tx: x.tx_hash, at: new Date(x.at * 1000).toISOString(), side: x.side as "buy" | "sell", eth: ethNum(x.eth), tokens: ethNum(x.tokens), venue: x.venue as "curve" | "pool" }));
      out.sweeps = (this.d.db.q("SELECT tx_hash, at, amount FROM coin_splits WHERE agent = ? ORDER BY block DESC, log_index DESC LIMIT 12").all(c.agent) as { tx_hash: string; at: number; amount: string }[])
        .map((x) => ({ tx: x.tx_hash, at: new Date(x.at * 1000).toISOString(), eth: ethNum(x.amount) }));
    }
    return out;
  }

  /** Every listed coin: by what its fees have paid to its agent's compute, or newest first. */
  list(sort: "fees" | "new" = "fees"): CoinJson[] {
    if (!this.on()) return [];
    const rows = this.all().filter((c) => c.listed).map((c) => this.json(c));
    return rows.sort((a, b) => (sort === "new" ? (a.launchedAt < b.launchedAt ? 1 : -1) : b.paidFor.computeEth - a.paidFor.computeEth || (a.launchedAt < b.launchedAt ? 1 : -1)));
  }

  /** One coin, by its agent (address or name) or its own address: listed, or not found. */
  one(id: string): CoinJson | null {
    if (!this.on()) return null;
    const c = this.byAny(id);
    return c && c.listed ? this.json(c, true) : null;
  }

  /** The small mark beside an agent wherever it shows: its coin's ticker and address. */
  badge(agent: string): { coin: string; symbol: string } | null {
    if (!this.on()) return null;
    const c = this.byAgent(agent);
    return c && c.listed ? { coin: c.coin, symbol: c.symbol ?? "" } : null;
  }

  /** For the owner's health answer. */
  health(): Record<string, unknown> {
    const rows = this.all();
    const pending = rows.filter((c) => BigInt((JSON.parse(c.state) as Partial<CoinState>).pending ?? "0") > 0n).map((c) => c.coin);
    return { reading: this.reading(), on: this.on(), launcher: this.d.cfg.launcher, coins: rows.length, listed: rows.filter((c) => c.listed).length, pending, note: this.d.cfg.note };
  }
}

/** A coin as the site and the kit read it: web/src/lib/types.ts keeps the same shape by hand. */
export interface CoinJson {
  agent: { address: string; name: string; named: boolean; score: number; settled: number; barred: boolean; house: boolean; hosted: boolean };
  coin: string; name: string; symbol: string; splitter: string; curve: string; maker: string; bySignature: boolean;
  launchedAt: string; tx: string; openingBuyEth: number; listed: boolean; phase: string; pons: string;
  /** what the coin's fees have paid for: its agent's compute (in ETH as it arrived, and in dollars of credit, and what its calls spent of that), the $FACTOR burn, its own coins burned, and the jobs its agent has settled */
  paidFor: { computeEth: number; computeUsd: number; computeUsedUsd: number; burnEth: number; coinsBurned: number; jobsSettled: number };
  /** fees on their way: in the splitter or in Pons' escrow, for the next sweep */
  waitingEth: number;
  volumeEth: number; trades: number; buys: number; holders: number;
  recent?: { tx: string; at: string; side: "buy" | "sell"; eth: number; tokens: number; venue: "curve" | "pool" }[];
  sweeps?: { tx: string; at: string; eth: number }[];
}

const LAUNCHED = keccak256(new TextEncoder().encode("CoinLaunched(address,address,address,address,address,bool,uint256,uint256)")).toLowerCase();
const ethNum = (wei: string): number => Number(BigInt(wei) / 10n ** 12n) / 1e6;
const ethText = (wei: string): string => {
  const n = ethNum(wei);
  return n >= 0.01 ? n.toFixed(4) : n.toFixed(6);
};
const dedupe = (logs: ChainLog[]): ChainLog[] => {
  const seen = new Set<string>();
  return logs.filter((l) => { const k = `${l.transactionHash}:${l.logIndex}`; if (seen.has(k)) return false; seen.add(k); return true; });
};
