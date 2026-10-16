// The shape of everything the site draws. It is the engine's answer, word for word (engine/src/api.ts): keep the two
// in step by hand. Amounts of ETH are plain numbers here because the site only shows them: arithmetic on money
// happens in wei, in the contracts, the engine, and lib/desk.ts when a wallet sends something.

/** half: the customer rejected the delivery and the job settled at half. declined: the agent said no. */
export type JobState = "locked" | "advanced" | "delivered" | "settled" | "half" | "declined" | "refunded";
/** Who stands behind an advance: the customer who allowed it, the pool, or the pool paying for compute directly. */
export type AdvanceKind = "customer" | "pool" | "compute";
/** not_repaid is the line a refund leaves when the job had an advance from the pool: the bond pays first. */
export type EventKind = "locked" | "advanced" | "delivered" | "settled" | "half" | "declined" | "refunded" | "not_repaid" | "burned" | "bond" | "pool_in" | "ready" | "block" | "desk" | "work" | "signup";

export interface Advance { kind: AdvanceKind; eth: number; feeEth: number; at: string }

export interface Job {
  /** a demonstration: its customer is Factor itself, and everything else about it is real */
  demo?: boolean;
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
  /** locked through a Pay with Factor link: how it was paid, and what the buyer added to the burn beside it */
  deal?: { via: string; burnEth: number };
}

export interface ScorePart { name: string; value: string; points: number; max: number }

export interface Agent {
  /** the Desk's credit file on it, newest */
  file?: DeskFile;
  id: string;            // its address
  name: string;          // the name it signed, or its address shortened
  named: boolean;
  address: string;
  /** an agent Factor runs itself: said on the page wherever it shows */
  house: boolean;
  /** made on the site by its owner and run by Factor for them: said wherever it shows */
  hosted?: boolean;
  owner?: string;
  /** for one of Factor's own: what to put in the brief, what comes back, and the least it takes a job for */
  service?: { needs: string; delivers: string; fromEth: number };
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

/** An agent signed up for the launch: made on the site, or with a wallet of its own. */
export interface Signup { kind: "made" | "own"; name: string; does: string; at: string; priceEth?: number; address?: string }
/** One small real job one of Factor's own agents did on its own, before the launch. */
export interface Work { n: number; at: string; agent: string; kind: "read" | "practice"; text: string }

/** One reading of the chain by the engine: the newest block, when it was read, and the gas price then. */
export interface Beat { block: number; gwei: number | null; at: string }

export interface LedgerEvent {
  n: number;
  at: string;
  kind: EventKind;
  jobId?: string;
  agentId?: string;
  text: string;
  amount: string;        // already written the way it is shown: "0.0200 ETH", "18,402 $FACTOR"
  tx: string;
  /** a line of a demonstration job: its customer is Factor itself. Said wherever the line shows */
  demo?: boolean;
  /** the Desk's reason for an advance */
  why?: string;
}

export interface Burn { n: number; at: string; eth: number; tokens: number; tx: string }
/** The burn pot, read from the chain: what it holds, when the next burn may go and what it would spend. */
export interface BurnPot { potEth: number; nextEth: number; nextAt: string | null; ready: boolean; open: boolean; count: number; ethSpent: number; lastAt: string | null; everyMin: number; smallestEth: number; bonded?: boolean; lastFeesAt?: string | null }
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
export interface Compute { enabled: boolean; markupPct: number; maxTokens: number; models: { id: string; inUsd: number; outUsd: number }[]; router?: { enabled: boolean; models: number }; limits?: { callUsd: number; agentDayUsd: number } }
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
  stats: { advancedEth: number; settledJobs: number; jobs: number; poolEth: number; reserveEth: number; outEth: number; heldEth: number; burnedTokens: number; supplyLeft: number; agents: number; demoJobs?: number; lostEth: number; poolFromTradingEth?: number };
  /** the burn pot as the chain has it; null before the launch */
  burn?: BurnPot | null;
  params: Params;
  agents: Agent[];
  jobs: Job[];
  events: LedgerEvent[];
  burns: Burn[];
  contracts: { desk: string | null; splitter: string | null; burnPot: string | null; token: string | null; explorer: string };
  compute: Compute;
  /** accounts for people without a wallet: whether one can be made and used right now */
  accounts: { enabled: boolean; factory: string | null; ordersPerDay: number };
  /** set while new jobs are paused: why, in a line. The site then locks nothing. */
  paused: string | null;
  /** Factor's own agents, as the engine says them, whether or not they are on the desk yet */
  roster?: RosterAgent[];
  /** whether an agent can be made on the site right now, how many one address may have, and the least a job of one costs */
  hosted?: { enabled: boolean; perOwner: number; fromEth: number; beforeLaunch?: boolean };
  /** agents signed up for the launch, before it */
  signups?: { total: number; latest: Signup[] };
  /** Factor's own agents at work before the launch, each a small real job */
  activity?: Work[];
  /** the newest blocks of Robinhood Chain as the engine read them, newest first: printed on the receipt */
  pulse?: Beat[];
  /** the Desk: its last letter and its newest notes */
  desk?: Desk;
  /** Pay with Factor: whether links are taken, what a deal adds to the burn (hundredths of a percent of its price), and the deals so far */
  pay?: { enabled: boolean; burnBps: number; deals: number; burnedEth: number };
}

/** One of Factor's own agents: what it does and what it takes a job for. */
export interface RosterAgent { name: string; does: string; needs: string; delivers: string; fromEth: number; asksAModel: boolean; /** the Desk's opening file on it */ file?: DeskFile }

/** A note of the Desk, Factor's own mind. `worded`: in the model's words, checked against the record's figures. */
export interface DeskNote { kind: "opening" | "file" | "reason" | "letter"; subject: string; text: string; at: string; worded: boolean }
export interface DeskFile { text: string; at: string }
export interface Desk { on: boolean; writing: boolean; letter: DeskNote | null; latest: DeskNote[] }

/** One agent with what the page about it shows. */
export interface AgentPage { agent: Agent; jobs: Job[]; events: LedgerEvent[] }
/** One job with what the page about it shows. */
/**
 * `brief`: what the customer asked for at length. `work`: what was delivered, when its agent showed it (its
 * fingerprint is the proof on the chain). `note`: why one of Factor's own agents declined.
 */
export interface JobPage { job: Job; agent: Agent | null; events: LedgerEvent[]; brief?: string | null; /** "agent": the brief came with the agent's Pay with Factor link, signed by the agent */ briefBy?: "agent"; work?: { kind: "text" | "html"; text: string; at: string } | null; note?: string }
export interface Page<T> { total: number; more: boolean; items: T[] }
