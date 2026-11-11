// What the credit report reads, all of it read-only and free: the desk's jobs and config over public RPC, each
// account's access keys over RPC, when and by whom each account was created from NearBlocks' free API, and the
// price of NEAR from the 1Click token list. Nothing needs a key. A source that does not answer is said in the report,
// never guessed.

import { DESK, NETWORK, TEST_DOLLAR, accessKeys, view } from "../lib/near.ts";
import type { DeskJob, SameHand } from "./score.ts";

const NEARBLOCKS = process.env.NEARBLOCKS_API || (NETWORK === "testnet" ? "https://api-testnet.nearblocks.io" : "https://api.nearblocks.io");
const TOP = new Set(["testnet", "near"]);
/** Accounts that create accounts for anyone (the testnet faucet, the registrars): never a link between two accounts. */
const PUBLIC_CREATORS = new Set(["testnet", "near", "registrar", "relay.aurora", "faucet.testnet", "helper.testnet"]);

export interface AccountFacts {
  keys: string[];
  createdMs?: number;
  creator?: string;
  creatorRead: boolean;
}

export interface Snapshot {
  desk: string;
  network: string;
  config: any;
  jobs: DeskJob[];
  facts: Map<string, AccountFacts>;
  nearUsd: number | null;
  nearPerUnit: Record<string, number>;
  own: Set<string>;
  carriers: Set<string>;
  sources: string[];
  readAt: number;
}

export async function readJobs(desk = DESK): Promise<DeskJob[]> {
  const out: DeskJob[] = [];
  for (let from = 0; ; from += 100) {
    const page: DeskJob[] = await view(desk, "get_jobs", { from: String(from), limit: 100 });
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

async function nearblocks(path: string): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${NEARBLOCKS}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, 2_000 * (attempt + 1)));
        continue;
      }
      if (!r.ok) return null;
      return await r.json();
    } catch {
      await new Promise((res) => setTimeout(res, 800));
    }
  }
  return null;
}

/** When, and by which account, an account was created. */
export async function creation(account: string): Promise<{ createdMs?: number; creator?: string; read: boolean }> {
  const a = await nearblocks(`/v3/accounts/${account}`);
  const hash = a?.data?.created?.transaction_hash;
  const ts = a?.data?.created?.block_timestamp;
  if (!hash) return { read: false };
  const t = await nearblocks(`/v3/txns/${hash}`);
  return { createdMs: ts ? Number(BigInt(ts) / 1_000_000n) : undefined, creator: t?.data?.signer_account_id, read: !!t?.data };
}

export async function nearPrice(): Promise<number | null> {
  try {
    const r = await fetch("https://1click.chaindefuser.com/v0/tokens", { signal: AbortSignal.timeout(15_000) });
    const t: any[] = await r.json();
    return t.find((x) => x.assetId === "nep141:wrap.near")?.price ?? null;
  } catch {
    return null;
  }
}

export const parentOf = (a: string): string | null => {
  if (/^[0-9a-f]{64}$/.test(a) || a.startsWith("0x")) return null;
  const p = a.split(".").slice(1).join(".");
  return p && !TOP.has(p) ? p : null;
};

/** The same-hand rule from the facts read: sub-accounts, shared parents, shared keys, and who created whom. */
export function sameHandFrom(facts: Map<string, AccountFacts>): SameHand {
  return (a, b) => {
    if (a === b) return `${a} is the same account`;
    if (a.endsWith(`.${b}`)) return `${a} is a sub-account of ${b}`;
    if (b.endsWith(`.${a}`)) return `${b} is a sub-account of ${a}`;
    const pa = parentOf(a);
    if (pa && pa === parentOf(b)) return `${a} and ${b} are both sub-accounts of ${pa}`;
    const fa = facts.get(a);
    const fb = facts.get(b);
    if (fa && fb) {
      const shared = fa.keys.find((k) => fb.keys.includes(k));
      if (shared) return `${a} and ${b} share an access key`;
      if (fa.creator === b) return `${b} created ${a}`;
      if (fb.creator === a) return `${a} created ${b}`;
      if (fa.creator && fa.creator === fb.creator && !PUBLIC_CREATORS.has(fa.creator)) return `${a} and ${b} were both created by ${fa.creator}`;
    }
    return null;
  };
}

export async function snapshot(desk = DESK): Promise<Snapshot> {
  const sources: string[] = [];
  const config = await view(desk, "get_config");
  const jobs = await readJobs(desk);
  sources.push(`${jobs.length} jobs from ${desk} over public RPC`);
  const accounts = new Set<string>();
  for (const j of jobs) [j.customer, j.payer, j.agent].forEach((x) => x && accounts.add(x));
  const facts = new Map<string, AccountFacts>();
  let creatorsRead = 0;
  for (const a of accounts) {
    const keys = await accessKeys(a);
    const c = await creation(a);
    if (c.read) creatorsRead++;
    facts.set(a, { keys, createdMs: c.createdMs, creator: c.creator, creatorRead: c.read });
  }
  sources.push(`access keys of ${accounts.size} accounts over public RPC`);
  sources.push(`who created ${creatorsRead} of ${accounts.size} accounts from NearBlocks' free API`);
  const nearUsd = await nearPrice();
  const nearPerUnit: Record<string, number> = {};
  if (nearUsd) {
    // the testnet test dollar stands in for USDC: one unit is a millionth of a dollar
    for (const t of config.tokens as { token: string }[]) if (t.token === TEST_DOLLAR || t.token.includes("usdc")) nearPerUnit[t.token] = 1e-6 / nearUsd;
    sources.push(`the price of NEAR from the 1Click token list: $${nearUsd}`);
  } else sources.push("the price of NEAR could not be read: token jobs are not valued");
  const carriers = new Set(["intents.near", process.env.INTENTS_STANDIN || `intents-standin.${desk}`]);
  const own = new Set([desk, config.fee_account as string, ...[...accounts].filter((a) => a.endsWith(`.${desk}`) && !carriers.has(a))]);
  return { desk, network: NETWORK, config, jobs, facts, nearUsd, nearPerUnit, own, carriers, sources, readAt: Date.now() };
}
