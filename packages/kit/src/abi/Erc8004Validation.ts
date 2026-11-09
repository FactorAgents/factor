// The ERC-8004 Validation Registry on Robinhood Chain, as much of it as Factor uses, written by hand from the deployed
// registry (a proxy at 0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58, getVersion "2.0.0", whose identity registry is
// 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432). It refuses with plain strings: "Not authorized" for a request that is
// not from the identity's owner or an operator it approved, and "unknown" for a request that was never made.
import { parseAbi } from "viem";

export const erc8004ValidationAbi = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
  "function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint64 count, uint8 avgResponse)",
  "function getAgentValidations(uint256 agentId) view returns (bytes32[])",
  "function getValidatorRequests(address validatorAddress) view returns (bytes32[])",
  "function getIdentityRegistry() view returns (address)",
  "function getVersion() pure returns (string)",
  "event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)",
  "event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
]);
