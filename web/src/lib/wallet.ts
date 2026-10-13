// A visitor's wallet, spoken to the plain way every wallet understands (EIP-1193): no wallet kit, nothing loaded
// from anywhere. Everything here runs in the browser and only when the visitor does something.
//
// The site's own scripts never talk to a node. What has to be asked of the chain from the page (what a call would
// do before it is sent, whether a transaction is mined) is asked through the visitor's wallet, which has a node of
// its own.
import { CHAIN } from "./chain";

export interface Provider {
  request(a: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (...a: unknown[]) => void): void;
  removeListener?(event: string, fn: (...a: unknown[]) => void): void;
  isMetaMask?: boolean;
  providers?: Provider[];
}

export interface Receipt { status: string; transactionHash: string; logs: { address: string; topics: string[]; data: string }[] }

/** The wallet in this browser, or null. With several installed, MetaMask's if it is one of them. */
export function provider(): Provider | null {
  if (typeof window === "undefined") return null;
  const eth = (window as unknown as { ethereum?: Provider }).ethereum;
  if (!eth) return null;
  return eth.providers?.find((p) => p.isMetaMask) ?? eth.providers?.[0] ?? eth;
}

/** A phone: a coarse pointer AND a phone's name for itself. A touchscreen laptop is not one. Read at the tap. */
export function isPhone(): boolean {
  return window.matchMedia("(pointer: coarse)").matches && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** This very page, opened inside MetaMask's own browser, where a wallet exists. */
export function deepLink(): string {
  return `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/** No wallet here: a phone goes to this page inside MetaMask, a computer to where a wallet is got. */
export function goGetAWallet(): void {
  if (isPhone()) window.location.assign(deepLink());
  else window.open("https://metamask.io/download/", "_blank", "noopener,noreferrer");
}

const low = (v: unknown): string | null => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null);

/** The account the wallet has already shared with this site, without asking. */
export async function sharedAccount(p: Provider): Promise<string | null> {
  try {
    return low(((await p.request({ method: "eth_accounts" })) as string[])[0]);
  } catch {
    return null;
  }
}

/** Ask the wallet for an account. Throws what the wallet throws when the visitor says no. */
export async function askAccount(p: Provider): Promise<string | null> {
  return low(((await p.request({ method: "eth_requestAccounts" })) as string[])[0]);
}

export async function chainOf(p: Provider): Promise<string> {
  return String(await p.request({ method: "eth_chainId" })).toLowerCase();
}

/** Put the wallet on Robinhood Chain, adding the chain to it first if it has never heard of it. */
export async function ensureChain(p: Provider): Promise<void> {
  if ((await chainOf(p)) === CHAIN.hex) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.hex }] });
  } catch (e) {
    // 4902: the wallet does not know the chain
    if ((e as { code?: number }).code !== 4902 && !/unrecognized|not been added|unknown chain/i.test((e as Error).message ?? "")) throw e;
    await p.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN.hex, chainName: CHAIN.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [CHAIN.rpc], blockExplorerUrls: [CHAIN.explorer] }] });
  }
  if ((await chainOf(p)) !== CHAIN.hex) throw new Error("The wallet is still on another chain. Switch it to Robinhood Chain and try again.");
}

/** Run a call without sending it. The wallet's node answers; a call the contract refuses throws. */
export function ethCall(p: Provider, to: string, data: string, from?: string, value?: bigint): Promise<string> {
  return p.request({ method: "eth_call", params: [{ to, data, ...(from ? { from } : {}), ...(value ? { value: `0x${value.toString(16)}` } : {}) }, "latest"] }) as Promise<string>;
}

export function sendTx(p: Provider, tx: { from: string; to: string; data: string; value?: bigint }): Promise<string> {
  return p.request({ method: "eth_sendTransaction", params: [{ from: tx.from, to: tx.to, data: tx.data, ...(tx.value ? { value: `0x${tx.value.toString(16)}` } : {}) }] }) as Promise<string>;
}

/** Wait until a transaction is mined. Three minutes, then it says where to look. */
export async function waitFor(p: Provider, hash: string, ms = 180_000): Promise<Receipt> {
  const until = Date.now() + ms;
  for (;;) {
    const r = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null)) as Receipt | null;
    if (r) return r;
    if (Date.now() > until) throw new Error("The transaction was sent and is not mined yet. It may still go through: check your wallet's activity.");
    await new Promise((res) => setTimeout(res, 1500));
  }
}

/** Sign a readable message. The wallet shows the visitor exactly this text. */
export function signText(p: Provider, message: string, address: string): Promise<string> {
  const hex = `0x${Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  return p.request({ method: "personal_sign", params: [hex, address] }) as Promise<string>;
}

/** Did the visitor say no in their wallet? */
export const declined = (e: unknown): boolean => (e as { code?: number }).code === 4001 || /user rejected|user denied|rejected the request/i.test((e as Error)?.message ?? "");
