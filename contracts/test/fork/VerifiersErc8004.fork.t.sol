// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine} from "../../src/FactorLine.sol";
import {FactorVerifiers} from "../../src/FactorVerifiers.sol";

interface IIdentity8004 {
    function register() external returns (uint256 agentId);
    function ownerOf(uint256 agentId) external view returns (address);
}

interface IValidation8004 {
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external;
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256
        );
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse);
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory);
    function getIdentityRegistry() external view returns (address);
    function getVersion() external view returns (string memory);
}

/// A verifier that is a contract, as Factor's own verifiers are accounts: it answers on the registry by a call of its own.
contract ContractVerifier {
    function join(FactorVerifiers vf, uint8 maker) external payable {
        vf.join{value: msg.value}(maker);
    }

    function check(FactorVerifiers vf, uint256 id, bool accept, bytes32 reason) external {
        vf.check(id, accept, reason);
    }

    function answer(IValidation8004 reg, bytes32 h, uint8 response, string calldata uri) external {
        reg.validationResponse(h, response, uri, h, "factorVerify");
    }
}

/// A verified job's verdict written to the LIVE ERC-8004 validation registry on a copy of Robinhood Chain, the way the
/// engine prepares it (docs/VERIFIERS.md, section 17): a verifier contract beside the live desk, an agent with an identity
/// of its own on the live identity registry, its case decided by a verifier that is a contract, the request sent by the
/// identity's owner and the answer by the verifier the request names. The registry's own rules are held to: nobody else
/// may ask, nobody else may answer, nothing above 100.
contract VerifiersErc8004ForkTest is ForkBase {
    FactorDesk constant DESK = FactorDesk(payable(0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F));
    FactorLine constant LINE = FactorLine(payable(0xc9405ca62eD1e9a4a058F404e5c1C893F7ae67c4));
    IIdentity8004 constant IDENTITY = IIdentity8004(0x8004A169FB4a3325136EB29fA0ceB6D2e539a432);
    IValidation8004 constant VALIDATION = IValidation8004(0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58);
    string constant URI = "https://factoragents.fun/api/v1/verifiers/file/1";

    FactorVerifiers vf;
    ContractVerifier checker;
    address agent;
    address customer;
    uint256 agentId;
    uint256 id;
    bytes32 fileHash;

    function setUp() public {
        _fork();
        vf = new FactorVerifiers(DESK, LINE);
        agent = makeAddr("an agent with an ERC-8004 identity");
        customer = makeAddr("a customer");
        vm.deal(agent, 1 ether);
        vm.deal(customer, 1 ether);
        vm.prank(agent);
        DESK.register();
        vm.prank(agent);
        agentId = IDENTITY.register();
        checker = new ContractVerifier();
        checker.join{value: 0.02 ether}(vf, 1);
        // a job with a verifier, delivered, checked and settled as accepted
        vm.prank(customer);
        id = vf.hire{value: 0.0021 ether}(agent, block.timestamp + 1 days, false, 0.0001 ether, keccak256("terms"));
        uint256 job = vf.getCase(id).job;
        vm.prank(agent);
        DESK.deliver(job, keccak256("work"));
        checker.check(vf, id, true, keccak256("reasons"));
        vm.warp(block.timestamp + vf.DISPUTE_TIME());
        vf.step(id);
        fileHash = keccak256("the case file, exactly as served");
    }

    function test_fork_theLiveRegistryIsTheStandardsOwn() public view {
        assertEq(VALIDATION.getIdentityRegistry(), address(IDENTITY));
        assertEq(VALIDATION.getVersion(), "2.0.0");
        assertEq(IDENTITY.ownerOf(agentId), agent);
        assertEq(uint8(vf.getCase(id).state), uint8(FactorVerifiers.State.Accepted));
    }

    function test_fork_theOwnerAsksAndTheNamedVerifierAnswers() public {
        vm.prank(agent);
        VALIDATION.validationRequest(address(checker), agentId, URI, fileHash);
        (address named, uint256 who,,,,) = VALIDATION.getValidationStatus(fileHash);
        assertEq(named, address(checker));
        assertEq(who, agentId);
        checker.answer(VALIDATION, fileHash, 100, URI);
        (,, uint8 response, bytes32 responseHash, string memory tag,) = VALIDATION.getValidationStatus(fileHash);
        assertEq(response, 100);
        assertEq(responseHash, fileHash);
        assertEq(tag, "factorVerify");
        address[] memory any = new address[](0);
        (uint64 count, uint8 avg) = VALIDATION.getSummary(agentId, any, "factorVerify");
        assertEq(count, 1);
        assertEq(avg, 100);
        bytes32[] memory all = VALIDATION.getAgentValidations(agentId);
        assertEq(all[all.length - 1], fileHash);
    }

    function test_fork_nobodyButTheIdentitysOwnerMayAsk() public {
        vm.prank(customer);
        vm.expectRevert(bytes("Not authorized"));
        VALIDATION.validationRequest(address(checker), agentId, URI, fileHash);
        vm.expectRevert(bytes("Not authorized"));
        VALIDATION.validationRequest(address(checker), agentId, URI, fileHash);
    }

    function test_fork_nobodyButTheNamedVerifierMayAnswer_andNotAbove100() public {
        vm.prank(agent);
        VALIDATION.validationRequest(address(checker), agentId, URI, fileHash);
        vm.prank(agent);
        vm.expectRevert();
        VALIDATION.validationResponse(fileHash, 100, URI, fileHash, "factorVerify");
        vm.expectRevert();
        checker.answer(VALIDATION, fileHash, 101, URI);
    }

    function test_fork_aRequestNeverMadeCannotBeAnswered() public {
        vm.expectRevert(bytes("unknown"));
        checker.answer(VALIDATION, keccak256("never asked"), 100, URI);
    }
}
