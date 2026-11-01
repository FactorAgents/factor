// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GuaranteeBase} from "./GuaranteeBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorGuarantee} from "../../src/FactorGuarantee.sol";
import {Reenterer, ForceSend} from "../mocks/Actors.sol";

/// Every attack in section 10 of docs/GUARANTEES.md, carried out against the guarantee contract and the desk together.
contract GuaranteeAttacksTest is GuaranteeBase {
    address internal attacker = makeAddr("attacker");
    address internal sockPuppet = makeAddr("the attacker's second wallet");

    function setUp() public override {
        super.setUp();
        vm.prank(attacker);
        desk.register();
        _fund(1 ether);
    }

    /// 1. The customer rejects good work to collect the cover: the job settles at half and the cover goes back.
    function test_attack1_rejectingDoesNotPayTheCover() public {
        _ready(agentA, 1 ether, 1 ether);
        uint256 start = buyer.balance;
        (uint256 id, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        _deliver(agentA, job);
        vm.prank(buyer);
        desk.reject(job);
        g.close(job);
        assertEq(uint8(g.cover(id).state), uint8(FactorGuarantee.State.Released));
        // the buyer was dealt the price and the fee by the test, and has half the price back
        assertEq(buyer.balance - start, 0.02 ether, "half the price back, and no cover");
        assertEq(g.bondOf(agentA).bond, 1 ether, "the bond is whole");
        _gbooks();
    }

    /// 2. The agent takes its bond out just before a hire. Before the reservation: the reservation fails and nothing is
    ///    locked. After it: the cover is held back and cannot leave.
    function test_attack2_theBondCannotBePulledFromUnderACover() public {
        _ready(agentA, 0.01 ether, 1 ether);
        uint256 dueAt = block.timestamp + 1 days;
        vm.prank(agentA);
        g.takeBond(agentA, 0.01 ether);
        uint256 jobs = desk.jobCount();
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.OverLimit.selector, 0));
        g.reserve{value: 0.0001 ether}(agentA, 0.04 ether, dueAt, false, 0.01 ether);
        assertEq(desk.jobCount(), jobs, "the reservation comes first: nothing was locked");
        // bonded again, reserved, and now the bond is stuck under the cover
        _gbond(agentA, 0.01 ether);
        uint256 id = _reserve(buyer, agentA, 0.04 ether, dueAt, false, 0.01 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.OverFree.selector, 0));
        g.takeBond(agentA, 1);
        uint256 job = _lockAt(buyer, agentA, 0.04 ether, dueAt, false);
        g.bind(id, job);
        vm.warp(dueAt + 12 hours + 1);
        uint256 before = buyer.balance;
        g.close(job);
        assertEq(buyer.balance - before, 0.04 ether + 0.01 ether, "paid in full");
        _gbooks();
    }

    /// 3. A withdrawal and a reservation in a race: whichever comes first is checked against the bond as it then is.
    function test_attack3_aRaceBetweenAWithdrawalAndACover() public {
        _ready(agentA, 0.01 ether, 1 ether);
        uint256 dueAt = block.timestamp + 1 days;
        // the withdrawal first: the reservation is held to what is left
        vm.prank(agentA);
        g.takeBond(agentA, 0.006 ether);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.OverLimit.selector, 0.004 ether));
        g.reserve{value: 0.00005 ether}(agentA, 0.04 ether, dueAt, false, 0.005 ether);
        // the reservation first: the withdrawal is held to what is free
        _reserve(buyer, agentA, 0.04 ether, dueAt, false, 0.004 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.OverFree.selector, 0));
        g.takeBond(agentA, 0.004 ether);
        _gbooks();
    }

    /// 4. Between the reservation and the lock the agent's score drops (another customer rejects a delivery) and,
    ///    once the job is locked, the agent draws on it. The cover stands as reserved, and pays.
    function test_attack4_nothingAfterTheReservationChangesTheCover() public {
        _ready(agentA, 1 ether, 1 ether);
        _bond(agentA, 0.01 ether);
        assertEq(desk.score(agentA), 200);
        uint256 dueAt = block.timestamp + 1 days;
        uint256 id = _reserve(buyer, agentA, 0.04 ether, dueAt, true, 0.01 ether);
        // a delivery the agent's own second wallet rejects: 50 points off
        uint256 dust = _lockFrom(sockPuppet, agentA, 0.001 ether, false);
        _deliver(agentA, dust);
        vm.prank(sockPuppet);
        desk.reject(dust);
        assertEq(desk.score(agentA), 150);
        assertEq(g.coverLimit(agentA, 0.04 ether), 0, "no new cover at 150");
        uint256 job = _lockAt(buyer, agentA, 0.04 ether, dueAt, true);
        _draw(agentA, job, 0.02 ether, FactorDesk.Kind.Early);
        g.bind(id, job);
        vm.warp(dueAt + 12 hours + 1);
        uint256 before = buyer.balance;
        g.close(job);
        assertEq(buyer.balance - before, 0.02 ether + 0.01 ether, "the desk's refund less the early half, and the cover");
        _gbooks();
    }

    /// 5. Agent and customer are the same person. The cover moves the attacker's bond to its other wallet, half the fee
    ///    is burned, and nobody else (no other agent's bond, not the desk's pool) loses a wei.
    function test_attack5_collusionMovesOnlyTheColludersOwnEth() public {
        _ready(attacker, 1 ether, 1 ether);
        _ready(agentB, 1 ether, 1 ether);
        uint256 deskPool = desk.pool();
        uint256 bondB = g.bondOf(agentB).bond;
        uint256 pairBefore = attacker.balance + sockPuppet.balance + g.bondOf(attacker).bond;
        (, uint256 job) = _hire(sockPuppet, attacker, 1 ether, 0.25 ether, false);
        uint256 injected = 1 ether + g.feeFor(0.25 ether); // what the test dealt the second wallet
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        g.close(job);
        uint256 pairAfter = attacker.balance + sockPuppet.balance + g.bondOf(attacker).bond;
        (,, uint256 toAgent) = _halves(0.25 ether);
        (, uint256 burned,) = _halves(0.25 ether);
        assertEq(pairBefore + injected - pairAfter, burned, "the pair lost exactly the burned half of the fee");
        assertEq(g.bondOf(attacker).feesEarned, toAgent);
        assertEq(desk.pool(), deskPool, "the desk's pool is untouched");
        assertEq(g.bondOf(agentB).bond, bondB, "another agent's bond is untouched");
        _gbooks();
        _books();
    }

    /// 6. Hire yourself to raise the score, to sell bigger covers. It costs the desk's fees, and the most anyone can
    ///    then collect is the attacker's own bond.
    function test_attack6_aBoughtScoreRisksOnlyTheBuyersBond() public {
        uint256 deskPool = desk.pool();
        for (uint256 i = 0; i < 20; ++i) {
            _settleFor(sockPuppet, attacker, 0.001 ether);
        }
        assertEq(desk.score(attacker), 200);
        assertEq(desk.pool() - deskPool, 20 * 0.00002 ether, "the score cost the desk's job fees");
        _gbond(attacker, 0.005 ether);
        _offer(attacker, 1 ether);
        assertEq(g.coverLimit(attacker, 1 ether), 0.005 ether, "never more than its own free bond");
        (, uint256 job) = _hire(buyer, attacker, 1 ether, 0.005 ether, false);
        assertEq(g.coverLimit(attacker, 1 ether), 0);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        g.close(job);
        assertEq(g.bonds(), 0, "it paid out its own bond and nothing else");
        _gbooks();
    }

    /// 7. Dust: the smallest cover keeps the fee from rounding away, and an agent declines a dust job at no cost to
    ///    the customer.
    function test_attack7_dust() public {
        _ready(agentA, 1 ether, 1 ether);
        uint256 dueAt = block.timestamp + 1 days;
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.TooSmall.selector, 0.0001 ether));
        g.reserve{value: 0}(agentA, 0.001 ether, dueAt, false, 99);
        uint256 start = buyer.balance;
        (, uint256 job) = _hire(buyer, agentA, 0.001 ether, 0.0001 ether, false);
        assertEq(g.cover(g.coverOf(job)).fee, 0.000001 ether, "never 0");
        vm.prank(agentA);
        desk.decline(job);
        g.close(job);
        // the test dealt the price and the fee; both came back
        assertEq(buyer.balance - start, 0.001 ether + 0.000001 ether);
        _gbooks();
    }

    /// 8. Buy cover on a job already drawn on, or already late: only a job locked after the reservation, within the
    ///    hour, can be tied.
    function test_attack8_noCoverForAJobAlreadyGoingWrong() public {
        _ready(agentA, 1 ether, 1 ether);
        _bond(agentA, 0.01 ether);
        uint256 dueAt = block.timestamp + 2 hours;
        uint256 old = _lockAt(buyer, agentA, 0.04 ether, dueAt, true);
        _draw(agentA, old, 0.02 ether, FactorDesk.Kind.Early);
        vm.warp(dueAt + 1); // late, and drawn on
        uint256 id = _reserve(buyer, agentA, 0.04 ether, block.timestamp + 2 hours, true, 0.01 ether);
        vm.expectRevert(FactorGuarantee.NotTheJob.selector);
        g.bind(id, old);
        _gbooks();
    }

    /// 9. Double claims: one cover per job, one job per cover, each closed once.
    function test_attack9_noDoubleClaims() public {
        _ready(agentA, 1 ether, 1 ether);
        (uint256 id, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        g.close(job);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.WrongState.selector, FactorGuarantee.State.Paid));
        g.close(job);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.WrongState.selector, FactorGuarantee.State.Paid));
        g.lapse(id);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.WrongState.selector, FactorGuarantee.State.Paid));
        g.bind(id, job);
        assertEq(g.bondOf(agentA).bond, 0.99 ether, "paid once");
        _gbooks();
    }

    /// 10. Tie somebody else's job, or an old one, to a reservation: refused.
    function test_attack10_onlyTheCustomersOwnNewJob() public {
        _ready(agentA, 1 ether, 1 ether);
        uint256 dueAt = block.timestamp + 1 days;
        uint256 old = _lockAt(buyer, agentA, 0.04 ether, dueAt, false);
        uint256 id = _reserve(attacker, agentA, 0.04 ether, dueAt, false, 0.01 ether);
        uint256 theirs = _lockAt(buyer, agentA, 0.04 ether, dueAt, false);
        vm.expectRevert(FactorGuarantee.NotTheJob.selector);
        g.bind(id, theirs);
        vm.expectRevert(FactorGuarantee.NotTheJob.selector);
        g.bind(id, old);
    }

    /// 11. Hold an agent's bond hostage with reservations never used: each costs its whole fee, half of which pays the
    ///     agent, and lapses after the hour.
    function test_attack11_hostageReservationsPayTheAgent() public {
        _mockScore(agentA, 1000);
        _gbond(agentA, 1 ether);
        _offer(agentA, 1 ether);
        uint256 dueAt = block.timestamp + 1 days;
        uint256 id = _reserve(attacker, agentA, 1 ether, dueAt, false, 1 ether);
        assertEq(g.freeOf(agentA), 0, "the whole bond is held");
        uint256 agentBefore = agentA.balance;
        vm.warp(block.timestamp + 1 hours + 1);
        g.lapse(id);
        assertEq(g.freeOf(agentA), 1 ether);
        assertEq(agentA.balance - agentBefore, 0.005 ether, "half of the 0.01 fee went to the agent");
        assertEq(attacker.balance, 0, "the attacker paid the whole fee");
        _gbooks();
    }

    /// 12. Re-entry: a customer that calls back in when its cover arrives, and an agent that calls back in when its
    ///     half of the fee arrives. Neither gets in; the books hold.
    function test_attack12_reentryIsShutOut() public {
        _ready(agentA, 1 ether, 1 ether);
        Reenterer cust = new Reenterer();
        (uint256 id, uint256 job) = _hire(address(cust), agentA, 0.04 ether, 0.01 ether, false);
        cust.arm(abi.encodeCall(FactorGuarantee.close, (job)));
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        g.close(job);
        assertTrue(cust.reentered());
        assertFalse(cust.reentrySucceeded());
        assertEq(uint8(g.cover(id).state), uint8(FactorGuarantee.State.Paid));
        assertEq(g.bondOf(agentA).bond, 0.99 ether, "paid once");

        Reenterer ag = new Reenterer();
        vm.prank(address(ag));
        desk.register();
        _score200(address(ag));
        _gbond(address(ag), 1 ether);
        vm.prank(address(ag));
        g.setOffer(address(ag), 1 ether);
        (, uint256 job2) = _hire(buyer, address(ag), 0.04 ether, 0.01 ether, false);
        vm.prank(address(ag));
        desk.deliver(job2, keccak256("the work"));
        vm.prank(buyer);
        desk.accept(job2);
        ag.arm(abi.encodeCall(FactorGuarantee.takeBond, (address(ag), 1 ether)));
        g.close(job2);
        assertTrue(ag.reentered());
        assertFalse(ag.reentrySucceeded());
        assertEq(g.bondOf(address(ag)).bond, 1 ether);
        _gbooks();
    }

    /// 13. Decline at the last moment to escape the cover: the customer has the whole price and the fee back, and an
    ///     agent that drew cannot decline at all.
    function test_attack13_aLateDeclineReturnsEverything() public {
        _ready(agentA, 1 ether, 1 ether);
        uint256 start = buyer.balance;
        (, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, true);
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(agentA);
        desk.decline(job);
        g.close(job);
        assertEq(buyer.balance - start, 0.04 ether + 0.0001 ether, "everything the test dealt it, back");
        assertEq(g.bondOf(agentA).declined, 1, "on the agent's guarantee record");
        (, uint256 job2) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, true);
        _draw(agentA, job2, 0.01 ether, FactorDesk.Kind.Early);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Advanced));
        desk.decline(job2);
        _gbooks();
    }

    /// 14. A job locked for a line account: the guarantee bond is not the desk bond. The line does not lend against
    ///     it, a paid cover leaves the desk bond alone, and bond taken out goes to the line account, which repays first.
    function test_attack14_aLineAccountsGuaranteeBondStaysApart() public {
        FactorLineAccount acct = _open(attacker);
        _score200(address(acct));
        vm.prank(attacker);
        acct.withdraw(payable(attacker), address(acct).balance);
        _gbond(address(acct), 1 ether);
        vm.prank(attacker);
        g.setOffer(address(acct), 1 ether);
        _seed(1 ether);
        _lineBond(attacker, 0.001 ether);
        uint256 limit = line.limit(address(acct));
        assertEq(limit, 0.001 ether + 20 * 0.00002 ether, "the line counts the desk bond and fees, not the guarantee bond");
        _lineDraw(attacker, limit, false);
        (, uint256 job) = _hire(buyer, address(acct), 0.04 ether, 0.01 ether, false);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        g.close(job);
        assertEq(desk.agent(address(acct)).bond, 0.001 ether, "the desk bond is untouched");
        vm.prank(attacker);
        g.takeBond(address(acct), 0.99 ether);
        (,, uint256 half) = _halves(0.01 ether);
        assertEq(address(acct).balance, 0.99 ether + half, "it went to the line account, beside its half of the fee");
        uint256 keyBefore = attacker.balance;
        vm.prank(attacker);
        acct.withdraw(payable(attacker), 0.5 ether);
        assertEq(attacker.balance - keyBefore, 0.5 ether);
        assertEq(line.debtOf(address(acct)), 0, "the line was repaid first");
        _gbooks();
    }

    /// 15. Take another agent's bond, or set its offer: only the agent or its line key can, and bond goes only to the
    ///     agent's own address.
    function test_attack15_onlyTheAgent() public {
        _ready(agentA, 1 ether, 1 ether);
        FactorLineAccount acct = _open(agentB);
        _gbond(address(acct), 1 ether);
        vm.startPrank(attacker);
        vm.expectRevert(FactorGuarantee.NotAgent.selector);
        g.takeBond(agentA, 1 ether);
        vm.expectRevert(FactorGuarantee.NotAgent.selector);
        g.setOffer(agentA, 0);
        vm.expectRevert(FactorGuarantee.NotAgent.selector);
        g.takeBond(address(acct), 1 ether);
        vm.stopPrank();
        // agentA's key is not the key of agentB's account
        vm.prank(agentA);
        vm.expectRevert(FactorGuarantee.NotAgent.selector);
        g.takeBond(address(acct), 1 ether);
        uint256 before = agentB.balance;
        vm.prank(agentB);
        g.takeBond(address(acct), 1 ether);
        assertEq(agentB.balance, before, "the key itself gets nothing: the account does");
        assertEq(address(acct).balance, 1 ether);
    }

    /// 16. One agent's bond never backs another's cover.
    function test_attack16_eachBondBacksItsOwnAgent() public {
        _ready(agentA, 1 ether, 1 ether);
        _score200(agentB);
        _offer(agentB, 1 ether);
        assertEq(g.coverLimit(agentB, 1 ether), 0, "agentB has no bond, whatever agentA holds");
        _gbond(agentB, 0.01 ether);
        (, uint256 job) = _hire(buyer, agentB, 0.04 ether, 0.01 ether, false);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        g.close(job);
        assertEq(g.bondOf(agentA).bond, 1 ether);
        assertEq(g.bondOf(agentB).bond, 0);
        _gbooks();
    }

    /// 17. Grief a close: refused until the desk job is finished, and the desk is asked to finish it only when the desk
    ///     itself would.
    function test_attack17_closeWaitsForTheDesk() public {
        _ready(agentA, 1 ether, 1 ether);
        (, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.NotFinished.selector, FactorDesk.State.Locked));
        g.close(job);
        _deliver(agentA, job);
        vm.warp(block.timestamp + 24 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.NotFinished.selector, FactorDesk.State.Delivered));
        g.close(job);
        vm.warp(block.timestamp + 1);
        g.close(job);
        assertEq(uint8(desk.job(job).state), uint8(FactorDesk.State.Settled));
    }

    /// 18. The books never mix: ETH forced into the contract changes nothing anybody can take, and every flow still
    ///     balances.
    function test_attack18_forcedEthChangesNothing() public {
        _ready(agentA, 1 ether, 1 ether);
        vm.deal(address(this), address(this).balance + 0.5 ether);
        new ForceSend{value: 0.5 ether}(payable(address(g)));
        assertEq(address(g).balance, 1.5 ether);
        (, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        g.close(job);
        uint256 free = g.freeOf(agentA);
        vm.prank(agentA);
        g.takeBond(agentA, free);
        assertEq(g.bonds(), 0);
        assertEq(address(g).balance, 0.5 ether, "only what was forced in is left, and nobody can take it");
    }
}
