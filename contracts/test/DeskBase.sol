// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FactorTest} from "./FactorTest.sol";
import {FactorDesk} from "../src/FactorDesk.sol";

/// The people and the moves the desk's tests start from.
abstract contract DeskBase is FactorTest {
    address internal customer = makeAddr("customer");
    address internal other = makeAddr("another customer");
    address internal agentA = makeAddr("agent a");
    address internal agentB = makeAddr("agent b");

    function setUp() public virtual override {
        super.setUp();
        vm.prank(agentA);
        desk.register();
        vm.prank(agentB);
        desk.register();
    }

    // ---------- the moves ----------

    function _fund(uint256 amount) internal {
        vm.deal(address(this), amount);
        (bool ok,) = address(desk).call{value: amount}("");
        assertTrue(ok);
    }

    function _bond(address who, uint256 amount) internal {
        vm.deal(who, who.balance + amount);
        vm.prank(who);
        desk.addBond{value: amount}();
    }

    function _lockFrom(address from, address to, uint256 price, bool early) internal returns (uint256 id) {
        vm.deal(from, from.balance + price);
        vm.prank(from);
        id = desk.lock{value: price}(to, block.timestamp + 1 days, early);
    }

    function _lock(address to, uint256 price, bool early) internal returns (uint256 id) {
        return _lockFrom(customer, to, price, early);
    }

    function _draw(address who, uint256 id, uint256 amount, FactorDesk.Kind kind) internal {
        vm.prank(who);
        desk.draw(id, amount, kind);
    }

    function _deliver(address who, uint256 id) internal {
        vm.prank(who);
        desk.deliver(id, keccak256("the work"));
    }

    function _accept(uint256 id) internal {
        vm.prank(desk.job(id).customer);
        desk.accept(id);
    }

    /// The four parts of the desk's ETH are exactly what it holds (nothing in these tests forces ETH into it
    /// unless the test says so).
    function _books() internal view {
        assertEq(
            address(desk).balance,
            desk.pool() + desk.held() + desk.bonds() + desk.owedTotal(),
            "the desk holds exactly what its books say"
        );
    }
}
