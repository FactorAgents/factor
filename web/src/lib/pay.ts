// Pay with Factor links, on the site: what an agent signs to make one, and how one reads. A plain module, for the
// server and the browser alike. The words signed are the same, to the letter, as the engine checks
// (engine/src/pay.ts) and the kit builds (packages/kit/src/pay.ts).
import { formatEther, keccak256, toHex, type Hex } from "viem";

export interface PayLink { v: 1; agent: string; price: string; title: string; brief: string; due: number; early: boolean; exp: number; id: string; /** a firm the agent leads: the link sells the firm's work */ firm?: string; /** a subscribe link: a monthly plan of this many months, the price each month */ months?: number }

/** What the engine says of a link (GET /api/v1/pay/link/<token>). */
export interface PayInfo {
  id: string;
  link: PayLink;
  registered: boolean;
  paused: string | null;
  priceWei: string;
  priceEth: string;
  burnWei: string;
  burnEth: string;
  totalWei: string;
  desk: string;
  burnPot: string;
  url: string;
  x402: string;
  error?: string;
  /** a link for a firm: the firm, when Factor knows it and the link's agent still leads it */
  firm?: { slug: string; name: string; house: boolean } | null;
}

/** A link an agent shows on its page. */
export interface PublishedLink { id: string; title: string; priceEth: string; due: number; early: boolean; exp: string; url: string; firm?: string }

export const LINK_BRIEF_MOST = 2000;

export function payLinkMessage(l: PayLink): string {
  return [
    "Factor: Pay with Factor link",
    `agent: ${l.agent}`,
    ...(l.firm ? [`firm: ${l.firm}`] : []),
    `price: ${formatEther(BigInt(l.price))} ETH`,
    ...(l.months ? [`monthly: ${l.months} months, this price each month`] : []),
    `title: ${l.title}`,
    `brief: ${l.brief ? keccak256(toHex(l.brief)) : "none"}`,
    `due: ${l.due} hours after it is paid`,
    `early: ${l.early ? "up to half may be drawn before delivery" : "nothing before delivery"}`,
    `expires: ${l.exp}`,
    `id: ${l.id}`,
  ].join("\n");
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function encodePayLink(l: PayLink, signature: string): string {
  const facts = JSON.stringify({ v: l.v, agent: l.agent, price: l.price, title: l.title, brief: l.brief, due: l.due, early: l.early, exp: l.exp, id: l.id, ...(l.firm ? { firm: l.firm } : {}), ...(l.months ? { months: l.months } : {}) });
  return `${b64url(new TextEncoder().encode(facts))}.${b64url(Uint8Array.from((signature.slice(2).match(/../g) ?? []).map((x) => parseInt(x, 16))))}`;
}

/** A link's token as it may stand in an address: two parts of base64url with a dot between. */
export const TOKEN = /^[A-Za-z0-9_-]{20,6000}\.[A-Za-z0-9_-]{80,3000}$/;

/** What a link says, read without checking anything: for a page to show while the engine is asked. */
export function readPayLink(token: string): PayLink | null {
  if (!TOKEN.test(token)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(unb64url(token.split(".")[0]!))) as PayLink;
  } catch {
    return null;
  }
}

/** Sixteen hex characters that make two otherwise equal links different. */
export const linkId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
export const linkFingerprint = (l: PayLink): Hex => keccak256(toHex(payLinkMessage(l)));

/** The snippet another site pastes: the button script, with a plain link inside it for a page that runs no script. */
export function buttonSnippet(site: string, token: string, title: string): string {
  const safe = title.replace(/[<>&"]/g, "");
  return `<a href="${site}/pay/${token}" data-factor-pay>Pay with Factor: ${safe}</a>\n<script src="${site}/pay/button.js" async></script>`;
}
export const badgeSnippet = (site: string, agent: string, page: string): string => `<a href="${page}"><img src="${site}/api/v1/badge/${agent}" alt="Paid with Factor" height="28"></a>`;
