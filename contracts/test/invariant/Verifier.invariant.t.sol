// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {FactorTest} from "../FactorTest.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine} from "../../src/FactorLine.sol";
import {FactorVerifiers} from "../../src/FactorVerifiers.sol";
import {VerifierHandler} from "./VerifierHandler.sol";

/// The verifiers' rules that must hold whatever anybody does, in whatever order, beside the desk. The handler does the
/// doing; each function here is one rule, checked after every step.
contract VerifierInvariantTest is FactorTest {
    VerifierHandler internal handler;
    FactorVerifiers internal vf;

    function setUp() public override {
        super.setUp();
        FactorLine line = new FactorLine(desk);
        vf = new FactorVerifiers(desk, line);
        handler = new VerifierHandler(desk, vf);
        targetContract(address(handler));
        bytes4[] memory moves = new bytes4[](20);
        moves[0] = VerifierHandler.hire.selector;
        moves[1] = VerifierHandler.reject.selector;
        moves[2] = VerifierHandler.deliver.selector;
        moves[3] = VerifierHandler.deliver.selector;
        moves[4] = VerifierHandler.check.selector;
        moves[5] = VerifierHandler.check.selector;
        moves[6] = VerifierHandler.dispute.selector;
        moves[7] = VerifierHandler.panel.selector;
        moves[8] = VerifierHandler.sit.selector;
        moves[9] = VerifierHandler.dispute.selector;
        moves[10] = VerifierHandler.reveal.selector;
        moves[11] = VerifierHandler.panel.selector;
        moves[12] = VerifierHandler.accept.selector;
        moves[13] = VerifierHandler.decline.selector;
        moves[14] = VerifierHandler.step.selector;
        moves[15] = VerifierHandler.step.selector;
        moves[16] = VerifierHandler.deskCloses.selector;
        moves[17] = VerifierHandler.bond.selector;
        moves[18] = VerifierHandler.warp.selector;
        moves[19] = VerifierHandler.strike.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: moves}));
    }

    function _open(FactorVerifiers.State s) internal pure returns (bool) {
        return s == FactorVerifiers.State.Working || s == FactorVerifiers.State.Checked
            || s == FactorVerifiers.State.Disputed || s == FactorVerifiers.State.CustomerDecides;
    }

    /// The books as they should be, worked out case by case.
    function _worked()
        internal
        view
        returns (uint256 fees, uint256 disputes, uint256 atDesk, uint256 staked, uint256 seats, uint256 backHere)
    {
        uint256 n = vf.caseCount();
        for (uint256 id = 1; id <= n; ++id) {
            FactorVerifiers.Case memory c = vf.getCase(id);
            if (!_open(c.state)) {
                assertEq(c.fee, 0, "an ended case holds no fee");
                continue;
            }
            fees += c.fee;
            atDesk += c.price;
            if (c.state == FactorVerifiers.State.Disputed) disputes += c.disputeBond;
            if (c.state == FactorVerifiers.State.Checked || c.state == FactorVerifiers.State.Disputed) {
                staked += c.stake;
                seats += 1;
            }
            if (c.state == FactorVerifiers.State.Disputed) {
                FactorVerifiers.Seat[3] memory s = vf.seats(id);
                for (uint256 i = 0; i < 3; ++i) {
                    if (s[i].verifier == address(0)) continue;
                    staked += c.stake;
                    seats += 1;
                    for (uint256 k = i + 1; k < 3; ++k) {
                        if (s[k].verifier != address(0)) {
                            assertTrue(s[k].maker != s[i].maker, "a panel's seats are of different makers");
                            assertTrue(s[k].verifier != s[i].verifier, "one seat each");
                        }
                    }
                    assertTrue(s[i].verifier != c.checker, "the first verifier never sits on its own case's panel");
                }
            }
            FactorDesk.Job memory j = desk.job(c.job);
            if (j.state == FactorDesk.State.Refunded) backHere += j.price - j.early;
            else if (j.state == FactorDesk.State.Declined) backHere += j.price;
        }
    }

    function invariant_theContractHoldsExactlyItsBooks() public view {
        (,,,,, uint256 backHere) = _worked();
        assertEq(
            address(vf).balance,
            vf.bonds() + vf.staked() + vf.fees() + vf.disputes() + vf.owedTotal() + backHere,
            "every wei here is a bond, a stake, a fee, a dispute bond, owed, or a payment on its way back"
        );
    }

    function invariant_everyBucketIsWhatTheCasesSay() public view {
        (uint256 fees, uint256 disputes, uint256 atDesk, uint256 staked, uint256 seats,) = _worked();
        assertEq(vf.fees(), fees, "fees");
        assertEq(vf.disputes(), disputes, "dispute bonds");
        assertEq(vf.atDesk(), atDesk, "the price at the desk");
        assertEq(vf.staked(), staked, "stakes");
        uint256 free;
        uint256 locked;
        uint256 open;
        for (uint256 i = 0; i < handler.verifierCount(); ++i) {
            FactorVerifiers.Verifier memory v = vf.verifier(handler.vers(i));
            free += v.free;
            locked += v.locked;
            open += v.open;
            assertTrue(v.since == 0 || v.free + v.locked >= vf.MIN_BOND(), "a standing needs the bond");
        }
        assertEq(vf.bonds(), free, "free bonds are the verifiers'");
        assertEq(vf.staked(), locked, "staked bonds are the verifiers'");
        assertEq(open, seats, "every open seat is counted once");
    }

    function invariant_theDeskHoldsItsBooks() public view {
        assertGe(
            address(desk).balance,
            desk.pool() + desk.held() + desk.bonds() + desk.owedTotal(),
            "the desk holds at least its books"
        );
    }

    function invariant_callSummary() public view {
        console.log("hires", handler.hires(), "checks", handler.checks());
        console.log("disputes", handler.disputes(), "seats", handler.seats());
        console.log("reveals", handler.reveals(), "panels", handler.panels());
        console.log("ended", handler.ended());
    }
}
