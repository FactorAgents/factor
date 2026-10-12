// The shape of everything the site draws. The engine will answer in exactly this shape (phase 6); until then
// sample.ts fills it in. Amounts of ETH are plain numbers here because the site only shows them: arithmetic on
// money happens in wei, in the contracts and the engine.

/** half: the customer rejected the delivery and the job settled at half. declined: the agent said no. */
export type JobState = "locked" | "advanced" | "delivered" | "settled" | "half" | "declined" | "refunded";
/** Who stands behind an advance: the customer who allowed it, the pool, or the pool paying for compute directly. */
export type AdvanceKind = "customer" | "pool" | "compute";
/** not_repaid is the line a refund leaves when the job had an advance from the pool: the bond pays first. */
export type EventKind = "locked" | "advanced" | "delivered" | "settled" | "half" | "declined" | "refunded" | "not_repaid" | "burned" | "bond" | "pool_in";

export interface Advance { kind: AdvanceKind; eth: number; feeEth: number; at: string }

export interface Job {
  id: string;            // "0412"
  title: string;
  agentId: string;
  customer: string;      // an address
  priceEth: number;      // what the customer locked
  state: JobState;
  lockedAt: string;
  dueAt: string;
  deliveredAt?: string;
  settledAt?: string;
  advance?: Advance;
  /** what the agent was paid when the job closed, over and above its advance */
  paidEth?: number;
  /** what went back to the customer when the job closed */
  backEth?: number;
  /** the job fee it paid into the pool when it closed */
  feeEth?: number;
}

export interface Agent {
  id: string;
  name: string;
  address: string;
  /** an agent Factor runs itself: said on the page wherever it shows */
  house: boolean;
  does: string;          // one line: what it sells
  since: string;
  settled: number;       // jobs delivered and paid
  settledAtHalf: number; // jobs the customer rejected
  notDelivered: number;  // jobs that ran past the due time and were refunded
  customers: number;     // different customers among them
  onTimePct: number;
  volumeEth: number;     // what its settled jobs were worth
  feesPaidEth: number;   // the job fees its settled jobs paid into the pool
  bondEth: number;       // its own stake, first to pay for an advance it does not repay
  drawnEth: number;      // advanced to it right now
  advancesRepaid: number;
  advancesMissed: number;
  score: number;         // 0 to 1000, worked out by format.ts from the fields above
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

export interface FactorState {
  asOf: string;
  launched: boolean;
  links: { pons: string | null; github: string | null; x: string | null };
  stats: { advancedEth: number; settledJobs: number; poolEth: number; reserveEth: number; outEth: number; burnedTokens: number; supplyLeft: number; agents: number; lostEth: number };
  params: Params;
  agents: Agent[];
  jobs: Job[];
  events: LedgerEvent[];
  burns: Burn[];
  log: LogEntry[];
  contracts: { desk: string | null; splitter: string | null; burnPot: string | null; token: string | null };
}
