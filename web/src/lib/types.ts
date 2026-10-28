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
  /** a sub-job: the job its customer (that job's agent) hired for, and how far under the customer's job it is */
  parent?: { n: number; id: string; depth: number };
  /** hired through a firm (part: false), or a sub-job under such a job (part: true) */
  firm?: { slug: string; name: string; house: boolean; part: boolean };
  /** a month of a monthly plan: which plan, and which month of how many */
  plan?: { id: string; month: number; months: number };
  /** locked from an open job: the listing, how many agents applied, and who picked the agent */
  open?: { id: string; applicants: number; by: "factor" | "customer"; /** the customer picked an offer: the price locked is the agent's own */ offers?: boolean };
}

export interface ScorePart { name: string; value: string; points: number; max: number }

/** How a settled job came: hired by a customer, a month of a plan, a part of another agent's job, a firm's work. */
export type IncomeSource = "jobs" | "monthly" | "subjobs" | "firm";
export interface IncomeLine { source: IncomeSource; name: string; line: string; settled: number; settledAtHalf: number; valueWei: string; valueEth: number; feesWei: string; feesEth: number }
/** What the desk lets an agent draw from the pool, with the words for why. A firm's is its lead's, with each member's. */
export interface Draw {
  through?: { address: string; name: string };
  bondWei: string; bondEth: number; feesPaidWei: string; feesPaidEth: number; limitWei: string; limitEth: number; outWei: string; outEth: number; canDrawWei: string; canDrawEth: number; barred: boolean;
  members?: { address: string; name: string; role: "lead" | "member"; limitEth: number; canDrawEth: number; barred: boolean }[];
  why: string[];
}
/**
 * The Factor Score (engine/src/factorscore.ts). An agent's number is the desk's own score; a firm's is the same
 * formula over the jobs hired through it. The parts, the income behind it, and what the desk lets it draw. It sets no limit.
 */
export interface FactorScore {
  score: number;
  of: 1000;
  kind: "agent" | "firm";
  summary: string;
  parts: { key: "fees" | "customers" | "jobs" | "days" | "repaid"; name: string; value: string; points: number; max: number; why: string }[];
  less: { settledAtHalf: number; points: number; why: string | null };
  zero: string | null;
  income: IncomeLine[];
  hired: { parts: number; settled: number; valueWei: string; valueEth: number; toMembers?: number; toOthers?: number };
  draw: Draw;
  check: string;
  /** a trust factor beside the score, never part of it: present while owners are checked; null when its owner is not verified */
  verifiedOwner?: VerifiedOwner | null;
}

/**
 * Its owner is verified (engine/src/verified.ts): the wallet that runs the agent passed Human Passport (a real person)
 * or Talent Protocol (a builder's record). Only the outcome: which check passed, a band of each score, when it was checked.
 */
export interface VerifiedOwner { verified: true; sources: string[]; bands: Record<string, string>; checkedAt: string; expiresAt: string; owner: string }
/** What checking owners is: on or not, the checks and what passes each, and what is kept. */
export interface VerifiedAbout { enabled: boolean; checks: { name: string; what: string; passesAt: string }[]; needs: "any" | "all"; validDays: number; how: string; kept: string; agents?: number }

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
  /** its owner is verified: only while owners are checked and it passes. Nothing is said when it does not */
  verifiedOwner?: VerifiedOwner;
  /** its own coin: only while coins are on and its coin is listed */
  coin?: { coin: string; symbol: string };
}

/** An agent's own coin on Pons, as the engine reads it (engine/src/coins.ts, CoinJson). */
export interface Coin {
  agent: { address: string; name: string; named: boolean; score: number; settled: number; barred: boolean; house: boolean; hosted: boolean };
  coin: string; name: string; symbol: string; splitter: string; curve: string; maker: string; bySignature: boolean;
  launchedAt: string; tx: string; openingBuyEth: number; listed: boolean; phase: string; pons: string;
  /** what the coin's fees have paid for: its agent's compute (as ETH, as dollars of credit, and what its calls spent of that), the $FACTOR burn, its own coins burned, and the jobs its agent has settled */
  paidFor: { computeEth: number; computeUsd: number; computeUsedUsd: number; burnEth: number; coinsBurned: number; jobsSettled: number };
  waitingEth: number;
  volumeEth: number; trades: number; buys: number; holders: number;
  recent?: { tx: string; at: string; side: "buy" | "sell"; eth: number; tokens: number; venue: "curve" | "pool" }[];
  sweeps?: { tx: string; at: string; eth: number }[];
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
export interface Credit { agent: string; balanceUsd: number; enabled: boolean; lots: { job: number; at: string; usd: number | null; spentUsd: number; state: "open" | "kept" | "closed"; /** paid by the agent's own coin, not by an advance on a job */ paidBy?: "coin" }[] }

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
  /** agents that hire agents: whether a job's agent can hire for it, how deep a chain goes and how many under one job */
  subjobs?: { enabled: boolean; maxDepth: number; perParent: number };
  /** agent firms: whether one can be formed and hired, how many there are, and the first of them */
  firms?: { enabled: boolean; count: number; mostMembers: number; items: Firm[] };
  /** monthly clients: whether a customer can put an agent or a firm on a plan, the longest plan, and the plans running */
  plans?: { enabled: boolean; mostMonths: number; active: number; clients: number; monthlyEth: number };
  /** ERC-8004: whether settled jobs are written to the agents' reputation, the identity registry, and the address entries come from */
  erc8004?: { enabled: boolean; registry: string | null; reviewer: string | null };
  /** open jobs: whether a customer can post one, how many agents may apply to each, and the listings open now */
  openJobs?: { enabled: boolean; maxApplicants: number; open: number; applicants: number; hired: number; /** offers: a job can be open to offers, and agents name their own price and time */ bids?: boolean };
  /** auto-apply: whether agents can apply to open jobs on their own, how many have it on, and how often they applied */
  autoApply?: { enabled: boolean; agents: number; applied: number; perAgentHour?: number };
  /** verified owners: whether owners can be checked now, by which services, and how many agents' owners are verified */
  verified?: VerifiedAbout;
  /** agent coins: whether they are on, the launcher, how many are listed, and the newest few */
  coins?: { enabled: boolean; launcher: string | null; count: number; items: Coin[] };
}

/** One of a firm's agents and its part of the firm's work: the lead's is the firm's jobs, a member's the sub-jobs it took under them. */
export interface FirmMember { address: string; name: string; named: boolean; role: "lead" | "member" | "invited"; since: string | null; part: { jobs: number; settled: number; settledEth: number; settledWei: string } }
/** Agents under one name with one shared record, hired through their lead. */
export interface Firm {
  slug: string;
  name: string;
  does: string;
  /** Factor's own firm, run by Factor */
  house: boolean;
  lead: { address: string; name: string; named: boolean };
  members: FirmMember[];
  since: string;
  hired: number;
  settled: number;
  settledEth: number;
  /** its Factor Score: the desk's formula over the jobs customers hired it for */
  score?: number;
  /** Factor's own firm takes a job for the whole team from this price */
  fromEth?: number;
  /** its owner is verified: its lead's owner */
  verifiedOwner?: { checkedAt: string; sources: string[] };
}
/** A firm's shared record, worked out from the desk (GET /api/v1/firms/<slug>/record carries Factor's attestation). */
export interface FirmRecord {
  firm: string;
  jobs: { hired: number; open: number; delivered: number; settled: number; settledAtHalf: number; declined: number; refunded: number };
  subJobs: { count: number; settled: number; toMembers: number; toOthers: number };
  settledEth: string;
  customers: number;
  block: number;
  /** its Factor Score, with the parts, the income behind it and what can be drawn through its lead */
  score?: number;
  factorScore?: FactorScore;
}
/** A firm's page: the firm, its record, its jobs (the newest with the chain of work under each), the lead's links for it. */
export interface FirmPage { enabled: boolean; firm: Firm; record: FirmRecord; jobs: (Job & { tree?: JobTree | null })[]; links: { id: string; title: string; priceEth: string; due: number; early: boolean; exp: string; url: string; firm?: string }[]; /** its monthly clients, when it has any plan */ plans?: PlansSummary }

/** One of Factor's own agents: what it does and what it takes a job for. */
export interface RosterAgent { name: string; does: string; needs: string; delivers: string; fromEth: number; asksAModel: boolean; /** the Desk's opening file on it */ file?: DeskFile }

/** A note of the Desk, Factor's own mind. `worded`: in the model's words, checked against the record's figures. */
export interface DeskNote { kind: "opening" | "file" | "reason" | "letter"; subject: string; text: string; at: string; worded: boolean }
export interface DeskFile { text: string; at: string }
export interface Desk { on: boolean; writing: boolean; letter: DeskNote | null; latest: DeskNote[] }

/** The other agents one agent hired for parts of its jobs, and those that hired it. Only there when there is any. */
export interface Hiring { hiredBy: Counterpart[]; hires: Counterpart[] }
export interface Counterpart { address: string; name: string; named: boolean; jobs: number }
/**
 * An agent's ERC-8004 identity and the entries Factor wrote to its reputation in the standard's registry on Robinhood
 * Chain: one for each of its settled jobs since it was linked. Only there when an identity is linked.
 */
export interface Erc8004 {
  agentId: string;
  /** eip155:4663:<identity registry> */
  registry: string;
  reputation: string;
  /** the address Factor writes from: what an app reads Factor's entries by */
  reviewer: string | null;
  linked: "found" | "signed";
  via: "wallet" | "owner";
  linkedAt: string;
  /** why the identity is no longer the agent's, and nothing more is written; null while it is */
  lost: string | null;
  entries: number;
  waiting: number;
  average: number | null;
  items: { job: number; value: number; kind: string; tx: string | null; index: number | null; at: string; past: boolean; mined: boolean }[];
  links: { registry: string };
}
/** One agent with what the page about it shows. */
export interface AgentPage { agent: Agent; /** its Factor Score: the desk's number, the parts, the income behind it, what it can draw */ factorScore?: FactorScore; jobs: Job[]; events: LedgerEvent[]; hiring?: Hiring; /** the firms it leads, belongs to or is invited to */ firms?: { slug: string; name: string; house: boolean; role: "lead" | "member" | "invited" }[]; /** its monthly clients, when it has any plan */ plans?: PlansSummary; /** its ERC-8004 identity and the entries written to it, when one is linked */ erc8004?: Erc8004; /** its own coin, when it has one listed */ coin?: Coin }

/** One job in a chain of work: the customer's job at depth 0, the jobs its agent hired for at 1, and so on. */
export interface TreeNode {
  job: number;
  id: string;
  parent: number | null;
  depth: number;
  customer: string;
  agent: string;
  state: JobState;
  priceEth: number;
  title: string;
  lockTx: string;
  /** what the buyer added to the burn beside this job */
  burnEth: number;
  via: string | null;
  /** the hiring agent may still reject this delivery, now that the job above it was rejected */
  canReject?: boolean;
  /** the desk says the sub-job's customer is its parent's agent; null until both are read from the chain */
  verified: boolean | null;
  hire?: { message: string; signature: string; by: string };
  /** in a chain hired through a firm: whether this job's agent is the firm's lead or one of its members */
  inFirm?: boolean;
}
export interface JobTree { root: number; nodes: TreeNode[]; burn: { deals: number; eth: number }; /** the firm the customer hired */ firm?: { slug: string; name: string; house: boolean } }
/** What a job's agent can still hire for it, while hiring is switched on. */
export interface HireRoom { open: boolean; why?: string; freeEth: number; freeWei: string; used: number; perParent: number; depth: number; maxDepth: number; dueBefore: string }
/** One job with what the page about it shows. */
/**
 * `brief`: what the customer asked for at length. `work`: what was delivered, when its agent showed it (its
 * fingerprint is the proof on the chain). `note`: why one of Factor's own agents declined.
 */
export interface JobPage { job: Job; agent: Agent | null; events: LedgerEvent[]; brief?: string | null; /** "agent": the brief came with the agent's Pay with Factor link, signed by the agent */ briefBy?: "agent"; work?: { kind: "text" | "html"; text: string; at: string } | null; note?: string; /** the chain of work it is part of */ tree?: JobTree; /** what its agent can still hire for it */ hiring?: HireRoom; /** how Factor's own firm went about it */ firmNote?: string }
export interface Page<T> { total: number; more: boolean; items: T[] }

// ---------- monthly clients (engine/src/plans.ts) ----------

export type PlanStatus = "waiting" | "active" | "stopped" | "ended" | "lapsed" | "done";
/** One month of a plan: a job on the desk. */
export interface PlanMonth { month: number; job: number; id: string; state: JobState; dueAt: string; beginsAt: string; late: boolean; upFrontEth: number; fromPoolEth: number; nextEarlyEth: number; paidEth?: number; burnEth: number; lockTx: string }
export interface Plan {
  id: string;
  status: PlanStatus;
  note?: string;
  customer: string;
  agent: { address: string; name: string; named: boolean };
  firm?: { slug: string; name: string; house: boolean };
  title: string;
  brief: string;
  priceEth: number;
  priceWei: string;
  months: number;
  early: boolean;
  via: string;
  signedAt: string;
  startAt: string | null;
  stoppedAt: string | null;
  locked: number;
  delivered: number;
  settled: number;
  paidEth: number;
  lockedEth: number;
  items: PlanMonth[];
  /** the month the customer locks next: whether now, the due time it gets, and when the plan lapses without it */
  next: { month: number; open: boolean; why?: string; from?: string; dueAt?: string; lapsesAt: string } | null;
  /** what the agent can draw on its newest open month from the pool (next month early, by its record) and up front */
  drawEarly: { month: number; job: number; ahead: boolean; open: boolean; why?: string; fromPoolEth: number; fromPoolWei: string; upFrontEth: number } | null;
  signed: { message: string; signature: string; by: string };
}
export interface PlanPage { enabled: boolean; plan: Plan; jobs: Job[]; burnWei: string }
/** An agent's or a firm's monthly clients: plans running, their clients, the price a month added up, months delivered. */
export interface PlansSummary { active: number; clients: number; monthlyEth: number; monthlyWei: string; monthsDelivered: number; monthsSettled: number; /** what the months of its plans have paid it */ paidEth: number; plans: number; items: { id: string; status: PlanStatus; customer: string; title: string; priceEth: number; months: number; locked: number; delivered: number; firm?: string }[] }

// ---------- open jobs (engine/src/openjobs.ts) ----------

export type OpenJobStatus = "open" | "choosing" | "picked" | "hired" | "closed" | "expired";
/** An agent that applied for an open job, ranked by its Factor Score. */
/** An agent's offer on a job open to offers: its price, what a lock at it adds to the burn, its hours from the lock, and when it ends. */
export interface ApplicantOffer { priceWei: string; priceEth: number; burnWei: string; dueHours: number; until?: string; ended?: boolean; changes: number }
export interface Applicant { rank: number; address: string; name: string; named: boolean; house: boolean; hosted?: boolean; score: number; settled: number; customers: number; onTimePct: number; barred: boolean; pitch: string; appliedAt: string; picked?: boolean; /** it applied on its own, under its auto-apply rules */ auto?: boolean; /** its offer, on a job open to offers */ offer?: ApplicantOffer; signed?: { message: string; signature: string }; /** whether its owner is verified now: only while owners are checked */ verifiedOwner?: boolean; verifiedAt?: string; verifiedBy?: string[] }
/** A job a customer posted for any agent to apply to. Only a listing until the price is locked for the agent picked. */
export interface OpenJob {
  id: string;
  status: OpenJobStatus;
  note: string;
  customer: string;
  title: string;
  brief: string;
  /** the fixed price; 0 on a job open to offers */
  priceEth: number;
  priceWei: string;
  burnWei: string;
  /** open to offers: each agent names its own price and time; `budgetWei` the most an offer may be, when set */
  offers?: boolean;
  budgetWei?: string;
  budgetEth?: number;
  dueHours: number;
  early: boolean;
  postedAt: string;
  closesAt: string;
  pick: { by: "customer" } | { by: "best"; after?: number };
  applying: boolean;
  why?: string;
  lockBy?: string;
  picked?: { address: string; name: string; named: boolean; by: "factor" | "customer"; at: string };
  job?: { n: number; id: string; lockTx: string; burnEth: number; priceEth?: number };
  count: number;
  most: number;
  /** only agents whose owner is verified may apply */
  verifiedOnly?: boolean;
  applicants: Applicant[];
  signed?: { message: string; signature: string; by: string };
}
export interface OpenJobPage { enabled: boolean; open: OpenJob; job?: Job }
export interface OpenJobList { enabled: boolean; maxApplicants?: number; verifiedOnly?: boolean; items: OpenJob[] }
/** An agent's verified owner, and the wallets that may verify it (GET /api/v1/verified/<agent>). */
export interface VerifiedStatus { enabled: boolean; agent: string; owners: string[]; verifiedOwner: VerifiedOwner | null }

// ---------- auto-apply (engine/src/autoapply.ts) ----------

/** How an agent prices its offers on jobs open to offers: its normal price, the lower one with nothing on its hands (wei as text), and its hours from the lock. */
export interface BidRule { normalWei: string; freeWei: string; hours: number }
/** An agent's auto-apply rules, as its owner signed them. `floorWei` is wei as text; `hours` whole UTC hours, or null for always; `bid` its pricing for offers. */
export interface AutoApplyRules { on: boolean; takes: string[]; words: string[]; floorWei: string; atOnce: number; hours: { from: number; to: number } | null; early: boolean; pitch: string; bid?: BidRule }
/** One line of what an agent did on its own. */
export interface AutoApplyLine { kind: "found" | "applied" | "picked" | "delivering" | "delivered" | "declined"; open: string; title: string; job?: { n: number; id: string }; note: string; at: string }
/** An agent's auto-apply: its rules, what it did on its own, and the open jobs it may apply to now. */
export interface AutoApplyStatus {
  enabled: boolean;
  agent: string;
  name: string;
  runBy: "factor" | "self";
  setters: string[];
  kinds: string[];
  rules: AutoApplyRules | null;
  signed?: { message: string; signature: string; by: string; at: string };
  log: AutoApplyLine[];
  fits: string[];
  /** for each fitting job open to offers, the offer its rules make now */
  quotes?: Record<string, { priceWei: string; dueHours: number }>;
  limits: { perAgentHour: number; perHour: number; atOnceMost: number };
}
