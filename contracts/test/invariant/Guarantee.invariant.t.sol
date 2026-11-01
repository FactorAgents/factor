// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FactorTest} from "../FactorTest.sol";
import {FactorLine} from "../../src/FactorLine.sol";
import {FactorGuarantee} from "../../src/FactorGuarantee.sol";
import {GuaranteeHandler} from "./GuaranteeHandler.sol";

/// The guarantee's rules that must hold whatever anybody does, in whatever order, beside the desk and the line
/// contract. The handler does the doing and checks each close as it happens; each function here is one rule, checked
/// after every step.
contract GuaranteeInvariantTest is FactorTest {
    GuaranteeHandler internal handler;
    FactorLine internal line;
    FactorGuarantee internal g;

    function setUp() public override {
        super.setUp();
        line = new FactorLine(desk);
        g = new FactorGuarantee(desk, line);
        handler = new GuaranteeHandler(desk, line, g);
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(desk).call{value: 2 ether}("");
        assertTrue(ok);
        handler.scoreUp();
        // every agent with a bond and an offer, and a desk bond for pool advances, so the runs spend their steps on the
        // rules
        for (uint8 i = 0; i < 4; ++i) {
            handler.bond(i, 0.5 ether);
            handler.offer(i, 0.2 ether);
        }
        for (uint8 i = 0; i < 2; ++i) {
            address a = handler.agents(i);
            vm.deal(a, 0.1 ether);
            vm.prank(a);
            desk.addBond{value: 0.05 ether}();
        }
        targetContract(address(handler));
        bytes4[] memory moves = new bytes4[](18);
        moves[0] = GuaranteeHandler.bond.selector;
        moves[1] = GuaranteeHandler.takeBond.selector;
        moves[2] = GuaranteeHandler.offer.selector;
        moves[3] = GuaranteeHandler.reserve.selector;
        moves[4] = GuaranteeHandler.hire.selector;
        moves[5] = GuaranteeHandler.hire.selector; // twice: most covers come this way
        moves[6] = GuaranteeHandler.lock.selector;
        moves[7] = GuaranteeHandler.bind.selector;
        moves[8] = GuaranteeHandler.bindLatest.selector;
        moves[9] = GuaranteeHandler.lapse.selector;
        moves[10] = GuaranteeHandler.draw.selector;
        moves[11] = GuaranteeHandler.deliver.selector;
        moves[12] = GuaranteeHandler.decline.selector;
        moves[13] = GuaranteeHandler.answer.selector;
        moves[14] = GuaranteeHandler.deskCloses.selector;
        moves[15] = GuaranteeHandler.warp.selector;
        moves[16] = GuaranteeHandler.close.selector;
        moves[17] = GuaranteeHandler.collect.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: moves}));
    }

    /// Nothing the handler saw was against the rulebook: every cover tied to its own job, paid only on a refund,
    /// released only on a settlement, the fee back only on a decline.
    function invariant_everyMoveKeptTheRules() public view {
        assertFalse(handler.wrong(), handler.why());
    }

    /// The contract holds exactly its bonds, the fees it holds and what it owes wallets.
    function invariant_theContractHoldsExactlyItsBooks() public view {
        assertEq(address(g).balance, g.bonds() + g.feesHeld() + g.owedTotal());
    }

    /// Bonds are free plus held back, agent by agent: no cover is ever unbacked, and every bond is somebody's.
    function invariant_eachBondBacksItsOwnCovers() public view {
        uint256 bonds;
        uint256 held;
        for (uint256 i = 0; i < 4; ++i) {
            FactorGuarantee.Bond memory b = g.bondOf(handler.agents(i));
            assertLe(b.reserved, b.bond, "held back <= bond");
            assertEq(g.freeOf(handler.agents(i)), b.bond - b.reserved);
            bonds += b.bond;
            held += b.reserved;
        }
        assertEq(g.bonds(), bonds, "bonds = every agent's");
        assertEq(g.reserved(), held, "held back = every agent's");
    }

    /// What is held back and the fees held are exactly those of the covers that have not ended; every fee that ended
    /// was counted once.
    function invariant_everyCoverIsCountedOnce() public view {
        uint256 held;
        uint256 fees;
        uint256 split;
        uint256 burned;
        uint256 n = g.coverCount();
        for (uint256 id = 1; id <= n; ++id) {
            FactorGuarantee.Cover memory c = g.cover(id);
            if (c.state == FactorGuarantee.State.Reserved || c.state == FactorGuarantee.State.Bound) {
                held += c.amount;
                fees += c.fee;
            } else if (c.state != FactorGuarantee.State.Declined) {
                split += c.fee;
                burned += c.fee / 2;
            }
            if (c.state == FactorGuarantee.State.Bound || c.state >= FactorGuarantee.State.Released) {
                if (c.state != FactorGuarantee.State.Lapsed) assertEq(g.coverOf(c.job), id, "one cover per job");
            }
        }
        assertEq(g.reserved(), held, "held back = the open covers");
        assertEq(g.feesHeld(), fees, "fees held = the open covers' fees");
        assertEq(g.totalFees(), split, "every fee split once");
        assertEq(g.totalBurned(), burned, "half of each, rounded down, burned");
    }

    /// The desk's books are untouched by all of it.
    function invariant_theDeskStillHoldsItsBooks() public view {
        assertEq(address(desk).balance, desk.pool() + desk.held() + desk.bonds() + desk.owedTotal());
    }

    /// What a run did, so a run that never paid a cover is seen for what it is.
    function afterInvariant() external view {
        console.log("reserved %s, tied %s, lapsed %s", handler.reserves(), handler.binds(), handler.lapsed());
        console.log("paid %s, released %s, declined %s", handler.paid(), handler.released(), handler.declined());
    }
}
