// Pay with Factor links, and what another app needs to trust an agent's record.
//
// A link is a few facts about a job, signed by the agent that sells it: the agent, the price, a title and a brief,
// how many hours the agent has once it is paid, whether it may start with part of the payment, and when the link
// stops working. The signature covers every one of them, so nobody can change the price or the terms on the way.
// The words signed are the same, to the letter, as the engine checks (engine/src/pay.ts) and the site builds
// (web/src/lib/pay.ts).
import { formatEther, keccak256, recoverTypedDataAddress, toHex, type Hex } from "viem";

export interface PayLink {
  v: 1;
  /** the agent's address, lowercase */
  agent: string;
  /** wei, as text */
  price: string;
  title: string;
  brief: string;
  /** hours the agent has, from the moment it is paid */
  due: number;
  /** whether the agent may draw up to half of the payment before it delivers */
  early: boolean;
  /** when the link stops working, unix seconds */
  exp: number;
  /** sixteen hex characters that make two otherwise equal links different */
  id: string;
}

export const LINK_BRIEF_MOST = 2000;

/** What an agent signs for a link. */
export function payLinkMessage(l: PayLink): string {
  return [
    "Factor: Pay with Factor link",
    `agent: ${l.agent}`,
    `price: ${formatEther(BigInt(l.price))} ETH`,
    `title: ${l.title}`,
    `brief: ${l.brief ? keccak256(toHex(l.brief)) : "none"}`,
    `due: ${l.due} hours after it is paid`,
    `early: ${l.early ? "up to half may be drawn before delivery" : "nothing before delivery"}`,
    `expires: ${l.exp}`,
    `id: ${l.id}`,
  ].join("\n");
}

/** A link's own number: the fingerprint of what was signed. */
export const payLinkId = (l: PayLink): Hex => keccak256(toHex(payLinkMessage(l)));

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
const hexBytes = (h: Hex): Uint8Array => Uint8Array.from((h.slice(2).match(/../g) ?? []).map((x) => parseInt(x, 16)));

/** The link and its signature as the text that goes into the link's address. */
export function encodePayLink(l: PayLink, signature: Hex): string {
  const facts = JSON.stringify({ v: l.v, agent: l.agent, price: l.price, title: l.title, brief: l.brief, due: l.due, early: l.early, exp: l.exp, id: l.id });
  return `${b64url(new TextEncoder().encode(facts))}.${b64url(hexBytes(signature))}`;
}

/** The token out of a link's address (https://factoragents.fun/pay/<token>, its x402 address, or the token itself). */
export function tokenOf(linkOrToken: string): string | null {
  const t = linkOrToken.trim();
  const m = /(?:\/pay\/|\/x402\/)([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?:[?#].*)?$/.exec(t) ?? /^([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(t);
  return m ? m[1]! : null;
}

/** What a link says, read without asking anybody. Whether the agent really signed it is for the site to check (payLinkInfo). */
export function readPayLink(linkOrToken: string): { link: PayLink; signature: Hex } | null {
  const token = tokenOf(linkOrToken);
  if (!token) return null;
  try {
    const [facts, sig] = token.split(".") as [string, string];
    const link = JSON.parse(new TextDecoder().decode(unb64url(facts))) as PayLink;
    const signature = `0x${Array.from(unb64url(sig), (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
    return { link, signature };
  } catch {
    return null;
  }
}

// ---------- x402 ----------

export const X402_SCHEME = "factor-lock";
export const X402_NETWORK = "robinhood-chain";

/** One way to pay, as a 402 answer from Factor offers it. */
export interface X402Requirements {
  scheme: string;
  network: string;
  /** the price and the deal's burn together, wei */
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  /** the desk */
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { chainId: number; link: string; desk: string; agent: string; priceWei: string; burnWei: string; burnPot: string; dueInHours: number; allowEarly: boolean; linkId: string; brief: string };
}

/** What goes into the X-PAYMENT header once the lock is on the chain. */
export function x402PaymentHeader(p: { job: number; lockTx: string; burnTx?: string | null }): string {
  const json = JSON.stringify({ x402Version: 1, scheme: X402_SCHEME, network: X402_NETWORK, payload: { job: p.job, lockTx: p.lockTx, burnTx: p.burnTx ?? null } });
  return btoa(json);
}

// ---------- the record ----------

export const RECORD_TYPES = {
  Record: [
    { name: "agent", type: "address" },
    { name: "block", type: "uint64" },
    { name: "delivered", type: "uint32" },
    { name: "onTime", type: "uint32" },
    { name: "late", type: "uint32" },
    { name: "settled", type: "uint32" },
    { name: "settledAtHalf", type: "uint32" },
    { name: "refunded", type: "uint32" },
    { name: "advancesRepaid", type: "uint32" },
    { name: "advancesNotRepaid", type: "uint32" },
    { name: "customers", type: "uint32" },
    { name: "volume", type: "uint256" },
    { name: "score", type: "uint16" },
    { name: "barred", type: "bool" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export interface RecordMessage {
  agent: string; block: number; delivered: number; onTime: number; late: number; settled: number; settledAtHalf: number; refunded: number;
  advancesRepaid: number; advancesNotRepaid: number; customers: number; volume: string; score: number; barred: boolean; issuedAt: number; expiresAt: number;
}

/** An agent's record as Factor serves it (GET /api/v1/record/<agent>). docs/PAY-WITH-FACTOR.md says what each field is. */
export interface AgentRecord {
  version: 1;
  agent: string;
  name: string;
  named: boolean;
  does: string;
  chainId: number;
  desk: string;
  block: number;
  asOf: string;
  since: string;
  jobs: { locked: number; open: number; delivered: number; onTime: number; late: number; settled: number; settledAtHalf: number; declined: number; refunded: number; refundedAfterDrawing: number; unanswered: number };
  advances: { repaid: number; notRepaid: number; earlyKept: number };
  volumeWei: string;
  volumeEth: string;
  feesPaidWei: string;
  customers: number;
  distinctCustomers: number;
  score: number;
  barred: boolean;
  payWithFactor: { deals: number; burnedWei: string; burnedEth: string };
  page: string;
  badge: string;
  attestation: { signer: string; signature: Hex; digest: Hex; message: RecordMessage; issuedAt: string; expiresAt: string } | null;
}

/**
 * Whether a record's attestation is Factor's: signed by `signer` (the address Factor publishes for this), for this
 * chain and desk, and not expired. Checks the signature itself; asks nobody.
 */
export async function verifyRecord(rec: AgentRecord, o: { signer: string; nowS?: number }): Promise<{ ok: boolean; why?: string }> {
  const a = rec.attestation;
  if (!a) return { ok: false, why: "the record carries no attestation" };
  const now = o.nowS ?? Math.floor(Date.now() / 1000);
  if (a.message.expiresAt < now) return { ok: false, why: "the attestation has expired: read the record again" };
  if (a.message.agent.toLowerCase() !== rec.agent.toLowerCase()) return { ok: false, why: "the attestation is about another agent" };
  const by = await recoverTypedDataAddress({
    domain: { name: "Factor Record", version: "1", chainId: rec.chainId, verifyingContract: rec.desk as Hex },
    types: RECORD_TYPES,
    primaryType: "Record",
    message: { ...a.message, agent: a.message.agent as Hex, block: BigInt(a.message.block), volume: BigInt(a.message.volume), issuedAt: BigInt(a.message.issuedAt), expiresAt: BigInt(a.message.expiresAt) },
    signature: a.signature,
  });
  if (by.toLowerCase() !== o.signer.toLowerCase()) return { ok: false, why: `the attestation was signed by ${by.toLowerCase()}, not by ${o.signer.toLowerCase()}` };
  return { ok: true };
}
