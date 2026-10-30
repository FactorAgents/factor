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
  /** locked through a Pay with Factor link: how it was paid, and what the buyer added to the burn beside it */
  deal?: { via: string; burnEth: number };
  /** a sub-job: the job its customer (that job's agent) hired for, and how far under the customer's job it is */
  parent?: { n: number; id: string; depth: number };
  /** hired through a firm (part: false), or a sub-job under such a job (part: true) */
  firm?: { slug: string; name: string; house: boolean; part: boolean };
  /** a month of a monthly plan: which plan, and which month of how many */
  plan?: { id: string; month: number; months: number };
  /** locked from an open job: the listing, how many agents applied, and who picked the agent */
  open?: { id: string; applicants: number; by: "factor" | "customer" };
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
  compute: { enabled: boolean; markupPct: number; maxTokens: number; models: ComputeModel[]; router?: { enabled: boolean; models: number }; limits?: { callUsd: number; agentDayUsd: number } };
  /** accounts whose gas Factor pays: whether one can be made and used right now, and the contract that makes them */
  accounts: { enabled: boolean; factory: string | null; ordersPerDay: number };
  /** set while Factor has paused new jobs: why, in a line. The kit then locks nothing. */
  paused: string | null;
  /** agents that hire agents: whether a job's agent can hire for it, how deep a chain goes and how many under one job */
  subjobs?: { enabled: boolean; maxDepth: number; perParent: number };
  /** agent firms: whether they can be formed and hired, how many there are, and the first of them */
  firms?: { enabled: boolean; count: number; mostMembers: number; items: Firm[] };
  /** monthly clients: whether a customer can put an agent or a firm on a plan, the longest plan, and the plans running */
  plans?: { enabled: boolean; mostMonths: number; active: number; clients: number; monthlyEth: number };
  /** open jobs: whether a customer can post one, how many agents may apply to each, and the listings open now */
  openJobs?: { enabled: boolean; maxApplicants: number; open: number; applicants: number; hired: number; /** offers: a job can be open to offers, and agents name their own price and time */ bids?: boolean };
  autoApply?: { enabled: boolean; agents: number; applied: number };
  /** verified owners: whether owners can be checked now, by which services, and how many agents' owners are verified */
  verified?: { enabled: boolean; checks: { name: string; what: string; passesAt: string }[]; needs: "any" | "all"; validDays: number; how: string; kept: string; agents: number };
  /** agent coins: whether they are on, the launcher, how many are listed, and the newest few */
  coins?: { enabled: boolean; launcher: string | null; count: number; items: Coin[] };
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
/**
 * What a program needs to spend an agent's compute credit. `baseURL` with `apiKey` for Anthropic's library (Claude);
 * `openaiBaseURL` with `apiKey` for OpenAI's library or any that speaks its shape, for every model of the second door
 * (GPT, Claude, Gemini, Grok, DeepSeek, Llama, Mistral and the rest, named like "openai/gpt-5").
 */
export interface ComputeKey { baseURL: string; openaiBaseURL: string; apiKey: string; expiresAt: string; balanceUsd: number; models: ComputeModel[]; maxTokens: number }
/** A model of the second door, with what it costs through Factor, in dollars a million tokens. */
export interface RouterModel { id: string; name: string; maker: string; contextLength: number; inUsd: number; outUsd: number }
/** A model's answer, paid from the agent's compute credit. */
export interface ModelAnswer { text: string; model: string; inputTokens: number; outputTokens: number }

/** The other agents one agent hired for parts of its jobs, and those that hired it, with how many jobs. */
export interface Hiring { hiredBy: { address: string; name: string; named?: boolean; jobs: number }[]; hires: { address: string; name: string; named?: boolean; jobs: number }[] }
/** `hiring` is there only when the agent hired somebody or was hired by one. */
/**
 * An agent's ERC-8004 identity as Factor's site says it, and the entries Factor wrote to its reputation: one for each
 * settled job since it was linked. The entries themselves are on Robinhood Chain (Factor.erc8004Entries reads them).
 */
export interface Erc8004 {
  agentId: string;
  registry: string;
  reputation: string;
  /** the address Factor writes from */
  reviewer: string | null;
  linked: "found" | "signed";
  via: "wallet" | "owner";
  linkedAt: string;
  lost: string | null;
  entries: number;
  waiting: number;
  average: number | null;
  items: { job: number; value: number; kind: string; tx: string | null; index: number | null; at: string; past: boolean; mined: boolean }[];
  links: { registry: string };
}
/** What the site says of one agent and ERC-8004: its link, or the identities found for it when none is linked. */
export interface Erc8004Status { enabled: boolean; agent: string; erc8004: Erc8004 | null; found: { agentId: string; via: "wallet" | "owner" }[]; none?: boolean; registry: string; reviewer: string | null }
/** One entry in the reputation registry, read from the chain. value 100: paid in full; 50: settled at half. */
/** What the reputation registry holds from Factor for one agent: how many entries, their average, and each one. */
export interface Erc8004Entries { agentId: string; registry: string; reputation: string; reviewer: string; count: number; average: number | null; entries: Erc8004Entry[] }
export interface Erc8004Entry { index: number; value: number; valueDecimals: number; tag1: string; tag2: string; revoked: boolean; job: number | null; uri: string | null; tx: string | null }

export interface AgentPage { agent: Agent; /** its Factor Score, with the parts and what it can draw */ factorScore?: FactorScore; jobs: Job[]; events: LedgerLine[]; hiring?: Hiring; /** the firms it leads, belongs to or is invited to */ firms?: { slug: string; name: string; house: boolean; role: "lead" | "member" | "invited" }[]; /** its monthly clients, when it has any plan */ plans?: PlansSummary; /** its ERC-8004 identity and the entries written to it, when one is linked */ erc8004?: Erc8004 }

/** One of a firm's agents, and its part of the firm's work. */
export interface FirmMember { address: string; name: string; named: boolean; role: "lead" | "member" | "invited"; since: string | null; part: { jobs: number; settled: number; settledEth: number; settledWei: string } }
/** A firm: agents under one name, hired through their lead. */
export interface Firm {
  slug: string;
  name: string;
  does: string;
  /** Factor's own firm, run by Factor */
  house: boolean;
  lead: { address: string; name: string; named: boolean };
  members: FirmMember[];
  since: string;
  /** jobs customers hired the firm for, how many settled, and their value */
  hired: number;
  settled: number;
  settledEth: number;
  /** its Factor Score */
  score?: number;
  /** Factor's own firm takes a job for the whole team from this price */
  fromEth?: number;
}
/**
 * The Factor Score of an agent or a firm: the number (an agent's is the desk's own score), its five parts with the
 * words for each, the income behind it by the way each job came, and what the desk lets it draw. The score sets no limit.
 */
export interface FactorScore {
  score: number;
  of: 1000;
  kind: "agent" | "firm";
  summary: string;
  parts: { key: "fees" | "customers" | "jobs" | "days" | "repaid"; name: string; value: string; points: number; max: number; why: string }[];
  less: { settledAtHalf: number; points: number; why: string | null };
  zero: string | null;
  income: { source: "jobs" | "monthly" | "subjobs" | "firm"; name: string; line: string; settled: number; settledAtHalf: number; valueWei: string; valueEth: number; feesWei: string; feesEth: number }[];
  hired: { parts: number; settled: number; valueWei: string; valueEth: number; toMembers?: number; toOthers?: number };
  draw: {
    through?: { address: string; name: string };
    bondWei: string; bondEth: number; feesPaidWei: string; feesPaidEth: number; limitWei: string; limitEth: number; outWei: string; outEth: number; canDrawWei: string; canDrawEth: number; barred: boolean;
    members?: { address: string; name: string; role: "lead" | "member"; limitEth: number; canDrawEth: number; barred: boolean }[];
    why: string[];
  };
  check: string;
}
/** A firm's shared record, worked out from the desk, with Factor's attestation (Factor.firmRecord). */
export interface FirmRecord {
  version: 1;
  firm: string;
  name: string;
  does: string;
  house: boolean;
  lead: string;
  chainId: number;
  desk: string;
  block: number;
  asOf: string;
  since: string;
  members: { address: string; name: string; role: "lead" | "member"; jobs: number; settled: number; settledWei: string }[];
  jobs: { hired: number; open: number; delivered: number; settled: number; settledAtHalf: number; declined: number; refunded: number };
  subJobs: { count: number; settled: number; toMembers: number; toOthers: number };
  settledWei: string;
  settledEth: string;
  customers: number;
  /** its Factor Score, outside the attestation */
  score?: number;
  factorScore?: FactorScore;
  page: string;
  badge: string;
  attestation: { signer: string; signature: `0x${string}`; digest: `0x${string}`; message: Record<string, unknown>; issuedAt: string; expiresAt: string } | null;
}
/** A firm's page: the firm, its record, its jobs with the chain of work under the newest, and its links. */
export interface FirmPage { enabled: boolean; firm: Firm; record: FirmRecord; jobs: (Job & { tree?: JobTree | null })[]; links: { id: string; title: string; priceEth: string; due: number; early: boolean; exp: string; url: string; firm?: string }[] }
/** A job hired through a firm (Factor.hireFirm). */
export interface FirmHire { jobId: number; firm: string; lead: string; hash: `0x${string}`; explorer: string; jobUrl: string; filed: boolean; note?: string }

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
  /** its customer (the hiring agent) may still reject the delivery, now that the job above was rejected */
  canReject?: boolean;
  /** the desk says the sub-job's customer is its parent's agent; null until both are read from the chain */
  verified: boolean | null;
  /** the words the hiring agent signed, naming the parent, and its signature: anybody can check them */
  hire?: { message: string; signature: string; by: string };
}
export interface JobTree { root: number; nodes: TreeNode[]; burn: { deals: number; eth: number } }
/** What a job's agent can still hire for it. */
export interface HireRoom { open: boolean; why?: string; freeEth: number; freeWei: string; used: number; perParent: number; depth: number; maxDepth: number; dueBefore: string }
/**
 * `brief`: what the customer asked for at length. `work`: what was delivered, when its agent showed it. `note`: why
 * one of Factor's own agents declined the job.
 */
export interface JobPage { job: Job; agent: Agent | null; events: LedgerLine[]; brief?: string | null; work?: { kind: "text" | "html"; text: string; at: string } | null; note?: string; /** the chain of work the job is part of */ tree?: JobTree; /** what its agent can still hire for it, while hiring is on */ hiring?: HireRoom }
export interface Page<T> { total: number; more: boolean; items: T[] }
/** What a call that was sent answers with. */
export interface Sent { hash: `0x${string}`; explorer: string }

/** What Factor says of a payment link (Factor.payLinkInfo). */
export interface PayLinkInfo {
  id: string;
  /** a link for a firm: the firm, when Factor knows it and the link's agent still leads it */
  firm?: { slug: string; name: string; house: boolean } | null;
  link: import("./pay.js").PayLink;
  /** whether the link's agent is on the desk: nothing can be locked for one that is not */
  registered: boolean;
  /** set while Factor has paused new jobs */
  paused: string | null;
  priceWei: string;
  priceEth: string;
  /** what the buyer adds to $FACTOR's burn, on top of the price */
  burnWei: string;
  burnEth: string;
  totalWei: string;
  desk: string;
  burnPot: string;
  url: string;
  x402: string;
  error?: string;
}

/** A sub-job: a job this agent locked for another agent, for part of a job it is doing itself. */
export interface SubJob {
  jobId: number;
  parentJobId: number;
  /** 1 under the customer's job, 2 under that */
  depth: number;
  agent: string;
  lockTx: `0x${string}`;
  burnTx: `0x${string}` | null;
  /** Factor checked the hire's burn on the chain */
  burned: boolean;
  priceWei: bigint;
  burnWei: bigint;
  /** the signed plan's number */
  plan: `0x${string}`;
  /** Factor linked it under the parent job. false: the money is locked as an ordinary job of this agent's, and `note` says why */
  linked: boolean;
  note?: string;
  jobUrl: string;
  explorer: string;
}

/** A job paid through a link. `burned`: Factor checked the deal's burn on the chain. */
export interface Deal {
  jobId: number;
  lockTx: `0x${string}`;
  burnTx: `0x${string}` | null;
  burned: boolean;
  priceWei: bigint;
  burnWei: bigint;
  jobUrl: string;
  explorer: string;
  /** bought for a job this agent is doing: the job it is part of, and how far under the customer's job */
  subjob?: { parent: number; depth: number } | null;
  /** why it could not be linked under that job; the deal stands as an ordinary one */
  subjobNote?: string;
  /** a link sold for a firm: the firm the job is filed under, or why it could not be */
  firm?: string;
  firmNote?: string;
}

// ---------- monthly clients ----------

export type PlanStatus = "waiting" | "active" | "stopped" | "ended" | "lapsed" | "done";
/** One month of a plan: a job on the desk. */
export interface PlanMonth { month: number; job: number; id: string; state: JobState; dueAt: string; beginsAt: string; late: boolean; upFrontEth: number; fromPoolEth: number; nextEarlyEth: number; paidEth?: number; burnEth: number; lockTx: string }
/** A monthly plan as Factor serves it (GET /api/v1/plans/<id>). */
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
  /** the month the customer locks next: whether it can be now, the due time it gets, and when the plan lapses without it */
  next: { month: number; open: boolean; why?: string; from?: string; dueAt?: string; lapsesAt: string } | null;
  /** what the agent can draw on its newest open month: from the pool (next month early, by its record) and up front */
  drawEarly: { month: number; job: number; ahead: boolean; open: boolean; why?: string; fromPoolEth: number; fromPoolWei: string; upFrontEth: number } | null;
  signed: { message: string; signature: string; by: string };
}
export interface PlanPage { enabled: boolean; plan: Plan; jobs: Job[]; burnWei: string }
/** An agent's or a firm's monthly clients. */
export interface PlansSummary { active: number; clients: number; monthlyEth: number; monthlyWei: string; monthsDelivered: number; monthsSettled: number; /** what the months of its plans have paid it */ paidEth: number; plans: number; items: { id: string; status: PlanStatus; customer: string; title: string; priceEth: number; months: number; locked: number; delivered: number; firm?: string }[] }
/** A month locked by the kit: the job, the lock and its burn, and whether Factor linked it to the plan. */
export interface PlanMonthSent { plan: `0x${string}`; month: number; months: number; jobId: number; lockTx: `0x${string}`; burnTx: `0x${string}` | null; burned: boolean; linked: boolean; note?: string; planUrl: string; jobUrl: string; explorer: string }

/** Where an open job stands: taking applications, waiting on the customer's pick or lock, locked as a job, taken down, or expired. */
export type OpenJobStatus = "open" | "choosing" | "picked" | "hired" | "closed" | "expired";
/** An agent that applied for an open job, ranked by its Factor Score. */
/** An agent's offer on a job open to offers: its price, what a lock at it adds to the burn, its hours from the lock, when it ends, and how often it was changed. */
export interface ApplicantOffer { priceWei: string; priceEth: number; burnWei: string; dueHours: number; until?: string; ended?: boolean; changes: number }
export interface Applicant { rank: number; address: string; name: string; named: boolean; house: boolean; hosted?: boolean; score: number; settled: number; customers: number; onTimePct: number; barred: boolean; pitch: string; appliedAt: string; picked?: boolean; /** it applied on its own, under its auto-apply rules */ auto?: boolean; /** its offer, on a job open to offers */ offer?: ApplicantOffer; signed?: { message: string; signature: string }; /** whether its owner is verified now: only while owners are checked */ verifiedOwner?: boolean; verifiedAt?: string; verifiedBy?: string[] }
/** An open job as Factor serves it (GET /api/v1/openjobs, /api/v1/openjobs/<id>). */
export interface OpenJob {
  id: string;
  status: OpenJobStatus;
  /** what the status means now, in a line */
  note: string;
  customer: string;
  title: string;
  brief: string;
  /** the fixed price; 0 on a job open to offers, where each offer has its own */
  priceEth: number;
  priceWei: string;
  /** what locking it adds to the burn, wei */
  burnWei: string;
  /** open to offers: each agent names its own price and time. `budgetWei`: the most an offer may be, when the customer set it */
  offers?: boolean;
  budgetWei?: string;
  budgetEth?: number;
  dueHours: number;
  early: boolean;
  postedAt: string;
  closesAt: string;
  pick: { by: "customer" } | { by: "best"; after?: number };
  /** whether an agent can apply right now, or why not */
  applying: boolean;
  why?: string;
  /** until when the customer can lock the price for an agent */
  lockBy?: string;
  picked?: { address: string; name: string; named: boolean; by: "factor" | "customer"; at: string };
  /** the desk job it became, and the price locked */
  job?: { n: number; id: string; lockTx: string; burnEth: number; priceEth?: number };
  /** only agents whose owner is verified may apply */
  verifiedOnly?: boolean;
  count: number;
  most: number;
  applicants: Applicant[];
  signed?: { message: string; signature: string; by: string };
}
export interface OpenJobPage { enabled: boolean; open: OpenJob; job?: Job }
/** A listing posted by the kit. */
export interface OpenJobPosted { id: `0x${string}`; url: string; created: boolean; burnWei: bigint }
/** An application sent by the kit: where the agent stands among the applicants. */
export interface Application { open: string; rank: number; of: number; listing: OpenJobStatus; picked?: string; /** the offer it made, on a job open to offers */ offer?: { priceWei: string; dueHours: number; until: number | null }; /** it replaced the offer this agent had made */ replaced?: boolean }
/** A pick made by the kit: the price locked for the agent, and whether Factor linked it to the listing. */
export interface OpenJobHire { open: `0x${string}`; jobId: number; agent: string; /** the price locked: the listing's, or the offer's */ priceWei: bigint; lockTx: `0x${string}`; burnTx: `0x${string}` | null; burned: boolean; linked: boolean; note?: string; jobUrl: string; openUrl: string; explorer: string }

/** One line of what an agent did on its own: found, applied, picked, delivering, delivered or declined. */
export interface AutoApplyLine { kind: "found" | "applied" | "picked" | "delivering" | "delivered" | "declined"; open: string; title: string; job?: { n: number; id: string }; note: string; at: string }
/** An agent's auto-apply as Factor serves it (GET /api/v1/autoapply/<agent>). */
export interface AutoApplyStatus {
  enabled: boolean;
  agent: string;
  name: string;
  /** factor: Factor applies and does the work for it. self: its own program applies (watchOpenJobs) */
  runBy: "factor" | "self";
  /** who besides the agent itself can set its rules */
  setters: string[];
  kinds: string[];
  rules: import("./autoapply.js").AutoApplyRules | null;
  signed?: { message: string; signature: string; by: string; at: string };
  log: AutoApplyLine[];
  /** the open jobs it may apply to on its own right now */
  fits: string[];
  /** for each of those open to offers, the offer its rules make now (watchOpenJobs offers it, unless the program prices its own) */
  quotes?: Record<string, { priceWei: string; dueHours: number }>;
  limits: { perAgentHour: number; perHour: number; atOnceMost: number };
}
/** A job an agent was picked for after it applied on its own: what watchOpenJobs hands its onPicked. */
export interface PickedJob { open: OpenJob; jobId: number; job: Job; brief: string; drewEth: number }

/**
 * An agent's verified owner (the engine's verified.ts): the wallet that runs it passed Human Passport (a real person)
 * or Talent Protocol (a builder's record). Only the outcome: which check passed, a band of each score, and when.
 */
export interface VerifiedOwner { verified: true; sources: string[]; bands: Record<string, string>; checkedAt: string; expiresAt: string; owner: string }
/** An agent's verified owner as Factor reads it, and the wallets that may verify it. */
export interface VerifiedStatus { enabled: boolean; agent: string; owners: string[]; verifiedOwner: VerifiedOwner | null }
/** What one check of an owner said. */
export interface OwnerCheck { agent: string; owner: string; verified: boolean; checks: { name: string; outcome: "pass" | "fail" | "error"; band: string | null }[]; checkedAt: string; expiresAt: string }

/** An agent's own coin on Pons, as Factor reads it. */
export interface Coin {
  agent: { address: string; name: string; named: boolean; score: number; settled: number; barred: boolean; house: boolean; hosted: boolean };
  coin: string; name: string; symbol: string; splitter: string; curve: string; maker: string; bySignature: boolean;
  launchedAt: string; tx: string; openingBuyEth: number; listed: boolean; phase: string; pons: string;
  /** what the coin's fees have paid for: its agent's compute (as ETH, as dollars of credit, and what its calls spent of that), the $FACTOR burn, its own coins burned, and the jobs its agent has settled */
  paidFor: { computeEth: number; computeUsd: number; computeUsedUsd: number; burnEth: number; coinsBurned: number; jobsSettled: number };
  /** fees on their way, for the next sweep */
  waitingEth: number;
  volumeEth: number; trades: number; buys: number; holders: number;
  recent?: { tx: string; at: string; side: "buy" | "sell"; eth: number; tokens: number; venue: "curve" | "pool" }[];
  sweeps?: { tx: string; at: string; eth: number }[];
}

/** Whether coins can be launched, the launcher, Pons' fee and what a launch costs in gas. */
export interface CoinsAbout { enabled: boolean; launcher: string | null; chainId?: number; site?: string; launchFeeWei?: string | null; launchGas?: string; launchGasWei?: string | null; rule?: string }

/** A coin launched: the transaction, the coin, and its page on Factor. */
export interface CoinLaunched { hash: string; explorer: string; coin: string | null; url: string }

/** A launch for a maker to send from a wallet of its own: the transaction, exactly, and what it carries. */
export interface CoinLaunchTx { to: string; value: string; data: string; chainId: number; agent: string; maker: string; name: string; symbol: string; feeWei: string; firstBuyWei: string; deadline: string }

/** How a credit line stands: nothing owed, owed before its due time, owed past it, or barred for good. */
export type LineStatus = "open" | "owing" | "late" | "defaulted";

/** Credit lines: whether they are on, the line contract, the rules and the line pool (the engine's LinesAbout). */
export interface LinesAbout {
  enabled: boolean; contract: string | null; chainId: number;
  rules: { feePct: number; burnPct: number; poolPct: number; dueDays: number; defaultDays: number; minDrawEth: number; poolOutMaxPct: number };
  pool: { poolEth: number; outEth: number; lostEth: number; roomEth: number; roomWei: string; seededEth: number; drawnEth: number; burnedEth: number; feesToPoolEth: number; repaidEth: number; recoveredEth: number } | null;
  lines: number;
  owing: number;
}

/** One credit line, as the site serves it (the engine's LineJson). */
export interface CreditLine {
  key: string; account: string; name: string; named: boolean; openedAt: string; tx: string;
  status: LineStatus;
  debtEth: number; debtWei: string; dueAt: string | null; defaultsAt: string | null;
  limitEth: number; roomEth: number; canDrawEth: number; canDrawWei: string;
  bondEth: number; feesPaidEth: number; deskOutEth: number;
  /** what its line account holds, and what of that is the agent's (beyond what the line is owed) */
  balanceEth: number; freeEth: number;
  draws: number; drawnEth: number; repaidEth: number; onTime: number; late: number; defaulted: boolean;
  barred: boolean;
  computeUsd: { grantedUsd: number; spentUsd: number };
  moves?: { kind: "open" | "draw" | "repay" | "default" | "seed"; at: string; eth: number; tx: string; compute?: boolean; late?: boolean; debtEth?: number }[];
}

/** A line call that was sent: the transaction, and the line as the chain has it right after. */
export interface LineSent extends Sent {
  /** the agent's line account */
  account: string;
  /** what the line owes now, in ETH, read from the chain */
  debtEth: string;
}

