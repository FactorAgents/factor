// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FactorTest} from "./FactorTest.sol";
import {FactorBurnPot} from "../src/FactorBurnPot.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {FactorSplitter} from "../src/FactorSplitter.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";
import {Bouncer, ForceSend, GasEater, Reenterer, Rejecter, TogglePot} from "./mocks/Actors.sol";
import {MockEscrow, MockFactory} from "./mocks/MockPons.sol";

contract SplitterTest is FactorTest {
    event Split(
        uint256 amount,
        uint256 toAdmin,
        uint256 toBurn,
        uint256 toPool,
        bool adminPushed,
        bool burnPushed,
        bool poolPushed
    );
    event PendingDelivered(address indexed to, uint256 amount);
    event TokensSentToBurn(uint256 amount);

    // ---------- what it is ----------

    function test_theSharesAreSeventyThirtyAndNothingElse() public view {
        assertEq(splitter.ADMIN_BPS(), 7000);
        assertEq(splitter.BURN_BPS(), 2000);
        assertEq(splitter.POOL_BPS(), 1000);
        assertEq(uint256(splitter.ADMIN_BPS()) + splitter.BURN_BPS() + splitter.POOL_BPS(), splitter.BPS());
        assertEq(splitter.admin(), admin);
        assertEq(splitter.burnPot(), address(burnPot));
        assertEq(address(splitter.escrow()), address(escrow));
    }

    /// Nothing about the splitter can be changed by anybody: every function that could plausibly do so is absent.
    function test_nothingCanBeSet() public {
        string[8] memory sigs = [
            "setAdmin(address)",
            "setBurnPot(address)",
            "setEscrow(address)",
            "setShares(uint16,uint16)",
            "transferOwnership(address)",
            "withdraw(address,uint256)",
            "setToken(address)",
            "initialize(address,address,address)"
        ];
        for (uint256 i = 0; i < sigs.length; ++i) {
            vm.prank(admin);
            (bool ok,) = address(splitter).call(abi.encodeWithSignature(sigs[i], admin, admin, admin, admin));
            assertFalse(ok, sigs[i]);
        }
    }

    // ---------- the split ----------

    function test_aRoundAmountSplitsExactly() public {
        vm.deal(address(splitter), 1 ether);
        vm.expectEmit(address(splitter));
        emit Split(1 ether, 0.7 ether, 0.2 ether, 0.1 ether, true, true, true);
        assertEq(splitter.distribute(), 1 ether);
        assertEq(admin.balance, 0.7 ether);
        assertEq(address(burnPot).balance, 0.2 ether);
        assertEq(address(splitter).balance, 0);
        assertEq(splitter.totalSplit(), 1 ether);
        assertEq(splitter.totalToAdmin(), 0.7 ether);
        assertEq(splitter.totalToBurn(), 0.2 ether);
    }

    /// The remainder rule: the admin's share and the pool's are rounded down, the burn takes what is left.
    function test_theRoundingDustGoesToTheBurn() public {
        vm.deal(address(splitter), 9); // 70% = 6.3, 10% = 0.9, 20% = 1.8
        splitter.distribute();
        assertEq(admin.balance, 6, "rounded down");
        assertEq(desk.pool(), 0, "rounded down");
        assertEq(address(burnPot).balance, 3, "the rest: 2 wei more than 20% rounded down");
    }

    function test_theDustIsNeverMoreThanTwoWei() public {
        vm.deal(address(splitter), 13); // 70% = 9.1, 10% = 1.3, 20% = 2.6
        splitter.distribute();
        assertEq(admin.balance, 9);
        assertEq(desk.pool(), 1);
        assertEq(address(burnPot).balance, 3, "20% rounded down is 2; the rounded-off parts add 1");
    }

    function test_oneWeiIsBurnedNotLost() public {
        vm.deal(address(splitter), 1);
        assertEq(splitter.distribute(), 1);
        assertEq(address(burnPot).balance, 1);
        assertEq(admin.balance, 0);
    }

    function test_nothingToSplitIsANoOp() public {
        assertEq(splitter.distribute(), 0);
        assertEq(splitter.claim(), 0);
        assertEq(splitter.sweep(), 0);
        assertEq(splitter.totalSplit(), 0);
    }

    /// No wei is lost or created, for any amount: the three shares are exactly the whole, the admin never gets more
    /// than 70%, the pool gets its 10% rounded down, and the burn at most 2 wei more than 20% rounded down.
    function testFuzz_theThreeSharesAreExactlyWhatCameIn(uint256 amount) public {
        amount = bound(amount, 0, 1_000_000 ether);
        vm.deal(address(splitter), amount);
        uint256 split = splitter.distribute();
        assertEq(split, amount);
        uint256 toAdmin = admin.balance;
        uint256 toBurn = address(burnPot).balance;
        uint256 toPool = address(desk).balance;
        assertEq(toAdmin + toBurn + toPool, amount, "nothing lost, nothing made");
        assertEq(address(splitter).balance, 0, "nothing left behind");
        assertEq(toPool, (amount * 1000) / 10_000, "10% rounded down");
        assertEq(desk.pool(), toPool, "and all of it is the pool's");
        assertEq(toAdmin, (amount * 7000) / 10_000, "70% rounded down");
        assertGe(toBurn, (amount * 2000) / 10_000, "at least 20% rounded down");
        assertLe(toBurn - (amount * 2000) / 10_000, 2, "and at most 2 wei of dust on top");
        assertLe(toAdmin * 10_000, amount * 7000, "the admin never gets more than 70%");
    }

    /// The same over many arrivals: splitting as it comes never drifts from the totals.
    function testFuzz_manySplitsAddUp(uint96[8] memory amounts) public {
        uint256 sum;
        for (uint256 i = 0; i < amounts.length; ++i) {
            uint256 a = uint256(amounts[i]) % 100 ether;
            sum += a;
            (bool ok,) = address(splitter).call{value: a}("");
            assertTrue(ok);
            splitter.distribute();
        }
        assertEq(splitter.totalSplit(), sum);
        assertEq(splitter.totalToAdmin() + splitter.totalToBurn() + splitter.totalToPool(), sum);
        assertEq(desk.pool(), splitter.totalToPool());
        assertEq(admin.balance, splitter.totalToAdmin());
        assertEq(address(burnPot).balance, splitter.totalToBurn());
        assertEq(address(splitter).balance, 0);
    }

    function test_ethSentStraightHereWaitsForDistribute() public {
        vm.deal(stranger, 2 ether);
        vm.prank(stranger);
        (bool ok,) = address(splitter).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(splitter.unsplit(), 2 ether);
        assertEq(admin.balance, 0, "arriving does not split");
        vm.prank(stranger);
        splitter.distribute();
        assertEq(admin.balance, 1.4 ether);
    }

    function test_forcedEthIsSplitLikeAnyOther() public {
        new ForceSend{value: 1 ether}(payable(address(splitter)));
        assertEq(splitter.distribute(), 1 ether);
        assertEq(admin.balance, 0.7 ether);
    }

    // ---------- the Pons fee path ----------

    function test_beforeTheLaunchThereIsNoCurve() public view {
        assertEq(splitter.curve(), address(0));
    }

    function test_sweepReleasesTheCurveClaimsTheEscrowAndSplits() public {
        _launch(0);
        assertEq(splitter.curve(), address(curve));
        _trade(1 ether);
        // 4% of the trade is fees; the fee recipient is owed the 3% tax and 70% of the 1% base fee
        assertEq(curve.pendingFees(), 0.04 ether);
        assertEq(escrow.balanceOf(address(splitter)), 0, "still on the curve");

        vm.prank(stranger);
        uint256 amount = splitter.sweep();
        assertEq(amount, 0.037 ether);
        assertEq(admin.balance, 0.0259 ether);
        assertEq(address(burnPot).balance, 0.0074 ether);
        assertEq(desk.pool(), 0.0037 ether, "the pool's tenth, in the desk");
        assertEq(address(desk).balance, 0.0037 ether);
        assertEq(curve.pendingFees(), 0);
        assertEq(escrow.balanceOf(address(splitter)), 0);
    }

    function test_onlyTheSplitterOrPonsCanReleaseTheCurve() public {
        _launch(0);
        _trade(1 ether);
        vm.prank(stranger);
        vm.expectRevert("NotFeeSweepOperator");
        curve.sweepFees(0);
    }

    function test_sweepWithNothingOnTheCurveStillClaimsAndNeverReverts() public {
        _launch(0);
        // the curve has nothing and its release reverts; the escrow holds something from an earlier release
        escrow.credit{value: 0.5 ether}(address(splitter));
        assertEq(splitter.sweep(), 0.5 ether);
        assertEq(admin.balance, 0.35 ether);
        assertEq(splitter.sweep(), 0, "and again with nothing anywhere");
    }

    function test_claimTakesTheEscrowAlone() public {
        _launch(0);
        _trade(1 ether);
        vm.prank(factory.operator());
        curve.sweepFees(0); // Pons' keeper released it
        assertEq(escrow.balanceOf(address(splitter)), 0.037 ether);
        assertEq(splitter.claim(), 0.037 ether);
        assertEq(escrow.balanceOf(address(splitter)), 0);
    }

    /// After graduation the pool's fees are released by Pons' keeper, late and in lumps. The splitter cannot
    /// hurry that; it claims whatever has been credited whenever it is asked.
    function test_afterGraduationThereIsNoCurveAndLateFeesStillSplit() public {
        _launch(0);
        _graduate(2 ** 96, 1e24);
        assertEq(splitter.curve(), address(0));
        assertEq(splitter.sweep(), 0, "nothing yet");
        escrow.credit{value: 0.2 ether}(address(splitter)); // an hourly release lands
        assertEq(splitter.sweep(), 0.2 ether);
        assertEq(admin.balance, 0.14 ether);
    }

    function test_curveIsZeroIfTheFactoryCannotBeRead() public {
        _launch(0);
        vm.mockCallRevert(address(factory), abi.encodeWithSelector(MockFactory.getLaunchedToken.selector), "down");
        assertEq(splitter.curve(), address(0));
        vm.deal(address(splitter), 1 ether);
        assertEq(splitter.sweep(), 1 ether, "and a sweep still splits what is here");
    }

    // ---------- a fee credited in $FACTOR ----------

    /// Somebody holding $FACTOR credits the escrow's token ledger for the splitter, the way Pons would.
    function _creditFactor(uint256 amount) internal {
        vm.startPrank(trader);
        token.approve(address(escrow), amount);
        escrow.creditToken(address(splitter), address(token), amount);
        vm.stopPrank();
    }

    /// Fees arrive as ETH today. If the escrow ever holds $FACTOR for the splitter, anyone can have it claimed, and
    /// all of it goes to the burn pot, which destroys it with its next burn. None of it is split.
    function test_aTokenCreditIsClaimedAndSentWholeToTheBurnPot() public {
        _launch(0);
        _trade(1 ether);
        _creditFactor(5000e18);
        assertEq(escrow.balanceOfToken(address(splitter), address(token)), 5000e18);
        uint256 adminHeld = token.balanceOf(admin);

        vm.expectEmit(address(splitter));
        emit TokensSentToBurn(5000e18);
        vm.prank(stranger);
        assertEq(splitter.claimToken(), 5000e18);
        assertEq(escrow.balanceOfToken(address(splitter), address(token)), 0, "the credit is taken");
        assertEq(token.balanceOf(address(splitter)), 0, "nothing rests here");
        assertEq(token.balanceOf(address(burnPot)), 5000e18, "all of it is in the burn pot");
        assertEq(token.balanceOf(admin), adminHeld, "none of it is the admin's");
        assertEq(token.balanceOf(stranger), 0, "nor the caller's");

        // and the burn pot's next burn destroys it along with what it buys
        vm.deal(address(burnPot), 0.01 ether);
        vm.warp(block.timestamp + 30 minutes);
        uint256 supply = token.totalSupply();
        (, uint256 burned) = burnPot.burn(0);
        assertGt(burned, 5000e18);
        assertEq(supply - token.totalSupply(), burned, "the supply fell by the credit and the buy together");
        assertEq(token.balanceOf(address(burnPot)), 0);
    }

    /// $FACTOR sent straight to the splitter is forwarded the same way, with or without a credit in the escrow.
    function test_factorSentStraightToTheSplitterGoesToTheBurnPotToo() public {
        _launch(0);
        _trade(1 ether);
        vm.prank(trader);
        token.transfer(address(splitter), 700e18);
        assertEq(splitter.claimToken(), 700e18);
        assertEq(token.balanceOf(address(burnPot)), 700e18);

        _creditFactor(200e18);
        vm.prank(trader);
        token.transfer(address(splitter), 100e18);
        assertEq(splitter.claimToken(), 300e18, "the credit and what was already here, in one go");
        assertEq(token.balanceOf(address(burnPot)), 1000e18);
        assertEq(token.balanceOf(address(splitter)), 0);
    }

    /// With nothing to claim, claimToken() does nothing and returns zero. It does not revert, although the
    /// escrow's own claimToken() would: the escrow is only asked when it holds a credit.
    function test_claimTokenWithNothingToClaimDoesNothing() public {
        assertEq(splitter.claimToken(), 0, "before the launch there is no token");
        _launch(0);
        vm.expectRevert("NothingToClaim");
        vm.prank(address(splitter));
        escrow.claimToken(address(token));

        vm.recordLogs();
        vm.prank(stranger);
        assertEq(splitter.claimToken(), 0);
        assertEq(vm.getRecordedLogs().length, 0, "no event, no transfer");
        assertEq(token.balanceOf(address(burnPot)), 0);
    }

    /// claimToken() moves $FACTOR and nothing else: ETH waiting to be split, and shares waiting for a destination
    /// that refused them, are where they were.
    function test_claimTokenMovesNoEth() public {
        _launch(0);
        _trade(1 ether);
        _creditFactor(10e18);
        vm.deal(address(splitter), 2 ether);
        uint256 potEth = address(burnPot).balance;
        splitter.claimToken();
        assertEq(splitter.unsplit(), 2 ether);
        assertEq(address(burnPot).balance, potEth);
        assertEq(admin.balance, 0);
        assertEq(curve.pendingFees(), 0.04 ether, "and it does not release the curve's fees either");
    }

    // ---------- a destination that refuses ----------

    function _splitterFor(address payable admin_) internal returns (FactorSplitter s, FactorBurnPot b) {
        Factor memory h = _deployFactor(address(this), admin_, gateway, IPonsV2LaunchFactory(address(factory)));
        return (h.splitter, h.burnPot);
    }

    function test_anAdminWalletThatRefusesDoesNotStopTheBurnShare() public {
        Rejecter r = new Rejecter();
        (FactorSplitter s, FactorBurnPot b) = _splitterFor(payable(address(r)));
        vm.deal(address(s), 1 ether);
        vm.expectEmit(address(s));
        emit Split(1 ether, 0.7 ether, 0.2 ether, 0.1 ether, false, true, true);
        s.distribute();
        assertEq(address(b).balance, 0.2 ether, "the burn share went");
        assertEq(s.adminPending(), 0.7 ether, "the admin's waits");
        assertEq(s.unsplit(), 0, "and is not split a second time");
        assertEq(s.distribute(), 0);
        assertEq(s.totalToAdmin(), 0.7 ether, "it is still the admin's");

        // a second arrival splits on top of the waiting share
        vm.deal(address(s), address(s).balance + 1 ether);
        s.distribute();
        assertEq(s.adminPending(), 1.4 ether);
        assertEq(address(b).balance, 0.4 ether);

        // retry while it still refuses changes nothing
        s.retry();
        assertEq(s.adminPending(), 1.4 ether);

        // once the wallet accepts, anyone can deliver it
        r.setAccept(true);
        vm.expectEmit(address(s));
        emit PendingDelivered(address(r), 1.4 ether);
        vm.prank(stranger);
        s.retry();
        assertEq(address(r).balance, 1.4 ether);
        assertEq(s.adminPending(), 0);
        assertEq(address(s).balance, 0);
    }

    function test_theAdminCanCollectARefusedShareSomewhereElse() public {
        Rejecter r = new Rejecter();
        (FactorSplitter s,) = _splitterFor(payable(address(r)));
        vm.deal(address(s), 1 ether);
        s.distribute();

        vm.prank(stranger);
        vm.expectRevert(FactorSplitter.NotAdmin.selector);
        s.withdrawAdmin(payable(stranger));

        vm.prank(address(r));
        vm.expectRevert(FactorSplitter.ZeroAddress.selector);
        s.withdrawAdmin(payable(address(0)));

        // to an address that refuses too: nothing is lost
        Rejecter other = new Rejecter();
        vm.prank(address(r));
        vm.expectRevert(FactorSplitter.PushFailed.selector);
        s.withdrawAdmin(payable(address(other)));
        assertEq(s.adminPending(), 0.7 ether);

        address payable safe = payable(makeAddr("safe"));
        vm.prank(address(r));
        s.withdrawAdmin(safe);
        assertEq(safe.balance, 0.7 ether, "exactly the admin's share, nothing of the burn pot's");
        assertEq(s.adminPending(), 0);

        vm.prank(address(r));
        vm.expectRevert(FactorSplitter.NothingPending.selector);
        s.withdrawAdmin(safe);
    }

    /// withdrawAdmin() moves the admin's own waiting share and nothing else: unsplit ETH stays for the split.
    function test_withdrawAdminCannotTouchUnsplitEth() public {
        Rejecter r = new Rejecter();
        (FactorSplitter s, FactorBurnPot b) = _splitterFor(payable(address(r)));
        vm.deal(address(s), 1 ether);
        s.distribute();
        vm.deal(address(s), address(s).balance + 10 ether); // arrives, not split yet
        address payable safe = payable(makeAddr("safe"));
        vm.prank(address(r));
        s.withdrawAdmin(safe);
        assertEq(safe.balance, 0.7 ether);
        assertEq(s.unsplit(), 10 ether);
        s.distribute();
        assertEq(address(b).balance, 0.2 ether + 2 ether);
    }

    /// withdrawAdmin() cannot reach the burn share either, even while the burn pot's share is waiting here.
    function test_withdrawAdminCannotTouchAWaitingBurnShare() public {
        Rejecter r = new Rejecter();
        address at = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        TogglePot burn = new TogglePot(at, address(factory), address(0));
        FactorSplitter s = new FactorSplitter(
            payable(address(r)), payable(address(burn)), _deskFor(address(burn)), IPonsV2FeeEscrow(address(escrow))
        );
        burn.setReject(true);
        vm.deal(address(s), 1 ether);
        s.distribute();
        assertEq(s.adminPending(), 0.7 ether);
        assertEq(s.burnPending(), 0.2 ether);
        address payable safe = payable(makeAddr("safe"));
        vm.prank(address(r));
        s.withdrawAdmin(safe);
        assertEq(safe.balance, 0.7 ether, "the admin's 70% and not a wei more");
        assertEq(s.burnPending(), 0.2 ether, "the burn share is still here, still the burn pot's");
        assertEq(address(s).balance, 0.2 ether);
        burn.setReject(false);
        s.retry();
        assertEq(address(burn).balance, 0.2 ether);
    }

    function test_anAdminWalletThatEatsGasDoesNotStopTheSplit() public {
        GasEater g = new GasEater();
        (FactorSplitter s, FactorBurnPot b) = _splitterFor(payable(address(g)));
        vm.deal(address(s), 1 ether);
        uint256 gasBefore = gasleft();
        s.distribute{gas: 600_000}();
        assertLt(gasBefore - gasleft(), 600_000);
        assertEq(address(b).balance, 0.2 ether);
        assertEq(s.adminPending(), 0.7 ether);
    }

    /// The burn pot here is the real one and cannot refuse ETH. Against a pot that can, the admin is still paid.
    function test_aPotThatRefusesDoesNotStopTheAdmin() public {
        address at = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        TogglePot burn = new TogglePot(at, address(factory), address(0));
        FactorSplitter s = new FactorSplitter(
            payable(admin), payable(address(burn)), _deskFor(address(burn)), IPonsV2FeeEscrow(address(escrow))
        );

        burn.setReject(true);
        vm.deal(address(s), 1 ether);
        vm.expectEmit(address(s));
        emit Split(1 ether, 0.7 ether, 0.2 ether, 0.1 ether, true, false, true);
        s.distribute();
        assertEq(admin.balance, 0.7 ether);
        assertEq(s.burnPending(), 0.2 ether);

        vm.deal(address(s), address(s).balance + 1 ether);
        s.distribute();
        assertEq(s.burnPending(), 0.4 ether);
        assertEq(admin.balance, 1.4 ether, "the admin is paid either way");
        assertEq(s.unsplit(), 0);

        s.retry();
        assertEq(s.burnPending(), 0.4 ether, "still refused, still waiting");
        burn.setReject(false);
        s.retry();
        assertEq(address(burn).balance, 0.4 ether, "the share reaches the pot it was split for");
        assertEq(s.burnPending(), 0);
        assertEq(address(s).balance, 0);
    }

    // ---------- reentrancy ----------

    function test_anAdminWalletCannotReenterTheSplit() public {
        bytes[6] memory calls = [
            abi.encodeCall(FactorSplitter.distribute, ()),
            abi.encodeCall(FactorSplitter.sweep, ()),
            abi.encodeCall(FactorSplitter.claim, ()),
            abi.encodeCall(FactorSplitter.claimToken, ()),
            abi.encodeCall(FactorSplitter.retry, ()),
            abi.encodeCall(FactorSplitter.withdrawAdmin, (payable(stranger)))
        ];
        for (uint256 i = 0; i < calls.length; ++i) {
            Reenterer r = new Reenterer();
            (FactorSplitter s, FactorBurnPot b) = _splitterFor(payable(address(r)));
            r.arm(calls[i]);
            vm.deal(address(s), 1 ether);
            s.distribute();
            assertFalse(r.reentrySucceeded(), "the call back in was refused");
            assertEq(address(b).balance, 0.2 ether);
            assertEq(address(r).balance + s.adminPending(), 0.7 ether, "paid once, or waiting once");
            assertEq(address(s).balance, s.adminPending());
        }
    }

    /// The same with all the gas in the world: the admin collects a waiting share to a wallet that calls back in
    /// while it is being paid. Every way back in is refused by the guard itself, and the payment still lands once.
    function test_theGuardRefusesEveryWayBackIn() public {
        bytes[6] memory calls = [
            abi.encodeCall(FactorSplitter.distribute, ()),
            abi.encodeCall(FactorSplitter.sweep, ()),
            abi.encodeCall(FactorSplitter.claim, ()),
            abi.encodeCall(FactorSplitter.claimToken, ()),
            abi.encodeCall(FactorSplitter.retry, ()),
            abi.encodeCall(FactorSplitter.withdrawAdmin, (payable(stranger)))
        ];
        Rejecter r = new Rejecter();
        (FactorSplitter s,) = _splitterFor(payable(address(r)));
        vm.deal(address(s), 1 ether);
        s.distribute();
        vm.deal(address(s), address(s).balance + 1 ether); // something a call back in could try to split
        for (uint256 i = 0; i < calls.length; ++i) {
            uint256 snap = vm.snapshotState();
            Reenterer e = new Reenterer();
            e.arm(calls[i]);
            vm.prank(address(r));
            s.withdrawAdmin(payable(address(e)));
            assertTrue(e.reentered(), "it did call back in");
            assertFalse(e.reentrySucceeded(), "and was refused");
            assertEq(address(e).balance, 0.7 ether, "paid once");
            assertEq(s.unsplit(), 1 ether, "the unsplit ETH is untouched");
            vm.revertToState(snap);
        }
    }

    function test_ethThatComesBackDuringAPushWaitsForTheNextSplit() public {
        Bouncer bouncer = new Bouncer();
        (FactorSplitter s, FactorBurnPot b) = _splitterFor(payable(address(bouncer)));
        bouncer.setBack(1000);
        vm.deal(address(s), 1 ether);
        s.distribute{gas: 2_000_000}();
        // 50,000 gas is enough for the wallet to send 1000 wei back
        assertEq(s.adminPending(), 0);
        assertEq(address(bouncer).balance, 0.7 ether - 1000);
        assertEq(s.unsplit(), 1000, "not counted as anybody's share");
        assertEq(address(b).balance, 0.2 ether);
        assertEq(s.totalSplit(), 1 ether);
        bouncer.setBack(0);
        assertEq(s.distribute(), 1000);
        assertEq(address(s).balance, 0);
    }

    // ---------- the constructor ----------

    function _new(address admin_, address burn_, address escrow_) internal returns (FactorSplitter) {
        return new FactorSplitter(payable(admin_), payable(burn_), payable(address(desk)), IPonsV2FeeEscrow(escrow_));
    }

    /// A desk that sends its advance fees to this burn pot, which is what the splitter asks of the desk it is given.
    function _deskFor(address burn_) internal returns (address payable) {
        return payable(address(new FactorDesk(burn_, gateway)));
    }

    function test_theConstructorRefusesZeroAddresses() public {
        vm.expectRevert(FactorSplitter.ZeroAddress.selector);
        _new(address(0), address(burnPot), address(escrow));
        vm.expectRevert(FactorSplitter.ZeroAddress.selector);
        _new(admin, address(0), address(escrow));
        vm.expectRevert(FactorSplitter.ZeroAddress.selector);
        _new(admin, address(burnPot), address(0));
    }

    function test_theAdminMustBeAnAddressOfItsOwn() public {
        vm.expectRevert(FactorSplitter.BadAdmin.selector);
        _new(address(burnPot), address(burnPot), address(escrow));
        vm.expectRevert(FactorSplitter.BadAdmin.selector);
        _new(address(escrow), address(burnPot), address(escrow));
        address self = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(FactorSplitter.BadAdmin.selector);
        _new(self, address(burnPot), address(escrow));
    }

    function test_theConstructorRefusesAPotThatIsNotWiredToIt() public {
        // an address with no code
        vm.expectRevert(FactorSplitter.PotMismatch.selector);
        _new(admin, makeAddr("empty"), address(escrow));
        // the real burn pot names the first splitter, not a second one
        vm.expectRevert(FactorSplitter.PotMismatch.selector);
        _new(admin, address(burnPot), address(escrow));
        // a burn pot that was given some other address for its splitter
        FactorBurnPot b = new FactorBurnPot(admin, IPonsV2LaunchFactory(address(factory)), makeAddr("elsewhere"));
        vm.expectRevert(FactorSplitter.PotMismatch.selector);
        _new(admin, address(b), address(escrow));
    }

    function test_theEscrowMustBeTheOneTheFactoryCredits() public {
        address at = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 3);
        MockEscrow other = new MockEscrow();
        FactorBurnPot b = new FactorBurnPot(admin, IPonsV2LaunchFactory(address(factory)), at);
        address payable d = _deskFor(address(b));
        vm.expectRevert(FactorSplitter.EscrowMismatch.selector);
        new FactorSplitter(payable(admin), payable(address(b)), d, IPonsV2FeeEscrow(address(other)));
    }

    /// The desk has to exist and send its advance fees to this same burn pot, or the pool's share would be aimed
    /// at something that is not the pool.
    function test_theDeskMustBeWiredToTheSameBurnPot() public {
        address at = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        FactorBurnPot b = new FactorBurnPot(admin, IPonsV2LaunchFactory(address(factory)), at);
        // the first deployment's desk pays its advance fees to the first deployment's burn pot, not to this one
        vm.expectRevert(FactorSplitter.DeskMismatch.selector);
        new FactorSplitter(
            payable(admin), payable(address(b)), payable(address(desk)), IPonsV2FeeEscrow(address(escrow))
        );
    }

    function test_theDeskCannotBeAnEmptyAddressOrTheBurnPotItself() public {
        address at = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        FactorBurnPot b = new FactorBurnPot(admin, IPonsV2LaunchFactory(address(factory)), at);
        uint256 snap = vm.snapshotState();
        vm.expectRevert(FactorSplitter.DeskMismatch.selector);
        new FactorSplitter(
            payable(admin), payable(address(b)), payable(makeAddr("no desk here")), IPonsV2FeeEscrow(address(escrow))
        );
        vm.revertToState(snap);
        vm.expectRevert(FactorSplitter.DeskMismatch.selector);
        new FactorSplitter(payable(admin), payable(address(b)), payable(address(b)), IPonsV2FeeEscrow(address(escrow)));
    }

    // ---------- the pool's share ----------

    /// The pool's tenth arrives in the desk as pool, and nowhere else in the desk's books.
    function test_thePoolShareBecomesThePool() public {
        vm.deal(address(splitter), 1 ether);
        splitter.distribute();
        assertEq(address(desk).balance, 0.1 ether);
        assertEq(desk.pool(), 0.1 ether);
        assertEq(desk.totalPoolIn(), 0.1 ether);
        assertEq(desk.held() + desk.bonds() + desk.owedTotal() + desk.out(), 0);
        assertEq(splitter.totalToPool(), 0.1 ether);
        assertEq(splitter.poolPending(), 0);
    }
}
