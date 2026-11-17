// The Recoverable mark, with Upoch (docs/RELEASE-recoverable.md). Upoch runs agent workflows with checkpoints on the chain
// and a way to restore them: its Epoch contract on Robinhood Chain keeps each workflow's owner, executors, guardians,
// policy and checkpoints. Factor reads it, read only, and marks an agent Recoverable when at least ONE Upoch workflow
// linked to it passes all four, the rule agreed with Upoch:
//
//   1. linked    the agent's ERC-8004 identity owner or its agentWallet is the workflow's owner or one of its executors
//   2. active    the workflow is Active, not Paused
//   3. recent    its head checkpoint (getCheckpoint(id, headSequence).timestamp) is at most 7 days old, for every agent
//   4. guardian  at least one guardian and guardianThreshold >= 1. A timelock alone does not count: it only delays the
//                owner's own rollback. Checkpoints alone never count.
//
//   GET /v1/recoverable     whether it is on, the rule, the contract, when it was read, and every Recoverable agent
//
// An agent's mark and its evidence are in its credit report (./reports.ts, "recovery") and on its desk page's answer
// (./api.ts, "recoverable"). It changes no score and moves no money.
//
// How it is read: workflowCount, then for each workflow getWorkflow, getGuardians, getExecutors and the head checkpoint,
// as plain view calls at the head (never logs). Every RECOVERABLE_EVERY_S (600) and when a report asks for an older
// reading, in the background: a page never waits on the chain. A reading that fails keeps the last good one; once
// nothing good has been read for a while (three intervals, at least 30 minutes) no mark is shown at all, rather than a
// wrong one. An age is always worked out at the moment it is asked for, so a checkpoint grows older between readings.
//
// Switches: RECOVERABLE=on (off unless it is said) reads and shows it; the owner's "recoverable" switch (./switches.ts)
// hides every mark at once and stops the reading, without a restart.
//
// Upoch Verified: Upoch's own status for a workflow (active, a checkpoint in the last 7 days, a guardian), read from
// UPOCH_VERIFIED_URL/api/verified/<id> after each good reading of the contract and shown beside the workflow it is for.
// It is Upoch's word, said as theirs, with a link to its page there; it never decides the Recoverable mark and changes no
// score. A status that cannot be read, or is older than a good reading may stand, is not shown at all. UPOCH_VERIFIED=off
// stops it.

import { getAddress, parseAbi, type Abi } from "viem";
import type { Chain } from "./chain/chain.js";
import type { EngineDb } from "./chain/db.js";
import { stopped } from "./switches.js";

type Env = Record<string, string | undefined>;

/** Upoch's Epoch contract on Robinhood Chain (chain 4663). */
export const UPOCH_EPOCH = "0x6179d9123c3c1f9e82f948101a4350cb55aa8c27";
/** The rule's window: a head checkpoint at most this many days old. Fixed, the same for every agent. */
export const RECENT_DAYS = 7;
/** Workflow status 0 is Active in the Epoch contract; 1 is Paused. */
const ACTIVE = 0;
const PAUSED = 1;
/** The most workflows one reading reads: the newest, should the contract ever hold more. */
const MOST_WORKFLOWS = 2000;

export const epochAbi = parseAbi([
  "function workflowCount() view returns (uint256)",
  "function getWorkflow(uint256) view returns ((address owner,address pendingOwner,uint8 status,(uint8 guardianThreshold,bool ownerApprovalRequired,uint32 ownerFallbackDelay,uint32 timelock,uint32 approvalWindow,uint32 executionWindow) policy,uint64 checkpointCount,uint64 headSequence,bytes32 headHash,uint256 activeProposalId,string metadataURI))",
  "function getCheckpoint(uint256,uint64) view returns ((bytes32 checkpointHash,bytes32 parentHash,uint64 parentSequence,bytes32 stateHash,bytes32 traceHash,bytes32 dataURIHash,address submitter,uint64 timestamp))",
  "function getGuardians(uint256) view returns (address[])",
  "function getExecutors(uint256) view returns (address[])",
]);

// ---------- the configuration ----------

export interface RecoverableConfig {
  /** RECOVERABLE=on: off unless it is said */
  enabled: boolean;
  contract: string;
  /** RECOVERABLE_EVERY_S: seconds between readings of the contract */
  everyS: number;
  /** UPOCH_VERIFIED: on unless it is said off. Upoch's own Verified status for each workflow, read from its API */
  verified: boolean;
  /** UPOCH_VERIFIED_URL: Upoch's site, https */
  verifiedUrl: string;
}

export function readRecoverable(env: Env, problems: string[] = []): RecoverableConfig {
  const raw = (env.RECOVERABLE ?? "").trim().toLowerCase();
  if (raw && raw !== "on" && raw !== "off") problems.push(`RECOVERABLE must be on or off: it is "${env.RECOVERABLE}"`);
  let everyS = 600;
  const e = env.RECOVERABLE_EVERY_S?.trim();
  if (e) {
    if (/^\d{1,6}$/.test(e) && Number(e) >= 60 && Number(e) <= 86_400) everyS = Number(e);
    else problems.push(`RECOVERABLE_EVERY_S must be a whole number from 60 to 86400: it is "${e}"`);
  }
  const v = (env.UPOCH_VERIFIED ?? "").trim().toLowerCase();
  if (v && v !== "on" && v !== "off") problems.push(`UPOCH_VERIFIED must be on or off: it is "${env.UPOCH_VERIFIED}"`);
  let verifiedUrl = "https://upoch.tech";
  const u = env.UPOCH_VERIFIED_URL?.trim().replace(/\/+$/, "");
  if (u) {
    if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u)) verifiedUrl = u;
    else problems.push(`UPOCH_VERIFIED_URL must be an https site with no path: it is "${env.UPOCH_VERIFIED_URL}"`);
  }
  return { enabled: raw === "on", contract: UPOCH_EPOCH, everyS, verified: v !== "off", verifiedUrl };
}

// ---------- the rule ----------

/** One workflow as the Epoch contract holds it, addresses in lower case. */
export interface WorkflowRead {
  id: number;
  owner: string;
  executors: string[];
  guardians: string[];
  status: number;
  guardianThreshold: number;
  timelockSeconds: number;
  checkpoints: number;
  /** seconds: the head checkpoint's timestamp, or null with no checkpoint */
  lastCheckpointAt: number | null;
}

/** The two wallets of an agent the rule links by: its ERC-8004 identity's owner and its agentWallet. */
export interface AgentWallets { owner: string | null; agentWallet: string | null }

export interface WorkflowLink { wallet: string; is: "owner" | "agentWallet"; as: "owner" | "executor" }

/** One linked workflow, with each of the four conditions and the evidence for them. */
export interface WorkflowJson {
  id: number;
  name: string;
  recoverable: boolean;
  link: WorkflowLink[];
  /** "agentWallet": the agent's own wallet is the workflow's owner or an executor. "owner": only its ERC-8004 owner is,
   * as when one deployer runs workflows for several agents, so the workflow may belong to another agent of that owner. */
  via: "agentWallet" | "owner" | null;
  active: boolean;
  status: "active" | "paused" | "other";
  recent: boolean;
  lastCheckpointAt: string | null;
  /** days, to one decimal, at the moment of asking */
  ageDays: number | null;
  checkpoints: number;
  guardian: boolean;
  guardians: number;
  guardianThreshold: number;
  timelockSeconds: number;
  /** what keeps it from counting, in words; empty when it counts */
  why: string[];
  /** Upoch's own Verified status for this workflow, as Upoch says it; absent when it could not be read lately */
  upoch?: UpochVerified;
}

/** Upoch Verified for one workflow, from Upoch's API: its word, with the page anyone can check it on. */
export interface UpochVerified {
  verified: boolean;
  /** Upoch's checks, each as it says it */
  checks: { label: string; ok: boolean }[];
  /** the workflow's page on Upoch, made here from the id, never taken from the answer */
  page: string;
  readAt: string;
}

/** An agent's mark and its evidence. */
export interface RecoveryJson {
  recoverable: boolean;
  source: "upoch";
  /** the line on its report */
  line: string;
  /** the workflow that makes it Recoverable (the best one), or, when none does, the linked one closest to it */
  workflow: WorkflowJson;
  /** every workflow linked to it: through the agent's own wallet first, then those only its owner runs; those that count first */
  workflows: WorkflowJson[];
  rule: { recentDays: number; text: string };
  contract: string;
  contractUrl: string | null;
  readAt: string;
}

export const RULE_TEXT = `Recoverable when at least one Upoch workflow linked to the agent (its ERC-8004 owner or agentWallet is the workflow's owner or an executor) is active, has a checkpoint in the last ${RECENT_DAYS} days, and has at least one guardian with a threshold of 1 or more. A timelock alone does not count, and checkpoints alone never count.`;
export const MARK_LINE = "Recoverable, checkpoints and recovery on Upoch";

const lower = (a: string | null | undefined): string | null => (a ? a.toLowerCase() : null);

/** How an agent is linked to a workflow: by which of its wallets, as the workflow's owner or an executor. Empty: not linked. */
export function linksOf(w: WorkflowRead, who: AgentWallets): WorkflowLink[] {
  const out: WorkflowLink[] = [];
  const owner = lower(w.owner), executors = w.executors.map((x) => x.toLowerCase());
  for (const [is, wallet] of [["agentWallet", lower(who.agentWallet)], ["owner", lower(who.owner)]] as const) {
    if (!wallet || /^0x0{40}$/.test(wallet)) continue;
    if (wallet === owner) out.push({ wallet, is, as: "owner" });
    if (executors.includes(wallet)) out.push({ wallet, is, as: "executor" });
  }
  return out;
}

/** The four conditions for one workflow, at `nowS` (seconds). `link` is how the agent is linked to it. */
export function judgeWorkflow(w: WorkflowRead, nowS: number, link: WorkflowLink[] = []): WorkflowJson {
  const linked = link.length > 0;
  const active = w.status === ACTIVE;
  const age = w.lastCheckpointAt === null ? null : Math.max(0, nowS - w.lastCheckpointAt) / 86_400;
  const recent = age !== null && age <= RECENT_DAYS;
  const guardian = w.guardians.length > 0 && w.guardianThreshold >= 1;
  const why: string[] = [];
  if (!linked) why.push("not linked to the agent's owner or agentWallet");
  if (!active) why.push(w.status === PAUSED ? "paused" : "not active");
  if (age === null) why.push("no checkpoint yet");
  else if (!recent) why.push(`its last checkpoint is ${age.toFixed(1)} days old, more than ${RECENT_DAYS}`);
  if (!guardian) why.push(w.timelockSeconds > 0 ? "only a timelock, no guardian" : "no guardian");
  return {
    id: w.id, name: `Upoch workflow #${w.id}`, recoverable: linked && active && recent && guardian, link,
    via: link.some((l) => l.is === "agentWallet") ? "agentWallet" : linked ? "owner" : null,
    active, status: active ? "active" : w.status === PAUSED ? "paused" : "other",
    recent, lastCheckpointAt: w.lastCheckpointAt === null ? null : new Date(w.lastCheckpointAt * 1000).toISOString(), ageDays: age === null ? null : Math.round(age * 10) / 10,
    checkpoints: w.checkpoints, guardian, guardians: w.guardians.length, guardianThreshold: w.guardianThreshold, timelockSeconds: w.timelockSeconds, why,
  };
}

/** How close a workflow comes, for picking the one shown: those that count, then the agent's own wallet, then the freshest. */
const rank = (j: WorkflowJson): number[] => [j.recoverable ? 1 : 0, [j.active, j.recent, j.guardian].filter(Boolean).length, j.link.some((l) => l.is === "agentWallet") ? 1 : 0, j.link.some((l) => l.as === "executor") ? 1 : 0, j.lastCheckpointAt ? Date.parse(j.lastCheckpointAt) : 0, -j.id];
const better = (a: WorkflowJson, b: WorkflowJson): number => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i]! - x[i]!; return 0; };

/** An agent's mark from the workflows read: null when no workflow is linked to it. */
export function recoveryOf(who: AgentWallets, workflows: WorkflowRead[], nowS: number, o: { readAt: number; contract?: string; explorer?: string | null; upoch?: (id: number) => UpochVerified | null }): RecoveryJson | null {
  const linked = workflows.map((w) => ({ w, link: linksOf(w, who) })).filter((x) => x.link.length > 0).map((x) => {
    const j = judgeWorkflow(x.w, nowS, x.link);
    const u = o.upoch?.(x.w.id);
    return u ? { ...j, upoch: u } : j;
  }).sort(better);
  if (!linked.length) return null;
  const best = linked[0]!;
  const contract = getAddress(o.contract ?? UPOCH_EPOCH);
  return {
    recoverable: best.recoverable, source: "upoch",
    line: best.recoverable ? MARK_LINE : `Not Recoverable now. ${best.name}: ${best.why.join(", ")}.`,
    workflow: best, workflows: [...linked.filter((x) => x.via === "agentWallet"), ...linked.filter((x) => x.via !== "agentWallet")], rule: { recentDays: RECENT_DAYS, text: RULE_TEXT },
    contract, contractUrl: o.explorer ? `${o.explorer}/address/${contract}` : null, readAt: new Date(o.readAt).toISOString(),
  };
}

// ---------- the reading ----------

export interface RecoverableDeps {
  db: EngineDb;
  chain: Pick<Chain, "read">;
  /** the chain's explorer, for the contract's link */
  explorer: string | null;
  /** the wall clock, ms */
  now: () => number;
  log: (line: string) => void;
  /** for Upoch's API: the engine gives the global fetch; without one Upoch Verified is not read */
  fetch?: typeof fetch;
}

/** Upoch's answer for one workflow, checked: null when it is not what Upoch's API says it answers. */
export function parseUpochVerified(id: number, body: unknown, base: string, at: number): UpochVerified | null {
  const b = body as { workflowId?: unknown; verified?: unknown; checks?: unknown } | null;
  if (!b || typeof b !== "object" || Number(b.workflowId) !== id || typeof b.verified !== "boolean") return null;
  const checks = Array.isArray(b.checks)
    ? b.checks.flatMap((c: { label?: unknown; ok?: unknown }) => (c && typeof c.label === "string" && typeof c.ok === "boolean" ? [{ label: c.label.slice(0, 80), ok: c.ok }] : [])).slice(0, 8)
    : [];
  return { verified: b.verified, checks, page: `${base}/verified/${id}`, readAt: new Date(at).toISOString() };
}

/** The most workflows Upoch's API is asked about after one reading: the newest. */
const MOST_VERIFIED = 200;

interface Reading { at: number; workflows: WorkflowRead[] }

export class Recoverable {
  private last: Reading | null = null;
  private busy: Promise<string> | null = null;
  private lastTryAt = 0;
  private failures = 0;
  private lastError: string | null = null;
  /** Upoch Verified by workflow id, with when it was read (ms) */
  private upoch = new Map<number, { v: UpochVerified; at: number }>();
  private upochRun: Promise<void> | null = null;
  private upochFailing = false;

  constructor(readonly cfg: RecoverableConfig, private d: RecoverableDeps) {}

  on(): boolean {
    return this.cfg.enabled && !stopped(this.d.db, "recoverable");
  }

  /** How long a good reading stands while newer ones fail: three intervals, at least 30 minutes. */
  private get standsMs(): number {
    return Math.max(3 * this.cfg.everyS, 1800) * 1000;
  }

  /** A good reading that is recent enough to show, or null: then no mark is shown anywhere. */
  private reading(): Reading | null {
    if (!this.on() || !this.last) return null;
    return this.d.now() - this.last.at <= this.standsMs ? this.last : null;
  }

  private read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.d.chain.read<T>({ to: this.cfg.contract, abi: epochAbi as Abi, functionName, args });
  }

  /** One workflow, every part of it read at the head. */
  private async workflow(id: number): Promise<WorkflowRead> {
    const [w, guardians, executors] = await Promise.all([
      this.read<{ owner: string; status: number; policy: { guardianThreshold: number; timelock: number }; checkpointCount: bigint; headSequence: bigint }>("getWorkflow", [BigInt(id)]),
      this.read<readonly string[]>("getGuardians", [BigInt(id)]),
      this.read<readonly string[]>("getExecutors", [BigInt(id)]),
    ]);
    const count = Number(w.checkpointCount);
    const head = count > 0 ? await this.read<{ timestamp: bigint }>("getCheckpoint", [BigInt(id), w.headSequence]) : null;
    return {
      id, owner: w.owner.toLowerCase(), executors: executors.map((x) => x.toLowerCase()), guardians: guardians.map((x) => x.toLowerCase()),
      status: Number(w.status), guardianThreshold: Number(w.policy.guardianThreshold), timelockSeconds: Number(w.policy.timelock),
      checkpoints: count, lastCheckpointAt: head ? Number(head.timestamp) : null,
    };
  }

  /** Read every workflow again. A failure keeps the last good reading and is said in the log once. Returns what it did. */
  refresh(): Promise<string> {
    if (!this.on()) return Promise.resolve("recoverable is off");
    if (this.busy) return this.busy;
    this.lastTryAt = this.d.now();
    this.busy = (async () => {
      try {
        const count = Number(await this.read<bigint>("workflowCount"));
        const first = Math.max(1, count - MOST_WORKFLOWS + 1);
        const workflows: WorkflowRead[] = [];
        // four workflows at a time: a few view calls each, never a burst at the node
        for (let id = first; id <= count; id += 4) {
          const ids = Array.from({ length: Math.min(4, count - id + 1) }, (_, i) => id + i);
          workflows.push(...(await Promise.all(ids.map((n) => this.workflow(n)))));
        }
        this.last = { at: this.d.now(), workflows };
        if (this.failures) this.d.log("[recoverable] Upoch's contract answers again");
        this.failures = 0;
        this.lastError = null;
        this.readUpoch(workflows.map((w) => w.id)).catch(() => undefined);
        return `read ${workflows.length} workflow${workflows.length === 1 ? "" : "s"}, ${this.recoverableWorkflows().length} recoverable`;
      } catch (e) {
        const m = ((e as Error).message ?? String(e)).split("\n")[0]!.slice(0, 200);
        if (!this.failures) this.d.log(`[recoverable] Upoch's contract could not be read (${m}): the last reading stands for a while, then no mark is shown`);
        this.failures++;
        this.lastError = m;
        throw e;
      } finally {
        this.busy = null;
      }
    })();
    return this.busy;
  }

  /** Upoch Verified for the workflows read, a few at a time; a workflow that cannot be read keeps nothing new. Never throws
   * into a reading of the contract, and is said in the log once while Upoch's API does not answer. */
  readUpoch(ids: number[]): Promise<void> {
    if (!this.cfg.verified || !this.on() || !this.d.fetch) return Promise.resolve();
    if (this.upochRun) return this.upochRun;
    const f = this.d.fetch;
    this.upochRun = (async () => {
      let ok = 0, failed = 0;
      const want = ids.slice(-MOST_VERIFIED);
      for (let i = 0; i < want.length; i += 4) {
        await Promise.all(want.slice(i, i + 4).map(async (id) => {
          try {
            const res = await f(`${this.cfg.verifiedUrl}/api/verified/${id}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
            if (res.status === 404) { this.upoch.delete(id); ok++; return; }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const v = parseUpochVerified(id, await res.json(), this.cfg.verifiedUrl, this.d.now());
            if (!v) throw new Error("an answer Factor does not read");
            this.upoch.set(id, { v, at: this.d.now() });
            ok++;
          } catch {
            failed++;
          }
        }));
      }
      if (failed && !ok && !this.upochFailing) { this.d.log("[recoverable] Upoch's API does not answer: Upoch Verified is not shown once the last status is old"); this.upochFailing = true; }
      if (ok && this.upochFailing) { this.d.log("[recoverable] Upoch's API answers again"); this.upochFailing = false; }
    })().finally(() => { this.upochRun = null; });
    return this.upochRun;
  }

  /** Upoch Verified for one workflow, while it is recent enough to show: null otherwise. */
  private upochOf(id: number): UpochVerified | null {
    if (!this.cfg.verified) return null;
    const x = this.upoch.get(id);
    return x && this.d.now() - x.at <= this.standsMs ? x.v : null;
  }

  /** A reading in the background when the last is older than the interval: what a report calls, never waiting on it. */
  refreshIfDue(): void {
    if (!this.on() || this.busy) return;
    const age = this.d.now() - Math.max(this.last?.at ?? 0, this.lastTryAt);
    if (age >= this.cfg.everyS * 1000) this.refresh().catch(() => undefined);
  }

  /** The workflows that pass all but the link: the ones an agent can be Recoverable by, now. */
  private recoverableWorkflows(nowS = Math.floor(this.d.now() / 1000)): WorkflowRead[] {
    const r = this.last;
    return r ? r.workflows.filter((w) => judgeWorkflow(w, nowS, [{ wallet: w.owner, is: "owner", as: "owner" }]).recoverable) : [];
  }

  /** An agent's mark and its evidence, from the last good reading: null when off, not read, or no workflow is linked to it. */
  of(who: AgentWallets): RecoveryJson | null {
    this.refreshIfDue();
    const r = this.reading();
    if (!r || (!who.owner && !who.agentWallet)) return null;
    return recoveryOf(who, r.workflows, Math.floor(this.d.now() / 1000), { readAt: r.at, contract: this.cfg.contract, explorer: this.d.explorer, upoch: (id) => this.upochOf(id) });
  }

  /** The wallets an agent can be linked by to a workflow that counts now: owners and executors. */
  wallets(): string[] {
    if (!this.reading()) return [];
    return [...new Set(this.recoverableWorkflows().flatMap((w) => [w.owner, ...w.executors]))];
  }

  /** What /v1/recoverable says of the whole, without the agents. */
  about(): Record<string, unknown> {
    const r = this.reading();
    const contract = getAddress(this.cfg.contract);
    return {
      enabled: this.on(), source: "upoch", rule: { recentDays: RECENT_DAYS, text: RULE_TEXT },
      contract, contractUrl: this.d.explorer ? `${this.d.explorer}/address/${contract}` : null,
      readAt: r ? new Date(r.at).toISOString() : null, everyS: this.cfg.everyS,
      workflows: r ? r.workflows.length : null, recoverableWorkflows: r ? this.recoverableWorkflows().map((w) => w.id) : null,
      upochVerified: this.cfg.verified ? { source: `${this.cfg.verifiedUrl}/api/verified/<id>`, workflows: r ? r.workflows.flatMap((w) => { const u = this.upochOf(w.id); return u ? [{ id: w.id, verified: u.verified, page: u.page }] : []; }) : [] } : null,
    };
  }

  health(): Record<string, unknown> {
    return { enabled: this.cfg.enabled, on: this.on(), readAt: this.last ? new Date(this.last.at).toISOString() : null, shown: !!this.reading(), workflows: this.last?.workflows.length ?? null, failures: this.failures, lastError: this.lastError, upochVerified: this.cfg.verified ? { read: this.upoch.size, failing: this.upochFailing } : null };
  }
}
