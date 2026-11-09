// What went wrong, in plain words. The desk answers a call it will not take with one of its own errors; each of
// them is said here the way a person would say it, so an agent (or the assistant driving it) knows what to do next.
import { BaseError, ContractFunctionRevertedError, formatEther } from "viem";

/** A refusal: the desk, the kit or the site saying no, with the reason as its message. Nothing was sent. */
export class Refusal extends Error {
  constructor(message: string, readonly code = "refused") {
    super(message);
    this.name = "Refusal";
  }
}

const eth = (wei: unknown): string => formatEther(BigInt(String(wei)));
const when = (s: unknown): string => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export const WORDS: Record<string, (a: readonly unknown[]) => string> = {
  NotRegistered: () => "That wallet has not registered as an agent.",
  AlreadyRegistered: () => "This wallet is already registered as an agent.",
  TooSmall: (a) => `The smallest job is ${eth(a[0])} ETH.`,
  BadDueTime: () => "The due time must be between 1 hour and 30 days from now.",
  NotAgent: () => "Only the job's agent can do this.",
  NotCustomer: () => "Only the customer who locked this job can do this.",
  WrongState: () => "The job is not in a state where that can be done. Read the job again.",
  TooLate: () => "It is too late for that on this job.",
  TooSoon: (a) => `Not before ${when(a[0])}.`,
  OverHalf: (a) => (BigInt(String(a[0])) === 0n ? "Half of this job is already advanced. Nothing more can be drawn on it." : `At most ${eth(a[0])} ETH more can be drawn on this job: advances stop at half of it.`),
  EarlyNotAllowed: () => "The customer did not allow an early advance on this job.",
  Barred: () => "The pool does not advance this agent any more.",
  OverLimit: (a) => (BigInt(String(a[0])) === 0n ? "The agent's limit with the pool is used up. It grows with its bond and with the fees its jobs pay in." : `The agent's limit with the pool allows ${eth(a[0])} ETH more right now.`),
  PoolShort: (a) => (BigInt(String(a[0])) === 0n ? "The pool has nothing to advance right now." : `The pool can advance ${eth(a[0])} ETH more right now.`),
  OwesThePool: (a) => `A bond can leave only while nothing is owed to the pool. ${eth(a[0])} ETH is out right now.`,
  OverBond: (a) => `The bond is ${eth(a[0])} ETH.`,
  ZeroAmount: () => "The amount is zero.",
  NothingOwed: () => "Nothing is waiting to be collected.",
  GasShort: () => "It was sent with too little gas. Try again.",
  PushFailed: () => "The wallet that money was owed to refused it. It is still waiting in the desk.",
  ZeroAddress: () => "An address is missing.",
  ReentrancyGuardReentrantCall: () => "The desk does not take a call in the middle of another one.",
  // a Factor account's own answers, and the engine's on its behalf
  BadSignature: () => "The signature is not one of this account's keys', or it is for another order.",
  Expired: () => "The order's time ran out before it was sent. Send it again.",
  NotAKey: () => "That wallet is not a key of this account.",
  LastKey: () => "An account keeps at least one key.",
  KeyExists: () => "The account already has that key.",
  CallFailed: () => "The account could not make that call: it does not hold enough ETH for it, or what it called refused.",
  AccountShort: (a) => `The account holds ${eth(a[0])} ETH: not enough for the ${eth(a[1])} ETH this needs. Send ETH to the account's address first.`,
};

const VERIFIER_STATE = ["not on the chain", "waiting for its first check", "checked: its first verdict is in", "disputed: a panel sits", "back in the customer's hands, by the desk's own rule", "over: accepted", "over: rejected", "over: the payment went back to the customer"];

/** The verifier contract's own refusals (contracts/src/FactorVerifiers.sol). A few share a name with the desk's, and mean something else here. */
export const VERIFIER_WORDS: Record<string, (a: readonly unknown[]) => string> = {
  ZeroAddress: () => "An address is missing.",
  DeskRules: () => "The desk's rules do not fit verified jobs.",
  NoTerms: () => "Say what the job is: its title and its brief.",
  BadFee: () => "The verification fee is at least 0.0001 ETH and at most the job's price, paid on top of the price.",
  BadMaker: () => "A model maker is a number from 1 to 255.",
  AlreadyJoined: () => "This wallet is a verifier already. Add to its bond instead.",
  NotVerifier: () => "This wallet has not joined as a verifier.",
  NoStanding: () => "This verifier's bond is under 0.01 ETH, so it has no standing and cannot check or sit. Add to its bond first.",
  TooSmall: (a) => `A verifier's bond is at least ${eth(a[0])} ETH.`,
  ZeroAmount: () => "The amount is zero.",
  OverFree: (a) => (BigInt(String(a[0])) === 0n ? "Nothing in the bond is free: all of it is staked on cases that have not ended." : `${eth(a[0])} ETH of the bond is free. The rest is staked on cases that have not ended.`),
  HasOpenSeats: () => "A verifier cannot declare another maker while it holds a panel seat.",
  BondShort: (a) => `A verdict on this case stakes ${eth(a[0])} ETH, and less than that of this verifier's bond is free. Add to the bond first.`,
  Related: () => "The chain ties this wallet to a side of this case (the customer, the agent, or a line account on either side), or it gave the first verdict: it cannot check or sit on it.",
  NotCustomer: () => "Only the case's customer can do that.",
  NotAgent: () => "Only the case's agent can do that.",
  NotYourSide: () => "Only the side a verdict goes against may dispute it, and only the case's customer or its agent may strike a panelist.",
  WrongState: (a) => `This case is ${VERIFIER_STATE[Number(a[0])] ?? "not in a state for that"}.`,
  NotDelivered: () => "The agent has not delivered the work on the desk yet.",
  TooLate: () => "It is too late for that on this case.",
  TooSoon: (a) => `Not before ${when(a[0])}.`,
  WrongValue: (a) => `A dispute of this case takes exactly ${eth(a[0])} ETH.`,
  NoCommit: () => "The sealed verdict is empty.",
  AlreadySeated: () => "This wallet holds a seat on this panel already.",
  StruckOff: () => "A side struck this verifier from this case's panel: it cannot sit on it again.",
  MakerTaken: () => "A verifier on the same model maker with an older standing holds that seat.",
  PanelFull: () => "The panel is full, and every panelist on it has an older standing than this verifier.",
  StrikeUsed: () => "This side has used its one strike on this case.",
  NotSeated: () => "That wallet holds no seat on this case's panel.",
  AlreadyRevealed: () => "This seat's verdict is revealed already.",
  BadReveal: () => "That is not what this wallet sealed: the verdict, the reasons or the salt differ.",
  NothingOwed: () => "Nothing is waiting to be collected.",
  PushFailed: () => "The wallet the payout was for refused it. It is still waiting in the verifier contract.",
  GasShort: () => "It was sent with too little gas. Try again.",
  OnlyDesk: () => "The verifier contract takes ETH from the desk and from nobody else.",
  ReentrancyGuardReentrantCall: () => "The verifier contract does not take a call in the middle of another one.",
};

/**
 * What a failed call to the verifier contract was, in words. A hire's refusals by the desk (an agent that never
 * registered, a price under the desk's smallest job, a due time outside its limits) and a reject after the desk's 24
 * hours come back through the verifier contract, and are said as the desk's.
 */
export function verifierWordsOf(e: unknown, functionName = ""): string {
  if (e instanceof Refusal) return e.message;
  if (e instanceof BaseError) {
    const hit = e.walk((x) => x instanceof ContractFunctionRevertedError);
    const name = hit instanceof ContractFunctionRevertedError ? hit.data?.errorName ?? "" : "";
    const args = (hit instanceof ContractFunctionRevertedError ? hit.data?.args ?? [] : []) as readonly unknown[];
    if (name === "TooSmall" && functionName === "hire") return WORDS.TooSmall!(args);
    // the verifier contract refuses an accept only in a state it never has while open: a state 1 to 4 is the desk's own
    if (name === "WrongState" && functionName === "accept" && [1, 2, 3, 4].includes(Number(args[0]))) return "The desk does not take it in the job's state there: the work must be delivered, and the job not over.";
    if (name === "TooLate" && functionName === "reject") return "The desk's 24 hours after the delivery are over: the job settles as accepted. Anyone can step the case (factor_verified_step).";
    if (name === "NotYourSide" && functionName === "dispute") return "Only the side the verdict goes against may dispute it: the customer a verdict of accept, the agent a verdict of reject.";
    if (name === "NotYourSide" && functionName === "strike") return "Only the case's customer or its agent may strike a panelist.";
    if (name && VERIFIER_WORDS[name]) return VERIFIER_WORDS[name]!(args);
  }
  return explain(e);
}

/** Any failure of a call, as one sentence. A Refusal is passed through as it is. */
export function explain(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (e instanceof BaseError) {
    const hit = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (hit instanceof ContractFunctionRevertedError) {
      const name = hit.data?.errorName ?? "";
      return WORDS[name]?.((hit.data?.args ?? []) as readonly unknown[]) ?? `The desk refuses it${name ? `: ${name}` : ""}.`;
    }
    if (/insufficient funds|exceeds the balance/i.test(`${e.shortMessage} ${e.message}`)) return "The wallet does not hold enough ETH for that and the gas.";
    return e.shortMessage.split("\n")[0];
  }
  return e instanceof Error ? e.message.split("\n")[0] : String(e);
}
