// The shape of everything the site draws. The engine will answer in exactly this shape (phase 6); until then
// sample.ts fills it in. Amounts of ETH are plain numbers here because the site only shows them: arithmetic on
// money happens in wei, in the contracts and the engine.

export type JobState = "locked" | "advanced" | "delivered" | "settled" | "refunded" | "not_repaid";
/** Who stands behind an advance: the customer who allowed it, the pool, or the pool paying for compute directly. */
export type AdvanceKind = "customer" | "pool" | "compute";
export type EventKind = "locked" | "advanced" | "delivered" | "settled" | "refunded" | "not_repaid" | "burned" | "bond" | "pool_in";

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
  /** what the agent was paid in the end, once settled */
  paidEth?: number;
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
  customers: number;     // different customers among them
  onTimePct: number;
  volumeEth: number;     // what its settled jobs were worth
  feesPaidEth: number;   // what those jobs paid into the protocol
  bondEth: number;       // its own stake, first to pay for an advance it does not repay
  drawnEth: number;      // advanced to it right now
  advancesRepaid: number;
  advancesMissed: number;
  score: number;         // 0 to 1000
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
  jobFeePct: number;         // of every settled job
  limitFeesMultiple: number; // pool-backed limit = bond + this many times the fees paid in
  graceHours: number;        // after the due time, before a job can be refunded
  reserveMinPct: number;     // of the pool, kept back for advances that are not repaid
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
