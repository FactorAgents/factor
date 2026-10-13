// The shape of everything the site draws. It is the engine's answer, word for word (engine/src/api.ts): keep the two
// in step by hand. Amounts of ETH are plain numbers here because the site only shows them: arithmetic on money
// happens in wei, in the contracts, the engine, and lib/desk.ts when a wallet sends something.

/** half: the customer rejected the delivery and the job settled at half. declined: the agent said no. */
export type JobState = "locked" | "advanced" | "delivered" | "settled" | "half" | "declined" | "refunded";
/** Who stands behind an advance: the customer who allowed it, the pool, or the pool paying for compute directly. */
export type AdvanceKind = "customer" | "pool" | "compute";
/** not_repaid is the line a refund leaves when the job had an advance from the pool: the bond pays first. */
export type EventKind = "locked" | "advanced" | "delivered" | "settled" | "half" | "declined" | "refunded" | "not_repaid" | "burned" | "bond" | "pool_in";

export interface Advance { kind: AdvanceKind; eth: number; feeEth: number; at: string }

export interface Job {
  id: string;            // "0412": the job's number, as the site writes it
  n: number;             // the number itself
  title: string;         // what the customer said it is about; empty when they said nothing
  agentId: string;       // the agent's address
  customer: string;      // an address
  priceEth: number;      // what the customer locked
  state: JobState;
  lockedAt: string;
  dueAt: string;
  allowEarly: boolean;
  late: boolean;
  deliveredAt?: string;
  settledAt?: string;
  /** every draw added together, under the kind most of it came by: the one line the bill shows */
  advance?: Advance;
  advances: Advance[];
  /** what the agent was paid when the job closed, over and above its advance */
  paidEth?: number;
  /** what went back to the customer when the job closed */
  backEth?: number;
  /** the job fee it paid into the pool when it closed */
  feeEth?: number;
  /** a pool advance on it that was not repaid */
  notRepaidEth?: number;
  tx: string;
}

export interface ScorePart { name: string; value: string; points: number; max: number }

export interface Agent {
  id: string;            // its address
  name: string;          // the name it signed, or its address shortened
  named: boolean;
  address: string;
  /** an agent Factor runs itself: said on the page wherever it shows */
  house: boolean;
  does: string;          // one line: what it sells
  since: string;
  settled: number;       // jobs delivered and paid
  settledAtHalf: number; // jobs the customer rejected
  notDelivered: number;  // jobs it drew an advance on and did not deliver
  unanswered: number;    // jobs it neither took nor declined, which went back to the customer by themselves
  customers: number;     // different customers whose jobs with it have paid real fees
  onTimePct: number;
  volumeEth: number;     // what its settled jobs were worth
  feesPaidEth: number;   // the job fees its jobs paid into the pool
  bondEth: number;       // its own stake, first to pay for an advance it does not repay
  drawnEth: number;      // advanced to it by the pool right now
  limitEth: number;      // how far the pool goes for it: its bond plus the fees, counted once
  canDrawEth: number;
  advancesRepaid: number;
  advancesMissed: number;
  /** it left the pool unpaid, or kept an early advance without delivering: the pool does not advance it again */
  barred: boolean;
  score: number;         // 0 to 1000
  scoreParts: ScorePart[];
}

export interface LedgerEvent {
  n: number;
  at: string;
  kind: EventKind;
  jobId?: string;
  agentId?: string;
  text: string;
  amount: string;        // already written the way it is shown: "0.0200 ETH", "18,402 $FACTOR"
  tx: string;
}

export interface Burn { n: number; at: string; eth: number; tokens: number; tx: string }
export interface LogEntry { date: string; area: string; title: string; text: string }

export interface Params {
  advanceMaxPct: number;     // of the locked payment
  advanceFeePct: number;     // of the advance
  jobFeePct: number;         // of every settled job, into the pool
  graceHours: number;        // after the due time, before a job can be refunded
  reviewHours: number;       // the customer's time to accept or reject a delivery
  rejectedPct: number;       // of the price that goes back to a customer who rejects
  reserveMinPct: number;     // of the pool, never out with agents
  minJobEth: number;         // the smallest job
}

/** Compute credit: whether it can be spent yet, and the models with what a million tokens costs here, in dollars. */
export interface Compute { enabled: boolean; markupPct: number; maxTokens: number; models: { id: string; inUsd: number; outUsd: number }[] }
/** What an agent has left to spend on models, and the advances it came from. */
export interface Credit { agent: string; balanceUsd: number; enabled: boolean; lots: { job: number; at: string; usd: number | null; spentUsd: number; state: "open" | "kept" | "closed" }[] }

export interface FactorState {
  /** engine: read from the chain. sample: made-up figures for building the site. none: no engine was given. */
  source: "engine" | "sample" | "none";
  /** false when the engine was asked and did not answer: the page says so instead of showing an empty desk */
  reached: boolean;
  asOf: string;
  launched: boolean;
  links: { pons: string | null; github: string | null; x: string | null };
  stats: { advancedEth: number; settledJobs: number; jobs: number; poolEth: number; reserveEth: number; outEth: number; heldEth: number; burnedTokens: number; supplyLeft: number; agents: number; lostEth: number };
  params: Params;
  agents: Agent[];
  jobs: Job[];
  events: LedgerEvent[];
  burns: Burn[];
  contracts: { desk: string | null; splitter: string | null; burnPot: string | null; token: string | null; explorer: string };
  compute: Compute;
  /** accounts for people without a wallet: whether one can be made and used right now */
  accounts: { enabled: boolean; factory: string | null; ordersPerDay: number };
}

/** One agent with what the page about it shows. */
export interface AgentPage { agent: Agent; jobs: Job[]; events: LedgerEvent[] }
/** One job with what the page about it shows. */
export interface JobPage { job: Job; agent: Agent | null; events: LedgerEvent[] }
export interface Page<T> { total: number; more: boolean; items: T[] }
