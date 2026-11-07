// Paid reviews on the site (docs/REVIEWS.md): the words in their plain form and the typed data a wallet signs, the same
// to the letter as the engine checks them (engine/src/reviews.ts) and the kit builds them (packages/kit/src/reviews.ts);
// signing in the visitor's own wallet or passkey account; and the browser's own check of the ERC-8004 call the engine
// prepares, before the wallet sees it. Factor sends nothing and pays no gas for any of it.
import { decodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Hex } from "viem";
import { CHAIN } from "./chain";
import { REPUTATION_REGISTRY } from "./erc8004";
import type { Provider } from "./wallet";

export const REVIEW_TAG1 = "factorReview";
export const REVIEW_MOST_CHARS = 500;

/**
 * A review's or a reply's words in their plain form, or null when there are more than `most` characters. What is
 * signed must already be in this form: the form shows it before the wallet does.
 */
export function reviewText(raw: unknown, most = REVIEW_MOST_CHARS): string | null {
  if (typeof raw !== "string" || raw.length > most * 8) return null;
  let t = raw.normalize("NFC").replace(/\r\n?/g, "\n");
  t = t.replace(/\t/g, " ").replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "");
  t = t.replace(/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u20E3\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g, "");
  t = t.replace(/[\u2190-\u21FF]/g, (c) => (c === "\u2190" || c === "\u2192" ? c : ""));
  t = t.replace(/[\u2300-\u23FF\u2460-\u24FF\u25A0-\u27BF\u2900-\u297F\u2B00-\u2BFF\u3030\u303D\u3297\u3299]|[\u{1F000}-\u{1FAFF}]|[\u{E0000}-\u{E007F}]/gu, "");
  t = t.split("\n").map((l) => l.replace(/[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g, " ").trim()).join("\n");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t.length > most ? null : t;
}

const DOMAIN_TYPE = [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }];
const REVIEW_TYPE = [{ name: "job", type: "uint256" }, { name: "agent", type: "address" }, { name: "reviewer", type: "address" }, { name: "stars", type: "uint8" }, { name: "text", type: "string" }, { name: "at", type: "uint64" }];
const REPLY_TYPE = [{ name: "job", type: "uint256" }, { name: "agent", type: "address" }, { name: "by", type: "address" }, { name: "review", type: "bytes32" }, { name: "text", type: "string" }, { name: "at", type: "uint64" }];
const domainOf = (desk: string) => ({ name: "Factor Reviews", version: "1", chainId: CHAIN.id, verifyingContract: getAddress(desk) });

/** A review as a wallet signs it (eth_signTypedData_v4): numbers as strings. */
export function reviewTyped(o: { desk: string; job: number; agent: string; reviewer: string; stars: number; text: string; at: number }) {
  return { domain: domainOf(o.desk), types: { EIP712Domain: DOMAIN_TYPE, Review: REVIEW_TYPE }, primaryType: "Review", message: { job: String(o.job), agent: getAddress(o.agent), reviewer: getAddress(o.reviewer), stars: o.stars, text: o.text, at: String(o.at) } };
}

/** The agent's reply to the version whose digest is `review`. */
export function replyTyped(o: { desk: string; job: number; agent: string; by: string; review: string; text: string; at: number }) {
  return { domain: domainOf(o.desk), types: { EIP712Domain: DOMAIN_TYPE, Reply: REPLY_TYPE }, primaryType: "Reply", message: { job: String(o.job), agent: getAddress(o.agent), by: getAddress(o.by), review: o.review, text: o.text, at: String(o.at) } };
}

/** Typed data signed in the wallet, which shows every field first. A passkey account answers the same request. */
export function signTyped(p: Provider, address: string, typed: object): Promise<string> {
  return p.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(typed)] }) as Promise<string>;
}

/** The call the engine prepares for the customer's own wallet (GET /api/v1/reviews/job/<n>/erc8004). */
export interface Erc8004Call { ok: true; to: string; data: Hex; value: string; chainId: number; from: string; fn: string; agentId: string; stars: number; tag1: string; tag2: string; uri: string; hash: Hex; version: number; already: { tx: string; index: number | null } | null; does: string }

const GIVE = parseAbi(["function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)"]);

/**
 * The browser's own check of the prepared ERC-8004 call, before the wallet sees it: the registry's address as this page
 * knows it, the function, the identity, the stars, the tag, the sender, no ETH, and the hash of the file this page fetched
 * itself from this site. Throws with the reason when anything does not hold.
 */
export async function checkErc8004Call(c: Erc8004Call, want: { job: number; stars: number; reviewer: string; agentId?: string | null }): Promise<void> {
  const no = (why: string): never => { throw new Error(`The prepared call does not hold: ${why}. Nothing was sent.`); };
  if (c.chainId !== CHAIN.id) no("it is for another chain");
  if (c.to.toLowerCase() !== REPUTATION_REGISTRY.toLowerCase()) no("it does not go to the ERC-8004 reputation registry");
  if (c.value !== "0") no("it would send ETH");
  if (c.from.toLowerCase() !== want.reviewer.toLowerCase()) no("it is not from your wallet");
  let d: { functionName: string; args: readonly unknown[] };
  try { d = decodeFunctionData({ abi: GIVE, data: c.data }) as typeof d; } catch { return no("its bytes are not a giveFeedback call"); }
  const [agentId, value, decimals, tag1, , , uri, hash] = d.args as [bigint, bigint, number, string, string, string, string, Hex];
  if (d.functionName !== "giveFeedback") no("it is not giveFeedback");
  if (want.agentId && agentId.toString() !== want.agentId) no("it is for another identity");
  if (value !== BigInt(want.stars) || decimals !== 0) no("its value is not your stars");
  if (tag1 !== REVIEW_TAG1) no("its tag is not factorReview");
  const m = /\/api\/v1\/reviews\/file\/(\d{1,9})\/(\d{1,2})$/.exec(uri);
  if (!m || Number(m[1]) !== want.job) no("its file is not this job's review");
  const file = await fetch(`/api/v1/reviews/file/${m![1]}/${m![2]}`, { cache: "no-store" }).then((r) => (r.ok ? r.text() : ""));
  if (!file || keccak256(toHex(file)) !== hash) no("the file it points at does not hash to what it carries");
}
