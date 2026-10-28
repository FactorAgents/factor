// Everything the engine is told from outside, read once at boot.
//
// The names are the ones contracts/deploy.sh and contracts/launch.sh write to contracts/broadcast/factor.env
// (FACTOR_SPLITTER, FACTOR_BURN_POT, FACTOR_DESK, FACTOR_DEPLOY_BLOCK, FACTOR_TOKEN, FACTOR_ADMIN), so the file can be
// pasted into the host's variables as it is. All of those are public addresses. The one secret the chain side has is
// BOT_PRIVATE_KEY, the key of the wallet that pays the gas for sweeps, burns and closing jobs, which the owner puts into the host
// himself: it is read here, handed to the signer, and never logged, stored or returned by anything.

import { readFileSync } from "node:fs";
import { normalizeAddress } from "./address.js";
import { readAccounts, type AccountsConfig } from "../accounts.js";
import { readCompute, type ComputeConfig } from "../compute.js";
import { readHouse, type HouseConfig } from "../house/house.js";
import { readPay, type PayConfig } from "../pay.js";
import { readSubjobs, type SubjobsConfig } from "../subjobs.js";
import { readFirms, type FirmsConfig } from "../firms.js";
import { readPlans, type PlansConfig } from "../plans.js";
import { readErc8004, type Erc8004Config } from "../erc8004.js";
import { readOpenJobs, type OpenJobsConfig } from "../openjobs.js";
import { readAutoApply, type AutoApplyConfig } from "../autoapply.js";
import { readVerified, type VerifiedConfig } from "../verified.js";
import { readCoins, type CoinsConfig } from "../coins.js";

// the chain the token lives on, written down once
export const CHAIN = { id: 4663, name: "Robinhood Chain", rpcUrl: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com" } as const;

export type EngineMode = "off" | "watch" | "dry" | "live";
export const MODES: EngineMode[] = ["off", "watch", "dry", "live"];
// the chain's id, its public node and its explorer are written down once, in shared/chain.ts
export const PUBLIC_RPC: string = CHAIN.rpcUrl;
export const ROBINHOOD_CHAIN_ID: number = CHAIN.id;
export const GWEI = 10n ** 9n;

export type Env = Record<string, string | undefined>;

// What the engine does and how often. Every one can be set from the environment under the name beside it.
export interface EngineParams {
  watchEveryMs: number; // ENGINE_WATCH_EVERY_MS
  actEveryMs: number; // ENGINE_ACT_EVERY_MS
  confirmations: number; // ENGINE_CONFIRMATIONS: blocks behind the head the watchers stay
  logSpan: number; // ENGINE_LOG_SPAN: blocks one log query asks for
  spansPerPass: number; // ENGINE_SPANS_PER_PASS: log queries one watcher makes in one pass at most
  checkpoints: number; // ENGINE_CHECKPOINTS: block hashes kept to find the way back after a reorg
  sweepEveryS: number; // ENGINE_SWEEP_EVERY_S
  minSweepWei: bigint; // ENGINE_MIN_SWEEP_WEI
  sweepGasMultiple: number; // ENGINE_SWEEP_GAS_MULTIPLE: a sweep must move at least this many times its own gas
  burnToleranceBps: number; // ENGINE_BURN_TOLERANCE_BPS
  burnRetryS: number; // ENGINE_BURN_RETRY_S
  maxGasWei: bigint; // ENGINE_MAX_GAS_GWEI: the most the engine pays per unit of gas
  unstickMaxGasWei: bigint; // ENGINE_UNSTICK_MAX_GAS_GWEI: the same for replacing a transaction that is stuck
  gasCaps: { sweep: bigint; claim_token: bigint; burn: bigint; settle_job: bigint; refund_job: bigint; collect: bigint; return_compute: bigint; relay: bigint; retry_split: bigint; skim: bigint; erc8004: bigint; coin_sweep: bigint };
  jobsPerPass: number; // ENGINE_JOBS_PER_PASS: jobs the engine settles or refunds in one pass at most
  deskReadsPerPass: number; // ENGINE_DESK_READS_PER_PASS: jobs and agents read back from the desk in one pass at most
  gasHeadroomBps: number; // on top of the node's estimate
  receiptWaitMs: number; // ENGINE_RECEIPT_WAIT_MS
  stuckAfterMs: number; // ENGINE_STUCK_AFTER_MS
  lockMs: number; // how long an attempt holds its lock at most
  botGasWarnWei: bigint; // ENGINE_BOT_GAS_WARN_WEI
  skimKeepWei: bigint; // ENGINE_SKIM_KEEP_WEI: what the gas wallet keeps for gas when its surplus is sent on
  skimMinWei: bigint; // ENGINE_SKIM_MIN_WEI: a surplus under this is not worth a transaction
  apiCacheMs: number; // ENGINE_API_CACHE_MS
}

export const DEFAULTS: EngineParams = {
  watchEveryMs: 10_000,
  actEveryMs: 30_000,
  confirmations: 20,
  logSpan: 100_000,
  spansPerPass: 20,
  checkpoints: 64,
  sweepEveryS: 600,
  minSweepWei: 300_000_000_000_000n, // 0.0003 ETH
  sweepGasMultiple: 20,
  burnToleranceBps: 100,
  burnRetryS: 120,
  maxGasWei: 2n * GWEI,
  unstickMaxGasWei: 20n * GWEI,
  gasCaps: { sweep: 700_000n, claim_token: 400_000n, burn: 900_000n, settle_job: 600_000n, refund_job: 500_000n, collect: 200_000n, return_compute: 150_000n, relay: 1_500_000n, retry_split: 400_000n, skim: 100_000n, erc8004: 500_000n, coin_sweep: 800_000n },
  jobsPerPass: 5,
  deskReadsPerPass: 200,
  gasHeadroomBps: 2500,
  receiptWaitMs: 60_000,
  stuckAfterMs: 90_000,
  lockMs: 180_000,
  botGasWarnWei: 5_000_000_000_000_000n, // 0.005 ETH
  skimKeepWei: 20_000_000_000_000_000n, // 0.02 ETH
  skimMinWei: 10_000_000_000_000_000n, // 0.01 ETH
  apiCacheMs: 3000,
};

export interface EngineConfig {
  mode: EngineMode;
  // null when it is not set (or not an address: `problems` says which)
  splitter: string | null;
  burnPot: string | null;
  desk: string | null;
  // agents Factor runs itself: said on the site wherever they show (FACTOR_HOUSE_AGENTS, addresses with commas)
  houseAgents: string[];
  // ENGINE_SKIM_TO: a wallet of the owner's that the gas wallet's surplus is sent on to, or null
  skimTo: string | null;
  token: string | null; // optional: the engine reads it from the burn pot; given, it must be the same
  admin: string | null; // optional, checked against the contracts when given
  deployBlock: bigint | null;
  rpcUrls: string[];
  chainId: number;
  explorer: string;
  reindex: string;
  params: EngineParams;
  // A rehearsal on a local fork moves the chain's clock by days in minutes; with this the engine's own clock follows
  // the chain's. Never on a real node (FACTOR_REHEARSAL_CLOCK=chain is refused unless every node is on this machine).
  rehearsalClock: boolean;
  // What is missing or wrong, in plain lines. Not empty: the engine does not start (the site's feed still answers).
  problems: string[];
  // Whether a key is there. The key itself is taken with `takeBotKey` and kept nowhere else.
  hasBotKey: boolean;
  // ENGINE_ADMIN_KEY: what the owner sends to hide a name or a title somebody signed. A secret, set on the host;
  // null when it is not set, and then nothing can be hidden. It is compared and never printed or returned.
  adminKey: string | null;
  // Compute credit: whether it is served, the models and their prices. The model makers' keys themselves are taken
  // with `takeModelKey` and `takeRouterKey` and kept nowhere else.
  compute: ComputeConfig;
  // Accounts for people without a wallet: whether orders are taken, the maker of accounts, and the limits on what
  // the gas wallet pays for.
  accounts: AccountsConfig;
  // Factor's own agents: whether they are put up, the model they ask and what they may spend on it in a day.
  house: HouseConfig;
  // Pay with Factor (../pay.ts): whether links are taken, and what a deal adds to the burn.
  pay: PayConfig;
  // Agents that hire agents (../subjobs.ts): whether a job's agent can hire for it, how deep and how many.
  subjobs: SubjobsConfig;
  // Agent firms (../firms.ts): whether agents can form firms and customers hire them.
  firms: FirmsConfig;
  // Monthly clients (../plans.ts): whether customers can put an agent or a firm on a monthly plan.
  plans: PlansConfig;
  // ERC-8004 (../erc8004.ts): whether settled jobs are written to the agents' reputation, and the past ones too.
  erc8004: Erc8004Config;
  // Open jobs (../openjobs.ts): whether a customer can post a job for agents to apply to, and how many may apply.
  openJobs: OpenJobsConfig;
  // Auto-apply (../autoapply.ts): whether agents apply to open jobs on their own, under rules their owners signed.
  autoApply: AutoApplyConfig;
  // verified owners (../verified.ts): whether an agent's owner wallet can be checked, by which services, and how long it stands
  verified: VerifiedConfig;
  // agent coins (../coins.ts): whether coins are read, shown and swept, the launcher, and how often a coin is swept
  coins: CoinsConfig;
}

// A factor.env-style file: NAME=value lines. What the environment already says wins.
export function readEnvFile(path: string): Env {
  const out: Env = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function wholeNumber(env: Env, name: string, fallback: number, problems: string[], min = 0): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || !Number.isSafeInteger(Number(raw))) {
    problems.push(`${name} must be a whole number${min ? ` of at least ${min}` : ""}: it is "${raw}"`);
    return fallback;
  }
  return Number(raw);
}

function weiOf(env: Env, name: string, fallback: bigint, problems: string[]): bigint {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    problems.push(`${name} must be whole wei, as digits: it is "${raw}"`);
    return fallback;
  }
  return BigInt(raw);
}

// Gwei given as a plain decimal ("2", "0.5"), turned into wei on its digits.
function gweiOf(env: Env, name: string, fallback: bigint, problems: string[]): bigint {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(raw);
  if (!m) {
    problems.push(`${name} must be gwei as a plain decimal, like 2 or 0.5: it is "${raw}"`);
    return fallback;
  }
  return BigInt(m[1]) * GWEI + BigInt((m[2] ?? "").padEnd(9, "0"));
}

export function readParams(env: Env, problems: string[] = []): EngineParams {
  const d = DEFAULTS;
  const p: EngineParams = {
    watchEveryMs: wholeNumber(env, "ENGINE_WATCH_EVERY_MS", d.watchEveryMs, problems, 250),
    actEveryMs: wholeNumber(env, "ENGINE_ACT_EVERY_MS", d.actEveryMs, problems, 250),
    confirmations: wholeNumber(env, "ENGINE_CONFIRMATIONS", d.confirmations, problems),
    logSpan: wholeNumber(env, "ENGINE_LOG_SPAN", d.logSpan, problems, 1),
    spansPerPass: wholeNumber(env, "ENGINE_SPANS_PER_PASS", d.spansPerPass, problems, 1),
    checkpoints: wholeNumber(env, "ENGINE_CHECKPOINTS", d.checkpoints, problems, 2),
    sweepEveryS: wholeNumber(env, "ENGINE_SWEEP_EVERY_S", d.sweepEveryS, problems),
    minSweepWei: weiOf(env, "ENGINE_MIN_SWEEP_WEI", d.minSweepWei, problems),
    sweepGasMultiple: wholeNumber(env, "ENGINE_SWEEP_GAS_MULTIPLE", d.sweepGasMultiple, problems),
    burnToleranceBps: wholeNumber(env, "ENGINE_BURN_TOLERANCE_BPS", d.burnToleranceBps, problems),
    burnRetryS: wholeNumber(env, "ENGINE_BURN_RETRY_S", d.burnRetryS, problems),
    maxGasWei: gweiOf(env, "ENGINE_MAX_GAS_GWEI", d.maxGasWei, problems),
    unstickMaxGasWei: gweiOf(env, "ENGINE_UNSTICK_MAX_GAS_GWEI", d.unstickMaxGasWei, problems),
    gasCaps: { ...d.gasCaps },
    gasHeadroomBps: d.gasHeadroomBps,
    jobsPerPass: wholeNumber(env, "ENGINE_JOBS_PER_PASS", d.jobsPerPass, problems, 1),
    deskReadsPerPass: wholeNumber(env, "ENGINE_DESK_READS_PER_PASS", d.deskReadsPerPass, problems, 1),
    receiptWaitMs: wholeNumber(env, "ENGINE_RECEIPT_WAIT_MS", d.receiptWaitMs, problems),
    stuckAfterMs: wholeNumber(env, "ENGINE_STUCK_AFTER_MS", d.stuckAfterMs, problems, 1000),
    lockMs: d.lockMs,
    botGasWarnWei: weiOf(env, "ENGINE_BOT_GAS_WARN_WEI", d.botGasWarnWei, problems),
    skimKeepWei: weiOf(env, "ENGINE_SKIM_KEEP_WEI", d.skimKeepWei, problems),
    skimMinWei: weiOf(env, "ENGINE_SKIM_MIN_WEI", d.skimMinWei, problems),
    apiCacheMs: wholeNumber(env, "ENGINE_API_CACHE_MS", d.apiCacheMs, problems),
  };
  // The burn's tolerance is what a sandwich may take: never all of it, and never so loose the minimum means nothing.
  if (p.burnToleranceBps >= 1000) {
    problems.push(`ENGINE_BURN_TOLERANCE_BPS must be under 1000 (10%): it is ${p.burnToleranceBps}. A looser minimum leaves a burn open to a sandwich.`);
    p.burnToleranceBps = d.burnToleranceBps;
  }
  // The lock outlives the wait for a receipt, so a second attempt cannot start while the first is still waiting.
  p.lockMs = Math.max(d.lockMs, p.receiptWaitMs * 2 + 60_000);
  return p;
}

export function modeOf(env: Env): EngineMode | null {
  const raw = (env.ENGINE_MODE ?? "").trim().toLowerCase();
  if (raw === "") return "off";
  return (MODES as string[]).includes(raw) ? (raw as EngineMode) : null;
}

// Read the engine's configuration. Nothing here touches the chain: whether the addresses hold the right
// contracts is checked at boot, against the node (index.ts).
export function readConfig(processEnv: Env = process.env): EngineConfig {
  const problems: string[] = [];
  let env: Env = { ...processEnv };
  const file = processEnv.FACTOR_ENV_FILE?.trim();
  if (file) {
    try {
      env = { ...readEnvFile(file), ...Object.fromEntries(Object.entries(processEnv).filter(([, v]) => v !== undefined && v !== "")) };
    } catch {
      problems.push(`FACTOR_ENV_FILE names a file that cannot be read: ${file}`);
    }
  }

  const mode = modeOf(env);
  if (mode === null) problems.push(`ENGINE_MODE must be off, watch, dry or live: it is "${env.ENGINE_MODE}". Nothing runs until it is one of those.`);

  const address = (name: string, required: boolean): string | null => {
    const raw = env[name]?.trim();
    if (!raw) {
      if (required) problems.push(`${name} is not set`);
      return null;
    }
    const a = normalizeAddress(raw);
    if (!a) problems.push(`${name} is not an address: "${raw}"`);
    else if (/^0x0{40}$/.test(a)) {
      problems.push(`${name} is the zero address`);
      return null;
    }
    return a;
  };
  const running = mode !== null && mode !== "off";
  const splitter = address("FACTOR_SPLITTER", running);
  const burnPot = address("FACTOR_BURN_POT", running);
  const desk = address("FACTOR_DESK", running);
  const houseAgents: string[] = [];
  for (const raw of (env.FACTOR_HOUSE_AGENTS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const a = normalizeAddress(raw);
    if (a) houseAgents.push(a);
    else problems.push(`FACTOR_HOUSE_AGENTS holds something that is not an address: "${raw}"`);
  }
  // where the gas wallet's surplus is sent on to (ENGINE_SKIM_TO). Not set: it stays in the gas wallet
  const skimTo = address("ENGINE_SKIM_TO", false);
  if (skimTo && (skimTo === desk || skimTo === splitter || skimTo === burnPot)) problems.push("ENGINE_SKIM_TO is one of the contracts: it must be a wallet of the owner's");
  const token = address("FACTOR_TOKEN", false);
  const admin = address("FACTOR_ADMIN", false);
  if (splitter && burnPot && splitter === burnPot) problems.push("FACTOR_SPLITTER and FACTOR_BURN_POT are the same address");
  if (desk && (desk === splitter || desk === burnPot)) problems.push("FACTOR_DESK is the same address as another of the three contracts");

  let deployBlock: bigint | null = null;
  const rawBlock = env.FACTOR_DEPLOY_BLOCK?.trim();
  if (!rawBlock) {
    if (running) problems.push("FACTOR_DEPLOY_BLOCK is not set (contracts/deploy.sh writes it: the block to read logs from)");
  } else if (!/^\d+$/.test(rawBlock)) problems.push(`FACTOR_DEPLOY_BLOCK must be a block number: it is "${rawBlock}"`);
  else deployBlock = BigInt(rawBlock);

  const rawUrls = (env.FACTOR_RPC_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const rpcUrls: string[] = [];
  for (const u of rawUrls) {
    if (/^https?:\/\/[^\s/]+/.test(u)) rpcUrls.push(u);
    else problems.push("FACTOR_RPC_URLS holds something that is not an http(s) address");
  }
  if (rpcUrls.length === 0 && rawUrls.length === 0) rpcUrls.push(PUBLIC_RPC);

  const chainId = wholeNumber(env, "FACTOR_CHAIN_ID", ROBINHOOD_CHAIN_ID, problems, 1);
  const hasBotKey = !!env.BOT_PRIVATE_KEY?.trim();
  if (mode === "live" && !hasBotKey) problems.push("ENGINE_MODE is live and BOT_PRIVATE_KEY is not set: the engine has nothing to sign with. Set the key on the host, or run in dry.");
  if (hasBotKey && !/^(0x)?[0-9a-fA-F]{64}$/.test(env.BOT_PRIVATE_KEY!.trim())) {
    problems.push("BOT_PRIVATE_KEY must be 32 bytes of hex, with or without the 0x in front");
  }
  const compute = readCompute(env, problems);
  const accounts = readAccounts(env, problems);
  const house = readHouse(env, problems);
  const pay = readPay(env, problems);
  const subjobs = readSubjobs(env, problems);
  const firms = readFirms(env, problems);
  const plans = readPlans(env, problems);
  const erc8004 = readErc8004(env, problems);
  const openJobs = readOpenJobs(env, problems);
  const autoApply = readAutoApply(env, problems);
  const verified = readVerified(env, problems);
  const coins = readCoins(env, problems);
  if (accounts.factory && (accounts.factory === desk || accounts.factory === splitter || accounts.factory === burnPot)) problems.push("FACTOR_ACCOUNTS is the same address as another of the contracts");
  const rawAdmin = env.ENGINE_ADMIN_KEY?.trim() ?? "";
  if (rawAdmin && rawAdmin.length < 24) problems.push("ENGINE_ADMIN_KEY must be at least 24 characters");
  const adminKey = rawAdmin.length >= 24 ? rawAdmin : null;
  const local = (u: string): boolean => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u);
  const rehearsalClock = (env.FACTOR_REHEARSAL_CLOCK ?? "").trim().toLowerCase() === "chain";
  if (rehearsalClock && !rpcUrls.every(local)) problems.push("FACTOR_REHEARSAL_CLOCK is for a rehearsal on a local fork: it is refused while FACTOR_RPC_URLS names a real node");

  return {
    mode: mode ?? "off",
    splitter,
    burnPot,
    desk,
    houseAgents,
    skimTo,
    token,
    admin,
    deployBlock,
    rpcUrls,
    chainId,
    explorer: (env.FACTOR_EXPLORER?.trim() || CHAIN.explorer).replace(/\/+$/, ""),
    reindex: env.ENGINE_REINDEX?.trim() ?? "",
    rehearsalClock,
    params: readParams(env, problems),
    problems: mode === "off" ? problems.filter((p) => p.startsWith("ENGINE_MODE")) : problems,
    hasBotKey,
    adminKey,
    compute,
    accounts,
    house,
    pay,
    subjobs,
    firms,
    plans,
    erc8004,
    openJobs,
    autoApply,
    verified,
    coins,
  };
}

// The bot's key, as the signer wants it. Read from the environment at the moment the signer is made and held by
// nothing else. Null when it is not there or not a key.
export function takeBotKey(env: Env = process.env): `0x${string}` | null {
  const raw = env.BOT_PRIVATE_KEY?.trim();
  if (!raw || !/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) return null;
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
}

// The owner's key with the model maker, for the compute gateway. Read at the moment the gateway is made, sent only
// to the model maker, and never logged, stored or returned.
export function takeModelKey(env: Env = process.env): string | null {
  return env.ANTHROPIC_API_KEY?.trim() || null;
}

// The owner's key with OpenRouter, for the gateway's second door. The same care as the key above.
export function takeRouterKey(env: Env = process.env): string | null {
  return env.OPENROUTER_API_KEY?.trim() || null;
}

// The addresses are all there and nothing is wrong: the engine may start.
export function configured(c: EngineConfig): c is EngineConfig & { splitter: string; burnPot: string; desk: string; deployBlock: bigint } {
  return c.mode !== "off" && c.problems.length === 0 && !!c.splitter && !!c.burnPot && !!c.desk && c.deployBlock !== null;
}
