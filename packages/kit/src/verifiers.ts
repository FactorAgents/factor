// Verifiers (contracts/src/FactorVerifiers.sol, spec-pack/verifiers): what a verified job's words are and their hash, a
// verifier's reasons and their hash, and a panelist's sealed verdict, to the letter as the contract and the engine take
// them. Nothing here sends anything; the Factor class does, from a plain wallet.
//
//   terms      = {"title":"...","brief":"..."}             compact JSON, keys in this order
//   termsHash  = keccak256(UTF-8 bytes of terms)
//   reasonHash = keccak256(UTF-8 bytes of the reasons, exactly as given)
//   salt       = keccak256(the wallet's personal_sign of sealMessage(case, wallet))
//   commit     = keccak256(abi.encode(uint256 case, address wallet, bool accept, bytes32 reasonHash, bytes32 salt))
import { BaseError, ContractFunctionRevertedError, encodeAbiParameters, keccak256, toHex, type Abi, type Hex } from "viem";
import { factorDeskAbi } from "./abi/FactorDesk.js";
import { factorVerifiersAbi } from "./abi/FactorVerifiers.js";
import type { ModelReceiptInput, VerifierCaseState, VerifiersAbout } from "./types.js";
import { explain, Refusal } from "./words.js";

/** The contract's states, in the order it numbers them, as the API names them. */
export const VERIFIER_STATES = ["none", "working", "checked", "disputed", "customer", "accepted", "rejected", "returned"] as const;

/** The contract's numbers, in wei and seconds. */
export const MIN_FEE_WEI = 100_000_000_000_000n;
export const MIN_BOND_WEI = 10_000_000_000_000_000n;
export const MIN_JOB_WEI = 1_000_000_000_000_000n;
export const MIN_STAKE_WEI = 1_000_000_000_000_000n;
export const MIN_DISPUTE_WEI = 500_000_000_000_000n;
export const TITLE_MOST = 80;
export const BRIEF_MOST = 12_000;
export const REASON_MOST = 4000;

/** The model makers, by the number a verifier declares. 16 to 255 are another maker. */
export const MAKERS: Record<number, { name: string; models: string }> = {
  1: { name: "Anthropic", models: "Claude" }, 2: { name: "Google", models: "Gemini" }, 3: { name: "OpenAI", models: "GPT" }, 4: { name: "xAI", models: "Grok" },
  5: { name: "Meta", models: "Llama" }, 6: { name: "Mistral", models: "Mistral" }, 7: { name: "DeepSeek", models: "DeepSeek" }, 8: { name: "Alibaba", models: "Qwen" },
  9: { name: "Moonshot", models: "Kimi" }, 10: { name: "Zhipu", models: "GLM" }, 11: { name: "Amazon", models: "Nova" }, 12: { name: "Cohere", models: "Command" },
  13: { name: "Microsoft", models: "Phi" }, 14: { name: "NVIDIA", models: "Nemotron" }, 15: { name: "MiniMax", models: "MiniMax" },
};
export const makerName = (id: number): string => MAKERS[id]?.name ?? "another maker";

/** What a verdict stakes on a job of this price, as the contract's stakeOf: 20%, at least 0.001 ETH. */
export const stakeOf = (price: bigint): bigint => { const s = (price * 2000n) / 10_000n; return s < MIN_STAKE_WEI ? MIN_STAKE_WEI : s; };
/** What a dispute of a job of this price costs, as the contract's disputeBondOf: 10%, at least 0.0005 ETH. */
export const disputeBondOf = (price: bigint): bigint => { const b = (price * 1000n) / 10_000n; return b < MIN_DISPUTE_WEI ? MIN_DISPUTE_WEI : b; };

/** A job's words as they are hashed: compact JSON, the title then the brief. */
export const verifierTermsText = (t: { title: string; brief: string }): string => JSON.stringify({ title: t.title, brief: t.brief });
/** The hash of a job's words, or of a verifier's reasons: keccak256 of the UTF-8 bytes. */
export const textHashOf = (text: string): Hex => keccak256(toHex(text));
export const verifierTermsHash = (terms: string): Hex => textHashOf(terms);
export const reasonHashOf = (reason: string): Hex => textHashOf(reason);

/** A job's title and brief, held to what the engine takes, and its words as they are hashed. Refused here, before anything is sent. */
export function checkVerifierTerms(t: { title: unknown; brief: unknown }): { title: string; brief: string; terms: string } {
  const title = typeof t.title === "string" ? t.title.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
  if (title.length < 3 || title.length > TITLE_MOST || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff<>]/.test(title) || /https?:|www\.|:\/\/|\.(com|io|xyz|fun|net|org|gg|me|app)\b/i.test(title)) throw new Refusal(`The title is one plain line of 3 to ${TITLE_MOST} characters, without links.`, "bad_title");
  const brief = typeof t.brief === "string" ? t.brief.replace(/\r\n?/g, "\n").trim() : "";
  if (!brief || brief.length > BRIEF_MOST || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/.test(brief)) throw new Refusal(`The brief is plain text of 1 to ${BRIEF_MOST.toLocaleString("en")} characters: what the work must do, and what the verifier checks it against.`, "bad_brief");
  return { title, brief, terms: verifierTermsText({ title, brief }) };
}

/** A verifier's reasons: plain text of 1 to 4,000 characters, hashed exactly as given. Refused here, before anything is sent. */
export function checkReason(reason: unknown): string {
  if (typeof reason !== "string" || !reason.trim() || reason.length > REASON_MOST || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) throw new Refusal(`The reasons are plain text of 1 to ${REASON_MOST.toLocaleString("en")} characters: what was checked and why.`, "bad_reason");
  return reason;
}

// ---------- model receipts ----------

/**
 * A model receipt in a verdict's reasons: these lines at the very end, joined to the reasons (their trailing white space
 * removed) by one line end. The reasons' hash on the chain then commits to that provider call and to the exact request
 * body and answer text whose hashes it gives.
 *
 *   Receipt:
 *   - provider: openrouter
 *   - generation: <the provider's id of the call>
 *   - model: <the model asked for>
 *   - request-hash: 0x<keccak256 of the exact request body sent, UTF-8>
 *   - output-hash: 0x<keccak256 of the answer's text, UTF-8>
 */
export const receiptBlock = (r: ModelReceiptInput): string =>
  ["Receipt:", `- provider: ${r.provider}`, `- generation: ${r.generationId}`, `- model: ${r.model}`, `- request-hash: ${r.requestHash}`, `- output-hash: ${r.outputHash}`].join("\n");

/** A receipt held to what fits its lines: refused here, before anything is sent. The hashes in lowercase. */
export function checkReceipt(r: unknown): ModelReceiptInput {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const field = (x: unknown, most: number, what: string, ok: RegExp): string => {
    const s = typeof x === "string" ? x.trim() : "";
    if (!s || s.length > most || !ok.test(s)) throw new Refusal(`The receipt's ${what}.`, "bad_receipt");
    return s;
  };
  return {
    provider: field(o.provider, 40, 'provider is a plain name of up to 40 characters, like "openrouter"', /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/),
    generationId: field(o.generationId, 200, "generation is the provider's id of the call: up to 200 characters, no spaces", /^[!-~]+$/),
    model: field(o.model, 200, "model is the model asked for: up to 200 characters, no spaces", /^[!-~]+$/),
    requestHash: field(o.requestHash, 66, "request hash is 0x and 64 hex characters: the keccak256 of the exact request body sent", /^0x[0-9a-fA-F]{64}$/).toLowerCase(),
    outputHash: field(o.outputHash, 66, "output hash is 0x and 64 hex characters: the keccak256 of the answer's text", /^0x[0-9a-fA-F]{64}$/).toLowerCase(),
  };
}

/** The reasons with a receipt at their end, as they are hashed. Without a receipt, the reasons as given. */
export function withReceipt(reason: string, receipt?: ModelReceiptInput | null): string {
  if (!receipt) return reason;
  const r = checkReceipt(receipt);
  if (/^Receipt:[ \t]*$/m.test(reason)) throw new Refusal("The reasons have a Receipt: line already. Give the receipt on its own, and the kit adds it at the end.", "bad_receipt");
  return checkReason(`${reason.replace(/\s+$/, "")}\n${receiptBlock(r)}`);
}

/** A receipt's two hashes, from the exact request body sent to the provider and the answer's text. */
export const receiptHashes = (request: string, output: string): { requestHash: Hex; outputHash: Hex } => ({ requestHash: textHashOf(request), outputHash: textHashOf(output) });

/** The receipt at the end of a verdict's reasons, with any further lines (Factor's own verifiers add some). null: there is none. */
export function readReceipt(reasons: string): (ModelReceiptInput & { more: Record<string, string> }) | null {
  const lines = reasons.split("\n");
  const at = lines.map((l) => l.trim()).lastIndexOf("Receipt:");
  if (at < 0) return null;
  const kv: Record<string, string> = {};
  for (const l of lines.slice(at + 1)) {
    const m = /^- ([a-z-]+): (.*)$/.exec(l.trim());
    if (!m) return null;
    kv[m[1]!] = m[2]!.trim();
  }
  const { provider, generation, model, "request-hash": requestHash, "output-hash": outputHash, ...more } = kv;
  if (!provider || !generation || !model || !requestHash || !outputHash) return null;
  return { provider, generationId: generation, model, requestHash, outputHash, more };
}

// ---------- ERC-8004 validations ----------

/** The ERC-8004 Validation Registry on Robinhood Chain, and the tag Factor's validations of verified jobs carry. */
export const VALIDATION_REGISTRY = "0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58";
export const VALIDATION_TAG = "factorVerify";

/** What a failed call to the Validation Registry was, in words. It refuses with plain strings. */
export function validationWordsOf(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (e instanceof BaseError) {
    const hit = e.walk((x) => x instanceof ContractFunctionRevertedError);
    const said = hit instanceof ContractFunctionRevertedError ? hit.reason ?? "" : "";
    if (/not authorized/i.test(said)) return "Only the owner of the agent's ERC-8004 identity, or an operator it approved, can ask for this validation.";
    if (/^unknown$/i.test(said.trim())) return "The registry has no such request: the owner of the agent's ERC-8004 identity has not asked for this validation yet.";
    if (said) return `The Validation Registry refuses it: ${said}.`;
  }
  return explain(e);
}

/** A case's number: a whole number, like 7. */
export function caseNumber(id: unknown): number {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new Refusal("A case's number is a whole number, like 7.", "bad_case");
  return id;
}

/** The words a panelist's wallet signs (EIP-191 personal_sign) to make its salt. The same wallet makes the same salt again at the reveal. */
export const sealMessage = (id: number, verifier: string): string => `Factor verifier seal\ncase: ${id}\nverifier: ${verifier.toLowerCase()}`;
/** The salt of a sealed verdict, from the wallet's signature of sealMessage. */
export const saltOf = (signature: Hex): Hex => keccak256(signature);

/** A sealed verdict, as the contract's commitOf: keccak256(abi.encode(uint256, address, bool, bytes32, bytes32)). */
export const commitOf = (id: number | bigint, who: string, accept: boolean, reasonHash: Hex, salt: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "bool" }, { type: "bytes32" }, { type: "bytes32" }], [BigInt(id), who as Hex, accept, reasonHash, salt]));

/** Where a case stands, in words. */
export const CASE_WORDS: Record<VerifierCaseState, string> = {
  working: "waiting for its first check",
  checked: "checked: its first verdict is in",
  disputed: "disputed: a panel sits",
  customer: "back in the customer's hands, by the desk's own rule",
  accepted: "over: accepted",
  rejected: "over: rejected",
  returned: "over: the payment went back to the customer",
};

/** Why the verifier calls refuse a Factor account. */
export const VERIFIERS_GASLESS = "The verifier tools act from a plain wallet that pays its own gas: they are not offered through a Factor account whose gas Factor pays (gasless). Connect without gasless, with a wallet that holds a little ETH.";

/** What the reads answer while verifiers are off, or before the site knows them. */
export const verifiersOff = (chainId: number): VerifiersAbout => ({
  enabled: false, contract: null, chainId,
  rules: { minFeeEth: 0.0001, minBondEth: 0.01, stakePct: 20, minStakeEth: 0.001, wrongLossPct: 50, disputePct: 10, minDisputeEth: 0.0005, panel: 3, checkH: 4, disputeH: 2, seatH: 14, revealH: 18, reviewH: 24, reasonChars: REASON_MOST, titleChars: TITLE_MOST, briefChars: BRIEF_MOST },
  makers: Object.entries(MAKERS).map(([id, m]) => ({ id: Number(id), name: m.name, models: m.models })),
  erc8004: { enabled: false, registry: VALIDATION_REGISTRY, tag: VALIDATION_TAG },
  totals: null, house: [],
});

/**
 * Hand a job's words (/verifiers/terms) or a verifier's reasons (/verifiers/reason) to Factor. The engine takes a text only
 * when its hash is the one on the chain, and may not have read the transaction yet: a 404 or a 409 is tried again every
 * 2 seconds, up to 20 times.
 */
export async function sendVerifierText(api: string, path: "/verifiers/terms" | "/verifiers/reason", body: Record<string, unknown>, o: { tries?: number; everyMs?: number } = {}): Promise<{ ok: boolean; note?: string }> {
  const tries = o.tries ?? 20, every = o.everyMs ?? 2000;
  for (let n = 1; ; n++) {
    let status = 0, said = "";
    try {
      const r = await fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      if (r.ok) return { ok: true };
      status = r.status;
      said = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Factor's site answered ${r.status}`;
    } catch {
      said = "Factor's site could not be reached";
    }
    if ((status === 404 || status === 409) && n < tries) { await new Promise<void>((r) => setTimeout(r, every)); continue; }
    const t = said.charAt(0).toUpperCase() + said.slice(1);
    return { ok: false, note: /[.!?]$/.test(t) ? t : `${t}.` };
  }
}

/** The verifier contract's ABI, with the desk's errors beside it: a hire the desk refuses comes back through the verifier contract. */
const OWN = new Set((factorVerifiersAbi as readonly { type: string; name?: string }[]).filter((x) => x.type === "error").map((x) => x.name));
export const VERIFIERS_ABI = [...factorVerifiersAbi, ...(factorDeskAbi as readonly { type: string; name?: string }[]).filter((x) => x.type === "error" && !OWN.has(x.name))] as unknown as Abi;

// ---------- the verdict file ----------

/** What the kit keeps of a sealed verdict, so that the reveal can be made from it. */
export interface KeptVerdict { chainId: number; contract: string; case: number; verifier: string; accept: boolean; reason: string; reasonHash: Hex; salt: Hex; commit: Hex; seat: number | null; tx: Hex; revealFrom: string | null; revealBy: string | null }

/** Where verdicts are kept: FACTOR_VERDICTS_DIR, or ~/.factor/verdicts. null where there are no files to write (not Node). */
async function verdictDir(dir?: string): Promise<string | null> {
  if (typeof process === "undefined" || !process.versions?.node) return null;
  if (dir) return dir;
  const [{ homedir }, { join }] = await Promise.all([import("node:os"), import("node:path")]);
  return process.env.FACTOR_VERDICTS_DIR?.trim() || join(homedir(), ".factor", "verdicts");
}

const verdictName = (chainId: number, contract: string, id: number): string => `${chainId}-${contract.toLowerCase()}-${id}.json`;

/** Keep a sealed verdict in <dir>/<chain>-<contract>-<case>.json, readable by this user only (mode 600). The path, or null when it could not be written. */
export async function keepVerdict(v: KeptVerdict, dir?: string): Promise<string | null> {
  try {
    const at = await verdictDir(dir);
    if (!at) return null;
    const [fs, { join }] = await Promise.all([import("node:fs"), import("node:path")]);
    fs.mkdirSync(at, { recursive: true, mode: 0o700 });
    const file = join(at, verdictName(v.chainId, v.contract, v.case));
    fs.writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
  } catch {
    return null;
  }
}

/** A kept verdict, or null when there is none. */
export async function readVerdict(chainId: number, contract: string, id: number, dir?: string): Promise<KeptVerdict | null> {
  try {
    const at = await verdictDir(dir);
    if (!at) return null;
    const [fs, { join }] = await Promise.all([import("node:fs"), import("node:path")]);
    const v = JSON.parse(fs.readFileSync(join(at, verdictName(chainId, contract, id)), "utf8")) as KeptVerdict;
    return typeof v.accept === "boolean" && typeof v.reason === "string" ? v : null;
  } catch {
    return null;
  }
}
