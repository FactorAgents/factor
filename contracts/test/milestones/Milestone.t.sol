// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MilestoneBase} from "./MilestoneBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorMilestones} from "../../src/FactorMilestones.sol";
import {Rejecter} from "../mocks/Actors.sol";

/// Every rule of docs/MILESTONES.md, one by one, with its examples to the wei.
contract MilestoneTest is MilestoneBase {
    // ---------- the contract ----------

    function test_readsTheDesk() public view {
        assertEq(address(m.desk()), address(desk));
        assertGe(m.MIN_STAGE(), desk.MIN_JOB());
        assertGe(m.MIN_TIME(), desk.MIN_DUE());
        assertLe(m.MAX_TIME(), desk.MAX_DUE());
    }

    function test_numbers() public view {
        assertEq(m.MIN_STAGES(), 2);
        assertEq(m.MAX_STAGES(), 6);
        assertEq(m.MIN_STAGE(), 0.001 ether);
        assertEq(m.MIN_TIME(), 1 hours);
        assertEq(m.MAX_TIME(), 30 days);
    }

    function test_constructor_refusesNoDesk() public {
        vm.expectRevert(FactorMilestones.ZeroAddress.selector);
        new FactorMilestones(FactorDesk(payable(address(0))));
    }

    function test_constructor_refusesADeskWhoseRulesDoNotFit() public {
        vm.mockCall(address(desk), abi.encodeWithSignature("MIN_JOB()"), abi.encode(0.002 ether));
        vm.expectRevert(FactorMilestones.DeskRules.selector);
        new FactorMilestones(desk);
        vm.clearMockedCalls();
        vm.mockCall(address(desk), abi.encodeWithSignature("MIN_DUE()"), abi.encode(2 hours));
        vm.expectRevert(FactorMilestones.DeskRules.selector);
        new FactorMilestones(desk);
        vm.clearMockedCalls();
        vm.mockCall(address(desk), abi.encodeWithSignature("MAX_DUE()"), abi.encode(29 days));
        vm.expectRevert(FactorMilestones.DeskRules.selector);
        new FactorMilestones(desk);
    }

    function test_takesEthOnlyFromTheDesk() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(m).call{value: 1}("");
        assertFalse(ok, "a stranger's ETH is refused");
        vm.deal(address(desk), address(desk).balance + 1);
        vm.prank(address(desk));
        (ok,) = address(m).call{value: 1}("");
        assertTrue(ok, "the desk's is taken");
    }

    // ---------- posting ----------

    function test_post_locksTheWholeBudgetAndOpensTheFirstStage() public {
        uint256 id = _post3();
        FactorMilestones.Plan memory p = m.plan(id);
        assertEq(id, 1);
        assertEq(m.planCount(), 1);
        assertEq(p.customer, hirer);
        assertEq(p.agent, agentA);
        assertEq(p.count, 3);
        assertEq(p.current, 0);
        assertEq(uint8(p.state), uint8(FactorMilestones.State.Running));
        assertFalse(p.allowEarly);
        assertEq(p.total, 0.006 ether, "the whole budget");
        assertEq(p.left, 0.005 ether, "the two later stages are held here");
        assertEq(p.terms, TERMS);
        FactorMilestones.Stage[] memory s = m.stages(id);
        assertEq(s.length, 3);
        assertEq(s[0].price, 0.001 ether);
        assertEq(s[1].price, 0.002 ether);
        assertEq(s[2].price, 0.003 ether);
        assertEq(s[0].time, 1 days);
        assertEq(s[2].time, 3 days);
        assertEq(s[1].job, 0, "a later stage is not on the desk yet");
        // the first stage is a desk job, with this contract as its customer
        uint256 job = s[0].job;
        assertEq(job, 1);
        assertEq(m.currentJob(id), job);
        assertEq(m.planOfJob(job), id);
        FactorDesk.Job memory j = desk.job(job);
        assertEq(j.customer, address(m));
        assertEq(j.agent, agentA);
        assertEq(j.price, 0.001 ether);
        assertEq(j.dueAt, block.timestamp + 1 days);
        assertFalse(j.allowEarly);
        assertEq(uint8(j.state), uint8(FactorDesk.State.Locked));
        assertEq(address(m).balance, 0.005 ether);
        assertEq(m.held(), 0.005 ether);
        assertEq(m.atDesk(), 0.001 ether);
        assertEq(m.totalBudgets(), 0.006 ether);
        _mbooks();
    }

    function test_post_emits() public {
        vm.deal(hirer, 1 ether);
        vm.expectEmit(true, true, true, true, address(m));
        emit FactorMilestones.Posted(1, hirer, agentA, 0.002 ether, true, TERMS, _same(2, STAGE), _same(2, 1 days));
        vm.expectEmit(true, true, false, true, address(m));
        emit FactorMilestones.Opened(1, 0, 1, 0.001 ether, block.timestamp + 1 days);
        vm.prank(hirer);
        m.post{value: 0.002 ether}(agentA, _same(2, STAGE), _same(2, 1 days), true, TERMS);
    }

    function test_post_twoToSixStages() public {
        vm.deal(hirer, 1 ether);
        vm.startPrank(hirer);
        vm.expectRevert(FactorMilestones.BadStages.selector);
        m.post{value: 0.001 ether}(agentA, _same(1, STAGE), _same(1, 1 days), false, TERMS);
        vm.expectRevert(FactorMilestones.BadStages.selector);
        m.post{value: 0.007 ether}(agentA, _same(7, STAGE), _same(7, 1 days), false, TERMS);
        vm.expectRevert(FactorMilestones.BadStages.selector);
        m.post{value: 0}(agentA, new uint256[](0), new uint256[](0), false, TERMS);
        uint256 id = m.post{value: 0.006 ether}(agentA, _same(6, STAGE), _same(6, 30 days), false, TERMS);
        vm.stopPrank();
        assertEq(m.plan(id).count, 6);
        assertEq(m.stages(id).length, 6);
    }

    function test_post_aTimeForEveryStage() public {
        vm.deal(hirer, 1 ether);
        vm.prank(hirer);
        vm.expectRevert(FactorMilestones.BadStages.selector);
        m.post{value: 0.002 ether}(agentA, _same(2, STAGE), _same(3, 1 days), false, TERMS);
    }

    function test_post_refusesAStageUnderTheDesksSmallestJob() public {
        vm.deal(hirer, 1 ether);
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(FactorMilestones.TooSmall.selector, 0.001 ether));
        m.post{value: 0.002 ether - 1}(agentA, _list(STAGE, STAGE - 1), _same(2, 1 days), false, TERMS);
    }

    function test_post_everyTimeFromAnHourToThirtyDays() public {
        vm.deal(hirer, 1 ether);
        vm.startPrank(hirer);
        vm.expectRevert(FactorMilestones.BadTime.selector);
        m.post{value: 0.002 ether}(agentA, _same(2, STAGE), _list(1 hours - 1, 1 days), false, TERMS);
        vm.expectRevert(FactorMilestones.BadTime.selector);
        m.post{value: 0.002 ether}(agentA, _same(2, STAGE), _list(1 days, 30 days + 1), false, TERMS);
        m.post{value: 0.002 ether}(agentA, _same(2, STAGE), _list(1 hours, 30 days), false, TERMS);
        vm.stopPrank();
        assertEq(desk.job(1).dueAt, block.timestamp + 1 hours, "an hour is the desk's shortest");
    }

    function test_post_refusesNoTermsNoAgentAndAnUnregisteredAgent() public {
        vm.deal(hirer, 1 ether);
        vm.startPrank(hirer);
        vm.expectRevert(FactorMilestones.NoTerms.selector);
        m.post{value: 0.002 ether}(agentA, _same(2, STAGE), _same(2, 1 days), false, bytes32(0));
        // the desk's own refusal, at the first stage's lock: nothing is kept
        vm.expectRevert(FactorDesk.NotRegistered.selector);
        m.post{value: 0.002 ether}(address(0), _same(2, STAGE), _same(2, 1 days), false, TERMS);
        vm.expectRevert(FactorDesk.NotRegistered.selector);
        m.post{value: 0.002 ether}(stranger, _same(2, STAGE), _same(2, 1 days), false, TERMS);
        vm.stopPrank();
        assertEq(m.planCount(), 0);
        assertEq(address(m).balance, 0);
    }

    function test_post_refusesTheWrongValue() public {
        vm.deal(hirer, 1 ether);
        vm.startPrank(hirer);
        vm.expectRevert(abi.encodeWithSelector(FactorMilestones.WrongValue.selector, 0.002 ether));
        m.post{value: 0.001 ether}(agentA, _same(2, STAGE), _same(2, 1 days), false, TERMS);
        vm.expectRevert(abi.encodeWithSelector(FactorMilestones.WrongValue.selector, 0.002 ether));
        m.post{value: 0.002 ether + 1}(agentA, _same(2, STAGE), _same(2, 1 days), false, TERMS);
    }

    function test_post_theEarlyHalfGoesToEveryStage() public {
        uint256 id = _post(hirer, agentA, _same(2, STAGE), _same(2, 1 days), true);
        assertTrue(m.plan(id).allowEarly);
        assertTrue(desk.job(_job(id)).allowEarly);
        _passStage(id);
        assertTrue(desk.job(_job(id)).allowEarly, "the second stage too");
    }

    function test_post_aCustomerCanHireItselfAsOnTheDesk() public {
        uint256 id = _post(agentA, agentA, _same(2, STAGE), _same(2, 1 days), false);
        assertEq(m.plan(id).customer, agentA);
    }

    // ---------- accepting ----------

    function test_accept_paysTheStageThroughTheDeskAndOpensTheNext() public {
        uint256 id = _post3();
        uint256 job1 = _deliverStage(id);
        uint256 before = agentA.balance;
        uint256 pool = desk.pool();
        vm.warp(block.timestamp + 5 hours);
        vm.expectEmit(true, true, false, true, address(m));
        emit FactorMilestones.StagePaid(id, 0, job1, 0.001 ether);
        vm.expectEmit(true, true, false, true, address(m));
        emit FactorMilestones.Opened(id, 1, job1 + 1, 0.002 ether, block.timestamp + 2 days);
        _acceptStage(id);
        assertEq(uint8(desk.job(job1).state), uint8(FactorDesk.State.Settled));
        assertEq(agentA.balance - before, 0.00098 ether, "98% of the stage");
        assertEq(desk.pool() - pool, 0.00002 ether, "the 2% job fee to the pool");
        FactorMilestones.Plan memory p = m.plan(id);
        assertEq(p.current, 1);
        assertEq(p.left, 0.003 ether);
        uint256 job2 = _job(id);
        assertEq(job2, job1 + 1);
        assertEq(desk.job(job2).price, 0.002 ether);
        assertEq(desk.job(job2).dueAt, block.timestamp + 2 days, "its time counts from the acceptance");
        assertEq(m.planOfJob(job2), id);
        assertEq(m.held(), 0.003 ether);
        assertEq(m.atDesk(), 0.002 ether);
        assertEq(m.totalPaid(), 0.001 ether);
        _mbooks();
    }

    function test_accept_everyStagePaidThePlanIsDone() public {
        uint256 id = _post3();
        _passStage(id);
        _passStage(id);
        uint256 job3 = _deliverStage(id);
        uint256 before = agentA.balance;
        vm.expectEmit(true, true, false, true, address(m));
        emit FactorMilestones.Ended(id, FactorMilestones.State.Done, 2, job3, 0, 0);
        _acceptStage(id);
        assertEq(agentA.balance - before, 0.00294 ether);
        assertEq(uint8(_stateOf(id)), uint8(FactorMilestones.State.Done));
        assertEq(m.plan(id).current, 2);
        assertEq(m.currentJob(id), job3);
        assertEq(address(m).balance, 0, "nothing is left");
        assertEq(m.held(), 0);
        assertEq(m.atDesk(), 0);
        assertEq(m.totalPaid(), 0.006 ether);
        assertEq(m.totalReturned(), 0);
        _mbooks();
    }

    /// docs/MILESTONES.md section 4, the example: 0.001, 0.002 and 0.003.
    function test_example_threeStagesToTheWei() public {
        uint256 start = agentA.balance;
        uint256 pool = desk.pool();
        uint256 id = _post3();
        _passStage(id);
        _passStage(id);
        _passStage(id);
        assertEq(agentA.balance - start, 0.00588 ether, "0.00098 + 0.00196 + 0.00294");
        assertEq(desk.pool() - pool, 0.00012 ether, "0.00002 + 0.00004 + 0.00006");
        FactorDesk.Agent memory a = desk.agent(agentA);
        assertEq(a.settled, 3, "every stage counts on the record");
        assertEq(a.onTime, 3);
        assertEq(a.volume, 0.006 ether);
        assertEq(a.feesPaid, 0.00012 ether);
        assertEq(desk.score(agentA), 30 + 0, "10 per settled job; the fees are under a point");
        (uint32 accepted,) = desk.customers(address(m));
        assertEq(accepted, 3, "the contract is the desk's customer");
    }

    function test_accept_onlyTheCustomer() public {
        uint256 id = _post();
        _deliverStage(id);
        vm.prank(agentA);
        vm.expectRevert(FactorMilestones.NotCustomer.selector);
        m.accept(id);
        vm.prank(stranger);
        vm.expectRevert(FactorMilestones.NotCustomer.selector);
        m.accept(id);
    }

    function test_accept_onlyADeliveredStage() public {
        uint256 id = _post();
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Locked));
        m.accept(id);
    }

    function test_accept_notAfterThePlanEnded() public {
        uint256 id = _post();
        _passStage(id);
        _passStage(id);
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(FactorMilestones.WrongState.selector, FactorMilestones.State.Done));
        m.accept(id);
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(FactorMilestones.WrongState.selector, FactorMilestones.State.None));
        m.accept(99);
    }

    function test_accept_aLateDeliveryCountsAndIsMarkedLate() public {
        uint256 id = _post();
        vm.warp(block.timestamp + 1 days + 6 hours);
        _passStage(id);
        assertEq(desk.agent(agentA).late, 1);
        assertEq(desk.job(_job(id)).dueAt, block.timestamp + 1 days, "the next stage has its whole time");
    }

    // ---------- the customer's 24 hours ----------

    function test_step_settlesAfterTheCustomersDayAndOpensTheNext() public {
        uint256 id = _post();
        uint256 job1 = _deliverStage(id);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.TooSoon.selector, block.timestamp + 24 hours));
        m.step(id);
        vm.warp(block.timestamp + 24 hours);
        uint256 before = agentA.balance;
        vm.prank(stranger);
        m.step(id);
        assertEq(uint8(desk.job(job1).state), uint8(FactorDesk.State.Settled));
        assertEq(agentA.balance - before, 0.00098 ether);
        assertEq(m.plan(id).current, 1);
        assertEq(desk.job(_job(id)).dueAt, block.timestamp + 1 days);
        _mbooks();
    }

    function test_step_aStageTheDeskSettledByItselfOpensTheNext() public {
        uint256 id = _post();
        uint256 job1 = _deliverStage(id);
        vm.warp(block.timestamp + 24 hours);
        desk.settle(job1);
        assertEq(m.plan(id).current, 0, "the plan waits for a step");
        assertEq(m.atDesk(), STAGE);
        m.step(id);
        assertEq(m.plan(id).current, 1);
        _mbooks();
    }

    // ---------- a missed due time ----------

    function test_step_aMissedStageAndTheRestGoBack() public {
        uint256 id = _post3();
        uint256 job1 = _job(id);
        vm.warp(block.timestamp + 1 days + 12 hours);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.TooSoon.selector, block.timestamp + 1));
        m.step(id);
        vm.warp(block.timestamp + 1);
        uint256 before = hirer.balance;
        vm.expectEmit(true, true, false, true, address(m));
        emit FactorMilestones.Ended(id, FactorMilestones.State.Missed, 0, job1, 0.001 ether, 0.005 ether);
        vm.prank(stranger);
        m.step(id);
        assertEq(uint8(desk.job(job1).state), uint8(FactorDesk.State.Refunded));
        assertEq(hirer.balance - before, 0.006 ether, "every wei back");
        assertEq(uint8(_stateOf(id)), uint8(FactorMilestones.State.Missed));
        assertEq(desk.agent(agentA).unanswered, 1, "a stage it never touched costs it nothing");
        assertEq(m.plan(id).left, 0);
        assertEq(m.held(), 0);
        assertEq(m.atDesk(), 0);
        assertEq(m.totalReturned(), 0.006 ether);
        assertEq(address(m).balance, 0);
        _mbooks();
    }

    function test_step_aMissInALaterStage() public {
        uint256 id = _post3();
        _passStage(id);
        uint256 job2 = _job(id);
        _pastDue(id);
        uint256 before = hirer.balance;
        m.step(id);
        assertEq(uint8(desk.job(job2).state), uint8(FactorDesk.State.Refunded));
        assertEq(hirer.balance - before, 0.005 ether, "the second and third stages");
        assertEq(m.plan(id).current, 1);
        assertEq(m.totalPaid(), 0.001 ether);
        assertEq(m.totalReturned(), 0.005 ether);
        assertEq(desk.agent(agentA).settled, 1, "the first stage stays paid");
        _mbooks();
    }

    function test_step_aMissWithTheEarlyHalfDrawn() public {
        uint256 id = _post(hirer, agentA, _same(2, 0.002 ether), _same(2, 1 days), true);
        uint256 job = _job(id);
        _draw(agentA, job, 0.001 ether, FactorDesk.Kind.Early);
        _pastDue(id);
        uint256 before = hirer.balance;
        m.step(id);
        assertEq(hirer.balance - before, 0.001 ether + 0.002 ether, "the stage less its early half, and the rest");
        assertTrue(desk.agent(agentA).barred, "the desk bars an agent that kept an early advance");
        assertEq(desk.agent(agentA).earlyKept, 1);
        _mbooks();
    }

    function test_step_aMissWithAPoolAdvance() public {
        _fund(1 ether);
        _bond(agentA, 0.001 ether);
        uint256 id = _post(hirer, agentA, _same(2, 0.002 ether), _same(2, 1 days), false);
        _draw(agentA, _job(id), 0.001 ether, FactorDesk.Kind.Pool);
        _pastDue(id);
        uint256 before = hirer.balance;
        m.step(id);
        assertEq(hirer.balance - before, 0.004 ether, "refunded in full, as on the desk");
        assertTrue(desk.agent(agentA).barred);
        assertEq(desk.agent(agentA).advancesNotRepaid, 1);
        _mbooks();
    }

    function test_step_aStageTheDeskRefundedByItselfIsTakenUp() public {
        uint256 id = _post();
        uint256 job = _job(id);
        _pastDue(id);
        desk.refund(job);
        _mbooks(STAGE);
        uint256 before = hirer.balance;
        m.step(id);
        assertEq(hirer.balance - before, 0.002 ether);
        _mbooks();
    }

    // ---------- a decline ----------

    function test_step_aDeclinedStageAndTheRestGoBack() public {
        uint256 id = _post3();
        _passStage(id);
        uint256 job2 = _job(id);
        vm.prank(agentA);
        desk.decline(job2);
        _mbooks(0.002 ether);
        uint256 before = hirer.balance;
        vm.expectEmit(true, true, false, true, address(m));
        emit FactorMilestones.Ended(id, FactorMilestones.State.Declined, 1, job2, 0.002 ether, 0.003 ether);
        m.step(id);
        assertEq(hirer.balance - before, 0.005 ether);
        assertEq(uint8(_stateOf(id)), uint8(FactorMilestones.State.Declined));
        _mbooks();
    }

    // ---------- a reject ----------

    function test_reject_halfOfTheStageAndTheRestGoBack() public {
        uint256 id = _post3();
        _passStage(id);
        uint256 job2 = _deliverStage(id);
        uint256 hirerBefore = hirer.balance;
        uint256 agentBefore = agentA.balance;
        vm.expectEmit(true, true, false, true, address(m));
        emit FactorMilestones.Ended(id, FactorMilestones.State.Rejected, 1, job2, 0.001 ether, 0.003 ether);
        vm.prank(hirer);
        m.reject(id);
        assertEq(uint8(desk.job(job2).state), uint8(FactorDesk.State.SettledAtHalf));
        assertEq(hirer.balance - hirerBefore, 0.001 ether + 0.003 ether, "half of the stage, and the third stage");
        assertEq(agentA.balance - agentBefore, 0.00098 ether, "the agent's half less the 2% fee on it");
        assertEq(desk.agent(agentA).settledAtHalf, 1);
        assertEq(uint8(_stateOf(id)), uint8(FactorMilestones.State.Rejected));
        assertEq(m.totalReturned(), 0.004 ether);
        _mbooks();
    }

    function test_reject_onlyTheCustomerWithinItsDay() public {
        uint256 id = _post();
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Locked));
        m.reject(id);
        _deliverStage(id);
        vm.prank(stranger);
        vm.expectRevert(FactorMilestones.NotCustomer.selector);
        m.reject(id);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(hirer);
        vm.expectRevert(FactorDesk.TooLate.selector);
        m.reject(id);
    }

    function test_step_refusesAPlanThatEnded() public {
        uint256 id = _post();
        _passStage(id);
        _passStage(id);
        vm.expectRevert(abi.encodeWithSelector(FactorMilestones.WrongState.selector, FactorMilestones.State.Done));
        m.step(id);
        vm.expectRevert(abi.encodeWithSelector(FactorMilestones.WrongState.selector, FactorMilestones.State.None));
        m.step(7);
    }

    function test_step_aStageNotDueYetIsLeftToTheDesk() public {
        uint256 id = _post();
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.TooSoon.selector, block.timestamp + 1 days + 12 hours + 1));
        m.step(id);
    }

    // ---------- advances per stage ----------

    function test_advances_eachStageAsAnyDeskJob() public {
        _fund(1 ether);
        _bond(agentA, 0.01 ether);
        uint256 id = _post(hirer, agentA, _same(2, 0.01 ether), _same(2, 1 days), true);
        uint256 job1 = _job(id);
        (uint256 early, uint256 fromPool) = desk.canDrawOn(job1);
        assertEq(early, 0.005 ether);
        assertEq(fromPool, 0.005 ether);
        uint256 pot = address(burnPot).balance;
        _draw(agentA, job1, 0.002 ether, FactorDesk.Kind.Early);
        _draw(agentA, job1, 0.003 ether, FactorDesk.Kind.Pool);
        assertEq(address(burnPot).balance - pot, 0.00005 ether, "1% of each advance to the burn pot");
        uint256 before = agentA.balance;
        _passStage(id);
        assertEq(agentA.balance - before, 0.01 ether - 0.002 ether - 0.003 ether - 0.0002 ether, "the rest, less the fee");
        assertEq(desk.agent(agentA).advancesRepaid, 1);
        assertEq(desk.agent(agentA).advancedNow, 0, "the pool was repaid first");
        (early, fromPool) = desk.canDrawOn(_job(id));
        assertEq(early, 0.005 ether, "the next stage has its own half");
        _mbooks();
    }

    function test_advances_noneOnAStageNotStarted() public {
        uint256 id = _post();
        (uint256 early, uint256 fromPool) = desk.canDrawOn(_job(id) + 1);
        assertEq(early + fromPool, 0, "the second stage is not a desk job yet");
    }

    // ---------- a refused payout ----------

    function test_owed_aCustomerThatRefusesEthBlocksNobody() public {
        Rejecter r = new Rejecter();
        uint256 id = _post(address(r), agentA, _same(2, STAGE), _same(2, 1 days), false);
        _pastDue(id);
        vm.expectEmit(true, false, false, true, address(m));
        emit FactorMilestones.Owed(address(r), 0.002 ether);
        m.step(id);
        assertEq(m.owed(address(r)), 0.002 ether);
        assertEq(m.owedTotal(), 0.002 ether);
        _mbooks();
        vm.expectRevert(FactorMilestones.PushFailed.selector);
        m.collect(address(r));
        r.setAccept(true);
        m.collect(address(r));
        assertEq(address(r).balance, 0.002 ether);
        assertEq(m.owedTotal(), 0);
        vm.expectRevert(FactorMilestones.NothingOwed.selector);
        m.collect(address(r));
        _mbooks();
    }

    function test_owed_collectTo() public {
        Rejecter r = new Rejecter();
        uint256 id = _post(address(r), agentA, _same(2, STAGE), _same(2, 1 days), false);
        _pastDue(id);
        m.step(id);
        vm.prank(address(r));
        vm.expectRevert(FactorMilestones.ZeroAddress.selector);
        m.collectTo(payable(address(0)));
        vm.prank(address(r));
        m.collectTo(payable(other));
        assertEq(other.balance, 0.002 ether);
        _mbooks();
    }

    // ---------- a line account as the agent ----------

    function test_lineAccount_takesStagesThroughItsKey() public {
        address key = agentB;
        FactorLineAccount acct = _open(key);
        uint256 id = _post(hirer, address(acct), _same(2, STAGE), _same(2, 1 days), false);
        for (uint256 i = 0; i < 2; ++i) {
            uint256 job = _job(id);
            vm.prank(key);
            acct.deliver(job, keccak256("the stage"));
            _acceptStage(id);
        }
        assertEq(uint8(_stateOf(id)), uint8(FactorMilestones.State.Done));
        assertEq(address(acct).balance, 0.00196 ether, "the payouts land in the account");
        assertEq(desk.agent(address(acct)).settled, 2);
        _mbooks();
    }

    // ---------- the record ----------

    function test_record_theContractIsOneCustomerToTheDesk() public {
        // 25 plans of two 0.025 stages: 1 ETH of work, 0.02 in fees, which would make many customers if hired directly
        for (uint256 i = 0; i < 25; ++i) {
            address c = makeAddr(string.concat("customer ", vm.toString(i)));
            uint256 id = _post(c, agentA, _same(2, 0.025 ether), _same(2, 1 days), false);
            _passStage(id);
            _passStage(id);
        }
        FactorDesk.Agent memory a = desk.agent(agentA);
        assertEq(a.settled, 50);
        assertEq(a.customers, 1, "every stage comes from this one contract");
    }

    // ---------- fuzzed ----------

    function testFuzz_everyStagePaid(uint8 n, uint256 seed) public {
        uint256 count = bound(n, 2, 6);
        uint256[] memory prices = new uint256[](count);
        uint256[] memory times = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            prices[i] = bound(uint256(keccak256(abi.encode(seed, i))), 0.001 ether, 10 ether);
            times[i] = bound(uint256(keccak256(abi.encode(seed, i, "t"))), 1 hours, 30 days);
        }
        uint256 total = _sum(prices);
        uint256 fees;
        for (uint256 i = 0; i < count; ++i) {
            fees += (prices[i] * 200) / 10_000;
        }
        uint256 before = agentB.balance;
        uint256 pool = desk.pool();
        uint256 id = _post(hirer, agentB, prices, times, false);
        for (uint256 i = 0; i < count; ++i) {
            assertEq(desk.job(_job(id)).dueAt, block.timestamp + times[i]);
            vm.warp(block.timestamp + times[i] / 2);
            _passStage(id);
        }
        assertEq(agentB.balance - before, total - fees);
        assertEq(desk.pool() - pool, fees);
        assertEq(desk.agent(agentB).settled, count);
        assertEq(address(m).balance, 0);
        _mbooks();
    }

    function testFuzz_aMissAtAnyStage(uint8 n, uint8 at, uint256 seed) public {
        uint256 count = bound(n, 2, 6);
        uint256 miss = bound(at, 0, count - 1);
        uint256[] memory prices = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            prices[i] = bound(uint256(keccak256(abi.encode(seed, i))), 0.001 ether, 1 ether);
        }
        uint256 id = _post(hirer, agentB, prices, _same(count, 2 days), false);
        for (uint256 i = 0; i < miss; ++i) {
            _passStage(id);
        }
        uint256 back;
        for (uint256 i = miss; i < count; ++i) {
            back += prices[i];
        }
        _pastDue(id);
        uint256 before = hirer.balance;
        m.step(id);
        assertEq(hirer.balance - before, back, "the stage missed and every one after it");
        assertEq(m.held(), 0);
        assertEq(m.atDesk(), 0);
        assertEq(address(m).balance, 0);
        _mbooks();
    }
}
