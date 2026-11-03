// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LineBase} from "../lines/LineBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorMilestones} from "../../src/FactorMilestones.sol";

/// The desk and the line contract of the other tests with a milestone contract beside them, and the moves the
/// milestones' tests start from.
abstract contract MilestoneBase is LineBase {
    FactorMilestones internal m;
    address internal hirer = makeAddr("a customer hiring in stages");
    uint256 internal constant STAGE = 0.001 ether;
    bytes32 internal constant TERMS = keccak256("A shop in three stages: the words, the page, the checkout");

    function setUp() public virtual override {
        super.setUp();
        m = new FactorMilestones(desk);
    }

    // ---------- the moves ----------

    function _list(uint256 a, uint256 b_) internal pure returns (uint256[] memory l) {
        l = new uint256[](2);
        l[0] = a;
        l[1] = b_;
    }

    function _list(uint256 a, uint256 b_, uint256 c) internal pure returns (uint256[] memory l) {
        l = new uint256[](3);
        l[0] = a;
        l[1] = b_;
        l[2] = c;
    }

    function _same(uint256 n, uint256 v) internal pure returns (uint256[] memory l) {
        l = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            l[i] = v;
        }
    }

    function _sum(uint256[] memory l) internal pure returns (uint256 s) {
        for (uint256 i = 0; i < l.length; ++i) {
            s += l[i];
        }
    }

    function _post(address from, address agent, uint256[] memory prices, uint256[] memory times, bool early)
        internal
        returns (uint256 id)
    {
        uint256 total = _sum(prices);
        vm.deal(from, from.balance + total);
        vm.prank(from);
        id = m.post{value: total}(agent, prices, times, early, TERMS);
    }

    /// Two stages of the smallest price, a day each, for agent a, early half off.
    function _post() internal returns (uint256) {
        return _post(hirer, agentA, _same(2, STAGE), _same(2, 1 days), false);
    }

    /// Three stages: 0.001, 0.002 and 0.003, a day, two days and three days.
    function _post3() internal returns (uint256) {
        return _post(hirer, agentA, _list(0.001 ether, 0.002 ether, 0.003 ether), _list(1 days, 2 days, 3 days), false);
    }

    function _job(uint256 id) internal view returns (uint256) {
        return m.currentJob(id);
    }

    function _deliverStage(uint256 id) internal returns (uint256 job) {
        job = _job(id);
        vm.prank(m.plan(id).agent);
        desk.deliver(job, keccak256(abi.encode("the work of job", job)));
    }

    function _acceptStage(uint256 id) internal {
        vm.prank(m.plan(id).customer);
        m.accept(id);
    }

    /// The agent delivers the stage on the desk and the customer accepts it.
    function _passStage(uint256 id) internal {
        _deliverStage(id);
        _acceptStage(id);
    }

    function _pastDue(uint256 id) internal {
        vm.warp(uint256(desk.job(_job(id)).dueAt) + desk.GRACE() + 1);
    }

    function _stateOf(uint256 id) internal view returns (FactorMilestones.State) {
        return m.plan(id).state;
    }

    /// The contract holds its books. `back` is a stage that came back from the desk and has not been stepped yet.
    function _mbooks(uint256 back) internal view {
        assertEq(address(m).balance, m.held() + m.owedTotal() + back, "the contract holds exactly its books");
        _books();
    }

    function _mbooks() internal view {
        _mbooks(0);
    }
}
