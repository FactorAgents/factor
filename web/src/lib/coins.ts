// Agent coins, as the site launches and shows them (engine/src/coins.ts; contracts/src/AgentCoinLauncher.sol).
//
// The name rule, a coin's description, its picture and the words a maker signs are the engine's, to the letter: the
// engine checks them again before it signs for an agent it runs, and the launcher checks the agent's signature over
// exactly these words. A launch goes from the visitor's own wallet, tried first without being sent.
import { decodeErrorResult, decodeEventLog, encodeFunctionData, formatEther, type Abi, type Hex } from "viem";
import { agentCoinLauncherAbi } from "./abi/AgentCoinLauncher";
import { explain as explainDesk, Refusal } from "./desk";
import { declined, ensureChain, ethCall, sendTx, signText, waitFor, type Provider } from "./wallet";

const ABI = agentCoinLauncherAbi as Abi;
const plain = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Names no coin may carry, or contain: other brands, people and projects. The engine's own list. */
const RESERVED = [
  "factor", "pons", "robinhood", "bitcoin", "ethereum", "ether", "solana", "binance", "coinbase", "uniswap", "metamask", "tether", "usdc", "usdt",
  "openai", "chatgpt", "anthropic", "claude", "gemini", "google", "apple", "tesla", "nvidia", "microsoft", "amazon", "deepseek", "grok", "xai",
  "elon", "musk", "trump", "biden", "vitalik", "satoshi", "doge", "pepe", "shiba", "bonk", "btc", "eth", "sol", "bnb", "gpt", "meta", "x",
];

/** The coin an agent of this name carries unless its maker shortens it. */
export function suggestCoin(agentName: string): { name: string; symbol: string } {
  const words = agentName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ").slice(0, 32).trim();
  const symbol = plain(agentName).toUpperCase().slice(0, 10);
  return { name, symbol: symbol.length >= 2 ? symbol : `${symbol}${symbol}`.slice(0, 2) };
}

/** Why a coin's name and ticker break the rule for an agent of this name, or null when they keep it. */
export function coinNameProblem(agentName: string | null | undefined, name: string, symbol: string): string | null {
  if (!agentName) return "the agent has no name yet: it gives itself one first, and its coin carries it";
  if (!/^[A-Za-z0-9][A-Za-z0-9 .-]{0,30}[A-Za-z0-9]$/.test(name)) return "the coin's name must be 2 to 32 letters, digits, spaces, dots or hyphens";
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return "the ticker must be 2 to 10 capital letters or digits";
  const a = plain(agentName), n = plain(name), t = plain(symbol);
  if (!(n === a || (n.length >= 3 && a.startsWith(n)))) return `the coin carries the agent's name: "${suggestCoin(agentName).name}", or the first three or more of its letters`;
  let i = 0;
  for (const ch of t) {
    i = a.indexOf(ch, i);
    if (i < 0) return `the ticker is made of letters of the agent's name, in their order: "${suggestCoin(agentName).symbol}", for one`;
    i++;
  }
  for (const r of RESERVED) {
    const hit = r.length <= 4 ? n === r || t === r : n.includes(r) || t.includes(r);
    if (hit) return "a coin may not carry the name of another brand, person or project";
  }
  return null;
}

export const coinDescription = (name: string): string =>
  `${name} is an AI agent on Factor. This coin's trading fees pay for the agent's compute, its maker and the $FACTOR burn. It pays its holders nothing and promises them nothing: buying it is at your own risk.`;
export const coinLogo = (site: string, agent: string): string => `${site}/api/v1/coins/logo/${agent}`;
export const coinAskMessage = (o: { agent: string; maker: string; name: string; symbol: string; at: number }): string =>
  ["Factor: launch an agent's coin", `agent: ${o.agent}`, `maker: ${o.maker}`, `name: ${o.name}`, `ticker: ${o.symbol}`, `at: ${o.at}`].join("\n");

/** What the engine says about coins: whether they are on, the launcher, Pons' fee and what a launch costs in gas. */
export interface CoinsAbout { enabled: boolean; launcher: string | null; chainId?: number; site?: string; launchFeeWei?: string | null; launchGas?: string; launchGasWei?: string | null; rule?: string }

// The launcher's own refusals, in plain words.
const WORDS: Record<string, (a: readonly unknown[]) => string> = {
  NotAllowed: () => "Only the agent itself, or its maker with the agent's permission, can launch its coin.",
  Expired: () => "The agent's permission ran out before it was sent. Ask for it again.",
  BadSignature: () => "The agent's permission is not for this launch. Ask for it again.",
  NotRegistered: () => "That wallet is not an agent on the desk.",
  Barred: () => "An agent that did not repay the pool cannot launch a coin.",
  AlreadyLaunched: () => "This agent has its coin already: one coin per agent, ever.",
  LaunchFeeShort: (a) => `Pons' launch fee is ${formatEther(BigInt(String(a[0])))} ETH: send at least that.`,
  RefundFailed: () => "The wallet that launched it would not take back the ETH the curve could not use.",
  ZeroAddress: () => "An address is missing.",
};

function explain(e: unknown): string {
  if (e instanceof Refusal) return e.message;
  if (declined(e)) return "You declined it in your wallet. Nothing was sent.";
  const err = e as { data?: unknown; error?: { data?: unknown }; cause?: { data?: unknown } };
  for (const d of [err.data, err.error?.data, err.cause?.data, (err.data as { data?: unknown } | undefined)?.data]) {
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
      try {
        const r = decodeErrorResult({ abi: ABI, data: d as Hex });
        return WORDS[r.errorName]?.((r.args ?? []) as readonly unknown[]) ?? `The launcher refuses it: ${r.errorName}.`;
      } catch {
        // not the launcher's
      }
    }
  }
  return explainDesk(e);
}

export interface Permission { agent: string; maker: string; name: string; symbol: string; logo: string; description: string; nonce: string; deadline: string; signature: Hex; launcher: string }

/** The maker of an agent Factor runs signs the words, and Factor answers with the agent's own permission. */
export async function askPermission(p: Provider, o: { agent: string; maker: string; name: string; symbol: string; at: number }): Promise<Permission> {
  const signature = await signText(p, coinAskMessage(o), o.maker);
  const r = await fetch("/api/v1/coins/permission", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...o, signature }) });
  const b = (await r.json().catch(() => ({}))) as Permission & { error?: string };
  if (!r.ok) throw new Refusal(b.error ? b.error.charAt(0).toUpperCase() + b.error.slice(1) + (b.error.endsWith(".") ? "" : ".") : "Factor could not sign for the agent just now.");
  return b;
}

/**
 * The launch, from the visitor's wallet: the agent's own (no permission), or its maker's (with one). Tried without
 * being sent, sent, followed until it is mined, and the coin read from the launcher's log.
 */
export async function launchCoin(p: Provider, o: { launcher: string; from: string; agent: string; maker: string; name: string; symbol: string; logo: string; description: string; salt: Hex; value: bigint; permission?: Permission; on?: (step: "checking" | "wallet" | "mining") => void }): Promise<{ hash: string; coin: string | null }> {
  o.on?.("checking");
  await ensureChain(p);
  const code = await p.request({ method: "eth_getCode", params: [o.launcher, "latest"] }).catch(() => null);
  if (typeof code !== "string" || code.length <= 2) throw new Refusal("Your wallet does not see the coin launcher on the chain it is on. Nothing was sent. Check that the wallet is on Robinhood Chain.");
  const params = { name: o.name, symbol: o.symbol, logo: o.logo, description: o.description, socials: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" }, creatorFeeRecipient: "0x0000000000000000000000000000000000000000", creatorTaxBps: 0, buybackEnabled: false, expectedEconomics: `0x${"0".repeat(64)}`, salt: o.salt };
  const data = encodeFunctionData({ abi: ABI, functionName: "launch", args: [o.agent, o.maker, params, 0n, BigInt(o.permission?.deadline ?? "0"), (o.permission?.signature ?? "0x") as Hex] });
  try {
    await ethCall(p, o.launcher, data, o.from, o.value);
  } catch (e) {
    throw new Refusal(explain(e));
  }
  o.on?.("wallet");
  let hash: string;
  try {
    hash = await sendTx(p, { from: o.from, to: o.launcher, data, value: o.value });
  } catch (e) {
    throw new Refusal(explain(e));
  }
  o.on?.("mining");
  const receipt = await waitFor(p, hash);
  if (receipt.status !== "0x1") throw new Refusal(receipt.reason ?? "The launch was mined and refused. Nothing changed, and nothing was spent but the gas.");
  let coin: string | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== o.launcher.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
      if (d.eventName === "CoinLaunched") coin = String((d.args as unknown as { coin: string }).coin).toLowerCase();
    } catch {
      // another event
    }
  }
  return { hash: receipt.transactionHash || hash, coin };
}

/** A salt for Pons: from the agent and the moment, so two tries never ask for the same address. */
export const saltFor = (agent: string, at: number): Hex => {
  const hex = (agent.slice(2) + at.toString(16)).padStart(64, "0").slice(-64);
  return `0x${hex}` as Hex;
};
