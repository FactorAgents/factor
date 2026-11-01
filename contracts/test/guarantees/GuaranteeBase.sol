// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LineBase} from "../lines/LineBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorGuarantee} from "../../src/FactorGuarantee.sol";

/// The desk and the line contract of the other tests with a guarantee contract beside them, and the moves the
/// guarantee's tests start from.
abstract contract GuaranteeBase is LineBase {
    FactorGuarantee internal g;
    /// a customer whose small jobs give agents their desk score
    address internal scorer = makeAddr("a customer whose small jobs build scores");
    address internal buyer = makeAddr("a customer hiring with cover");

    function setUp() public virtual override {
        super.setUp();
        g = new FactorGuarantee(desk, line);
    }

    // ---------- scores, earned on the desk ----------

    /// Twenty small jobs settled: 10 points each on the desk's score, so the agent's score is 200 (more if it had some).
    function _score200(address agent) internal {
        for (uint256 i = 0; i < 20; ++i) {
            _settleFor(scorer, agent, 0.001 ether);
        }
    }

    /// Ten customers each with one job of 1 ETH (fees 350 at most, ten customers 250) and ten small jobs more
    /// (twenty settled, 200): a score of 800.
    function _score800(address agent) internal {
        for (uint256 i = 0; i < 10; ++i) {
            _settleFor(makeAddr(string.concat("a big customer ", vm.toString(i))), agent, 1 ether);
        }
        for (uint256 i = 0; i < 10; ++i) {
            _settleFor(scorer, agent, 0.001 ether);
        }
        assertGe(desk.score(agent), 800, "a score of 800");
    }

    /// One job locked, delivered and accepted; through the line account when the agent is one.
    function _settleFor(address from, address agent, uint256 price) internal returns (uint256 id) {
        id = _lockFrom(from, agent, price, false);
        address key = line.keyOf(agent);
        if (key != address(0)) {
            vm.prank(key);
            FactorLineAccount(payable(agent)).deliver(id, keccak256("the work"));
        } else {
            _deliver(agent, id);
        }
        vm.prank(from);
        desk.accept(id);
    }

    function _mockScore(address agent, uint256 score) internal {
        vm.mockCall(address(desk), abi.encodeCall(FactorDesk.score, (agent)), abi.encode(score));
    }

    // ---------- the moves ----------

    /// Somebody adds to an agent's guarantee bond.
    function _gbond(address agent, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        g.addBond{value: amount}(agent);
    }

    /// The agent (or its line key) sets its offer.
    function _offer(address agent, uint256 amount) internal {
        address key = line.keyOf(agent);
        vm.prank(key == address(0) ? agent : key);
        g.setOffer(agent, amount);
    }

    /// An agent ready to sell cover: a score of 200, a bond and an offer.
    function _ready(address agent, uint256 bond, uint256 offer) internal {
        _score200(agent);
        _gbond(agent, bond);
        _offer(agent, offer);
    }

    function _reserve(address from, address agent, uint256 price, uint256 dueAt, bool early, uint256 amount)
        internal
        returns (uint256 id)
    {
        uint256 fee = g.feeFor(amount);
        vm.deal(from, from.balance + fee);
        vm.prank(from);
        id = g.reserve{value: fee}(agent, price, dueAt, early, amount);
    }

    function _lockAt(address from, address agent, uint256 price, uint256 dueAt, bool early) internal returns (uint256 id) {
        vm.deal(from, from.balance + price);
        vm.prank(from);
        id = desk.lock{value: price}(agent, dueAt, early);
    }

    /// Hire with cover, the whole flow: reserve, lock, tie. Due in a day.
    function _hire(address from, address agent, uint256 price, uint256 amount, bool early)
        internal
        returns (uint256 id, uint256 job)
    {
        uint256 dueAt = block.timestamp + 1 days;
        id = _reserve(from, agent, price, dueAt, early, amount);
        job = _lockAt(from, agent, price, dueAt, early);
        g.bind(id, job);
    }

    /// The guarantee contract holds exactly its books, and no cover is unbacked.
    function _gbooks() internal view {
        assertEq(
            address(g).balance,
            g.bonds() + g.feesHeld() + g.owedTotal(),
            "the guarantee contract holds exactly its bonds, the fees held and what it owes"
        );
        assertLe(g.reserved(), g.bonds(), "every cover held back is backed by a bond");
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

    function _halves(uint256 amount) internal pure returns (uint256 fee, uint256 burned, uint256 toAgent) {
        fee = (amount * 100) / 10_000;
        burned = fee / 2;
        toAgent = fee - burned;
    }
}
