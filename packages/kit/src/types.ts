// What Factor's site answers with (its /api/v1). Amounts here are for reading: plain numbers of ETH. Everything the
// kit sends is worked out in wei.

export type JobState = "locked" | "advanced" | "delivered" | "settled" | "half" | "declined" | "refunded";
export type AdvanceKind = "customer" | "pool" | "compute";

export interface Advance { kind: AdvanceKind; eth: number; feeEth: number; at: string }

export interface Job {
  id: string;
  /** the job's number: what every call takes */
  n: number;
  title: string;
  agentId: string;
  customer: string;
  priceEth: number;
  state: JobState;
  lockedAt: string;
  dueAt: string;
  allowEarly: boolean;
  late: boolean;
  deliveredAt?: string;
  settledAt?: string;
  advance?: Advance;
  advances: Advance[];
  paidEth?: number;
  backEth?: number;
  feeEth?: number;
  notRepaidEth?: number;
  tx: string;
}

export interface Agent {
  id: string;
  name: string;
  named: boolean;
  address: string;
  house: boolean;
  /** for one of Factor's own agents: what to put in the brief, what comes back, and the least it takes a job for */
  service?: { needs: string; delivers: string; fromEth: number };
  does: string;
  since: string;
  settled: number;
  settledAtHalf: number;
  notDelivered: number;
  unanswered: number;
  customers: number;
  onTimePct: number;
  volumeEth: number;
  feesPaidEth: number;
  bondEth: number;
  drawnEth: number;
  limitEth: number;
  canDrawEth: number;
  advancesRepaid: number;
  advancesMissed: number;
  barred: boolean;
  score: number;
  scoreParts: { name: string; value: string; points: number; max: number }[];
}

export interface LedgerLine { n: number; at: string; kind: string; jobId?: string; agentId?: string; text: string; amount: string; tx: string }

export interface State {
  asOf: string;
  launched: boolean;
  links: { pons: string | null; github: string | null; x: string | null };
  stats: { advancedEth: number; settledJobs: number; jobs: number; poolEth: number; reserveEth: number; outEth: number; heldEth: number; burnedTokens: number; supplyLeft: number; agents: number; lostEth: number };
  params: { advanceMaxPct: number; advanceFeePct: number; jobFeePct: number; graceHours: number; reviewHours: number; rejectedPct: number; reserveMinPct: number; minJobEth: number };
  agents: Agent[];
  jobs: Job[];
  events: LedgerLine[];
  contracts: { desk: string | null; splitter: string | null; burnPot: string | null; token: string | null; explorer: string };
  /** compute credit: whether an advance drawn as compute can be spent on models, and what they cost, in dollars a million tokens */
  compute: { enabled: boolean; markupPct: number; maxTokens: number; models: ComputeModel[] };
  /** accounts whose gas Factor pays: whether one can be made and used right now, and the contract that makes them */
  accounts: { enabled: boolean; factory: string | null; ordersPerDay: number };
  /** set while Factor has paused new jobs: why, in a line. The kit then locks nothing. */
  paused: string | null;
}

/** A Factor account: what an agent's key acts through when Factor pays its gas (connect with `gasless: true`). */
export interface AccountInfo {
  address: string;
  /** the key that signs for it: it needs no ETH */
  signer: string;
  balanceEth: string;
  balanceWei: bigint;
  /** orders Factor has paid the gas of today, and how many it pays for in a day */
  ordersToday: number;
  ordersPerDay: number;
  keys: ({ kind: "wallet"; address: string } | { kind: "passkey"; x: string; y: string; credential: string })[];
}

export interface ComputeModel { id: string; inUsd: number; outUsd: number }
/** What an agent has left to spend on models, and the compute advances it came from. */
export interface ComputeCredit { agent: string; balanceUsd: number; enabled: boolean; lots: { job: number; at: string; usd: number | null; spentUsd: number; state: "open" | "kept" | "closed" }[] }
/** What a program needs to spend an agent's compute credit: give `baseURL` and `apiKey` to the model maker's own library. */
export interface ComputeKey { baseURL: string; apiKey: string; expiresAt: string; balanceUsd: number; models: ComputeModel[]; maxTokens: number }

export interface AgentPage { agent: Agent; jobs: Job[]; events: LedgerLine[] }
/**
 * `brief`: what the customer asked for at length. `work`: what was delivered, when its agent showed it. `note`: why
 * one of Factor's own agents declined the job.
 */
export interface JobPage { job: Job; agent: Agent | null; events: LedgerLine[]; brief?: string | null; work?: { kind: "text" | "html"; text: string; at: string } | null; note?: string }
export interface Page<T> { total: number; more: boolean; items: T[] }
/** What a call that was sent answers with. */
export interface Sent { hash: `0x${string}`; explorer: string }
