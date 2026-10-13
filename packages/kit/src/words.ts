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
