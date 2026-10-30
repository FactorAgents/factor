// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LineBase, RefusingKey, GasEatingKey} from "./LineBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorAccount} from "../../src/FactorAccount.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// Every rule of docs/CREDIT-LINES.md, one by one, with its examples to the wei.
contract LineTest is LineBase {
    // ---------- the contract itself ----------

    function test_readsItsAddressesFromTheDeskAndHasNoOwner() public view {
        assertEq(address(line.desk()), address(desk));
        assertEq(line.burnPot(), desk.burnPot());
        assertEq(line.gateway(), desk.gateway());
        assertTrue(line.accountImplementation().code.length > 0);
        assertEq(address(FactorLineAccount(payable(line.accountImplementation())).line()), address(line));
        assertEq(line.DRAW_FEE_BPS(), 200);
        assertEq(line.BURN_BPS(), 100);
        assertEq(line.POOL_OUT_MAX_BPS(), 8000);
        assertEq(line.MIN_DRAW(), 0.0001 ether);
        assertEq(line.TERM(), 30 days);
        assertEq(line.DEFAULT_AFTER(), 30 days);
    }

    function test_aDeskIsNeeded() public {
        vm.expectRevert(FactorLine.ZeroAddress.selector);
        new FactorLine(FactorDesk(payable(address(0))));
    }

    function test_theImplementationCannotBeTakenOver() public {
        FactorLineAccount impl = FactorLineAccount(payable(line.accountImplementation()));
        vm.prank(stranger);
        vm.expectRevert(FactorLineAccount.OnlyLine.selector);
        impl.initialize(stranger);
    }

    // ---------- the pool ----------

    function test_plainEthIsAPoolSeedForGood() public {
        vm.expectEmit(address(line));
        emit FactorLine.PoolIn(seeder, 1 ether);
        _seed(1 ether);
        assertEq(line.pool(), 1 ether);
        assertEq(line.totalPoolIn(), 1 ether);
        assertEq(line.poolRoom(), 0.8 ether);
        _lineBooks();
    }

    function test_thePoolNeverHasMoreThan80PercentOut() public {
        _seed(1 ether);
        _open(agentA);
        _lineBond(agentA, 10 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.PoolShort.selector, 0.8 ether));
        line.draw(0.8 ether + 1, false);
        _lineDraw(agentA, 0.8 ether, false);
        // the fee's pool half came back in, so a little room opened: 80% of the larger pool, less what is out
        uint256 room = line.poolRoom();
        assertEq(room, ((line.pool() + line.out()) * 8000) / 10_000 - line.out());
        assertEq(line.canDraw(agentA), room);
        _lineBooks();
    }

    // ---------- opening ----------

    function test_aRegisteredAgentOpensItsLineOnce() public {
        address predicted = line.accountAddress(agentA);
        vm.expectEmit(address(line));
        emit FactorLine.Opened(agentA, predicted);
        FactorLineAccount acct = _open(agentA);
        assertEq(address(acct), predicted, "at the address that follows from the key");
        assertEq(acct.key(), agentA);
        assertEq(line.accountOf(agentA), address(acct));
        assertEq(line.keyOf(address(acct)), agentA);
        assertEq(line.lineCount(), 1);
        assertTrue(desk.agent(address(acct)).registered, "the account is an agent on the desk");
        FactorLine.Line memory l = line.line(address(acct));
        assertEq(l.key, agentA);
        assertEq(l.openedAt, block.timestamp);
        assertEq(l.debt, 0);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.HasLine.selector, address(acct)));
        line.open();
    }

    function test_onlyARegisteredAgentCanOpen() public {
        vm.prank(stranger);
        vm.expectRevert(FactorLine.NotRegistered.selector);
        line.open();
    }

    function test_aBarredAgentCannotOpen() public {
        _barOnDesk(agentA);
        vm.prank(agentA);
        vm.expectRevert(FactorLine.Barred.selector);
        line.open();
    }

    function test_aLineAccountCannotOpenALineOfItsOwn() public {
        FactorLineAccount acct = _open(agentA);
        vm.prank(address(acct));
        vm.expectRevert(FactorLine.IsLineAccount.selector);
        line.open();
    }

    function test_anAccountIsInitialisedOnceAndOnlyByTheLine() public {
        FactorLineAccount acct = _open(agentA);
        vm.prank(address(line));
        vm.expectRevert(FactorLineAccount.OnlyLine.selector);
        acct.initialize(stranger);
        vm.prank(stranger);
        vm.expectRevert(FactorLineAccount.OnlyLine.selector);
        acct.initialize(stranger);
        assertEq(acct.key(), agentA);
    }

    function test_aFactorAccountOpensAndDrawsWithItsWalletKey() public {
        address walletKey = makeAddr("a passkey account's wallet key");
        FactorAccount.Key memory first =
            FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(uint256(uint160(walletKey))), bytes32(0));
        address payable fa = payable(accounts.create(first, ""));
        FactorAccount.Call[] memory calls = new FactorAccount.Call[](2);
        calls[0] = FactorAccount.Call(address(desk), 0, abi.encodeCall(FactorDesk.register, ()));
        calls[1] = FactorAccount.Call(address(line), 0, abi.encodeCall(FactorLine.open, ()));
        vm.prank(walletKey);
        FactorAccount(fa).run(calls);
        FactorLineAccount acct = _acct(fa);
        assertEq(acct.key(), fa);
        // a bond from the account's own ETH, then a draw that lands back in it
        vm.deal(fa, 1 ether);
        _seed(1 ether);
        calls = new FactorAccount.Call[](2);
        calls[0] = FactorAccount.Call(address(acct), 0.1 ether, abi.encodeCall(FactorLineAccount.addBond, (0)));
        calls[1] = FactorAccount.Call(address(line), 0, abi.encodeCall(FactorLine.draw, (0.05 ether, false)));
        vm.prank(walletKey);
        FactorAccount(fa).run(calls);
        assertEq(fa.balance, 0.9 ether + 0.049 ether);
        assertEq(line.debtOf(address(acct)), 0.05 ether);
        _lineBooks();
    }

    // ---------- the limit ----------

    function test_theLimitIsTheAccountsBondPlusItsFeesPaid() public {
        FactorLineAccount acct = _open(agentA);
        assertEq(line.limit(address(acct)), 0, "a new account has neither");
        _lineBond(agentA, 0.03 ether);
        assertEq(line.limit(address(acct)), 0.03 ether);
        _earn(agentA, 0.5 ether); // a 2% job fee: 0.01
        assertEq(desk.agent(address(acct)).feesPaid, 0.01 ether);
        assertEq(line.limit(address(acct)), 0.04 ether);
        assertEq(line.room(address(acct)), 0.04 ether);
    }

    function test_theKeysOwnBondAndFeesDoNotCount() public {
        // the key has a bond and fees of its own at its old address on the desk
        _bond(agentA, 1 ether);
        uint256 id = _lock(agentA, 1 ether, false);
        _deliver(agentA, id);
        _accept(id);
        assertEq(desk.limit(agentA), 1.02 ether);
        FactorLineAccount acct = _open(agentA);
        assertEq(line.limit(address(acct)), 0, "the old address can still borrow on the desk against them");
        _seed(1 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.OverLimit.selector, 0));
        line.draw(0.0001 ether, false);
    }

    function test_zeroOnceTheKeyIsBarredOnTheDesk() public {
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.1 ether);
        assertEq(line.limit(address(acct)), 0.1 ether);
        _barOnDesk(agentA);
        assertEq(line.limit(address(acct)), 0);
        assertEq(line.room(address(acct)), 0);
    }

    function test_zeroOnceTheAccountIsBarredOnTheDesk() public {
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _fund(1 ether);
        // the account draws a pool advance on a job and never delivers
        uint256 id = _lock(address(acct), 0.04 ether, false);
        vm.prank(agentA);
        acct.drawAdvance(id, 0.02 ether, FactorDesk.Kind.Pool);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        desk.refund(id);
        assertTrue(desk.agent(address(acct)).barred);
        assertEq(line.limit(address(acct)), 0);
    }

    function test_aVerifiedOwnerOrAScoreMovesNothing() public {
        // nothing in the contract reads anything but the desk's bond, fees, advances and bars
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        vm.warp(block.timestamp + 300 days);
        assertEq(line.limit(address(acct)), 0.02 ether);
    }

    // ---------- drawing ----------

    function test_aCashDrawToTheWei() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        uint256 potBefore = address(burnPot).balance;
        uint256 keyBefore = agentA.balance;
        vm.expectEmit(address(line));
        emit FactorLine.Drawn(
            address(acct), agentA, 0.01 ether, 0.0001 ether, 0.0001 ether, false, block.timestamp + 30 days
        );
        _lineDraw(agentA, 0.01 ether, false);
        // the rulebook's example: draw 0.0100, the agent receives 0.0098, 0.0001 burned, 0.0001 to the pool
        assertEq(agentA.balance - keyBefore, 0.0098 ether);
        assertEq(address(burnPot).balance - potBefore, 0.0001 ether);
        assertEq(line.pool(), 1 ether - 0.01 ether + 0.0001 ether);
        assertEq(line.out(), 0.01 ether);
        FactorLine.Line memory l = line.line(address(acct));
        assertEq(l.debt, 0.01 ether, "the whole draw is owed");
        assertEq(l.dueAt, block.timestamp + 30 days);
        assertEq(l.draws, 1);
        assertEq(l.drawn, 0.01 ether);
        assertEq(line.totalBurned(), 0.0001 ether);
        assertEq(line.totalFeesToPool(), 0.0001 ether);
        _lineBooks();
    }

    function test_aComputeDrawGoesToTheGatewayNeverTheAgent() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        uint256 keyBefore = agentA.balance;
        uint256 gwBefore = gateway.balance;
        _lineDraw(agentA, 0.01 ether, true);
        assertEq(agentA.balance, keyBefore);
        assertEq(gateway.balance - gwBefore, 0.0098 ether);
        assertEq(line.debtOf(address(acct)), 0.01 ether);
        _lineBooks();
    }

    function test_drawingNeedsALine() public {
        _seed(1 ether);
        vm.prank(agentA);
        vm.expectRevert(FactorLine.NoLine.selector);
        line.draw(0.001 ether, false);
    }

    function test_theSmallestDraw() public {
        _seed(1 ether);
        _open(agentA);
        _lineBond(agentA, 0.02 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.TooSmall.selector, 0.0001 ether));
        line.draw(0.0001 ether - 1, false);
        _lineDraw(agentA, 0.0001 ether, false);
    }

    function test_neverOverTheRoom() public {
        _seed(1 ether);
        _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.015 ether, false);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.OverLimit.selector, 0.005 ether));
        line.draw(0.005 ether + 1, false);
        _lineDraw(agentA, 0.005 ether, false);
        assertEq(line.canDraw(agentA), 0);
    }

    function test_aSecondDrawDoesNotMoveTheDueTime() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.005 ether, false);
        uint256 due = line.line(address(acct)).dueAt;
        vm.warp(block.timestamp + 20 days);
        _lineDraw(agentA, 0.005 ether, false);
        assertEq(line.line(address(acct)).dueAt, due);
    }

    function test_theDueTimeClearsWhenRepaidAndTheNextDrawStartsANewTerm() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.005 ether, false);
        vm.warp(block.timestamp + 10 days);
        _repayFrom(stranger, address(acct), 0.005 ether);
        assertEq(line.line(address(acct)).dueAt, 0);
        vm.warp(block.timestamp + 5 days);
        _lineDraw(agentA, 0.005 ether, false);
        assertEq(line.line(address(acct)).dueAt, block.timestamp + 30 days);
    }

    function test_payingAllButALittleDoesNotMoveTheDueTime() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.01 ether, false);
        uint256 due = line.line(address(acct)).dueAt;
        _repayFrom(stranger, address(acct), 0.01 ether - 1);
        _lineDraw(agentA, 0.005 ether, false);
        assertEq(line.line(address(acct)).dueAt, due);
    }

    function test_feesAreRoundedSoEveryWeiIsCountedOnce() public {
        _seed(1 ether);
        _open(agentA);
        _lineBond(agentA, 0.5 ether);
        uint256 amount = 0.012345678901234567 ether;
        (uint256 fee, uint256 burned, uint256 toPool) = _fee(amount);
        uint256 potBefore = address(burnPot).balance;
        uint256 keyBefore = agentA.balance;
        _lineDraw(agentA, amount, false);
        assertEq(address(burnPot).balance - potBefore, burned);
        assertEq(agentA.balance - keyBefore, amount - fee);
        assertEq(burned + toPool + (amount - fee), amount);
        assertGe(toPool, burned);
        _lineBooks();
    }

    // ---------- counted once with the desk ----------

    function test_aDeskAdvanceToTheAccountLowersTheLinesRoom() public {
        _seed(1 ether);
        _fund(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.03 ether);
        uint256 id = _lock(address(acct), 0.1 ether, false);
        vm.prank(agentA);
        acct.drawAdvance(id, 0.02 ether, FactorDesk.Kind.Pool);
        assertEq(line.room(address(acct)), 0.01 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.OverLimit.selector, 0.01 ether));
        line.draw(0.01 ether + 1, false);
    }

    function test_aLineDrawLowersWhatTheAccountMayTakeFromTheDeskPool() public {
        _seed(1 ether);
        _fund(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.03 ether);
        _lineDraw(agentA, 0.02 ether, false);
        uint256 id = _lock(address(acct), 0.1 ether, true);
        // the desk alone would allow 0.03; the line leaves 0.01
        assertEq(desk.canDraw(address(acct)), 0.03 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.OverLineRoom.selector, 0.01 ether));
        acct.drawAdvance(id, 0.01 ether + 1, FactorDesk.Kind.Pool);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.OverLineRoom.selector, 0.01 ether));
        acct.drawAdvance(id, 0.01 ether + 1, FactorDesk.Kind.Compute);
        // an early advance is the customer's own money and is not held to it
        vm.prank(agentA);
        acct.drawAdvance(id, 0.03 ether, FactorDesk.Kind.Early);
        vm.prank(agentA);
        acct.drawAdvance(id, 0.01 ether, FactorDesk.Kind.Pool);
        assertEq(desk.agent(address(acct)).advancedNow + line.debtOf(address(acct)), 0.03 ether);
    }

    // ---------- paying back ----------

    function test_anyoneCanRepayUpToTheDebt() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.01 ether, false);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.OverDebt.selector, 0.01 ether));
        line.repay{value: 0.01 ether + 1}(address(acct));
        vm.prank(stranger);
        vm.expectRevert(FactorLine.ZeroAmount.selector);
        line.repay{value: 0}(address(acct));
        vm.prank(stranger);
        vm.expectRevert(FactorLine.NoLine.selector);
        line.repay{value: 1}(stranger);
        vm.expectEmit(address(line));
        emit FactorLine.Repaid(address(acct), stranger, 0.004 ether, 0.006 ether, false);
        _repayFrom(stranger, address(acct), 0.004 ether);
        assertEq(line.debtOf(address(acct)), 0.006 ether);
        assertEq(line.out(), 0.006 ether);
        assertEq(line.totalRepaid(), 0.004 ether);
        _lineBooks();
    }

    function test_incomeRepaysTheLineFirstAndTheAgentWithdrawsOnlyTheRest() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.01 ether, false);
        // a job pays 0.0098 into the account (0.01 less the 2% job fee): less than the debt
        _earn(agentA, 0.01 ether);
        assertEq(address(acct).balance, 0.0098 ether);
        assertEq(acct.free(), 0);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.Owes.selector, 0.0002 ether));
        acct.withdraw(payable(agentA), 1);
        // the failed withdrawal undid its sweep; anyone sweeps
        vm.prank(stranger);
        assertEq(acct.sweep(), 0.0098 ether);
        assertEq(line.debtOf(address(acct)), 0.0002 ether);
        // the next job clears it and the rest is the agent's
        _earn(agentA, 0.01 ether);
        assertEq(acct.free(), 0.0098 ether - 0.0002 ether);
        uint256 before = agentA.balance;
        vm.prank(agentA);
        acct.withdraw(payable(agentA), 0.0096 ether);
        assertEq(agentA.balance - before, 0.0096 ether);
        assertEq(line.debtOf(address(acct)), 0, "the withdrawal swept first");
        assertEq(line.line(address(acct)).onTime, 1);
        assertEq(address(acct).balance, 0);
        _lineBooks();
    }

    function test_withdrawNeedsTheKeyAndAnAddress() public {
        FactorLineAccount acct = _open(agentA);
        vm.deal(address(acct), 1 ether);
        vm.prank(stranger);
        vm.expectRevert(FactorLineAccount.NotKey.selector);
        acct.withdraw(payable(stranger), 1);
        vm.prank(agentA);
        vm.expectRevert(FactorLineAccount.ZeroAddress.selector);
        acct.withdraw(payable(address(0)), 1);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.NotFree.selector, 1 ether));
        acct.withdraw(payable(agentA), 1 ether + 1);
        vm.prank(agentA);
        acct.withdraw(payable(other), 1 ether);
        assertEq(other.balance, 1 ether);
    }

    function test_repaidByTheDueTimeIsOnTimeAndOneSecondLaterIsLate() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.01 ether, false);
        vm.warp(line.line(address(acct)).dueAt);
        assertFalse(line.isLate(address(acct)));
        _repayFrom(stranger, address(acct), 0.01 ether);
        assertEq(line.line(address(acct)).onTime, 1);
        _lineDraw(agentA, 0.01 ether, false);
        vm.warp(uint256(line.line(address(acct)).dueAt) + 1);
        assertTrue(line.isLate(address(acct)));
        vm.expectEmit(address(line));
        emit FactorLine.Repaid(address(acct), stranger, 0.01 ether, 0, true);
        _repayFrom(stranger, address(acct), 0.01 ether);
        FactorLine.Line memory l = line.line(address(acct));
        assertEq(l.onTime, 1);
        assertEq(l.late, 1);
        assertFalse(line.isLate(address(acct)));
    }

    function test_aLateLineCannotDrawUntilRepaid() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.005 ether, false);
        uint256 due = line.line(address(acct)).dueAt;
        vm.warp(due + 1);
        assertEq(line.room(address(acct)), 0);
        assertEq(line.canDraw(agentA), 0);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.IsLate.selector, due));
        line.draw(0.001 ether, false);
        // and its own pool advances from the desk wait too
        _fund(1 ether);
        uint256 id = _lock(address(acct), 0.1 ether, false);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.OverLineRoom.selector, 0));
        acct.drawAdvance(id, 0.001 ether, FactorDesk.Kind.Pool);
        _repayFrom(stranger, address(acct), 0.005 ether);
        _lineDraw(agentA, 0.001 ether, false);
    }

    // ---------- default ----------

    function test_recoverWaitsThirtyDaysPastTheDueTime() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.01 ether, false);
        uint256 at = uint256(line.line(address(acct)).dueAt) + 30 days;
        vm.warp(at);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.TooSoon.selector, at + 1));
        line.recover(address(acct));
        vm.expectRevert(FactorLine.NoLine.selector);
        line.recover(stranger);
    }

    function test_recoverTakesTheBondAndALineItCoversIsLateNotDefaulted() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.01 ether, false);
        vm.warp(uint256(line.line(address(acct)).dueAt) + 30 days + 1);
        vm.prank(stranger);
        line.recover(address(acct));
        FactorLine.Line memory l = line.line(address(acct));
        assertEq(l.debt, 0);
        assertFalse(l.defaulted);
        assertEq(l.late, 1);
        assertEq(desk.agent(address(acct)).bond, 0.01 ether, "only what was owed was taken");
        assertEq(line.lost(), 0);
        vm.expectRevert(FactorLine.NothingOwed.selector);
        line.recover(address(acct));
        _lineBooks();
    }

    function test_recoverUsesTheAccountsEthFirst() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.01 ether, false);
        vm.deal(address(acct), 0.004 ether);
        vm.warp(uint256(line.line(address(acct)).dueAt) + 30 days + 1);
        line.recover(address(acct));
        assertEq(desk.agent(address(acct)).bond, 0.014 ether);
        assertEq(line.debtOf(address(acct)), 0);
    }

    function test_whatIsNotCoveredDefaultsForGood() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _earn(agentA, 1 ether); // 0.02 in fees, and 0.98 paid into the account
        vm.prank(agentA);
        acct.withdraw(payable(agentA), 0.98 ether);
        _lineBond(agentA, 0.005 ether);
        _lineDraw(agentA, 0.025 ether, false);
        vm.warp(uint256(line.line(address(acct)).dueAt) + 30 days + 1);
        vm.expectEmit(address(line));
        emit FactorLine.Defaulted(address(acct), agentA, 0.02 ether);
        line.recover(address(acct));
        FactorLine.Line memory l = line.line(address(acct));
        assertTrue(l.defaulted);
        assertEq(l.debt, 0.02 ether, "still owed");
        assertEq(line.out(), 0);
        assertEq(line.lost(), 0.02 ether);
        assertEq(desk.agent(address(acct)).bond, 0);
        assertEq(line.limit(address(acct)), 0);
        assertEq(line.canDraw(agentA), 0);
        vm.prank(agentA);
        vm.expectRevert(FactorLine.IsDefaulted.selector);
        line.draw(0.001 ether, false);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.HasLine.selector, address(acct)));
        line.open();
        _lineBooks();
    }

    function test_aDefaultedLineStillOwesAndWhatComesInIsRecovered() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.01 ether);
        _lineDraw(agentA, 0.01 ether, false);
        // the bond is busy with a desk advance when the line is recovered, so it stays on the desk
        _fund(1 ether);
        uint256 id = _lock(address(acct), 1 ether, false);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.OverLineRoom.selector, 0));
        acct.drawAdvance(id, 0.001 ether, FactorDesk.Kind.Pool);
        vm.warp(uint256(line.line(address(acct)).dueAt) + 30 days + 1);
        // the job above was never delivered: it is refunded first, and the bond is still there
        desk.refund(id);
        line.recover(address(acct));
        assertEq(line.debtOf(address(acct)), 0, "the free bond paid it");
        // now a line that defaults, then income
        address agentC = makeAddr("agent c");
        vm.prank(agentC);
        desk.register();
        FactorLineAccount c = _open(agentC);
        _earn(agentC, 0.5 ether);
        vm.prank(agentC);
        c.withdraw(payable(agentC), 0.49 ether);
        _lineDraw(agentC, 0.01 ether, false);
        vm.warp(uint256(line.line(address(c)).dueAt) + 30 days + 1);
        line.recover(address(c));
        assertTrue(line.line(address(c)).defaulted);
        assertEq(line.lost(), 0.01 ether);
        // a customer still hires it, the payout lands in the account and anyone sweeps it into the line
        _earn(agentC, 0.004 ether);
        c.sweep();
        assertEq(line.lost(), 0.01 ether - 0.00392 ether);
        assertEq(line.totalRecovered(), 0.00392 ether);
        assertEq(line.debtOf(address(c)), 0.01 ether - 0.00392 ether);
        // recover can be called again; with nothing to take it changes nothing
        line.recover(address(c));
        assertEq(line.debtOf(address(c)), 0.01 ether - 0.00392 ether);
        _lineBooks();
    }

    function test_recoverLeavesTheBondToTheDeskWhileTheDeskHasAnAdvanceOut() public {
        _seed(1 ether);
        _fund(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.1 ether);
        // the desk advances the account as compute on a job that is never delivered, and nobody refunds it yet
        uint256 id = _lock(address(acct), 1 ether, false);
        vm.prank(agentA);
        acct.drawAdvance(id, 0.05 ether, FactorDesk.Kind.Compute);
        _lineDraw(agentA, 0.05 ether, false);
        vm.warp(block.timestamp + 61 days);
        // recover goes through: the bond stays on the desk for the desk's own advance, and the line defaults
        line.recover(address(acct));
        assertTrue(line.line(address(acct)).defaulted);
        assertEq(desk.agent(address(acct)).bond, 0.1 ether);
        // once the desk has its refund, the bond's rest is free and recovering again takes it
        desk.refund(id);
        line.recover(address(acct));
        assertEq(line.debtOf(address(acct)), 0);
        assertEq(desk.agent(address(acct)).bond, 0);
        assertEq(line.lost(), 0);
        _lineBooks();
    }

    function test_recoverBringsHomeWhatTheDeskOwesTheAccount() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.01 ether, false);
        uint256 id = _lock(address(acct), 0.01 ether, false);
        vm.prank(agentA);
        acct.deliver(id, keccak256("w"));
        // the account's receive never refuses, so for this one test it is swapped for code that does, to leave a
        // payout owed on the desk, and put back
        bytes memory code = address(acct).code;
        vm.etch(address(acct), hex"5f5ffd");
        vm.prank(customer);
        desk.accept(id);
        vm.etch(address(acct), code);
        assertEq(desk.owed(address(acct)), 0.0098 ether);
        vm.warp(uint256(line.line(address(acct)).dueAt) + 30 days + 1);
        line.recover(address(acct));
        assertEq(desk.owed(address(acct)), 0);
        assertEq(line.debtOf(address(acct)), 0);
        assertEq(
            desk.agent(address(acct)).bond, 0.02 ether - 0.0002 ether, "the bond paid only what the payout did not"
        );
    }

    // ---------- the account ----------

    function test_onlyTheKeyRunsTheAccount() public {
        FactorLineAccount acct = _open(agentA);
        vm.deal(stranger, 1 ether);
        vm.startPrank(stranger);
        vm.expectRevert(FactorLineAccount.NotKey.selector);
        acct.addBond{value: 1}(0);
        vm.expectRevert(FactorLineAccount.NotKey.selector);
        acct.takeBond(1);
        vm.expectRevert(FactorLineAccount.NotKey.selector);
        acct.drawAdvance(1, 1, FactorDesk.Kind.Early);
        vm.expectRevert(FactorLineAccount.NotKey.selector);
        acct.deliver(1, bytes32(0));
        vm.expectRevert(FactorLineAccount.NotKey.selector);
        acct.decline(1);
        vm.expectRevert(FactorLineAccount.NotKey.selector);
        acct.lock{value: 0.01 ether}(agentB, block.timestamp + 1 days, false, 0);
        vm.expectRevert(FactorLineAccount.NotKey.selector);
        acct.accept(1);
        vm.expectRevert(FactorLineAccount.NotKey.selector);
        acct.reject(1);
        vm.expectRevert(FactorLineAccount.OnlyLine.selector);
        acct.releaseBond(1);
        vm.stopPrank();
    }

    function test_theAccountHasNoOtherDoor() public {
        FactorLineAccount acct = _open(agentA);
        vm.deal(address(acct), 1 ether);
        // the desk's collectTo would send the account's money elsewhere: there is no way to ask for it
        vm.prank(agentA);
        (bool ok,) = address(acct).call(abi.encodeCall(FactorDesk.collectTo, (payable(agentA))));
        assertFalse(ok);
        vm.prank(agentA);
        (ok,) = address(acct).call(abi.encodeWithSignature("execute(address,uint256,bytes)", agentA, 1 ether, ""));
        assertFalse(ok);
        assertEq(address(acct).balance, 1 ether);
    }

    function test_theBondStaysWhileTheLineOwes() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.001 ether, false);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.Owes.selector, 0.001 ether));
        acct.takeBond(0.01 ether);
        _repayFrom(stranger, address(acct), 0.001 ether);
        vm.prank(agentA);
        acct.takeBond(0.02 ether);
        assertEq(address(acct).balance, 0.02 ether, "back in the account, the agent's to withdraw");
    }

    function test_theAccountSpendsOnlyWhatItDoesNotOwe() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.02 ether);
        _lineDraw(agentA, 0.01 ether, false);
        vm.deal(address(acct), 0.015 ether);
        assertEq(acct.free(), 0.005 ether);
        vm.startPrank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.NotFree.selector, 0.005 ether));
        acct.addBond(0.005 ether + 1);
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.NotFree.selector, 0.005 ether));
        acct.lock(agentB, block.timestamp + 1 days, false, 0.005 ether + 1);
        acct.addBond(0.005 ether);
        vm.stopPrank();
        assertEq(desk.agent(address(acct)).bond, 0.025 ether);
        // what the key sends with the call is its own fresh ETH, not income: it is not swept
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        uint256 id = acct.lock{value: 0.01 ether}(agentB, block.timestamp + 1 days, false, 0);
        assertEq(desk.job(id).customer, address(acct));
        assertEq(address(acct).balance, 0.01 ether, "only the line's 0.01 is left");
        assertEq(acct.free(), 0);
    }

    function test_theAccountHiresAnotherAgentAndGetsHalfBackOnARejection() public {
        FactorLineAccount acct = _open(agentA);
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        uint256 id = acct.lock{value: 0.02 ether}(agentB, block.timestamp + 1 days, false, 0);
        _deliver(agentB, id);
        vm.prank(agentA);
        acct.reject(id);
        assertEq(address(acct).balance, 0.01 ether);
        vm.prank(agentA);
        id = acct.lock{value: 0.01 ether}(agentB, block.timestamp + 1 days, false, 0);
        _deliver(agentB, id);
        vm.prank(agentA);
        acct.accept(id);
        assertEq(desk.job(id).state == FactorDesk.State.Settled, true);
    }

    function test_theAccountDeclinesAndDrawsEarly() public {
        FactorLineAccount acct = _open(agentA);
        uint256 id = _lock(address(acct), 0.02 ether, true);
        vm.prank(agentA);
        acct.drawAdvance(id, 0.01 ether, FactorDesk.Kind.Early);
        assertEq(address(acct).balance, 0.0099 ether);
        uint256 id2 = _lock(address(acct), 0.02 ether, false);
        vm.prank(agentA);
        acct.decline(id2);
        assertEq(uint8(desk.job(id2).state), uint8(FactorDesk.State.Declined));
    }

    function test_anyoneCollectsWhatTheDeskOwesTheAccountAndOnlyTheLineReleasesItsBond() public {
        FactorLineAccount acct = _open(agentA);
        vm.expectRevert(FactorDesk.NothingOwed.selector);
        acct.collect();
        _lineBond(agentA, 0.01 ether);
        vm.prank(agentA);
        vm.expectRevert(FactorLineAccount.OnlyLine.selector);
        acct.releaseBond(0.01 ether);
        // the line asking for nothing, or with the bond empty, does nothing
        vm.prank(address(line));
        acct.releaseBond(0);
        assertEq(desk.agent(address(acct)).bond, 0.01 ether);
    }

    function test_theKeysSignatureIsTheAccounts() public {
        (address keyAddr, uint256 pk) = makeAddrAndKey("a key that signs");
        vm.prank(keyAddr);
        desk.register();
        FactorLineAccount acct = _open(keyAddr);
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(bytes("Factor compute key\naddress: 0x..."));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        assertEq(acct.isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
        (, uint256 otherPk) = makeAddrAndKey("somebody else");
        (v, r, s) = vm.sign(otherPk, hash);
        assertEq(acct.isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
        assertEq(acct.isValidSignature(hash, hex"00"), bytes4(0xffffffff));
    }

    function test_aFactorAccountKeysSignatureIsTheLineAccountsToo() public {
        (address walletKey, uint256 pk) = makeAddrAndKey("a passkey account's wallet key that signs");
        FactorAccount.Key memory first =
            FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(uint256(uint160(walletKey))), bytes32(0));
        address payable fa = payable(accounts.create(first, ""));
        FactorAccount.Call[] memory calls = new FactorAccount.Call[](2);
        calls[0] = FactorAccount.Call(address(desk), 0, abi.encodeCall(FactorDesk.register, ()));
        calls[1] = FactorAccount.Call(address(line), 0, abi.encodeCall(FactorLine.open, ()));
        vm.prank(walletKey);
        FactorAccount(fa).run(calls);
        bytes32 hash = keccak256("a text");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        assertEq(_acct(fa).isValidSignature(hash, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
    }

    // ---------- payouts a wallet refuses ----------

    function test_aKeyThatRefusesEthHasItsDrawKeptAsOwed() public {
        _seed(1 ether);
        RefusingKey k = new RefusingKey(desk, line);
        k.register();
        k.open();
        vm.deal(address(this), 1 ether);
        k.addBond{value: 0.02 ether}(0);
        k.draw(0.01 ether, false);
        assertEq(line.owed(address(k)), 0.0098 ether);
        assertEq(line.owedTotal(), 0.0098 ether);
        assertEq(line.debtOf(line.accountOf(address(k))), 0.01 ether, "the debt stands");
        _lineBooks();
        vm.expectRevert(FactorLine.PushFailed.selector);
        line.collect(address(k));
        k.collectTo(payable(other));
        assertEq(other.balance, 0.0098 ether);
        assertEq(line.owedTotal(), 0);
        vm.expectRevert(FactorLine.NothingOwed.selector);
        k.collectTo(payable(other));
        vm.expectRevert(FactorLine.ZeroAddress.selector);
        k.collectTo(payable(address(0)));
        _lineBooks();
    }

    function test_aKeyThatEatsGasCannotStopItsOwnDraw() public {
        _seed(1 ether);
        GasEatingKey k = new GasEatingKey(desk, line);
        k.register();
        k.open();
        vm.deal(address(this), 1 ether);
        k.addBond{value: 0.02 ether}();
        k.draw(0.01 ether, false);
        assertEq(line.owed(address(k)), 0.0098 ether);
        _lineBooks();
    }

    function test_aDrawWithTooLittleGasIsRefusedWhole() public {
        _seed(1 ether);
        _open(agentA);
        _lineBond(agentA, 0.02 ether);
        vm.prank(agentA);
        (bool ok,) = address(line).call{gas: 150_000}(abi.encodeCall(FactorLine.draw, (0.01 ether, false)));
        assertFalse(ok);
        assertEq(line.debtOf(line.accountOf(agentA)), 0);
        assertEq(line.owedTotal(), 0);
    }

    // ---------- fuzzed ----------

    /// Any draw: the agent receives 98%, the burn and the pool share the rest, the whole of it is owed, every wei once.
    function testFuzz_anyDrawSplitsToTheWei(uint256 amount, bool compute) public {
        _seed(100 ether);
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 100 ether);
        amount = bound(amount, line.MIN_DRAW(), line.canDraw(agentA));
        (uint256 fee, uint256 burned, uint256 toPool) = _fee(amount);
        address to = compute ? gateway : agentA;
        uint256 toBefore = to.balance;
        uint256 potBefore = address(burnPot).balance;
        uint256 poolBefore = line.pool();
        _lineDraw(agentA, amount, compute);
        assertEq(to.balance - toBefore, amount - fee);
        assertEq(address(burnPot).balance - potBefore, burned);
        assertEq(poolBefore - line.pool(), amount - toPool);
        assertEq(line.debtOf(address(acct)), amount);
        _lineBooks();
    }

    /// Any bond, any fees, any desk advance, any line draw: together never more than bond + fees.
    function testFuzz_countedOnceWhateverTheOrder(uint256 bond, uint256 price, uint256 deskPart, bool deskFirst)
        public
    {
        _seed(100 ether);
        _fund(100 ether);
        FactorLineAccount acct = _open(agentA);
        bond = bound(bond, 0, 5 ether);
        price = bound(price, 0.001 ether, 50 ether);
        if (bond > 0) _lineBond(agentA, bond);
        _earn(agentA, price);
        uint256 cap = bond + desk.agent(address(acct)).feesPaid;
        uint256 id = _lock(address(acct), 100 ether, false);
        deskPart = bound(deskPart, 0, cap);
        if (deskFirst) {
            if (deskPart > 0) {
                vm.prank(agentA);
                acct.drawAdvance(id, deskPart, FactorDesk.Kind.Pool);
            }
            uint256 can = line.canDraw(agentA);
            assertEq(can, cap - deskPart);
            if (can >= line.MIN_DRAW()) _lineDraw(agentA, can, false);
        } else {
            uint256 lineFirst = cap - deskPart;
            if (lineFirst >= line.MIN_DRAW()) _lineDraw(agentA, lineFirst, false);
            uint256 r = line.room(address(acct));
            if (r > 0) {
                vm.prank(agentA);
                acct.drawAdvance(id, r, FactorDesk.Kind.Pool);
            }
            vm.prank(agentA);
            vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.OverLineRoom.selector, 0));
            acct.drawAdvance(id, 1, FactorDesk.Kind.Pool);
        }
        assertLe(desk.agent(address(acct)).advancedNow + line.debtOf(address(acct)), cap);
    }

    // ---------- helpers ----------

    function _repayFrom(address from, address account, uint256 amount) internal {
        vm.deal(from, from.balance + amount);
        vm.prank(from);
        line.repay{value: amount}(account);
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
}
