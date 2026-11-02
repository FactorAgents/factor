// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LineBase} from "../lines/LineBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorBounty} from "../../src/FactorBounty.sol";

/// The desk and the line contract of the other tests with a bounty contract beside them, and the moves the bounty's
/// tests start from.
abstract contract BountyBase is LineBase {
    FactorBounty internal b;
    address internal poster = makeAddr("a poster");
    address internal agentC = makeAddr("agent c");
    address internal agentD = makeAddr("agent d");
    uint256 internal constant PRIZE = 0.005 ether;
    uint256 internal constant FEE = 0.00005 ether;
    uint256 internal constant BOND = 0.00005 ether;
    bytes32 internal constant TASK = keccak256("Write the words for our front page");

    function setUp() public virtual override {
        super.setUp();
        b = new FactorBounty(desk, line);
        vm.prank(agentC);
        desk.register();
        vm.prank(agentD);
        desk.register();
    }

    // ---------- the moves ----------

    function _post(address from, uint256 prize, uint256 openFor, uint256 minScore) internal returns (uint256 id) {
        uint256 value = prize + b.feeFor(prize);
        vm.deal(from, from.balance + value);
        vm.prank(from);
        id = b.post{value: value}(prize, block.timestamp + openFor, minScore, TASK);
    }

    /// The smallest bounty, open for a day.
    function _post() internal returns (uint256) {
        return _post(poster, PRIZE, 1 days, 0);
    }

    function _hash(uint256 id, address agent) internal view returns (bytes32) {
        return b.entryHash(id, agent, keccak256(abi.encodePacked("the work of ", agent)));
    }

    function _enter(uint256 id, address agent) internal {
        _enterAs(agent, id, agent);
    }

    function _enterAs(address from, uint256 id, address agent) internal {
        uint256 bond = b.bounty(id).bond;
        bytes32 h = _hash(id, agent);
        vm.deal(from, from.balance + bond);
        vm.prank(from);
        b.enter{value: bond}(id, agent, h);
    }

    function _toDeadline(uint256 id) internal {
        vm.warp(b.bounty(id).deadline);
    }

    function _toSplit(uint256 id) internal {
        vm.warp(uint256(b.bounty(id).deadline) + 3 days);
    }

    function _pick(uint256 id, address winner) internal returns (uint256 job) {
        vm.prank(b.bounty(id).poster);
        job = b.pick(id, winner);
    }

    /// Up to the pick: posted, these agents in, the deadline passed, picked.
    function _picked(address winner, address[] memory also) internal returns (uint256 id, uint256 job) {
        id = _post();
        _enter(id, winner);
        for (uint256 i = 0; i < also.length; ++i) {
            _enter(id, also[i]);
        }
        _toDeadline(id);
        job = _pick(id, winner);
    }

    function _deliverProof(address agent, uint256 job, bytes32 proof) internal {
        vm.prank(agent);
        desk.deliver(job, proof);
    }

    function _two(address x, address y) internal pure returns (address[] memory l) {
        l = new address[](2);
        l[0] = x;
        l[1] = y;
    }

    function _one(address x) internal pure returns (address[] memory l) {
        l = new address[](1);
        l[0] = x;
    }

    /// A wallet that has earned a score of 200 on the desk: twenty small jobs.
    function _score200(address agent) internal {
        address scorer = makeAddr("a customer whose small jobs build scores");
        for (uint256 i = 0; i < 20; ++i) {
            uint256 job = _lockFrom(scorer, agent, 0.001 ether, false);
            address key = line.keyOf(agent);
            if (key != address(0)) {
                vm.prank(key);
                FactorLineAccount(payable(agent)).deliver(job, keccak256("the work"));
            } else {
                _deliver(agent, job);
            }
            vm.prank(scorer);
            desk.accept(job);
        }
    }

    /// An agent that drew a pool advance on a job and did not deliver: barred on the desk.
    function _barOnDesk(address who) internal {
        _fund(1 ether);
        _bond(who, 0.001 ether);
        uint256 id = _lock(who, 0.01 ether, false);
        _draw(who, id, 0.001 ether, FactorDesk.Kind.Pool);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        desk.refund(id);
        assertTrue(desk.agent(who).barred);
    }

    /// The contract holds its books. `back` is a prize that came back from the desk and has not been closed yet.
    function _bbooks(uint256 back) internal view {
        assertEq(
            address(b).balance, b.held() + b.bonds() + b.owedTotal() + back, "the contract holds exactly its books"
        );
        _books();
    }

    function _bbooks() internal view {
        _bbooks(0);
    }
}
