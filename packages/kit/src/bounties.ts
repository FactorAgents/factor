// Bounties (contracts/src/FactorBounty.sol, docs/BOUNTIES.md): the bounty contract's refusals in plain words, what a poster
// adds and an entrant puts up, the hash an entrant commits to, and the words a poster signs to read its entries. The hash and
// the words are the same, to the letter, as the engine checks (engine/src/bounties.ts) and the site builds
// (web/src/lib/bounties.ts).
import { BaseError, ContractFunctionRevertedError, encodeAbiParameters, formatEther, keccak256, toHex, type Hex } from "viem";
import { explain, Refusal } from "./words.js";

const eth = (wei: unknown): string => formatEther(BigInt(String(wei)));
const when = (s: unknown): string => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
/** The contract's states, in the order it numbers them. */
export const BOUNTY_STATES = ["none", "open", "picked", "won", "unpicked", "undelivered", "empty"] as const;
const STATE_WORD = ["not on the chain", "open", "picked already", "won", "split between its entrants", "over: the winner did not deliver", "over: nobody entered"];

/** The smallest prize, and the most a task's words and an entry's work may be, in bytes. */
export const MIN_PRIZE_WEI = 5_000_000_000_000_000n;
export const TASK_BYTES = 8000;
export const WORK_BYTES = 200_000;

/** The bounty contract's own refusals. A few share a name with the desk's, and mean something else here. */
export const BOUNTY_WORDS: Record<string, (a: readonly unknown[]) => string> = {
  ZeroAddress: () => "An address is missing.",
  WrongDesk: () => "The line contract is not the desk's.",
  DeskRules: () => "The desk's rules do not fit a bounty.",
  TooSmall: (a) => `The smallest prize is ${eth(a[0])} ETH.`,
  BadDeadline: () => "The deadline must be between 1 hour and 30 days from now.",
  BadScore: () => "A minimum score is at most 1000, the top of the desk's score.",
  NoTask: () => "Say what the task is.",
  WrongValue: (a) => `It takes exactly ${eth(a[0])} ETH.`,
  WrongState: (a) => `This bounty is ${STATE_WORD[Number(a[0])] ?? "not open"}.`,
  TooSoon: (a) => `Not before ${when(a[0])}.`,
  TooLate: (a) => `That ended ${when(a[0])}.`,
  NotAgent: () => "Only the agent's own wallet or account (or the key of its line account) can enter for it.",
  NotPoster: () => "Only the wallet or account that posted this bounty can pick its winner.",
  NoHash: () => "There is no work to enter.",
  NotRegistered: () => "That address has not registered as an agent on the desk. Register first.",
  Barred: () => "An agent barred on the desk cannot enter.",
  OwnBounty: () => "The poster of a bounty cannot enter it.",
  AlreadyIn: () => "This agent has entered this bounty already. One entry for one agent, and a line account and its key count as one.",
  Full: () => "This bounty has all the entries it takes.",
  ScoreTooLow: (a) => `The poster asks for a Factor Score of ${String(a[1])}. This agent has ${String(a[0])}.`,
  NotAnEntrant: () => "Only an agent that entered can be picked.",
  BondsAlreadyBack: () => "The bonds have gone back already.",
  NothingOwed: () => "Nothing is waiting to be collected.",
  PushFailed: () => "The wallet the payout was for refused it. It is still waiting in the bounty contract.",
  GasShort: () => "It was sent with too little gas. Try again.",
  OnlyDesk: () => "The bounty contract takes ETH from the desk and from nobody else.",
  ReentrancyGuardReentrantCall: () => "The bounty contract does not take a call in the middle of another one.",
};

/** What a failed bounty call was, in words. */
export function bountyWordsOf(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (e instanceof BaseError) {
    const hit = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (hit instanceof ContractFunctionRevertedError && hit.data?.errorName && BOUNTY_WORDS[hit.data.errorName]) return BOUNTY_WORDS[hit.data.errorName]!((hit.data.args ?? []) as readonly unknown[]);
  }
  return explain(e);
}

/** What a prize carries, as the contract takes it: the poster adds 1% for the burn on top, and each entry puts up 1% as its bond. */
export function bountyParts(prize: bigint): { fee: bigint; bond: bigint; total: bigint } {
  const fee = (prize * 100n) / 10_000n, bond = (prize * 100n) / 10_000n;
  return { fee, bond, total: prize + fee };
}

/** The hash of a piece of text: a task's words, or an entry's work. */
export const textHash = (text: string): Hex => keccak256(toHex(text));

/** What an entrant commits to: FactorBounty.entryHash, to the letter. It is also the proof a winner delivers on the desk. */
export const bountyEntryHash = (contract: string, id: number, agent: string, work: string): Hex =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }], [contract as Hex, BigInt(id), agent as Hex, textHash(work)]));

/** The words a poster signs to read its entries, from the deadline. */
export const bountyReadMessage = (o: { id: number; poster: string; at: number }): string => ["Factor: read the entries of a bounty", `bounty: ${o.id}`, `poster: ${o.poster}`, `at: ${o.at}`].join("\n");

/** The length of a text in bytes, as the contract's limits count it. */
export const bytesOf = (text: string): number => new TextEncoder().encode(text).length;
