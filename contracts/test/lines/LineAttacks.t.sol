// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LineBase, ReenteringKey, GasEatingKey} from "./LineBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";

/// Every attack in section 9 of docs/CREDIT-LINES.md, carried out against the line and the desk together.
contract LineAttacksTest is LineBase {
    address internal attacker = makeAddr("attacker");
    address internal sockPuppet = makeAddr("the attacker's second wallet");

    function setUp() public override {
        super.setUp();
        vm.prank(attacker);
        desk.register();
        _seed(10 ether);
        _fund(10 ether);
    }

    /// 1. Hire yourself to build a limit, draw it all, and never repay. The attacker ends below where it started and
    ///    the line pool loses no more than the fees the attacker paid into the desk's pool.
    function test_attack1_sybilFakeJobsCostMoreThanTheyTake() public {
        FactorLineAccount acct = _open(attacker);
        uint256 start = attacker.balance + sockPuppet.balance;
        // the five locks below are paid with 5 ETH the test hands the second wallet
        uint256 injected = 5 ether;
        uint256 deskPoolBefore = desk.pool();
        for (uint256 i = 0; i < 5; ++i) {
            _earnFrom(sockPuppet, attacker, 1 ether);
            vm.prank(attacker);
            acct.withdraw(payable(attacker), address(acct).balance);
        }
        uint256 feesPaid = desk.agent(address(acct)).feesPaid;
        assertEq(feesPaid, 0.1 ether);
        assertEq(desk.pool() - deskPoolBefore, feesPaid, "every fee went into the desk's pool");
        uint256 can = line.canDraw(attacker);
        assertEq(can, 0.1 ether);
        _lineDraw(attacker, can, false);
        vm.warp(block.timestamp + 61 days);
        line.recover(address(acct));
        assertTrue(line.line(address(acct)).defaulted);
        uint256 end = attacker.balance + sockPuppet.balance;
        assertLt(end, start + injected, "the attacker is poorer");
        assertEq(start + injected - end, feesPaid - (can - (can * 200) / 10_000), "it lost the fees, less what it drew");
        assertLe(line.lost(), feesPaid, "the line pool lost no more than the fees paid into the desk's pool");
        _lineBooks();
        _books();
    }

    /// 2. The same bond and fees behind a desk advance and a line draw: refused in both orders.
    function test_attack2_theSameFeesCannotBackTwoLoans() public {
        FactorLineAccount acct = _open(attacker);
        _lineBond(attacker, 0.1 ether);
        uint256 id = _lockFrom(sockPuppet, address(acct), 1 ether, false);
        // line first, then the desk
        _lineDraw(attacker, 0.1 ether, false);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.OverLineRoom.selector, 0));
        acct.drawAdvance(id, 0.0001 ether, FactorDesk.Kind.Pool);
        // the desk first, then the line (another agent)
        address b = makeAddr("attacker b");
        vm.prank(b);
        desk.register();
        FactorLineAccount acctB = _open(b);
        _lineBond(b, 0.1 ether);
        uint256 idB = _lockFrom(sockPuppet, address(acctB), 1 ether, false);
        vm.prank(b);
        acctB.drawAdvance(idB, 0.1 ether, FactorDesk.Kind.Compute);
        vm.prank(b);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.OverLimit.selector, 0));
        line.draw(0.0001 ether, false);
        // and around the account, straight on the desk: the desk only lends to its own caller, never the account's
        vm.prank(b);
        vm.expectRevert(FactorDesk.NotAgent.selector);
        desk.draw(idB, 0.0001 ether, FactorDesk.Kind.Pool);
    }

    /// 3. The old address borrows on the desk against its own record while the new one would borrow on the line
    ///    against the same record. The line does not count the old record, so the pair takes nothing from the line.
    function test_attack3_theOldAddressCannotBorrowTwiceOnItsRecord() public {
        // the old address builds 0.1 of fees by hiring itself, and a 0.05 bond
        for (uint256 i = 0; i < 5; ++i) {
            uint256 j = _lockFrom(sockPuppet, attacker, 1 ether, false);
            _deliver(attacker, j);
            vm.prank(sockPuppet);
            desk.accept(j);
        }
        _bond(attacker, 0.05 ether);
        assertEq(desk.limit(attacker), 0.15 ether);
        FactorLineAccount acct = _open(attacker);
        assertEq(line.canDraw(attacker), 0, "nothing on the line from the old record");
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.OverLimit.selector, 0));
        line.draw(0.1 ether, false);
        // the old address can still use its record on the desk, as it always could, and nothing more
        uint256 id = _lockFrom(sockPuppet, attacker, 1 ether, false);
        _draw(attacker, id, 0.15 ether, FactorDesk.Kind.Pool);
        assertEq(line.out(), 0);
        assertEq(address(acct).balance, 0);
    }

    /// 4. Many lines at once cannot take more than 80% of the pool.
    function test_attack4_manyLinesCannotDrainThePool() public {
        uint256 poolStart = line.pool();
        for (uint256 i = 0; i < 12; ++i) {
            address k = makeAddr(string.concat("drainer ", vm.toString(i)));
            vm.prank(k);
            desk.register();
            _open(k);
            _lineBond(k, 1 ether);
            uint256 can = line.canDraw(k);
            if (can >= line.MIN_DRAW()) _lineDraw(k, can, false);
        }
        assertLe(line.out(), ((line.pool() + line.out()) * 8000) / 10_000, "never more than 80% out");
        assertGe(line.pool(), poolStart / 5, "a fifth stays");
        _lineBooks();
    }

    /// 5. Take the bond out, then default: the account will not let the bond leave while the line owes.
    function test_attack5_theBondCannotLeaveBeforeADefault() public {
        FactorLineAccount acct = _open(attacker);
        _lineBond(attacker, 0.1 ether);
        _lineDraw(attacker, 0.1 ether, false);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.Owes.selector, 0.1 ether));
        acct.takeBond(0.1 ether);
        // and no way around it: the account is the agent on the desk, not the key
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.OverBond.selector, 0));
        desk.takeBond(0.1 ether);
        vm.warp(block.timestamp + 61 days);
        line.recover(address(acct));
        assertEq(line.debtOf(address(acct)), 0, "the bond paid it");
        assertEq(line.lost(), 0);
    }

    /// 6. A bond made of a flash loan cannot be paid back out of the account in the same transaction (or later).
    function test_attack6_aFlashLoanedBondIsStuck() public {
        FlashBorrower fb = new FlashBorrower(desk, line);
        fb.register();
        fb.open();
        vm.deal(address(fb), 1 ether); // the "loan"
        bool repaidLoan = fb.attack(1 ether);
        assertFalse(repaidLoan, "the loan cannot be repaid from the bond");
    }

    /// 7. Diverting income: every way out of the account goes through the line first.
    function test_attack7_incomeCannotBeDiverted() public {
        FactorLineAccount acct = _open(attacker);
        _lineBond(attacker, 0.1 ether);
        _lineDraw(attacker, 0.1 ether, false);
        _earnFrom(sockPuppet, attacker, 0.05 ether);
        uint256 income = address(acct).balance;
        assertGt(income, 0);
        vm.startPrank(attacker);
        // to another agent through a lock from income
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.NotFree.selector, 0));
        acct.lock(sockPuppet, block.timestamp + 1 days, false, income);
        // into the bond, to take later
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.NotFree.selector, 0));
        acct.addBond(income);
        // straight out
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.Owes.selector, 0.1 ether - income));
        acct.withdraw(payable(attacker), 1);
        vm.stopPrank();
        assertEq(address(acct).balance, income);
        acct.sweep();
        assertEq(line.debtOf(address(acct)), 0.1 ether - income);
    }

    /// 8. Withdrawing before the line sees the income: the withdrawal sweeps first.
    function test_attack8_aWithdrawalSweepsFirst() public {
        FactorLineAccount acct = _open(attacker);
        _lineBond(attacker, 0.1 ether);
        _lineDraw(attacker, 0.01 ether, false);
        _earnFrom(sockPuppet, attacker, 0.05 ether); // 0.049 in
        vm.prank(attacker);
        acct.withdraw(payable(attacker), 0.039 ether);
        assertEq(line.debtOf(address(acct)), 0);
        assertEq(address(acct).balance, 0);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(FactorLineAccount.NotFree.selector, 0));
        acct.withdraw(payable(attacker), 1);
    }

    /// 9. A key that calls back in when its cash arrives, or when an owed payout is collected for it.
    function test_attack9_reentryChangesNothing() public {
        ReenteringKey k = new ReenteringKey(desk, line);
        k.register();
        k.open();
        vm.deal(address(this), 1 ether);
        k.addBond{value: 0.1 ether}();
        k.draw(0.01 ether, false);
        // the bounded push starves its callback; the cash waits as owed
        uint256 owed = line.owed(address(k));
        uint256 debt = line.debtOf(line.accountOf(address(k)));
        assertEq(debt, 0.01 ether);
        // collected with all the gas it wants: its draw inside the collection is refused by the guard
        if (owed > 0) line.collect(address(k));
        assertFalse(k.drewAgain(), "no second draw from inside the first");
        assertFalse(k.withdrew(), "nothing withdrawn while the line owes");
        assertEq(line.debtOf(line.accountOf(address(k))), 0.01 ether);
        _lineBooks();
    }

    /// 10. Front-running: nobody can open a line for someone else, take its address, or make its account.
    function test_attack10_nobodyCanOpenOrMakeSomeoneElsesLine() public {
        address predicted = line.accountAddress(agentA);
        // the stranger opening "first" opens nothing of agent a's
        vm.prank(stranger);
        vm.expectRevert(FactorLine.NotRegistered.selector);
        line.open();
        // sending ETH to where the account will be is a gift to it
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = predicted.call{value: 0.01 ether}("");
        assertTrue(ok);
        FactorLineAccount acct = _open(agentA);
        assertEq(address(acct), predicted);
        assertEq(acct.key(), agentA);
        assertEq(acct.free(), 0.01 ether, "the gift is the agent's");
    }

    /// 11. Griefing the account: dust ETH repays it, dust jobs leave no mark, sweep and collect only move ETH home.
    function test_attack11_griefingTheAccountDoesNoHarm() public {
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.1 ether);
        _lineDraw(agentA, 0.01 ether, false);
        vm.deal(stranger, 1 ether);
        vm.startPrank(stranger);
        (bool ok,) = address(acct).call{value: 1}("");
        assertTrue(ok);
        acct.sweep();
        acct.sweep();
        vm.stopPrank();
        assertEq(line.debtOf(address(acct)), 0.01 ether - 1);
        // a dust job the agent never answers comes back to its customer and leaves no mark
        uint256 id = _lockFrom(stranger, address(acct), 0.001 ether, false);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        desk.refund(id);
        FactorDesk.Agent memory a = desk.agent(address(acct));
        assertFalse(a.barred);
        assertEq(a.unanswered, 1);
        assertEq(a.notDelivered, 0);
        assertGt(line.canDraw(agentA), 0, "the line still draws");
    }

    /// 12. Moving the record: a barred agent cannot open a line, and a line is linked for good.
    function test_attack12_aRecordCannotBeMoved() public {
        // agent b borrows on the desk and runs: barred
        _bond(agentB, 0.001 ether);
        uint256 id = _lock(agentB, 0.01 ether, false);
        _draw(agentB, id, 0.001 ether, FactorDesk.Kind.Pool);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        desk.refund(id);
        vm.prank(agentB);
        vm.expectRevert(FactorLine.Barred.selector);
        line.open();
        // agent a's link cannot be made again or pointed elsewhere
        FactorLineAccount acct = _open(agentA);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.HasLine.selector, address(acct)));
        line.open();
        assertEq(line.keyOf(address(acct)), agentA);
    }

    /// 13. Rolling the debt: draw, pay most of it, draw again. The due time does not move.
    function test_attack13_theDebtCannotBeRolled() public {
        FactorLineAccount acct = _open(attacker);
        _lineBond(attacker, 0.1 ether);
        _lineDraw(attacker, 0.05 ether, false);
        uint256 due = line.line(address(acct)).dueAt;
        for (uint256 i = 0; i < 5; ++i) {
            vm.warp(block.timestamp + 5 days);
            uint256 d = line.debtOf(address(acct));
            vm.deal(attacker, attacker.balance + d);
            vm.prank(attacker);
            line.repay{value: d - 1}(address(acct));
            _lineDraw(attacker, 0.01 ether, false);
            assertEq(line.line(address(acct)).dueAt, due);
        }
        vm.warp(due + 1);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(FactorLine.IsLate.selector, due));
        line.draw(0.01 ether, false);
    }

    /// 14. Many dust draws to keep the fee at zero: the smallest draw pays a fee of 2 thousandths of a cent's worth,
    ///     never zero, and every wei is accounted for.
    function test_attack14_dustDrawsPayTheirFees() public {
        _open(attacker);
        _lineBond(attacker, 1 ether);
        uint256 burnedBefore = line.totalBurned();
        for (uint256 i = 0; i < 50; ++i) {
            _lineDraw(attacker, line.MIN_DRAW(), false);
        }
        assertEq(line.totalBurned() - burnedBefore, 50 * (line.MIN_DRAW() / 100));
        assertGt(line.MIN_DRAW() / 100, 0);
        _lineBooks();
    }

    /// 15. A seed is no claim: the seeder cannot take its seed back, and seeding does not raise anyone's limit.
    function test_attack15_aSeedIsNoClaim() public {
        _open(agentA);
        assertEq(line.canDraw(agentA), 0);
        _seed(5 ether);
        assertEq(line.canDraw(agentA), 0, "a bigger pool is no bigger limit");
        vm.prank(seeder);
        vm.expectRevert(FactorLine.NothingOwed.selector);
        line.collectTo(payable(seeder));
    }

    /// 16. A compute draw never reaches the agent.
    function test_attack16_computeIsNeverCash() public {
        FactorLineAccount acct = _open(attacker);
        _lineBond(attacker, 0.1 ether);
        uint256 a = attacker.balance;
        uint256 acctBal = address(acct).balance;
        _lineDraw(attacker, 0.05 ether, true);
        assertEq(attacker.balance, a);
        assertEq(address(acct).balance, acctBal);
        assertEq(gateway.balance, 0.049 ether);
    }

    /// 17. Defaulting does not wipe the debt: what the account earns afterwards still repays it.
    function test_attack17_aDefaultWipesNothing() public {
        FactorLineAccount acct = _open(attacker);
        _earnFrom(sockPuppet, attacker, 1 ether);
        vm.prank(attacker);
        acct.withdraw(payable(attacker), address(acct).balance);
        _lineDraw(attacker, 0.02 ether, false);
        vm.warp(block.timestamp + 61 days);
        line.recover(address(acct));
        assertTrue(line.line(address(acct)).defaulted);
        _earnFrom(sockPuppet, attacker, 1 ether);
        // the agent wants its pay: the withdrawal pays the defaulted line first
        uint256 before = attacker.balance;
        vm.prank(attacker);
        acct.withdraw(payable(attacker), 0.96 ether);
        assertEq(attacker.balance - before, 0.96 ether);
        assertEq(address(acct).balance, 0);
        assertEq(line.debtOf(address(acct)), 0);
        assertEq(line.lost(), 0);
        assertEq(line.totalRecovered(), 0.02 ether);
        assertTrue(line.line(address(acct)).defaulted, "still barred for good");
        assertEq(line.canDraw(attacker), 0);
        _lineBooks();
    }

    /// 18. A key that eats gas or refuses ETH cannot block its own draw, a repayment, a sweep or a recovery.
    function test_attack18_aHostileKeyBlocksNothing() public {
        GasEatingKey k = new GasEatingKey(desk, line);
        k.register();
        k.open();
        vm.deal(address(this), 1 ether);
        k.addBond{value: 0.02 ether}();
        k.draw(0.01 ether, false);
        assertEq(line.owed(address(k)), 0.0098 ether, "its cash waits as owed");
        address acct = line.accountOf(address(k));
        _earn(address(k), 0.005 ether);
        FactorLineAccount(payable(acct)).sweep();
        vm.warp(block.timestamp + 61 days);
        line.recover(acct);
        assertEq(line.debtOf(acct), 0, "its own ETH and its bond paid the line");
        _lineBooks();
    }

    /// 20. The desk and the line both default on one account: together they lose no more than the fees its jobs paid
    ///     into the desk's pool, because the bond covers the desk first and then what is left of it pays the line.
    function test_attack20_bothDefaultingLosesAtMostTheFeesPaid() public {
        FactorLineAccount acct = _open(attacker);
        _earnFrom(sockPuppet, attacker, 2.5 ether); // 0.05 of fees
        vm.prank(attacker);
        acct.withdraw(payable(attacker), address(acct).balance);
        _lineBond(attacker, 0.1 ether);
        uint256 fees = desk.agent(address(acct)).feesPaid;
        assertEq(fees, 0.05 ether);
        uint256 deskLostBefore = desk.totalLost();
        // half of bond + fees from the desk, the other half from the line. The desk's half is taken as compute: a pool
        // advance in cash would land in the line account and repay the line, leaving it nothing to lose at all
        uint256 id = _lockFrom(sockPuppet, address(acct), 1 ether, false);
        vm.prank(attacker);
        acct.drawAdvance(id, 0.075 ether, FactorDesk.Kind.Compute);
        _lineDraw(attacker, line.canDraw(attacker), false);
        assertEq(line.debtOf(address(acct)), 0.075 ether);
        vm.warp(block.timestamp + 61 days);
        desk.refund(id);
        line.recover(address(acct));
        uint256 lostTogether = (desk.totalLost() - deskLostBefore) + line.lost();
        assertLe(lostTogether, fees, "together never more than the fees paid in");
        assertEq(lostTogether, fees);
        _books();
        _lineBooks();
    }

    /// 19. The two contracts keep their ETH apart: a line's whole life leaves the desk's books as they were.
    function test_attack19_theLineAndTheDeskKeepTheirEthApart() public {
        uint256 deskPool = desk.pool();
        FactorLineAccount acct = _open(agentA);
        _lineBond(agentA, 0.1 ether);
        _lineDraw(agentA, 0.05 ether, true);
        _earn(agentA, 0.2 ether);
        acct.sweep();
        assertEq(desk.pool(), deskPool + 0.004 ether, "the desk's pool gained only the job's fee");
        assertEq(line.debtOf(address(acct)), 0);
        _books();
        _lineBooks();
    }
}

/// Borrows ETH (given to it by the test), bonds it at its line account, draws, and tries to get the ETH back out to
/// repay the loan, all in one call.
contract FlashBorrower {
    FactorDesk internal desk;
    FactorLine internal line;

    constructor(FactorDesk d, FactorLine l) {
        desk = d;
        line = l;
    }

    receive() external payable {}

    function register() external {
        desk.register();
    }

    function open() external {
        line.open();
    }

    function attack(uint256 loan) external returns (bool repaid) {
        FactorLineAccount acct = FactorLineAccount(payable(line.accountOf(address(this))));
        acct.addBond{value: loan}(0);
        line.draw(line.canDraw(address(this)), false);
        try acct.takeBond(loan) {
            acct.withdraw(payable(address(this)), loan);
        } catch {}
        repaid = address(this).balance >= loan;
    }
}
