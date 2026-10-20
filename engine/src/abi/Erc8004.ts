// The two ERC-8004 registries on Robinhood Chain, as much of them as Factor uses. Read from the deployed
// implementations (version 2.0.0, source verified on Sourcify for chain 4663): IdentityRegistryUpgradeable behind
// 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 and ReputationRegistryUpgradeable behind
// 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63, the same addresses as on every other chain.
import { parseAbi } from "viem";

export const erc8004IdentityAbi = parseAbi([
  "function register() returns (uint256 agentId)",
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function getApproved(uint256 agentId) view returns (address)",
  "function isAuthorizedOrOwner(address spender, uint256 agentId) view returns (bool)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function getVersion() pure returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)",
  "error ERC721NonexistentToken(uint256 tokenId)",
]);

export const erc8004ReputationAbi = parseAbi([
  "function getIdentityRegistry() view returns (address)",
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function revokeFeedback(uint256 agentId, uint64 feedbackIndex)",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  "function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
  "function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)",
  "function getClients(uint256 agentId) view returns (address[])",
  "function getVersion() pure returns (string)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)",
  // the identity registry's error, which the reputation registry passes on for an agentId nobody registered
  "error ERC721NonexistentToken(uint256 tokenId)",
]);

// Multicall3, at its usual address on Robinhood Chain: many reads of the identity registry in one request.
export const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) view returns (Result[] returnData)",
]);
