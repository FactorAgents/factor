// Agent coins: the name rule, a coin's description and picture, the words a maker signs to ask Factor for the
// permission of an agent Factor runs, and the permission an agent signs itself. The same to the letter as the engine
// checks (engine/src/coins.ts), the site builds (web/src/lib/coins.ts) and the launcher verifies
// (contracts/src/AgentCoinLauncher.sol, PERMISSION_TYPEHASH).
import type { Hex } from "viem";

const plain = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Names no coin may carry, or contain: other brands, people and projects. */
const RESERVED = [
  "factor", "pons", "robinhood", "bitcoin", "ethereum", "ether", "solana", "binance", "coinbase", "uniswap", "metamask", "tether", "usdc", "usdt",
  "openai", "chatgpt", "anthropic", "claude", "gemini", "google", "apple", "tesla", "nvidia", "microsoft", "amazon", "deepseek", "grok", "xai",
  "elon", "musk", "trump", "biden", "vitalik", "satoshi", "doge", "pepe", "shiba", "bonk", "btc", "eth", "sol", "bnb", "gpt", "meta", "x",
];

/** The coin an agent of this name carries unless its maker shortens it: its name in words, its letters as the ticker. */
export function suggestCoin(agentName: string): { name: string; symbol: string } {
  const words = agentName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ").slice(0, 32).trim();
  const symbol = plain(agentName).toUpperCase().slice(0, 10);
  return { name, symbol: symbol.length >= 2 ? symbol : `${symbol}${symbol}`.slice(0, 2) };
}

/** Why a coin's name and ticker break the rule for an agent of this name, or null when they keep it. */
export function coinNameProblem(agentName: string | null | undefined, name: string, symbol: string): string | null {
  if (!agentName) return "the agent has no name yet: it gives itself one first, and its coin carries it";
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 .-]{0,30}[A-Za-z0-9]$/.test(name)) return "the coin's name must be 2 to 32 letters, digits, spaces, dots or hyphens";
  if (typeof symbol !== "string" || !/^[A-Z0-9]{2,10}$/.test(symbol)) return "the ticker must be 2 to 10 capital letters or digits";
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

/** The permission an agent signs for its maker, as EIP-712 typed data: what the launcher checks, word for word. */
export function coinPermissionTypedData(o: { chainId: number; launcher: string; agent: string; maker: string; name: string; symbol: string; logo: string; description: string; nonce: bigint; deadline: bigint }) {
  return {
    domain: { name: "Factor agent coins", version: "1", chainId: o.chainId, verifyingContract: o.launcher as Hex },
    types: { Permission: [{ name: "agent", type: "address" }, { name: "maker", type: "address" }, { name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "logo", type: "string" }, { name: "description", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Permission" as const,
    message: { agent: o.agent as Hex, maker: o.maker as Hex, name: o.name, symbol: o.symbol, logo: o.logo, description: o.description, nonce: o.nonce, deadline: o.deadline },
  };
}

/** A permission an agent gave its maker: everything the maker's launch must carry. */
export interface CoinPermission { agent: string; maker: string; name: string; symbol: string; logo: string; description: string; nonce: string; deadline: string; signature: Hex; launcher: string }
