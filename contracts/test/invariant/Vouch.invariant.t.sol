// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {FactorTest} from "../FactorTest.sol";
import {FactorLine} from "../../src/FactorLine.sol";
import {FactorGuarantee} from "../../src/FactorGuarantee.sol";
import {FactorVouch} from "../../src/FactorVouch.sol";
import {VouchHandler} from "./VouchHandler.sol";

/// The vouching rules that must hold whatever anybody does, in whatever order, beside the desk, the line contract and
/// the guarantee contract. The handler does the doing and checks each settle as it happens; each function here is one
/// rule, checked after every step.
contract VouchInvariantTest is FactorTest {
    VouchHandler internal handler;
    FactorLine internal line;
    FactorGuarantee internal g;
    FactorVouch internal vc;

    function setUp() public override {
        super.setUp();
        line = new FactorLine(desk);
        g = new FactorGuarantee(desk, line);
        vc = new FactorVouch(g);
        handler = new VouchHandler(desk, line, g, vc);
        vm.deal(address(this), 10 ether);
        (bool ok,) = address(line).call{value: 5 ether}("");
        assertTrue(ok);
        (ok,) = address(desk).call{value: 1 ether}("");
        assertTrue(ok);
        handler.setUpScores();
        // both vouchers with a bond, so the runs spend their steps on the rules
        handler.bond(0, 0.4 ether);
        handler.bond(1, 0.4 ether);
        vm.deal(handler.covered(), 0.1 ether);
        vm.prank(handler.covered());
        desk.addBond{value: 0.05 ether}();
        targetContract(address(handler));
        bytes4[] memory moves = new bytes4[](22);
        moves[0] = VouchHandler.bond.selector;
        moves[1] = VouchHandler.takeBond.selector;
        moves[2] = VouchHandler.offerLine.selector;
        moves[3] = VouchHandler.settle.selector; // twice: most vouches end this way
        moves[4] = VouchHandler.offerCover.selector;
        moves[5] = VouchHandler.withdraw.selector;
        moves[6] = VouchHandler.accept.selector;
        moves[7] = VouchHandler.accept.selector;
        moves[8] = VouchHandler.release.selector;
        moves[9] = VouchHandler.earn.selector;
        moves[10] = VouchHandler.lineBond.selector;
        moves[11] = VouchHandler.draw.selector;
        moves[12] = VouchHandler.repay.selector;
        moves[13] = VouchHandler.recover.selector;
        moves[14] = VouchHandler.hireCovered.selector;
        moves[15] = VouchHandler.deliver.selector;
        moves[16] = VouchHandler.answer.selector;
        moves[17] = VouchHandler.decline.selector;
        moves[18] = VouchHandler.hireCovered.selector; // twice: a job drawn on and not delivered ends the agent's covers
        moves[19] = VouchHandler.warp.selector;
        moves[20] = VouchHandler.settle.selector;
        moves[21] = VouchHandler.collect.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: moves}));
    }

    /// Nothing the handler saw was against the rulebook: a line vouch failed only on a default and paid the line, a
    /// cover vouch kept only on a release, failed only on a payout to the customer, returned only on a decline.
    function invariant_everyMoveKeptTheRules() public view {
        assertFalse(handler.wrong(), handler.why());
    }

    /// The contract holds exactly its bonds, the fees it holds and what it owes wallets.
    function invariant_theContractHoldsExactlyItsBooks() public view {
        assertEq(address(vc).balance, vc.bonds() + vc.feesHeld() + vc.owedTotal());
    }

    /// Bonds are free plus held back, voucher by voucher: no vouch is ever unbacked, and every bond is somebody's.
    function invariant_eachBondBacksItsOwnVouches() public view {
        uint256 bonds;
        uint256 held;
        for (uint256 i = 0; i < 2; ++i) {
            FactorVouch.Voucher memory b = vc.voucherOf(handler.vouchers(i));
            assertLe(b.held, b.bond, "held back <= bond");
            bonds += b.bond;
            held += b.held;
        }
        assertEq(vc.bonds(), bonds, "bonds = every voucher's");
        assertEq(vc.held(), held, "held back = every voucher's");
    }

    /// What is held back is exactly the open vouches' amounts, per voucher and agent too; the fees held are exactly the
    /// standing vouches' fees; every ended fee was counted once, and a voucher earns only from vouches kept.
    function invariant_everyVouchIsCountedOnce() public view {
        uint256 held;
        uint256 fees;
        uint256 earned;
        uint256 paid;
        uint256 n = vc.vouchCount();
        uint256[2][3] memory onAgent;
        for (uint256 id = 1; id <= n; ++id) {
            FactorVouch.Vouch memory v = vc.vouch(id);
            if (v.state == FactorVouch.State.Offered || v.state == FactorVouch.State.Active) {
                held += v.amount;
                uint256 vi = v.voucher == handler.vouchers(0) ? 0 : 1;
                uint256 ai = v.agent == handler.accounts(0) ? 0 : v.agent == handler.accounts(1) ? 1 : 2;
                onAgent[ai][vi] += v.amount;
                assertEq(vc.openOf(v.voucher, v.kind, v.subject), id, "one open vouch per voucher and subject");
            }
            if (v.state == FactorVouch.State.Active) fees += v.fee;
            if (v.state == FactorVouch.State.Kept) earned += (v.fee * 5000) / 10_000;
            if (v.state == FactorVouch.State.Failed) {
                paid += v.paid;
                assertLe(v.paid, v.fee + v.amount, "never more than the fee and the amount");
            } else {
                assertEq(v.paid, 0, "only a failed vouch pays");
            }
        }
        assertEq(vc.held(), held, "held back = the open vouches");
        assertEq(vc.feesHeld(), fees, "fees held = the standing vouches' fees");
        assertEq(vc.totalEarned(), earned, "half of each kept fee, rounded down, earned");
        assertEq(vc.totalPaid(), paid, "every loss paid counted once");
        for (uint256 vi = 0; vi < 2; ++vi) {
            address who = handler.vouchers(vi);
            assertEq(vc.heldOn(who, handler.accounts(0)), onAgent[0][vi]);
            assertEq(vc.heldOn(who, handler.accounts(1)), onAgent[1][vi]);
            assertEq(vc.heldOn(who, handler.covered()), onAgent[2][vi]);
        }
    }

    /// The line contract's and the desk's books are untouched by all of it.
    function invariant_theLineAndTheDeskStillHoldTheirBooks() public view {
        assertEq(address(line).balance, line.pool() + line.owedTotal());
        assertEq(line.pool() + line.out() + line.lost(), line.totalPoolIn() + line.totalFeesToPool());
        assertEq(address(desk).balance, desk.pool() + desk.held() + desk.bonds() + desk.owedTotal());
        assertEq(address(g).balance, g.bonds() + g.feesHeld() + g.owedTotal());
    }

    /// What a run did, so a run that never failed a vouch is seen for what it is.
    function afterInvariant() external view {
        console.log("offered %s, accepted %s, withdrawn %s", handler.offers(), handler.accepted(), handler.withdrawn());
        console.log("kept %s, failed %s, returned %s", handler.kept(), handler.fails(), handler.returned());
    }
}
