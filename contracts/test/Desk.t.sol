// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeskBase} from "./DeskBase.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {ForceSend, GasEater, Reenterer, Rejecter} from "./mocks/Actors.sol";

/// The desk, rule by rule, in the order of docs/RULEBOOK.md. Every test ends by checking the desk's books against
/// the ETH it really holds.
contract DeskTest is DeskBase {
    // ---------- the numbers ----------

    function test_theNumbersAreTheRulebooks() public view {
        assertEq(desk.ADVANCE_MAX_BPS(), 5000);
        assertEq(desk.ADVANCE_FEE_BPS(), 100);
        assertEq(desk.JOB_FEE_BPS(), 200);
        assertEq(desk.REJECTED_BPS(), 5000);
        assertEq(desk.POOL_OUT_MAX_BPS(), 8000);
        assertEq(desk.MIN_JOB(), 0.001 ether);
        assertEq(desk.MIN_DUE(), 1 hours);
        assertEq(desk.MAX_DUE(), 30 days);
        assertEq(desk.GRACE(), 12 hours);
        assertEq(desk.REVIEW(), 24 hours);
        assertEq(desk.burnPot(), address(burnPot));
        assertEq(desk.gateway(), gateway);
    }

    function test_theConstructorRefusesZeroAddresses() public {
        vm.expectRevert(FactorDesk.ZeroAddress.selector);
        new FactorDesk(address(0), gateway);
        vm.expectRevert(FactorDesk.ZeroAddress.selector);
        new FactorDesk(address(burnPot), address(0));
    }

    // ---------- registering and locking ----------

    function test_anAgentRegistersOnce() public {
        address fresh = makeAddr("fresh");
        assertFalse(desk.agent(fresh).registered);
        vm.prank(fresh);
        desk.register();
        assertTrue(desk.agent(fresh).registered);
        vm.prank(fresh);
        vm.expectRevert(FactorDesk.AlreadyRegistered.selector);
        desk.register();
    }

    function test_aJobIsLockedForARegisteredAgentOnly() public {
        vm.deal(customer, 1 ether);
        vm.prank(customer);
        vm.expectRevert(FactorDesk.NotRegistered.selector);
        desk.lock{value: 0.01 ether}(makeAddr("nobody"), block.timestamp + 1 days, false);
    }

    function test_theSmallestJobAndTheDueTimes() public {
        vm.deal(customer, 10 ether);
        vm.startPrank(customer);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.TooSmall.selector, 0.001 ether));
        desk.lock{value: 0.001 ether - 1}(agentA, block.timestamp + 1 days, false);
        vm.expectRevert(FactorDesk.BadDueTime.selector);
        desk.lock{value: 0.01 ether}(agentA, block.timestamp + 1 hours - 1, false);
        vm.expectRevert(FactorDesk.BadDueTime.selector);
        desk.lock{value: 0.01 ether}(agentA, block.timestamp + 30 days + 1, false);
        // the edges themselves are allowed
        assertEq(desk.lock{value: 0.001 ether}(agentA, block.timestamp + 1 hours, false), 1);
        assertEq(desk.lock{value: 0.01 ether}(agentA, block.timestamp + 30 days, true), 2);
        vm.stopPrank();

        FactorDesk.Job memory j = desk.job(2);
        assertEq(j.customer, customer);
        assertEq(j.agent, agentA);
        assertEq(j.price, 0.01 ether);
        assertEq(j.dueAt, block.timestamp + 30 days);
        assertTrue(j.allowEarly);
        assertEq(uint8(j.state), uint8(FactorDesk.State.Locked));
        assertEq(desk.held(), 0.011 ether);
        assertEq(desk.jobCount(), 2);
        assertEq(uint8(desk.job(3).state), uint8(FactorDesk.State.None), "a number never given out is no job");
        _books();
    }

    // ---------- a job that settles ----------

    /// The rulebook's own example, to the wei: price 0.0400, pool advance 0.0200.
    function test_theRulebooksExample() public {
        _fund(1 ether);
        _bond(agentA, 0.02 ether);
        uint256 id = _lock(agentA, 0.04 ether, false);

        _draw(agentA, id, 0.02 ether, FactorDesk.Kind.Pool);
        assertEq(agentA.balance, 0.0198 ether, "at the draw the agent receives 0.0198");
        assertEq(address(burnPot).balance, 0.0002 ether, "and 0.0002 goes to the burn");
        assertEq(desk.pool(), 0.98 ether);
        assertEq(desk.out(), 0.02 ether);
        assertEq(uint8(desk.job(id).state), uint8(FactorDesk.State.Advanced));
        _books();

        _deliver(agentA, id);
        _accept(id);
        assertEq(agentA.balance, 0.0198 ether + 0.0192 ether, "in all the agent has received 0.0390 of 0.0400");
        assertEq(desk.pool(), 1 ether + 0.0008 ether, "the pool has its 0.0200 back, and the job fee");
        assertEq(desk.out(), 0);
        assertEq(desk.held(), 0);
        assertEq(customer.balance, 0);

        FactorDesk.Agent memory a = desk.agent(agentA);
        assertEq(a.settled, 1);
        assertEq(a.customers, 0, "0.0008 in fees is not yet a customer that counts");
        assertEq(desk.feesFrom(agentA, customer), 0.0008 ether);
        assertEq(a.onTime, 1);
        assertEq(a.advancesRepaid, 1);
        assertEq(a.feesPaid, 0.0008 ether);
        assertEq(a.volume, 0.04 ether);
        assertEq(a.advancedNow, 0);
        assertEq(a.firstSettledAt, block.timestamp);
        assertEq(desk.limit(agentA), 0.02 ether + 0.0008 ether, "the bond plus the fees paid, counted once");
        (uint32 accepted, uint32 rejected) = desk.customers(customer);
        assertEq(accepted, 1);
        assertEq(rejected, 0);
        _books();
    }

    function test_aJobWithNoAdvancePaysEverythingButTheFee() public {
        uint256 id = _lock(agentA, 1 ether, false);
        _deliver(agentA, id);
        _accept(id);
        assertEq(agentA.balance, 0.98 ether);
        assertEq(desk.pool(), 0.02 ether, "the job fee is how the work fills the pool");
        assertEq(desk.totalJobFees(), 0.02 ether);
        assertEq(desk.totalSettled(), 1 ether);
        _books();
    }

    function test_onlyTheCustomerAcceptsAndOnlyADeliveredJob() public {
        uint256 id = _lock(agentA, 1 ether, false);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Locked));
        desk.accept(id);
        _deliver(agentA, id);
        vm.prank(other);
        vm.expectRevert(FactorDesk.NotCustomer.selector);
        desk.accept(id);
        _accept(id);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Settled));
        desk.accept(id);
    }

    /// Never coming back to accept does not hold the agent's money: after 24 hours anyone settles the job.
    function test_anyoneSettlesAfterTheCustomersDay() public {
        uint256 id = _lock(agentA, 1 ether, false);
        _deliver(agentA, id);
        uint256 at = block.timestamp + 24 hours;
        vm.warp(at - 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.TooSoon.selector, at));
        desk.settle(id);
        vm.warp(at);
        vm.prank(stranger);
        desk.settle(id);
        assertEq(agentA.balance, 0.98 ether);
        assertEq(uint8(desk.job(id).state), uint8(FactorDesk.State.Settled));
        _books();
    }

    // ---------- the three kinds of advance ----------

    function test_anEarlyAdvanceComesOutOfTheJobsOwnPayment() public {
        _fund(1 ether);
        uint256 id = _lock(agentA, 0.04 ether, true);
        _draw(agentA, id, 0.02 ether, FactorDesk.Kind.Early);
        assertEq(agentA.balance, 0.0198 ether);
        assertEq(address(burnPot).balance, 0.0002 ether);
        assertEq(desk.pool(), 1 ether, "the pool is not touched");
        assertEq(desk.out(), 0);
        assertEq(desk.held(), 0.02 ether, "the job holds what is left of it");
        assertEq(desk.agent(agentA).advancedNow, 0, "and it does not count against the agent's limit");
        _books();

        _deliver(agentA, id);
        _accept(id);
        assertEq(agentA.balance, 0.0198 ether + 0.0192 ether);
        assertEq(desk.pool(), 1 ether + 0.0008 ether);
        assertEq(desk.agent(agentA).advancesRepaid, 0, "nothing was borrowed from the pool");
        _books();
    }

    function test_anEarlyAdvanceNeedsTheCustomersSwitch() public {
        uint256 id = _lock(agentA, 0.04 ether, false);
        vm.prank(agentA);
        vm.expectRevert(FactorDesk.EarlyNotAllowed.selector);
        desk.draw(id, 0.01 ether, FactorDesk.Kind.Early);
    }

    function test_aComputeAdvanceIsPaidToTheGatewayNeverToTheAgent() public {
        _fund(1 ether);
        _bond(agentA, 0.02 ether);
        uint256 id = _lock(agentA, 0.04 ether, false);
        _draw(agentA, id, 0.012 ether, FactorDesk.Kind.Compute);
        assertEq(agentA.balance, 0, "not a wei reaches the agent");
        assertEq(gateway.balance, 0.012 ether - 0.00012 ether);
        assertEq(address(burnPot).balance, 0.00012 ether);
        assertEq(desk.out(), 0.012 ether);
        assertEq(desk.agent(agentA).advancedNow, 0.012 ether, "it is the agent's to repay, like any pool advance");

        _deliver(agentA, id);
        _accept(id);
        assertEq(agentA.balance, 0.04 ether - 0.012 ether - 0.0008 ether);
        assertEq(desk.pool(), 1 ether + 0.0008 ether);
        _books();
    }

    function test_advancesStopAtHalfInAnyMix() public {
        _fund(1 ether);
        _bond(agentA, 1 ether);
        uint256 id = _lock(agentA, 0.1 ether, true);
        _draw(agentA, id, 0.02 ether, FactorDesk.Kind.Early);
        _draw(agentA, id, 0.02 ether, FactorDesk.Kind.Pool);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.OverHalf.selector, 0.01 ether));
        desk.draw(id, 0.01 ether + 1, FactorDesk.Kind.Compute);
        (uint256 early, uint256 fromPool) = desk.canDrawOn(id);
        assertEq(early, 0.01 ether);
        assertEq(fromPool, 0.01 ether);
        _draw(agentA, id, 0.01 ether, FactorDesk.Kind.Compute);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.OverHalf.selector, 0));
        desk.draw(id, 1, FactorDesk.Kind.Early);
        _books();
    }

    function test_onlyTheJobsAgentDrawsAndNotNothing() public {
        _fund(1 ether);
        uint256 id = _lock(agentA, 0.1 ether, true);
        vm.prank(agentB);
        vm.expectRevert(FactorDesk.NotAgent.selector);
        desk.draw(id, 0.01 ether, FactorDesk.Kind.Early);
        vm.prank(customer);
        vm.expectRevert(FactorDesk.NotAgent.selector);
        desk.draw(id, 0.01 ether, FactorDesk.Kind.Early);
        vm.prank(agentA);
        vm.expectRevert(FactorDesk.ZeroAmount.selector);
        desk.draw(id, 0, FactorDesk.Kind.Early);
    }

    function test_nothingIsDrawnOnceTheJobIsDeliveredOrClosed() public {
        _fund(1 ether);
        uint256 id = _lock(agentA, 0.1 ether, true);
        _deliver(agentA, id);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Delivered));
        desk.draw(id, 0.01 ether, FactorDesk.Kind.Early);
        _accept(id);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Settled));
        desk.draw(id, 0.01 ether, FactorDesk.Kind.Early);
    }

    // ---------- the limit with the pool ----------

    function test_aNewAgentHasNoLimitWithThePool() public {
        _fund(1 ether);
        uint256 id = _lock(agentA, 0.1 ether, false);
        assertEq(desk.limit(agentA), 0);
        assertEq(desk.canDraw(agentA), 0);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.OverLimit.selector, 0));
        desk.draw(id, 1, FactorDesk.Kind.Pool);
    }

    function test_theLimitIsTheBondPlusTheFeesCountedOnce() public {
        _fund(1 ether);
        // one settled job of 1 ETH pays 0.02 into the pool: that is the whole limit
        uint256 first = _lock(agentA, 1 ether, false);
        _deliver(agentA, first);
        _accept(first);
        assertEq(desk.limit(agentA), 0.02 ether);

        uint256 id = _lock(agentA, 1 ether, false);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.OverLimit.selector, 0.02 ether));
        desk.draw(id, 0.02 ether + 1, FactorDesk.Kind.Pool);
        _draw(agentA, id, 0.02 ether, FactorDesk.Kind.Pool);
        assertEq(desk.canDraw(agentA), 0);

        // a bond raises it, and what is out counts against it across jobs
        _bond(agentA, 0.05 ether);
        assertEq(desk.limit(agentA), 0.07 ether);
        assertEq(desk.canDraw(agentA), 0.05 ether);
        uint256 second = _lock(agentA, 1 ether, false);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.OverLimit.selector, 0.05 ether));
        desk.draw(second, 0.05 ether + 1, FactorDesk.Kind.Compute);
        _draw(agentA, second, 0.05 ether, FactorDesk.Kind.Compute);
        _books();
    }

    function test_thePoolNeverHasMoreThanFourFifthsOut() public {
        _fund(1 ether);
        _bond(agentA, 10 ether);
        uint256 id = _lock(agentA, 10 ether, false);
        assertEq(desk.poolRoom(), 0.8 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.PoolShort.selector, 0.8 ether));
        desk.draw(id, 0.8 ether + 1, FactorDesk.Kind.Pool);
        _draw(agentA, id, 0.8 ether, FactorDesk.Kind.Pool);
        assertEq(desk.poolRoom(), 0);
        assertEq(desk.pool(), 0.2 ether, "the last fifth stays");
        (, uint256 fromPool) = desk.canDrawOn(id);
        assertEq(fromPool, 0);

        // more pool, more room: 80% of 2 ETH is 1.6, and 0.8 is out
        _fund(1 ether);
        assertEq(desk.poolRoom(), 0.8 ether);
        _books();
    }

    function test_anEmptyPoolAdvancesNothing() public {
        _bond(agentA, 1 ether);
        uint256 id = _lock(agentA, 1 ether, false);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.PoolShort.selector, 0));
        desk.draw(id, 0.01 ether, FactorDesk.Kind.Pool);
    }

    // ---------- a rejected job settles at half ----------

    /// The second example the site shows: price 0.03, 0.009 of compute, rejected.
    function test_aRejectedJobSettlesAtHalf() public {
        _fund(1 ether);
        _bond(agentA, 0.02 ether);
        uint256 id = _lock(agentA, 0.03 ether, false);
        _draw(agentA, id, 0.009 ether, FactorDesk.Kind.Compute);
        _deliver(agentA, id);
        vm.prank(customer);
        desk.reject(id);

        assertEq(customer.balance, 0.015 ether, "half of the price back");
        assertEq(agentA.balance, 0.015 ether - 0.009 ether - 0.0003 ether, "the agent keeps what is left of its half");
        assertEq(desk.pool(), 1 ether + 0.0003 ether, "the pool is repaid first, and has the fee on that half");
        assertEq(desk.out(), 0);
        assertEq(desk.held(), 0);
        assertEq(uint8(desk.job(id).state), uint8(FactorDesk.State.SettledAtHalf));

        FactorDesk.Agent memory a = desk.agent(agentA);
        assertEq(a.settledAtHalf, 1);
        assertEq(a.settled, 0, "it is not a settled job on the record");
        assertEq(a.customers, 0);
        assertEq(a.advancesRepaid, 1);
        assertEq(a.feesPaid, 0.0003 ether);
        (uint32 accepted, uint32 rejected) = desk.customers(customer);
        assertEq(accepted, 0);
        assertEq(rejected, 1, "the customer's rejections are public too");
        _books();
    }

    /// The pool comes before the agent and before the fee: with half the job out from the pool, the agent's half
    /// is exactly the repayment.
    function test_aRejectedJobRepaysThePoolBeforeAnythingElse() public {
        _fund(1 ether);
        _bond(agentA, 1 ether);
        uint256 id = _lock(agentA, 0.2 ether, false);
        _draw(agentA, id, 0.1 ether, FactorDesk.Kind.Pool);
        uint256 afterDraw = agentA.balance;
        _deliver(agentA, id);
        vm.prank(customer);
        desk.reject(id);
        assertEq(customer.balance, 0.1 ether);
        assertEq(agentA.balance, afterDraw, "nothing more for the agent");
        assertEq(desk.pool(), 1 ether, "the pool is whole");
        assertEq(desk.out(), 0);
        assertEq(desk.agent(agentA).feesPaid, 0, "there was nothing left to take a fee from");
        _books();
    }

    function test_anEarlyAdvanceCountsAsPartOfTheAgentsHalf() public {
        uint256 id = _lock(agentA, 0.2 ether, true);
        _draw(agentA, id, 0.1 ether, FactorDesk.Kind.Early);
        _deliver(agentA, id);
        vm.prank(customer);
        desk.reject(id);
        assertEq(customer.balance, 0.1 ether, "the customer's half is whole");
        assertEq(agentA.balance, 0.099 ether, "the agent already holds its half, less the advance fee");
        assertEq(desk.held(), 0);
        _books();
    }

    function test_anOddPriceLosesNoWeiWhenRejected() public {
        _fund(1 ether);
        _bond(agentA, 1 ether);
        uint256 price = 0.001 ether + 1; // odd: the customer's half rounds down, the agent's side up
        uint256 id = _lock(agentA, price, false);
        _draw(agentA, id, price / 2, FactorDesk.Kind.Pool);
        _deliver(agentA, id);
        vm.prank(customer);
        desk.reject(id);
        assertEq(customer.balance, price / 2);
        assertEq(desk.pool(), 1 ether + 1, "the odd wei is the fee");
        assertEq(desk.held(), 0);
        _books();
    }

    function test_onlyTheCustomerRejectsAndOnlyWithinTheDay() public {
        uint256 id = _lock(agentA, 1 ether, false);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Locked));
        desk.reject(id);
        _deliver(agentA, id);
        vm.prank(stranger);
        vm.expectRevert(FactorDesk.NotCustomer.selector);
        desk.reject(id);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(customer);
        vm.expectRevert(FactorDesk.TooLate.selector);
        desk.reject(id);
        // and from that same moment anyone can settle it
        desk.settle(id);
        assertEq(agentA.balance, 0.98 ether);
    }

    // ---------- declining ----------

    function test_theAgentDeclinesAndTheCustomerHasEverythingBack() public {
        uint256 id = _lock(agentA, 0.5 ether, true);
        vm.prank(customer);
        vm.expectRevert(FactorDesk.NotAgent.selector);
        desk.decline(id);
        vm.prank(agentA);
        desk.decline(id);
        assertEq(customer.balance, 0.5 ether);
        assertEq(desk.held(), 0);
        assertEq(uint8(desk.job(id).state), uint8(FactorDesk.State.Declined));
        FactorDesk.Agent memory a = desk.agent(agentA);
        assertEq(a.settled + a.settledAtHalf + a.notDelivered, 0, "a declined job leaves no mark");
        _books();
    }

    function test_aJobThatWasDrawnOnCannotBeDeclined() public {
        uint256 id = _lock(agentA, 0.5 ether, true);
        _draw(agentA, id, 0.1 ether, FactorDesk.Kind.Early);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Advanced));
        desk.decline(id);
    }

    // ---------- when the agent does not deliver ----------

    function test_anUndeliveredJobComesBackByItself() public {
        uint256 id = _lock(agentA, 0.5 ether, false);
        uint256 at = block.timestamp + 1 days + 12 hours;
        vm.warp(at);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.TooSoon.selector, at + 1));
        desk.refund(id);
        vm.warp(at + 1);
        vm.prank(stranger);
        desk.refund(id);
        assertEq(customer.balance, 0.5 ether);
        assertEq(uint8(desk.job(id).state), uint8(FactorDesk.State.Refunded));
        FactorDesk.Agent memory a = desk.agent(agentA);
        assertEq(a.notDelivered, 0, "it never touched the job, so its record is not marked");
        assertEq(a.unanswered, 1);
        assertFalse(a.barred, "it borrowed nothing, so it is not barred");
        _books();
    }

    /// The bond pays first, the pool carries the rest, the customer is whole, the agent is out for good.
    function test_anUnpaidPoolAdvanceTakesTheBondFirst() public {
        _fund(1 ether);
        // a limit of 0.03: a bond of 0.01 and 0.02 in fees from one settled job
        uint256 first = _lock(agentA, 1 ether, false);
        _deliver(agentA, first);
        _accept(first);
        _bond(agentA, 0.01 ether);
        uint256 poolBefore = desk.pool();

        uint256 id = _lock(agentA, 0.1 ether, false);
        _draw(agentA, id, 0.03 ether, FactorDesk.Kind.Pool);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        desk.refund(id);

        assertEq(customer.balance, 0.1 ether, "the customer is refunded in full");
        assertEq(desk.pool(), poolBefore - 0.02 ether, "the pool carries what the bond did not");
        assertEq(desk.out(), 0);
        assertEq(desk.totalLost(), 0.02 ether);
        assertEq(desk.bonds(), 0);
        FactorDesk.Agent memory a = desk.agent(agentA);
        assertEq(a.bond, 0, "the bond went first");
        assertEq(a.advancedNow, 0);
        assertEq(a.advancesNotRepaid, 1);
        assertEq(a.notDelivered, 1);
        assertTrue(a.barred);
        assertEq(desk.limit(agentA), 0);
        assertEq(desk.score(agentA), 0);
        _books();

        // never again, whatever it posts
        _bond(agentA, 1 ether);
        uint256 next = _lock(agentA, 0.1 ether, true);
        vm.prank(agentA);
        vm.expectRevert(FactorDesk.Barred.selector);
        desk.draw(next, 0.01 ether, FactorDesk.Kind.Pool);
        vm.prank(agentA);
        vm.expectRevert(FactorDesk.Barred.selector);
        desk.draw(next, 0.01 ether, FactorDesk.Kind.Compute);
        // a customer can still choose to pay it early
        _draw(agentA, next, 0.01 ether, FactorDesk.Kind.Early);
        _books();
    }

    function test_aBondThatCoversTheAdvanceLeavesThePoolWhole() public {
        _fund(1 ether);
        _bond(agentA, 0.05 ether);
        uint256 id = _lock(agentA, 0.1 ether, false);
        _draw(agentA, id, 0.03 ether, FactorDesk.Kind.Pool);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        desk.refund(id);
        assertEq(desk.pool(), 1 ether, "repaid out of the bond");
        assertEq(desk.totalLost(), 0);
        assertEq(desk.agent(agentA).bond, 0.02 ether);
        assertTrue(desk.agent(agentA).barred);
        _books();
    }

    function test_anEarlyAdvanceKeptWithoutDeliveringIsTheCustomersLossAndTheAgentsMark() public {
        _fund(1 ether);
        uint256 id = _lock(agentA, 0.1 ether, true);
        _draw(agentA, id, 0.05 ether, FactorDesk.Kind.Early);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        desk.refund(id);
        assertEq(customer.balance, 0.05 ether, "the whole price less the early advance the customer chose to allow");
        assertEq(desk.pool(), 1 ether);
        FactorDesk.Agent memory a = desk.agent(agentA);
        assertEq(a.earlyKept, 1);
        assertTrue(a.barred);
        assertEq(desk.score(agentA), 0);
        _books();
    }

    function test_aDeliveryInTheGraceCountsAndIsMarkedLate() public {
        uint256 id = _lock(agentA, 1 ether, false);
        vm.warp(block.timestamp + 1 days + 12 hours);
        _deliver(agentA, id);
        assertTrue(desk.job(id).late);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Delivered));
        desk.refund(id);
        _accept(id);
        assertEq(desk.agent(agentA).late, 1);
        assertEq(desk.agent(agentA).onTime, 0);
    }

    function test_pastTheGraceNothingIsDeliveredOrDrawn() public {
        _fund(1 ether);
        _bond(agentA, 1 ether);
        uint256 id = _lock(agentA, 1 ether, true);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        vm.startPrank(agentA);
        vm.expectRevert(FactorDesk.TooLate.selector);
        desk.deliver(id, keccak256("too late"));
        vm.expectRevert(FactorDesk.TooLate.selector);
        desk.draw(id, 0.1 ether, FactorDesk.Kind.Pool);
        vm.expectRevert(FactorDesk.TooLate.selector);
        desk.draw(id, 0.1 ether, FactorDesk.Kind.Early);
        vm.stopPrank();
        (uint256 early, uint256 fromPool) = desk.canDrawOn(id);
        assertEq(early + fromPool, 0);
    }

    function test_aClosedJobIsNotRefunded() public {
        uint256 id = _lock(agentA, 1 ether, false);
        _deliver(agentA, id);
        _accept(id);
        vm.warp(block.timestamp + 40 days);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Settled));
        desk.refund(id);
    }

    // ---------- the bond ----------

    function test_theBondLeavesOnlyWhileTheAgentOwesNothing() public {
        _fund(1 ether);
        _bond(agentA, 0.05 ether);
        assertEq(desk.bonds(), 0.05 ether);
        uint256 id = _lock(agentA, 0.1 ether, false);
        _draw(agentA, id, 0.01 ether, FactorDesk.Kind.Pool);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.OwesThePool.selector, 0.01 ether));
        desk.takeBond(0.01 ether);

        _deliver(agentA, id);
        _accept(id);
        uint256 before = agentA.balance;
        vm.startPrank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.OverBond.selector, 0.05 ether));
        desk.takeBond(0.05 ether + 1);
        vm.expectRevert(FactorDesk.ZeroAmount.selector);
        desk.takeBond(0);
        desk.takeBond(0.05 ether);
        vm.stopPrank();
        assertEq(agentA.balance - before, 0.05 ether);
        assertEq(desk.bonds(), 0);
        assertEq(desk.limit(agentA), 0.002 ether, "what is left is the fees it has paid in");
        _books();
    }

    function test_onlyARegisteredAgentPostsABond() public {
        vm.deal(stranger, 1 ether);
        vm.startPrank(stranger);
        vm.expectRevert(FactorDesk.NotRegistered.selector);
        desk.addBond{value: 0.1 ether}();
        desk.register();
        vm.expectRevert(FactorDesk.ZeroAmount.selector);
        desk.addBond{value: 0}();
        vm.stopPrank();
    }

    // ---------- the pool ----------

    function test_ethSentToTheDeskIsThePool() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(desk).call{value: 0.3 ether}("");
        assertTrue(ok);
        assertEq(desk.pool(), 0.3 ether);
        assertEq(desk.totalPoolIn(), 0.3 ether);
        _books();
    }

    /// ETH forced in without a call is in nobody's books: it cannot be drawn, and it breaks nothing.
    function test_forcedEthIsInNobodysBooks() public {
        _fund(1 ether);
        vm.deal(address(this), 5 ether);
        new ForceSend{value: 5 ether}(payable(address(desk)));
        assertEq(desk.pool(), 1 ether);
        assertEq(desk.poolRoom(), 0.8 ether);
        uint256 id = _lock(agentA, 1 ether, false);
        _deliver(agentA, id);
        _accept(id);
        assertEq(address(desk).balance, desk.pool() + desk.held() + desk.bonds() + desk.owedTotal() + 5 ether);
    }

    // ---------- the attacks of section 7 ----------

    /// Attack 1. An agent hires itself from a second wallet until it has a limit, then takes the pool's money and
    /// runs. With the fees counted once, what it takes is what it paid in: it ends below where it started and
    /// the pool ends where it started.
    function test_hiringYourselfToGrowALimitNeverPaysForItself() public {
        _fund(1 ether);
        address crook = makeAddr("crook");
        address second = makeAddr("the crook's second wallet");
        vm.prank(crook);
        desk.register();
        uint256 start = 10 ether;
        vm.deal(second, start);

        for (uint256 i = 0; i < 10; ++i) {
            vm.prank(second);
            uint256 own = desk.lock{value: 1 ether}(crook, block.timestamp + 1 hours, false);
            _deliver(crook, own);
            vm.prank(second);
            desk.accept(own);
            vm.prank(crook);
            payable(second).transfer(crook.balance);
        }
        assertEq(desk.limit(crook), 0.2 ether, "ten jobs of 1 ETH paid 0.2 into the pool");
        assertEq(desk.pool(), 1.2 ether);

        vm.prank(second);
        uint256 id = desk.lock{value: 1 ether}(crook, block.timestamp + 1 hours, false);
        _draw(crook, id, 0.2 ether, FactorDesk.Kind.Pool);
        vm.warp(block.timestamp + 13 hours + 1);
        desk.refund(id);
        vm.prank(crook);
        payable(second).transfer(crook.balance);

        assertEq(desk.totalLost(), 0.2 ether);
        assertEq(desk.pool(), 1 ether, "the pool is where it started");
        assertEq(start - second.balance, 0.002 ether, "and the crook is down the fee on its own advance");
        assertTrue(desk.agent(crook).barred);
        _books();
    }

    /// Attack 9. A wallet that refuses ETH blocks nobody: its payout is written down for it to collect.
    function test_aCustomerThatRefusesEthDoesNotBlockItsOwnRefundOrThePool() public {
        _fund(1 ether);
        _bond(agentA, 0.05 ether);
        Rejecter r = new Rejecter();
        uint256 id = _lockFrom(address(r), agentA, 0.1 ether, false);
        _draw(agentA, id, 0.03 ether, FactorDesk.Kind.Pool);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        desk.refund(id);

        assertEq(desk.owed(address(r)), 0.1 ether, "waiting for it");
        assertEq(desk.owedTotal(), 0.1 ether);
        assertEq(desk.pool(), 1 ether, "and the pool was repaid from the bond all the same");
        assertEq(desk.held(), 0);
        _books();

        vm.expectRevert(FactorDesk.PushFailed.selector);
        desk.collect(address(r));
        // it can name another address for its own money
        address payable safe = payable(makeAddr("safe"));
        vm.prank(address(r));
        desk.collectTo(safe);
        assertEq(safe.balance, 0.1 ether);
        assertEq(desk.owedTotal(), 0);
        vm.prank(address(r));
        vm.expectRevert(FactorDesk.NothingOwed.selector);
        desk.collectTo(safe);
        _books();
    }

    function test_anyoneDeliversAWaitingPayoutButOnlyToItsOwner() public {
        Rejecter r = new Rejecter();
        vm.prank(address(r));
        desk.register();
        uint256 id = _lock(address(r), 1 ether, false);
        _deliver(address(r), id);
        _accept(id);
        assertEq(desk.owed(address(r)), 0.98 ether);
        r.setAccept(true);
        vm.prank(stranger);
        desk.collect(address(r));
        assertEq(address(r).balance, 0.98 ether);
        assertEq(stranger.balance, 0);
        vm.expectRevert(FactorDesk.NothingOwed.selector);
        desk.collect(address(r));
        vm.prank(stranger);
        vm.expectRevert(FactorDesk.NothingOwed.selector);
        desk.collectTo(payable(stranger));
        _books();
    }

    function test_anAgentWalletThatEatsGasDoesNotStopThePoolBeingRepaid() public {
        _fund(1 ether);
        GasEater g = new GasEater();
        vm.prank(address(g));
        desk.register();
        _bond(address(g), 0.05 ether);
        uint256 id = _lock(address(g), 0.1 ether, false);
        vm.prank(address(g));
        desk.draw(id, 0.05 ether, FactorDesk.Kind.Compute);
        _deliver(address(g), id);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(stranger);
        desk.settle{gas: 1_000_000}(id);
        assertEq(desk.pool(), 1 ether + 0.002 ether, "the pool has its advance and the fee");
        assertEq(desk.out(), 0);
        assertEq(desk.owed(address(g)), 0.1 ether - 0.05 ether - 0.002 ether, "the agent's payout waits for it");
        _books();
    }

    /// Nobody can make a payout fail by sending too little gas: the call reverts instead and changes nothing.
    function test_tooLittleGasRevertsRatherThanParkingAPayout() public {
        uint256 id = _lock(agentA, 1 ether, false);
        _deliver(agentA, id);
        vm.warp(block.timestamp + 24 hours);
        bool settled;
        for (uint256 gas = 40_000; gas <= 400_000 && !settled; gas += 5_000) {
            try desk.settle{gas: gas}(id) {
                settled = true;
            } catch {}
            assertEq(desk.owed(agentA), 0, "never parked");
        }
        assertTrue(settled);
        assertEq(agentA.balance, 0.98 ether);
        _books();
    }

    /// Attack 10. A wallet that calls back into the desk while it is being paid gets nowhere.
    function test_aWalletCannotReenterWhileItIsPaid() public {
        _fund(1 ether);
        Reenterer r = new Reenterer();
        vm.prank(address(r));
        desk.register();
        _bond(address(r), 0.5 ether);
        uint256 a = _lock(address(r), 1 ether, true);
        uint256 b = _lock(address(r), 1 ether, true);

        // paid by a draw, it tries to draw again on the other job
        r.arm(abi.encodeCall(FactorDesk.draw, (b, 0.5 ether, FactorDesk.Kind.Pool)));
        vm.prank(address(r));
        desk.draw(a, 0.1 ether, FactorDesk.Kind.Pool);
        assertFalse(r.reentrySucceeded());
        assertEq(desk.out(), 0.1 ether, "one advance, not two");

        // paid by a settlement, it tries to take its bond
        r.arm(abi.encodeCall(FactorDesk.takeBond, (0.5 ether)));
        _deliver(address(r), a);
        _accept(a);
        assertFalse(r.reentrySucceeded());
        assertEq(desk.agent(address(r)).bond, 0.5 ether);

        // paid its bond back, it tries to take the same bond a second time
        r.arm(abi.encodeCall(FactorDesk.takeBond, (0.25 ether)));
        vm.prank(address(r));
        desk.takeBond(0.25 ether);
        assertTrue(r.reentered(), "it did try");
        assertFalse(r.reentrySucceeded());
        assertEq(desk.agent(address(r)).bond, 0.25 ether, "taken once");
        assertEq(desk.owedTotal(), 0);
        _books();
    }

    // ---------- the score ----------

    function test_theScoreFollowsTheFormula() public {
        _fund(1 ether);
        assertEq(desk.score(agentA), 0);
        // two settled jobs of 1 ETH from two customers, one with an advance repaid
        _bond(agentA, 0.1 ether);
        uint256 one = _lock(agentA, 1 ether, false);
        _draw(agentA, one, 0.1 ether, FactorDesk.Kind.Pool);
        _deliver(agentA, one);
        _accept(one);
        uint256 two = _lockFrom(other, agentA, 1 ether, false);
        _deliver(agentA, two);
        _accept(two);
        // fees 0.04 ETH: 80. customers 2: 50. jobs 2: 20. advances repaid 1: 10. no days yet.
        assertEq(desk.score(agentA), 160);
        vm.warp(block.timestamp + 3 days + 1 hours);
        assertEq(desk.score(agentA), 166, "two points a day since its first settled job");

        // a rejected job takes 50 off (and its fee on the half adds: 0.01 ETH is 20 more)
        uint256 three = _lock(agentA, 1 ether, false);
        _deliver(agentA, three);
        vm.prank(customer);
        desk.reject(three);
        assertEq(desk.score(agentA), 166 + 20 - 50);

        // a job it never answered costs it nothing but the days that pass
        uint256 four = _lock(agentA, 1 ether, false);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        desk.refund(four);
        assertEq(desk.score(agentA), 166 + 20 - 50 + 2);

        // a job it drew on and did not deliver ends the score
        uint256 five = _lock(agentA, 1 ether, true);
        _draw(agentA, five, 0.001 ether, FactorDesk.Kind.Early);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        desk.refund(five);
        assertEq(desk.score(agentA), 0);
        assertEq(desk.agent(agentA).notDelivered, 1);
    }

    /// A customer counts once its settled jobs with the agent have paid 0.001 ETH in fees, which is 0.05 ETH of
    /// work. Dust jobs from many wallets make no customers.
    function test_aCustomerCountsOnlyOnceItsJobsHavePaidRealFees() public {
        // twenty wallets, one smallest job each: twenty settled jobs and not one customer
        for (uint256 i = 0; i < 20; ++i) {
            address c = address(uint160(0xD057 + i));
            uint256 id = _lockFrom(c, agentA, 0.001 ether, false);
            _deliver(agentA, id);
            vm.prank(c);
            desk.accept(id);
        }
        assertEq(desk.agent(agentA).settled, 20);
        assertEq(desk.agent(agentA).customers, 0);

        // one customer, small jobs: it counts when their fees add up to the floor, and it counts once
        for (uint256 i = 0; i < 4; ++i) {
            uint256 id = _lock(agentA, 0.02 ether, false);
            _deliver(agentA, id);
            _accept(id);
            assertEq(desk.agent(agentA).customers, i < 2 ? 0 : 1, "three jobs of 0.02 reach 0.0012 in fees");
        }
        assertEq(desk.feesFrom(agentA, customer), 0.0016 ether);

        // a rejected job pays a fee to the pool but does not make its customer count
        uint256 half = _lockFrom(other, agentA, 1 ether, false);
        _deliver(agentA, half);
        vm.prank(other);
        desk.reject(half);
        assertEq(desk.agent(agentA).customers, 1);
        assertEq(desk.feesFrom(agentA, other), 0);

        // and one job of 0.05 ETH is exactly enough
        uint256 exact = _lockFrom(other, agentA, 0.05 ether, false);
        _deliver(agentA, exact);
        vm.prank(other);
        desk.accept(exact);
        assertEq(desk.agent(agentA).customers, 2);
    }

    function test_theScoreStopsAtItsCaps() public {
        // 21 settled jobs of 10 ETH from 11 customers: every part but the days is past its cap
        for (uint256 i = 0; i < 21; ++i) {
            address c = address(uint160(0xC000 + (i % 11)));
            uint256 id = _lockFrom(c, agentA, 10 ether, false);
            _deliver(agentA, id);
            vm.prank(c);
            desk.accept(id);
        }
        assertEq(desk.agent(agentA).customers, 11);
        assertEq(desk.score(agentA), 350 + 250 + 200);
        vm.warp(block.timestamp + 400 days);
        assertEq(desk.score(agentA), 350 + 250 + 200 + 100);
    }

    // ---------- every wei, for any job ----------

    /// Any price, any mix of advances, any of the four endings: the customer, the agent, the gateway, the burn pot
    /// and the pool between them hold exactly what went in, the books are exact and nothing is left out.
    function testFuzz_everyWeiOfAJobIsAccountedFor(
        uint256 price,
        uint16 earlyBps,
        uint16 poolBps,
        uint8 ending,
        bool compute
    ) public {
        price = bound(price, 0.001 ether, 1000 ether);
        earlyBps = uint16(bound(earlyBps, 0, 5000));
        poolBps = uint16(bound(poolBps, 0, 5000 - earlyBps));
        ending = ending % 4;
        _fund(10_000 ether);
        _bond(agentA, price); // a bond that covers any advance on this job
        uint256 id = _lock(agentA, price, true);
        uint256 half = (price * 5000) / 10_000;
        uint256 early = (price * earlyBps) / 10_000;
        uint256 fromPool = (price * poolBps) / 10_000;
        if (early + fromPool > half) fromPool = half - early;
        if (early > 0) _draw(agentA, id, early, FactorDesk.Kind.Early);
        if (fromPool > 0) _draw(agentA, id, fromPool, compute ? FactorDesk.Kind.Compute : FactorDesk.Kind.Pool);
        _books();

        if (ending == 0) {
            _deliver(agentA, id);
            _accept(id);
        } else if (ending == 1) {
            _deliver(agentA, id);
            vm.warp(block.timestamp + 24 hours);
            desk.settle(id);
        } else if (ending == 2) {
            _deliver(agentA, id);
            vm.prank(customer);
            desk.reject(id);
        } else {
            vm.warp(block.timestamp + 1 days + 12 hours + 1);
            desk.refund(id);
        }

        _books();
        assertEq(desk.held(), 0, "a closed job holds nothing");
        assertEq(desk.out(), 0, "and has nothing out");
        assertEq(desk.owedTotal(), 0);
        assertGe(desk.pool(), 10_000 ether, "the pool never ends below where it started when the bond covers it");
        assertEq(desk.totalLost(), 0);
        // what went in: the price and the bond. Where it is now:
        assertEq(
            customer.balance + agentA.balance + gateway.balance + address(burnPot).balance
                + (desk.pool() - 10_000 ether) + desk.bonds(),
            price + price,
            "nothing lost, nothing made"
        );
        if (ending == 2) assertEq(customer.balance, (price * 5000) / 10_000, "a rejection is half back, exactly");
        if (ending == 3) assertEq(customer.balance, price - early, "a refund is everything but the early advance");
        if (ending < 2) assertEq(customer.balance, 0);
    }
}
