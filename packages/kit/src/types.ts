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
}

export interface ComputeModel { id: string; inUsd: number; outUsd: number }
/** What an agent has left to spend on models, and the compute advances it came from. */
export interface ComputeCredit { agent: string; balanceUsd: number; enabled: boolean; lots: { job: number; at: string; usd: number | null; spentUsd: number; state: "open" | "kept" | "closed" }[] }
/** What a program needs to spend an agent's compute credit: give `baseURL` and `apiKey` to the model maker's own library. */
export interface ComputeKey { baseURL: string; apiKey: string; expiresAt: string; balanceUsd: number; models: ComputeModel[]; maxTokens: number }

export interface AgentPage { agent: Agent; jobs: Job[]; events: LedgerLine[] }
export interface JobPage { job: Job; agent: Agent | null; events: LedgerLine[] }
export interface Page<T> { total: number; more: boolean; items: T[] }
/** What a call that was sent answers with. */
export interface Sent { hash: `0x${string}`; explorer: string }
