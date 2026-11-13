// What every part of the chain side is handed: the mode, the parameters, the three addresses, the chain, the gas
// wallet when there is one, and the database.

import type { AccountsConfig } from "../accounts.js";
import type { Erc8004 } from "../erc8004.js";
import type { Erc8004Scores } from "../erc8004score.js";
import type { ReportsErc8004 } from "../reportserc8004.js";
import type { Coins } from "../coins.js";
import type { Lines } from "../lines.js";
import type { Guarantees } from "../guarantees.js";
import type { Bounties } from "../bounties.js";
import type { Milestones } from "../milestones.js";
import type { Verifiers } from "../verifiers.js";
import type { Vouching } from "../vouching.js";
import type { Claims } from "../claims.js";
import type { Chain, Signer } from "./chain.js";
import type { EngineMode, EngineParams } from "./config.js";
import type { EngineDb } from "./db.js";

export interface Addresses {
  splitter: string;
  burnPot: string;
  desk: string;
  // the maker of accounts for people without a wallet, when there is one
  accounts?: string | null;
  // a wallet of the owner's that the gas wallet's surplus is sent on to, when one is named
  skimTo?: string | null;
  // the credit line contract, when lines are read (../lines.ts)
  line?: string | null;
  // the guarantee contract, when guarantees are read (../guarantees.ts)
  guarantee?: string | null;
  // the bounty contract, when bounties are read (../bounties.ts)
  bounty?: string | null;
  // the milestone contract, when milestones are read (../milestones.ts)
  milestones?: string | null;
  // the verifier contract, when verifiers are read (../verifiers.ts)
  verifiers?: string | null;
}

// What the engine learns from the chain and keeps for the life of the process. The token is never cached as
// "none": it is asked for again until the burn pot has one.
export interface Facts {
  token: string | null;
  factory: string | null;
  escrow: string | null;
  // the address the desk pays compute advances to, fixed in the desk
  gateway: string | null;
  // the wallet whose key the engine was given (live, and dry when a key is set), or null
  bot: string | null;
  // who a call is simulated as: that wallet, or without a key the admin (sweeps and burns are open to anyone)
  from: string | null;
}

export interface Ctx {
  mode: EngineMode;
  params: EngineParams;
  chainId: number;
  explorer: string;
  addr: Addresses;
  deployBlock: bigint;
  chain: Chain;
  signer: Signer | null;
  db: EngineDb;
  facts: Facts;
  log: (line: string) => void;
  now: () => number; // the wall clock, ms
  pollMs: number; // how often a sent transaction's receipt is asked for
  blockTimes: Map<bigint, number>; // block times asked of the node, kept for the life of the process
  stopping: () => boolean; // the server is shutting down: nothing new is started, and no receipt is waited for
  accounts?: AccountsConfig; // what the gas wallet pays for on accounts, and how much
  erc8004?: Erc8004 | null; // settled jobs written to the agents' ERC-8004 reputation (../erc8004.ts)
  erc8004Scores?: Erc8004Scores | null; // agents' Factor Scores written to ERC-8004 (../erc8004score.ts)
  reportsErc8004?: ReportsErc8004 | null; // ranked agents' credit report scores written to ERC-8004 (../reportserc8004.ts)
  coins?: Coins | null; // agent coins: read, swept and credited (../coins.ts)
  lines?: Lines | null; // credit lines: read, swept, recovered and credited (../lines.ts)
  guarantees?: Guarantees | null; // guarantees: read, covers tied, closed and let lapse (../guarantees.ts)
  bounties?: Bounties | null; // bounties: read, closed, bonds sent back (../bounties.ts)
  milestones?: Milestones | null; // milestones: read, stepped (../milestones.ts)
  verifiers?: Verifiers | null; // verifiers: read, stepped (../verifiers.ts)
  vouching?: Vouching | null; // vouching: read, settled and withdrawn (../vouching.ts)
  claims?: Claims | null; // selling locked pay: read, pay accounts swept (../claims.ts)
}

// The chain as the engine last read it. Amounts are wei in text; times are unix seconds unless they say ms.
export interface Snapshot {
  at: number; // ms, the wall clock when it was read
  block: number;
  blockTime: number;
  token: { address: string; totalSupply: string } | null;
  phase: string | null; // curve, graduating, pool, rescued
  ethUsd8: string | null; // Chainlink's ETH price with 8 decimals, for saying what a burn cost in dollars
  splitter: {
    unsplit: string;
    adminPending: string;
    burnPending: string;
    totalSplit: string;
    totalToAdmin: string;
    totalToBurn: string;
    poolPending: string;
    totalToPool: string;
    escrowEth: string; // what Pons' escrow holds for the splitter
    escrowFactor: string;
    factorHeld: string;
  };
  burnPot: {
    balance: string;
    factorHeld: string;
    startedAt: number;
    lastBurnAt: number;
    burnCount: number;
    totalEthBurned: string;
    totalTokensBurned: string;
    open: boolean; // a buy can go through right now
    viaCurve: boolean;
    depthCap: string;
    nextAmount: string; // what the next burn would spend
    nextAt: number; // and the earliest it is allowed
    ready: boolean;
  };
  // the desk's own books, read at the head
  desk: {
    balance: string;
    pool: string; // pool ETH that is in the desk
    out: string; // pool ETH that is with agents
    held: string;
    bonds: string;
    owedTotal: string;
    owedBurnPot: string; // an advance fee the burn pot has not been sent yet
    jobCount: number;
    totalAdvanced: string;
    totalAdvanceFees: string;
    totalJobFees: string;
    totalSettled: string;
    totalPoolIn: string;
    totalLost: string;
  };
  bot: { address: string; balance: string } | null;
}

export const SNAPSHOT_KEY = "snapshot";

export function snapshotOf(db: EngineDb): Snapshot | null {
  return db.getJson<Snapshot>(SNAPSHOT_KEY);
}
