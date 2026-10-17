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
export interface AgentPage { agent: Agent; jobs: Job[]; events: LedgerLine[]; hiring?: Hiring }

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
}
