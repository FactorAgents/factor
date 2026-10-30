// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {FactorTest} from "../FactorTest.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine} from "../../src/FactorLine.sol";
import {LineHandler} from "./LineHandler.sol";

/// The line's rules that must hold whatever anybody does, in whatever order, beside the desk. The handler does the
/// doing and checks each draw and payout as it happens; each function here is one rule, checked after every step.
contract LineInvariantTest is FactorTest {
    LineHandler internal handler;
    FactorLine internal line;

    function setUp() public override {
        super.setUp();
        line = new FactorLine(desk);
        handler = new LineHandler(desk, line);
        // a pool on each side, every agent with a line and a bond, so the runs spend their steps on the rules
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(desk).call{value: 2 ether}("");
        assertTrue(ok);
        handler.seed(2 ether);
        for (uint8 i = 0; i < 4; ++i) {
            handler.open(i);
            handler.bond(i, 0.05 ether);
            handler.hire(i, 0.5 ether, i % 2 == 0);
        }
        targetContract(address(handler));
    }

    /// Nothing the handler saw was against the rulebook: every draw within bond + fees counted once, every payout
    /// where it belongs, nothing out of an account that owed.
    function invariant_everyMoveKeptTheRules() public view {
        assertFalse(handler.wrong(), handler.why());
    }

    /// The line holds exactly its pool and what it owes wallets.
    function invariant_theLineHoldsExactlyItsBooks() public view {
        assertEq(address(line).balance, line.pool() + line.owedTotal(), "balance = pool + owed");
    }

    /// Everything that went in is here, out with lines, or lost: nothing made, nothing vanished.
    function invariant_everyWeiIsCounted() public view {
        assertEq(line.pool() + line.out() + line.lost(), line.totalPoolIn() + line.totalFeesToPool());
    }

    /// `out` is what lines in good standing owe, `lost` what defaulted lines owe; a debt has a due time and only a
    /// debt does; and counted once with the desk, no account owes more than its bond and fees.
    function invariant_eachLineAddsUp() public view {
        uint256 out;
        uint256 lost;
        for (uint256 i = 0; i < 4; ++i) {
            address acct = handler.accountOf(i);
            if (acct == address(0)) continue;
            FactorLine.Line memory l = line.line(acct);
            if (l.defaulted) lost += l.debt;
            else out += l.debt;
            assertEq(l.debt == 0, l.dueAt == 0, "a due time exactly while something is owed");
            assertEq(l.drawn, l.debt + l.repaid, "drawn = owed + repaid");
            FactorDesk.Agent memory a = desk.agent(acct);
            assertLe(l.debt + a.advancedNow, a.bond + a.feesPaid, "counted once: never more than bond + fees");
        }
        assertEq(line.out(), out, "out = what lines in good standing owe");
        assertEq(line.lost(), lost, "lost = what defaulted lines owe");
    }

    /// The pool never has more than 80% of itself out.
    function invariant_aFifthStays() public view {
        assertLe(line.out(), ((line.pool() + line.out()) * 8000) / 10_000);
    }

    /// The desk's books are untouched by all of it.
    function invariant_theDeskStillHoldsItsBooks() public view {
        assertEq(address(desk).balance, desk.pool() + desk.held() + desk.bonds() + desk.owedTotal());
    }

    /// What a run did, so a run that never drew is seen for what it is.
    function afterInvariant() external view {
        console.log(
            "line draws %s, desk draws by accounts %s, recoveries %s",
            handler.draws(),
            handler.deskDraws(),
            handler.recovers()
        );
        console.log("lost %s, recovered %s, out %s", line.lost(), line.totalRecovered(), line.out());
    }
}
