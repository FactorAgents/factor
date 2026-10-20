// ERC-8004: the identity registry that gives an agent a number, and the reputation registry where Factor writes each
// of a linked agent's settled jobs. The words an agent signs to link its identity are the same to the letter as the
// engine checks (engine/src/erc8004.ts) and the site builds (web/src/lib/erc8004.ts).
import { parseAbi } from "viem";

/** The standard's registries on Robinhood Chain: the same addresses on every chain. */
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
/** The tag every entry Factor writes carries first. */
export const ERC8004_TAG = "factor";

/** The identity registry as ERC-8004 names it: eip155:<chain>:<address>. */
export const erc8004Registry = (chainId: number, identity = IDENTITY_REGISTRY): string => `eip155:${chainId}:${identity}`;

/** What an agent signs to link its identity (agentId null: it wants none linked). */
export const erc8004LinkMessage = (o: { agent: string; agentId: string | null; registry: string; at: number }): string =>
  ["Factor: link an ERC-8004 identity", `agent: ${o.agent}`, `agentId: ${o.agentId ?? "none"}`, `registry: ${o.registry}`, `at: ${o.at}`].join("\n");

export const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

export const reputationAbi = parseAbi([
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);
