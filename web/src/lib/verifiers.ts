// Verifiers, as a visitor's wallet sends them (contracts/src/FactorVerifiers.sol, spec-pack/verifiers): a customer hires
// an agent with a verifier, a verifier checks the delivered work and stakes part of its bond on its verdict, the side
// the verdict goes against may dispute it for a bond, and a panel of verifiers on different model makers decides. The
// site sends what a customer, an agent or a verifier's own wallet does here; checking, sitting and revealing are the
// kit's (factor-kit). Amounts are wei, always. The words of a job and their hash are the same, to the letter, as the
// engine checks.
//
// Every call is tried first without being sent: a call the contract would refuse never reaches the wallet, and the
// visitor is told why in plain words.
import { decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeFunctionData, formatEther, keccak256, parseEther, toHex, type Abi, type Hex } from "viem";
import { factorVerifiersAbi } from "./abi/FactorVerifiers";
import { factorDeskAbi } from "./abi/FactorDesk";
import { explain as deskExplain, Refusal, wordsFor } from "./desk";
import { declined, ensureChain, ethCall, sendTx, waitFor, type Provider, type Receipt } from "./wallet";
import type { CaseErc8004, CaseHow, CaseNext, CaseState, VerifierMaker, VerifierRules, VerifiersAbout } from "./types";

export const VERIFIERS_ABI = factorVerifiersAbi as Abi;
const ALL = [...VERIFIERS_ABI, ...(factorDeskAbi as Abi)].filter((x) => x.type === "error") as Abi;

/**
 * The contract's numbers, for a page drawn before any engine has answered: the same constants the engine reads from
 * the contract (/api/v1/verifiers/about, `rules`), which every page uses once it has them.
 */
export const RULES: VerifierRules = { minFeeEth: 0.0001, minBondEth: 0.01, stakePct: 20, minStakeEth: 0.001, wrongLossPct: 50, disputePct: 10, minDisputeEth: 0.0005, panel: 3, checkH: 4, disputeH: 2, seatH: 14, revealH: 18, reviewH: 24, reasonChars: 4000, titleChars: 80, briefChars: 12000 };
/** The makers by their numbers, as Factor's site and API name them (spec-pack/verifiers/README.md), for the same page. */
export const MAKERS: VerifierMaker[] = [
  { id: 1, name: "Anthropic", models: "Claude" }, { id: 2, name: "Google", models: "Gemini" }, { id: 3, name: "OpenAI", models: "GPT" },
  { id: 4, name: "xAI", models: "Grok" }, { id: 5, name: "Meta", models: "Llama" }, { id: 6, name: "Mistral", models: "Mistral" },
  { id: 7, name: "DeepSeek", models: "DeepSeek" }, { id: 8, name: "Alibaba", models: "Qwen" }, { id: 9, name: "Moonshot", models: "Kimi" },
  { id: 10, name: "Zhipu", models: "GLM" }, { id: 11, name: "Amazon", models: "Nova" }, { id: 12, name: "Cohere", models: "Command" },
  { id: 13, name: "Microsoft", models: "Phi" }, { id: 14, name: "NVIDIA", models: "Nemotron" }, { id: 15, name: "MiniMax", models: "MiniMax" },
];
export const rulesOf = (a: VerifiersAbout | null): VerifierRules => a?.rules ?? RULES;
export const makersOf = (a: VerifiersAbout | null): VerifierMaker[] => (a?.makers?.length ? a.makers : MAKERS);
/** A maker's name by its number: 16 to 255 are accepted by the contract and named "another maker". */
export const makerName = (id: number, makers: VerifierMaker[] = MAKERS): string => makers.find((m) => m.id === id)?.name ?? "Another maker";
/** Whether verifiers can be used from this site now: on, with a contract to send to. */
export const isOpen = (a: VerifiersAbout | null): a is VerifiersAbout & { contract: string } => !!a?.enabled && !!a.contract;

// ---- the money, in wei, from the rules ----

const weiOf = (n: number): bigint => parseEther(n.toFixed(18).replace(/0+$/, "").replace(/\.$/, ""));
/** What a verifier stakes on one verdict about a job of this price: a share of it, never under the least stake (stakeOf). */
export function stakeFor(price: bigint, r: VerifierRules): bigint {
  const s = (price * BigInt(Math.round(r.stakePct * 100))) / 10_000n;
  const min = weiOf(r.minStakeEth);
  return s < min ? min : s;
}
/** What a dispute of a job of this price costs (disputeBondOf). */
export function disputeBondFor(price: bigint, r: VerifierRules): bigint {
  const b = (price * BigInt(Math.round(r.disputePct * 100))) / 10_000n;
  const min = weiOf(r.minDisputeEth);
  return b < min ? min : b;
}
export const minFeeWei = (r: VerifierRules): bigint => weiOf(r.minFeeEth);
/** The stake and the dispute bond on a job of `price` ETH, as text for reading: "0.002" and "0.001" on a 0.01 ETH job. */
export const exampleOf = (r: VerifierRules, price = 0.01): { price: string; stake: string; bond: string } => ({
  price: String(price),
  stake: String(+Math.max((price * r.stakePct) / 100, r.minStakeEth).toFixed(6)),
  bond: String(+Math.max((price * r.disputePct) / 100, r.minDisputeEth).toFixed(6)),
});
export const minBondWei = (r: VerifierRules): bigint => weiOf(r.minBondEth);

// ---- a job's words, hashed against the chain ----

/** The words as they are hashed: compact JSON, keys in this order, no spaces. The engine and the kit write the same. */
export const termsText = (t: { title: string; brief: string }): string => JSON.stringify({ title: t.title, brief: t.brief });
export const termsHash = (text: string): Hex => keccak256(toHex(text));

// ---- the contract's refusals, in plain words ----

const eth = (wei: unknown): string => {
  const s = formatEther(BigInt(String(wei)));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};
const when = (s: unknown): string => new Date(Number(s) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const STATE_ON_CHAIN = ["not on the chain", "waiting for its first check", "checked, and open to a dispute", "disputed, with a panel sitting", "back in the customer's hands", "accepted and over", "rejected and over", "returned to the customer"];

const WORDS: Record<string, (a: readonly unknown[], fn: string) => string> = {
  WrongState: (a) => `This job is ${STATE_ON_CHAIN[Number(a[0])] ?? "not in a state that allows it"}. Reload the page and look again.`,
  TooLate: (_a, fn) => (fn === "dispute" ? "The two hours to dispute this verdict are over." : fn === "strike" ? "Seating has closed: no more strikes on this job." : fn === "reject" ? "The desk's 24 hours are over: the job settles as accepted." : "Its time is over."),
  TooSoon: (a) => `Not before ${when(a[0])}.`,
  NotDelivered: () => "The agent has not delivered yet.",
  NotVerifier: () => "This wallet has not joined as a verifier.",
  NoStanding: () => "This wallet's bond is under the least bond, so it has no standing. Add to it first.",
  Related: () => "The chain ties this wallet to a side of the job.",
  BondShort: (a) => `It stakes ${eth(a[0])} ETH, more than this wallet's free bond.`,
  GasShort: () => "The wallet sent it with too little gas. Try again.",
  AlreadyJoined: () => "This wallet has joined already. Add to its bond instead.",
  BadMaker: () => "Choose the maker of the model the verifier runs on.",
  TooSmall: (a, fn) => (fn === "join" ? `The least bond is ${eth(a[0])} ETH.` : `The smallest job is ${eth(a[0])} ETH.`),
  ZeroAmount: () => "Enter an amount.",
  OverFree: (a) => `Only the free bond comes out: ${eth(a[0])} ETH right now. A stake on an open case stays until the case ends.`,
  HasOpenSeats: () => "Not while this wallet holds a seat on a panel.",
  NoTerms: () => "Say what the job is.",
  BadFee: () => "The verification fee is at least the least fee and at most the job's price.",
  NotCustomer: () => "Only the wallet that hired with a verifier can do this. Connect that wallet.",
  NotAgent: () => "Only the job's agent can do this. Connect the agent's wallet.",
  NotYourSide: () => "Only the side the verdict goes against can do this: the customer against accept, the agent against reject.",
  WrongValue: (a) => `It takes exactly ${eth(a[0])} ETH.`,
  StrikeUsed: () => "This side has used its one strike on this job.",
  NotSeated: () => "That verifier does not hold a seat on this panel.",
  StruckOff: () => "That verifier was struck from this job.",
  NothingOwed: () => "Nothing is waiting to be collected.",
  MakerTaken: () => "A verifier of an older standing holds that maker's seat.",
  PanelFull: () => "The panel is full of older standings.",
  AlreadySeated: () => "This wallet holds a seat on this panel already.",
  NotRegistered: () => "That address has not registered as an agent on the desk.",
};

/** What a failed call was, in words. `fn`: the call it was, which some refusals need to be said right. */
export function explainVerifiers(e: unknown, fn = ""): string {
  if (e instanceof Refusal) return e.message;
  if (declined(e)) return "You declined it in your wallet. Nothing was sent.";
  const err = e as { data?: unknown; error?: { data?: unknown }; cause?: { data?: unknown } };
  for (const d of [err.data, err.error?.data, err.cause?.data, (err.data as { data?: unknown } | undefined)?.data, (err.data as { originalError?: { data?: unknown } } | undefined)?.originalError?.data]) {
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
      try {
        const r = decodeErrorResult({ abi: ALL, data: d as Hex });
        const args = (r.args ?? []) as readonly unknown[];
        return WORDS[r.errorName]?.(args, fn) ?? wordsFor(r.errorName, args) ?? `The contract refuses it: ${r.errorName}.`;
      } catch {
        // not one of these
      }
    }
  }
  return deskExplain(e);
}

/** One call to the verifier contract from a wallet: tried without sending, sent, followed until it is mined. */
export async function sendVerifiers(p: Provider, o: { contract: string; from: string; fn: string; args?: readonly unknown[]; value?: bigint; on?: (step: "checking" | "wallet" | "mining") => void }): Promise<{ hash: string; receipt: Receipt }> {
  o.on?.("checking");
  await ensureChain(p);
  const code = await p.request({ method: "eth_getCode", params: [o.contract, "latest"] }).catch(() => null);
  if (typeof code !== "string" || code.length <= 2) throw new Refusal("Your wallet does not see the verifier contract on the chain it is on. Nothing was sent. Check that the wallet is on Robinhood Chain.");
  const data = encodeFunctionData({ abi: VERIFIERS_ABI, functionName: o.fn, args: o.args ?? [] });
  try {
    await ethCall(p, o.contract, data, o.from, o.value);
  } catch (e) {
    throw new Refusal(explainVerifiers(e, o.fn));
  }
  o.on?.("wallet");
  let hash: string;
  try {
    hash = await sendTx(p, { from: o.from, to: o.contract, data, value: o.value });
  } catch (e) {
    throw new Refusal(explainVerifiers(e, o.fn));
  }
  o.on?.("mining");
  const receipt = await waitFor(p, hash);
  if (receipt.status !== "0x1") throw new Refusal(receipt.reason ?? "The transaction was mined and refused. Nothing changed. Reload the page and look again.");
  return { hash: receipt.transactionHash || hash, receipt };
}

/** A wallet's free bond as the contract has it now (verifier(address).free): what withdraw can take out. */
export async function freeBondOf(p: Provider, contract: string, who: string): Promise<bigint> {
  const data = encodeFunctionData({ abi: VERIFIERS_ABI, functionName: "verifier", args: [who as Hex] });
  const out = await ethCall(p, contract, data);
  const v = decodeFunctionResult({ abi: VERIFIERS_ABI, functionName: "verifier", data: out as Hex }) as unknown as { free: bigint };
  return v.free;
}

/** The case and its desk job, read from the transaction that hired with a verifier (Hired). */
export function hiredCase(receipt: Receipt, contract: string): { id: number; job: number } | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: VERIFIERS_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      if (d.eventName === "Hired") {
        const a = d.args as unknown as { id: bigint; job: bigint };
        return { id: Number(a.id), job: Number(a.job) };
      }
    } catch {
      // another event
    }
  }
  return null;
}

/** The words of a job go to the engine, which takes them because they hash to what the case holds. Tried every 2 s for up to 40 s while the engine reads the new case. */
export async function sendTerms(id: number, terms: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    const r = await fetch("/api/v1/verifiers/terms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, terms }) });
    if (r.ok) return;
    const said = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "They could not be saved.";
    if (!((r.status === 404 || r.status === 409 || r.status === 502) && tries < 20)) throw new Refusal(said.charAt(0).toUpperCase() + said.slice(1) + (said.endsWith(".") ? "" : "."));
    await new Promise((res) => setTimeout(res, 2000));
  }
}

// ---- verdicts on the ERC-8004 Validation Registry ----

/** A revert's own words (Error(string)), when a call was refused with some: the registry says "Not authorized". */
function revertText(e: unknown): string | null {
  const err = e as { data?: unknown; message?: string; error?: { data?: unknown; message?: string }; cause?: { data?: unknown } };
  for (const d of [err.data, err.error?.data, err.cause?.data, (err.data as { data?: unknown } | undefined)?.data, (err.data as { originalError?: { data?: unknown } } | undefined)?.originalError?.data]) {
    if (typeof d === "string" && d.startsWith("0x08c379a0")) {
      try {
        return decodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }] as Abi, data: d as Hex }).args?.[0] as string;
      } catch {
        // not a plain reason
      }
    }
  }
  const m = /reverted(?: with reason string)?:? '?([^'\n]+)'?/i.exec(`${err.message ?? ""} ${err.error?.message ?? ""}`);
  return m ? m[1]!.trim() : null;
}

/**
 * One call to the ERC-8004 Validation Registry exactly as the engine prepared it (a request from the agent identity's
 * owner, or the validator's answer): tried first without sending, then sent and followed until it is mined. `who`
 * says, in words, which wallet the registry takes it from, for when it refuses.
 */
export async function sendRegistryCall(p: Provider, o: { call: { to: string; data: string }; registry: string; from: string; who: string; on?: (step: "checking" | "wallet" | "mining") => void }): Promise<{ hash: string }> {
  if (o.call.to.toLowerCase() !== o.registry.toLowerCase()) throw new Refusal("That call is not to the ERC-8004 Validation Registry. Nothing was sent.");
  o.on?.("checking");
  await ensureChain(p);
  const code = await p.request({ method: "eth_getCode", params: [o.registry, "latest"] }).catch(() => null);
  if (typeof code !== "string" || code.length <= 2) throw new Refusal("Your wallet does not see the ERC-8004 Validation Registry on the chain it is on. Nothing was sent. Check that the wallet is on Robinhood Chain.");
  const refused = (e: unknown): Refusal => {
    if (declined(e)) return new Refusal("You declined it in your wallet. Nothing was sent.");
    const why = revertText(e);
    return new Refusal(why && /not authori[sz]ed/i.test(why) ? `The registry refuses this wallet: ${o.who}. Nothing was sent.` : why ? `The registry refuses it: ${why}. Nothing was sent.` : deskExplain(e));
  };
  try {
    await ethCall(p, o.call.to, o.call.data, o.from);
  } catch (e) {
    throw refused(e);
  }
  o.on?.("wallet");
  let hash: string;
  try {
    hash = await sendTx(p, { from: o.from, to: o.call.to, data: o.call.data });
  } catch (e) {
    throw refused(e);
  }
  o.on?.("mining");
  const receipt = await waitFor(p, hash);
  if (receipt.status !== "0x1") throw new Refusal(receipt.reason ?? "The transaction was mined and refused. Nothing changed. Reload the page and look again.");
  return { hash: receipt.transactionHash || hash };
}

/** Where a verdict stands on ERC-8004, in a few words. */
export const ERC8004_WORD: Record<CaseErc8004["state"], string> = {
  off: "Not written there",
  "no-identity": "The agent has no identity there",
  "no-verdict": "Waiting for the outcome",
  prepared: "Ready to request",
  requested: "Requested, waiting for the answer",
  answered: "Answered",
};

/** What a checked model receipt shows, and what it does not, in the words every page uses. */
export const RECEIPT_SHOWS = "The verifier's reasons, whose hash has been on the chain since its verdict, name one call at the model provider, by its id, and the hashes of the exact request and answer, which anyone can work out again from the published texts. Factor looked that call up at the provider, with the key that made it, and the model that answered was of the maker the verifier declared.";
export const RECEIPT_NOT = "Nobody but Factor can read the provider's own record of the call. A receipt an outside verifier gives is shown as given and not checked, so its model stays declared.";

// ---- words for a case ----

export const CASE_WORD: Record<CaseState, string> = { working: "Working", checked: "Checked", disputed: "Disputed", customer: "Customer decides", accepted: "Accepted", rejected: "Rejected", returned: "Returned" };
export const CASE_TONE: Partial<Record<CaseState, string>> = { accepted: "go", checked: "warn", disputed: "warn", customer: "warn", rejected: "bad", returned: "bad" };
export const HOW_WORD: Record<CaseHow, string> = { "first-check": "the first check", panel: "the panel", customer: "the customer, by the desk's rule", clock: "the desk's clock", "not-delivered": "never delivered: the desk refunded it" };
export const NEXT_WORD: Record<CaseNext, string> = { check: "Waiting for a check", dispute: "Open to a dispute", seats: "Panel seating", reveals: "Panel revealing", step: "A step is due", customer: "The customer decides" };

/**
 * The parts of a verifier's reasons, when it wrote them as Factor's own do (`Verdict:`, `Tests:` with `- pass:` and
 * `- fail:` lines, `Reasons:`, `Model:`). Any other plain text comes back whole as `text`.
 */
export function readReason(raw: string): { tests: { pass: boolean; text: string }[]; text: string; model: string | null } {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const tests: { pass: boolean; text: string }[] = [];
  const rest: string[] = [];
  let model: string | null = null, section: "tests" | "reasons" | null = null, structured = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^verdict:/i.test(t)) { structured = true; continue; }
    if (/^tests:\s*$/i.test(t)) { structured = true; section = "tests"; continue; }
    const r = /^reasons?:\s*(.*)$/i.exec(t);
    if (r) { structured = true; section = "reasons"; if (r[1]) rest.push(r[1]); continue; }
    const m = /^model:\s*(.+)$/i.exec(t);
    if (m) { structured = true; model = m[1]!; section = null; continue; }
    const k = /^-\s*(pass|fail):\s*(.+)$/i.exec(t);
    if (k && section === "tests") { tests.push({ pass: k[1]!.toLowerCase() === "pass", text: k[2]! }); continue; }
    rest.push(line);
  }
  return structured ? { tests, text: rest.join("\n").trim(), model } : { tests: [], text: raw.trim(), model: null };
}
