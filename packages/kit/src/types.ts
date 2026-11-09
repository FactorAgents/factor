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
  /** hired with cover: how much, the fee, and how the cover stands (while guarantees are on) */
  cover?: { id: number; coverEth: number; feeEth: number; state: CoverState };
  /** a bounty's prize, paid through the desk (while bounties are on): the bounty, its poster, and the hash its winner delivers as the proof */
  bounty?: { id: number; title: string | null; poster: string; proof: string | null };
  /** a stage of a job in stages: the plan, which stage of how many, its customer. Accepted or rejected through the milestone contract */
  milestone?: { id: number; stage: number; count: number; title: string | null; stageTitle: string | null; customer: string; state: MilestoneState };
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
  /** "Guaranteed up to": while guarantees are on and it sells cover, the most cover on one job and the share of a price its score allows */
  guarantee?: { upToEth: number; sharePct: number };
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
  compute: { enabled: boolean; markupPct: number; maxTokens: number; models: ComputeModel[]; router?: { enabled: boolean; models: number }; limits?: { callUsd: number; agentDayUsd: number }; /** raeto/auto at the second door, while it is served: its names, Raeto's fee, and what a call holds while it runs, in dollars a million tokens */ raeto?: RaetoAbout };
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
  /** guarantees: whether they are on, the contract, the rules and the totals */
  guarantees?: GuaranteesAbout;
  /** credit lines: whether they are on, the contract, the rules and the line pool */
  lines?: LinesAbout;
  /** bounties: whether they are on, the contract, the rules and the totals */
  bounties?: BountiesAbout;
  /** milestones: whether jobs in stages are on, the contract, the rules and the totals */
  milestones?: MilestonesAbout;
  /** ERC-8004: whether settled jobs are written to the agents' reputation, the identity registry, and the address entries come from */
  erc8004?: { enabled: boolean; registry: string | null; reviewer: string | null };
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
/**
 * raeto/auto: a name at the second door with no model of its own. Raeto picks the model for each request (the variants
 * lean to the cheap answer, the fast one, code, reasoning, pictures, tools, JSON or a long memory), and a call costs what
 * Raeto charged for it, with its fee and Factor's margin. What a call holds while it runs assumes the dearest model.
 */
export interface RaetoAbout { models: string[]; feePct: number; routeFeeMostUsd: number; holdInUsd: number; holdOutUsd: number }
/** What an agent's (or a job's) credit went on through raeto/auto: the dollars, the calls, and which models Raeto picked. */
export interface RaetoSpend { spentUsd: number; calls: number; models: { model: string; tier: string; calls: number; usd: number }[] }
/** What an agent has left to spend on models, and the lots of credit it came from: compute advances, its coin's fees, or its credit line. */
export interface ComputeCredit { agent: string; balanceUsd: number; enabled: boolean; lots: { job: number; at: string; usd: number | null; spentUsd: number; state: "open" | "kept" | "closed"; /** a lot its coin's fees or its credit line paid for, not a job's advance */ paidBy?: "coin" | "line" }[]; /** what it spent through raeto/auto, while that is served */ raeto?: RaetoSpend }
/**
 * What a program needs to spend an agent's compute credit. `baseURL` with `apiKey` for Anthropic's library (Claude);
 * `openaiBaseURL` with `apiKey` for OpenAI's library or any that speaks its shape, for every model of the second door
 * (GPT, Claude, Gemini, Grok, DeepSeek, Llama, Mistral and the rest, named like "openai/gpt-5").
 */
export interface ComputeKey { baseURL: string; openaiBaseURL: string; apiKey: string; expiresAt: string; balanceUsd: number; models: ComputeModel[]; maxTokens: number }
/**
 * A model of the second door, with what it costs through Factor, in dollars a million tokens. `auto`: raeto/auto or one of
 * its variants, which picks the model for each request and has no price of its own (inUsd and outUsd are 0): a call costs
 * what Raeto charged for it, with the margin.
 */
export interface RouterModel { id: string; name: string; maker: string; contextLength: number; inUsd: number; outUsd: number; auto?: boolean }
/**
 * A model's answer, paid from the agent's compute credit. `model`: the model that answered (through raeto/auto, the one
 * Raeto picked). `costUsd`: what the call took from the credit, when the answer says it (raeto/auto's always do).
 */
export interface ModelAnswer { text: string; model: string; inputTokens: number; outputTokens: number; costUsd?: number }

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

export interface AgentPage {
  agent: Agent; /** its Factor Score, with the parts and what it can draw */ factorScore?: FactorScore; jobs: Job[]; events: LedgerLine[]; hiring?: Hiring; /** the firms it leads, belongs to or is invited to */ firms?: { slug: string; name: string; house: boolean; role: "lead" | "member" | "invited" }[]; /** its monthly clients, when it has any plan */ plans?: PlansSummary; /** its ERC-8004 identity and the entries written to it, when one is linked */ erc8004?: Erc8004;
  /** its own coin, while coins are on and it is listed */ coin?: Coin;
  /** its credit line, while lines are on and it has one */ line?: CreditLine;
  /** its guarantee bond, offer and covers, while guarantees are on and it has ever had one */ guarantee?: AgentGuarantee;
  /** its bounties, entered and won, while bounties are on and it has entered one */ bounties?: AgentBounties;
  /** what its credit went on through raeto/auto, while that is served */ raetoSpend?: RaetoSpend;
}

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
export interface FirmHire { jobId: number; firm: string; lead: string; hash: `0x${string}`; explorer: string; jobUrl: string; filed: boolean; note?: string; /** hired with cover from the lead's bond: its number, how much, and whether it is tied to the job yet */ cover?: number | null; coverEth?: string; tied?: boolean }

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
export interface JobPage { job: Job; agent: Agent | null; events: LedgerLine[]; brief?: string | null; work?: { kind: "text" | "html"; text: string; at: string } | null; note?: string; /** the chain of work the job is part of */ tree?: JobTree; /** what its agent can still hire for it, while hiring is on */ hiring?: HireRoom; /** its cover, when it was hired with one (while guarantees are on) */ cover?: Cover; /** what its compute credit went on through raeto/auto, while that is served */ raetoSpend?: RaetoSpend }
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
export interface PlanMonthSent { plan: `0x${string}`; month: number; months: number; jobId: number; lockTx: `0x${string}`; burnTx: `0x${string}` | null; burned: boolean; linked: boolean; note?: string; planUrl: string; jobUrl: string; explorer: string; /** the month locked with cover: how much */ coverEth?: string }

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

/** Guarantees: whether they are on, the contract, the rules and the totals (the engine's GuaranteesAbout). */
export interface GuaranteesAbout {
  enabled: boolean; contract: string | null; chainId: number;
  rules: { feePct: number; burnPctOfFee: number; minCoverEth: number; windowMin: number; graceH: number; shares: { score: number; pct: number }[] };
  totals: { bondsEth: number; heldEth: number; coveredEth: number; paidEth: number; feesEth: number; burnedEth: number; covers: number; agents: number } | null;
}

/** reserved: not tied to a job yet. bound: tied. released: delivered, back to the bond. paid: not delivered, paid to the customer. declined: the agent declined, the fee went back. lapsed: never tied */
export type CoverState = "reserved" | "bound" | "released" | "paid" | "declined" | "lapsed";

/** One cover, as the site serves it (the engine's CoverJson). */
export interface Cover {
  id: number; customer: string; agent: string; agentName: string; named: boolean;
  priceEth: number; coverEth: number; coverWei: string; feeEth: number; dueAt: string; allowEarly: boolean;
  state: CoverState; job: string | null; reservedAt: string; expiresAt: string; tx: string;
  boundTx?: string; boundAt?: string; closedTx?: string; closedAt?: string; paidEth?: number; toAgentEth?: number; burnedEth?: number; feeBackEth?: number;
  /** what happens next, and from when */
  next?: { what: "tie" | "lapse" | "pays-if-not-delivered" | "releases" | "pays"; at: string };
}

/** One agent's guarantee, as the site serves it (the engine's AgentGuaranteeJson). */
export interface AgentGuarantee {
  agent: string; name: string; named: boolean;
  /** the key that runs it, when the agent's address is a credit line account */
  key: string | null;
  bondEth: number; heldEth: number; freeEth: number; offerEth: number; offerWei: string;
  /** "Guaranteed up to": the offer or the free bond, whichever is less; 0 while the score allows no share */
  upToEth: number; upToWei: string;
  /** the score the contract counts and the share of a price it allows, in percent */
  score: number; sharePct: number; selling: boolean;
  covers: number; released: number; paid: number; declined: number; lapsed: number; coveredEth: number; paidOutEth: number; feesEarnedEth: number;
  items?: Cover[];
}

/** A job hired with cover: the job, its cover, and whether the two are tied yet. */
export interface CoveredHire extends Sent {
  jobId: number;
  /** the cover's number on the guarantee contract */
  cover: number | null;
  coverEth: string;
  feeEth: string;
  /** tied to the job: false only when the last of a wallet's three transactions did not go; Factor ties it within the hour */
  tied: boolean;
  titled: boolean;
  briefed: boolean;
  jobUrl: string;
  note?: string;
}

/** A guarantee call that was sent: the transaction, and the agent's guarantee as the chain has it right after. */
export interface GuaranteeSent extends Sent {
  /** the desk address whose guarantee it is: the wallet, or its line account */
  agent: string;
  bondEth: string;
  freeEth: string;
  offerEth: string;
}

/** A burn of $FACTOR by the burn pot: its number, the ETH it spent and the tokens it burned. */
export interface Burn { n: number; at: string; eth: number; tokens: number; tx: string }

/** A link an agent published on its page: what it sells, for how much, and until when. */
export interface PublishedLink { id: string; title: string; priceEth: string; due: number; early: boolean; exp: string; url: string; firm?: string }

// ---------- bounties ----------

/** Bounties: whether they are on, the contract, the rules and the totals (the engine's BountiesAbout). */
export interface BountiesAbout {
  enabled: boolean; contract: string | null; chainId: number;
  rules: { burnPct: number; bondPct: number; jobFeePct: number; minPrizeEth: number; maxEntries: number; minOpenH: number; maxOpenD: number; pickD: number; deliverD: number; graceH: number; taskBytes: number; workBytes: number };
  totals: { bounties: number; prizesEth: number; openEth: number; wonEth: number; splitEth: number; burnedEth: number; open: number; entries: number } | null;
}

/** The contract's own states: open (taking entries, then the poster's pick), picked, and how it ended. */
export type BountyState = "open" | "picked" | "won" | "unpicked" | "undelivered" | "empty";
/** What a bounty is doing now: `open` taking entries, `choosing` waiting for the poster's pick, `ending` its time is up and anyone can close it, then the contract's own states. */
export type BountyStatus = "open" | "choosing" | "ending" | "picked" | "won" | "unpicked" | "undelivered" | "empty";

/** One bounty as the board shows it (the engine's BountyJson). Never any work. */
export interface Bounty {
  id: number; poster: string; prizeEth: number; prizeWei: string; feeEth: number; feeWei: string; bondEth: number; bondWei: string;
  deadline: string; pickUntil: string; minScore: number; taskHash: string;
  /** the task's first line and the whole of it; null until its words have arrived, or while they are hidden */
  title: string | null; task: string | null; hidden: boolean;
  state: BountyState; status: BountyStatus; entries: number; slots: number;
  /** its entries are public: a winner is picked, or it ended */
  revealed: boolean; postedAt: string; tx: string;
  winner?: { address: string; name: string; named: boolean };
  /** the desk job its prize became at the pick */
  job?: { n: number; id: string; state?: number; dueAt?: string; deliveredAt?: string };
  pickedTx?: string; pickedAt?: string; closedTx?: string; closedAt?: string; shareEth?: number; paidTo?: number; burnedEth?: number; toPosterEth?: number;
  /** its time is up: what anyone's close does */
  next?: "returns" | "splits";
}

/** One entry (the engine's BountyEntryJson): public once a winner is picked or the bounty ends, and to its poster from the deadline. */
export interface BountyEntry {
  agent: string; name: string; named: boolean; n: number; enteredAt: string; hash: string; tx: string; score: number; won: boolean;
  /** one of Factor's own agents entered on its own */
  house: boolean;
  /** its work reached Factor */
  shown: boolean;
  kind?: "text" | "html"; work?: string; whole?: boolean;
  shareEth: number; bondBackEth: number;
}

/** A poster's history, in the open: what it posted, how each ended, and whom it picked. Worth reading before putting work in. */
export interface BountyPoster { poster: string; posted: number; won: number; unpicked: number; undelivered: number; empty: number; open: number; items: Bounty[]; picks: { bounty: number; winner: string; name: string; score: number; jobsSettled: number }[] }

/** One bounty's page: its facts, its entries once they are public, and its poster's history. */
export interface BountyPage extends Bounty { items?: BountyEntry[]; history: BountyPoster }

/** An agent's bounties: how many it entered and won, what it won, what it had from splits, and the newest. */
export interface AgentBounties { entered: number; won: number; wonEth: number; splitEth: number; items: Bounty[] }

/** A bounty posted by the kit: its number, what was sent, and whether its words reached Factor. */
export interface BountyPosted extends Sent {
  id: number;
  prizeWei: bigint; feeWei: bigint; bondWei: bigint;
  /** when entries end, and until when the poster can pick */
  deadline: string; pickUntil: string;
  /** the task's words reached Factor, which shows them because they hash to what the bounty holds */
  taskSaved: boolean;
  url: string;
  note?: string;
}

/** An entry sent by the kit: the agent it is for, the hash committed on the chain, and whether its work reached Factor. */
export interface BountyEntered extends Sent {
  id: number;
  /** the address that entered: this wallet, or its line account */
  agent: string;
  entryHash: `0x${string}`;
  bondWei: bigint;
  workSaved: boolean;
  url: string;
  note?: string;
}

/** A pick sent by the kit: the winner, and the desk job its prize became. */
export interface BountyPicked extends Sent { id: number; winner: string; jobId: number; dueAt: string; jobUrl: string }

// ---------- milestones ----------

/** Milestones: whether jobs in stages are on, the contract, the rules and the totals (the engine's MilestonesAbout). */
export interface MilestonesAbout {
  enabled: boolean; contract: string | null; chainId: number;
  rules: { minStages: number; maxStages: number; minStageEth: number; minTimeH: number; maxTimeD: number; jobFeePct: number; advanceFeePct: number; graceH: number; reviewH: number; titleChars: number; briefChars: number; termsBytes: number };
  totals: { plans: number; budgetsEth: number; paidEth: number; returnedEth: number; heldEth: number; running: number; done: number; stagesPaid: number } | null;
}

/** The contract's own states: running (a stage on the desk), and how it ended. */
export type MilestoneState = "running" | "done" | "missed" | "declined" | "rejected";
/** Where one stage stands: not on the desk yet, on it, delivered, paid, or how it ended the plan; returned: never started, back to the customer. */
export type StageStatus = "waiting" | "open" | "delivered" | "paid" | "missed" | "declined" | "rejected" | "returned";

/** One stage (the engine's MilestoneStageJson). */
export interface MilestoneStage {
  /** 1 to 6 */
  n: number; priceEth: number; priceWei: string; timeS: number; status: StageStatus; title: string | null;
  /** its desk job, once it is on the desk */
  job?: { n: number; id: string };
  dueAt?: string;
  /** not on the desk yet: the due date it would have if every stage before it were accepted on its due date */
  expectedDueAt?: string;
  openedAt?: string; deliveredAt?: string; paidAt?: string; paidTx?: string | null;
}

/** One job in stages (the engine's MilestonePlanJson). */
export interface MilestonePlan {
  id: number; customer: string; agent: { address: string; name: string; named: boolean; score: number; barred: boolean };
  totalEth: number; totalWei: string; count: number; allowEarly: boolean; termsHash: string; title: string | null; hidden: boolean; state: MilestoneState;
  /** the stage on the desk now, from 1; the last one once it ended */
  current: number; postedAt: string; tx: string; paidEth: number; stages: MilestoneStage[];
  endedAt?: string; endedTx?: string; returnedEth?: number;
  /** its time has come: what anyone's step does */
  next?: "opens" | "returns" | "settles" | "refunds";
}

/** An agent's jobs in stages: how many, how they went, the stages it was paid for, and the newest. */
export interface AgentMilestones { plans: number; running: number; done: number; missed: number; declined: number; rejected: number; stagesPaid: number; paidEth: number; items: MilestonePlan[] }

/** A job in stages hired by the kit: its number, the first stage's desk job, what was sent, and whether its words reached Factor. */
export interface MilestonesHired extends Sent {
  id: number;
  /** the first stage's desk job */
  job: number;
  totalWei: bigint;
  stages: number;
  /** the words reached Factor, which gives each stage its title and brief because they hash to what the plan holds */
  termsSaved: boolean;
  url: string;
  note?: string;
}

/** A call on a job in stages: where it stands after it. */
export interface MilestoneSent extends Sent { id: number; state: MilestoneState | null; current: number; job: number }

// ---------- verifiers ----------

/** A model maker a verifier declares: its number on the chain, and the name Factor gives it. */
export interface VerifierMaker { id: number; name: string; models: string }

/** Verifiers: whether they are on, the contract, the rules, the model makers, the totals and Factor's own verifiers (the engine's VerifiersAbout). */
export interface VerifiersAbout {
  enabled: boolean; contract: string | null; chainId: number;
  rules: { minFeeEth: number; minBondEth: number; stakePct: number; minStakeEth: number; wrongLossPct: number; disputePct: number; minDisputeEth: number; panel: number; checkH: number; disputeH: number; seatH: number; revealH: number; reviewH: number; reasonChars: number; titleChars: number; briefChars: number };
  makers: VerifierMaker[];
  totals: { cases: number; open: number; disputed: number; panels: number; verifiers: number; bondedEth: number; feesPaidEth: number; slashedEth: number } | null;
  /** Factor's own verifiers: ordinary verifiers with bonds of their own */
  house: { address: string; maker: number; makerName: string; model: string; joined: boolean }[];
}

/** One verifier (the engine's VerifierJson). Amounts in ETH are for reading; the ...Wei fields are exact. */
export interface Verifier {
  address: string; name: string | null; maker: number; makerName: string; house: boolean;
  /** whether its bond is 0.01 ETH or more now, and since when */
  standing: boolean; since: string | null; joinedAt: string;
  freeEth: number; freeWei: string; lockedEth: number; lockedWei: string;
  /** open cases it holds a stake in */
  open: number;
  checks: number; panels: number; right: number; wrong: number;
  /** panel seats it never revealed */
  hidden: number; struck: number;
  earnedEth: number; lostEth: number;
  /** right calls over right and wrong ones; null before the first */
  rightPct: number | null;
}

/** Where a case stands, as the API names the contract's states. */
export type VerifierCaseState = "working" | "checked" | "disputed" | "customer" | "accepted" | "rejected" | "returned";
/** Who decided how a case ended. */
export type VerifierCaseHow = "first-check" | "panel" | "customer" | "clock" | "not-delivered";
/** A verifier as a case shows it. */
export type VerifierShort = Pick<Verifier, "address" | "name" | "maker" | "makerName" | "house"> & Partial<Verifier>;

/** One panel seat of a case. */
export interface VerifierSeat {
  seat: number; verifier: VerifierShort; maker: number; makerName: string; since: string;
  vote: null | "accept" | "reject"; reasonHash: string | null; reason: string | null;
  /** what Factor's records tie this verifier to a side by; empty means Factor sees none, not that there is none */
  ties: string[];
}

/** One verified job: a desk job hired with a verifier, and its check (the engine's VerifierCaseJson). */
export interface VerifierCase {
  id: number;
  job: { n: number; id: string; state: string };
  customer: string;
  agent: { address: string; name: string | null };
  priceEth: number; priceWei: string; feeEth: number; feeWei: string; stakeEth: number; stakeWei: string;
  disputeBondEth: number; disputeBondWei: string;
  termsHash: string; title: string | null; brief: string | null;
  work: { kind: "text" | "html"; text: string; at: string } | null;
  state: VerifierCaseState; how: VerifierCaseHow | null; hiredAt: string; tx: string;
  deliveredAt?: string;
  deadlines?: { checkBy: string; disputeBy: string | null; seatBy: string; revealBy: string; reviewBy: string };
  first?: { verifier: VerifierShort; accept: boolean; at: string; reasonHash: string; reason: string | null; tx: string };
  dispute?: { by: "customer" | "agent"; address: string; at: string; bondEth: number; tx: string };
  seats?: VerifierSeat[];
  struck?: { verifier: string; by: "customer" | "agent"; at: string }[];
  decided?: { how: VerifierCaseHow; verdict: "accept" | "reject" | null; votesAccept: number; votesReject: number; at: string };
  paid?: { verifier: string; eth: number }[];
  slashed?: { verifier: string; eth: number }[];
  ended?: { state: VerifierCaseState; how: VerifierCaseHow; at: string; tx: string; toCustomerEth: number };
  /** what comes next, and from when */
  next?: "check" | "dispute" | "seats" | "reveals" | "step" | "customer" | null;
  nextAt?: string | null;
  /** asked with a verifier: whether that wallet may check or sit now, by the contract's rules. A guide: the contract decides */
  forYou?: { can: boolean; why?: string };
}

/** One verifier and its latest cases. `verifier` is null for a wallet that never joined. */
export interface VerifierPage { verifier: Verifier | null; cases: VerifierCase[] }

/** A call to the verifier contract: the case it was about, and where the case stands after it. */
export interface VerifierSent extends Sent { case?: number; state?: VerifierCaseState | null }

/** A hire with a verifier: the case, the desk job, what it cost, what a verdict stakes and a dispute costs, and whether its words reached Factor. */
export interface VerifiedHire extends Sent {
  case: number; job: number; priceWei: bigint; feeWei: bigint; stakeWei: bigint; disputeBondWei: bigint;
  terms: string; termsHash: `0x${string}`;
  /** the words reached Factor, which makes them the desk job's title and brief because they hash to what the case holds */
  termsPosted: boolean;
  url: string; note?: string;
}

/** A first verdict given, or a sealed one revealed: its hash on the chain, and whether the reasons reached Factor. */
export interface VerdictGiven extends Sent { case: number; accept: boolean; reasonHash: `0x${string}`; reasonPosted: boolean; stakeWei?: bigint; note?: string }

/** A seat taken with a sealed verdict. Keep `accept` and `reason` exactly: the reveal needs both. */
export interface VerdictSealed extends Sent {
  case: number; seat: number | null; commit: `0x${string}`; accept: boolean; reason: string; reasonHash: `0x${string}`; stakeWei: bigint;
  /** the reveal window, from when seating closes */
  revealFrom: string | null; revealBy: string | null;
  /** where the verdict and its salt were kept on this machine, or null */
  kept: string | null;
}
