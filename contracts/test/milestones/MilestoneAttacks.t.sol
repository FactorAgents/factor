// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MilestoneBase} from "./MilestoneBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorMilestones} from "../../src/FactorMilestones.sol";
import {Rejecter, GasEater, Reenterer, ForceSend} from "../mocks/Actors.sol";

/// A wallet that refuses ETH until it is armed, then takes it and calls back in with all the gas it has.
contract MFlipper {
    bytes public armed;
    bool public reentered;
    bool public succeeded;

    function arm(bytes calldata data) external {
        armed = data;
    }

    receive() external payable {
        if (armed.length == 0) revert("no");
        reentered = true;
        (bool ok,) = msg.sender.call(armed);
        succeeded = ok;
    }
}

/// Every attack in section 8 of docs/MILESTONES.md, carried out against the milestone contract and the desk together.
contract MilestoneAttacksTest is MilestoneBase {
    /// 1. The customer never answers, to hold the agent's pay: the desk's 24 hours pass, anyone settles, and the next
    ///    stage opens at once.
    function test_attack1_theCustomerNeverAnswers() public {
        uint256 id = _post();
        _deliverStage(id);
        vm.warp(block.timestamp + 24 hours);
        uint256 before = agentA.balance;
        vm.prank(agentA);
        m.step(id);
        assertEq(agentA.balance - before, 0.00098 ether);
        assertEq(m.plan(id).current, 1);
        _deliverStage(id);
        vm.warp(block.timestamp + 24 hours);
        m.step(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorMilestones.State.Done));
        _mbooks();
    }

    /// 2. The customer rejects to pay half: it can, by the desk's own rule, once. A reject ends the plan, so it cannot go
    ///    on paying half for every stage, and the agent keeps half of the stage it delivered.
    function test_attack2_aRejectEndsThePlan() public {
        uint256 id = _post3();
        _passStage(id);
        _deliverStage(id);
        vm.prank(hirer);
        m.reject(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorMilestones.State.Rejected));
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorMilestones.WrongState.selector, FactorMilestones.State.Rejected));
        m.step(id);
        assertEq(desk.agent(agentA).settled, 1);
        assertEq(desk.agent(agentA).settledAtHalf, 1);
        _mbooks();
    }

    /// 3. The agent never delivers, to hold the budget: after the due time and the grace anyone sends it all back.
    function test_attack3_theAgentNeverDelivers() public {
        uint256 id = _post3();
        _pastDue(id);
        uint256 before = hirer.balance;
        vm.prank(stranger);
        m.step(id);
        assertEq(hirer.balance - before, 0.006 ether);
        _mbooks();
    }

    /// 4. The agent draws the early half of every stage and vanishes: only the stage on the desk can be drawn on. The
    ///    stages after it are not desk jobs yet.
    function test_attack4_onlyTheStageOnTheDeskCanBeDrawnOn() public {
        uint256 id = _post(hirer, agentA, _same(3, 0.002 ether), _same(3, 1 days), true);
        uint256 job1 = _job(id);
        _draw(agentA, job1, 0.001 ether, FactorDesk.Kind.Early);
        vm.prank(agentA);
        vm.expectRevert(FactorDesk.NotAgent.selector);
        desk.draw(job1 + 1, 0.001 ether, FactorDesk.Kind.Early);
        _pastDue(id);
        uint256 before = hirer.balance;
        m.step(id);
        assertEq(hirer.balance - before, 0.001 ether + 0.004 ether, "all but the half it drew");
        _mbooks();
    }

    /// 5. Re-entry from an agent paid by the desk, in the middle of an accept: it is refused, and the stage still opens.
    function test_attack5_reentry_fromTheAgentOnItsPay() public {
        Reenterer r = new Reenterer();
        vm.prank(address(r));
        desk.register();
        uint256 id = _post(hirer, address(r), _same(2, STAGE), _same(2, 1 days), false);
        uint256 job = _job(id);
        vm.prank(address(r));
        desk.deliver(job, keccak256("work"));
        r.arm(abi.encodeCall(FactorMilestones.step, (id)));
        _acceptStage(id);
        assertTrue(r.reentered(), "it did try");
        assertFalse(r.reentrySucceeded());
        assertEq(m.plan(id).current, 1);
        _mbooks();
    }

    function test_attack5_reentry_fromTheCustomerOnItsReturn() public {
        Reenterer r = new Reenterer();
        vm.deal(address(this), 1 ether);
        (bool ok, bytes memory out) = r.call{value: 0.002 ether}(
            address(m), abi.encodeCall(FactorMilestones.post, (agentA, _same(2, STAGE), _same(2, 1 days), false, TERMS))
        );
        assertTrue(ok);
        uint256 id = abi.decode(out, (uint256));
        r.arm(abi.encodeCall(FactorMilestones.step, (id)));
        _pastDue(id);
        m.step(id);
        assertTrue(r.reentered());
        assertFalse(r.reentrySucceeded());
        assertEq(address(r).balance, 0.002 ether);
        _mbooks();
    }

    function test_attack5_reentry_guardedAtFullGas() public {
        MFlipper f = new MFlipper();
        Rejecter c2 = new Rejecter();
        uint256 id = _post(address(f), agentA, _same(2, STAGE), _same(2, 1 days), false);
        uint256 id2 = _post(address(c2), agentA, _same(2, STAGE), _same(2, 1 days), false);
        _pastDue(id);
        m.step(id);
        m.step(id2);
        assertEq(m.owed(address(f)), 0.002 ether);
        c2.setAccept(true);
        f.arm(abi.encodeCall(FactorMilestones.collect, (address(c2))));
        m.collect(address(f));
        assertTrue(f.reentered(), "it did try, with all the gas");
        assertFalse(f.succeeded(), "the guard refused it");
        assertEq(m.owed(address(c2)), 0.002 ether, "what the other is owed is untouched");
        _mbooks();
    }

    /// 6. A customer that refuses ETH or eats the gas it is given: kept as owed, for it alone.
    function test_attack6_aCustomerThatEatsGas() public {
        GasEater g = new GasEater();
        uint256 id = _post(address(g), agentA, _same(2, STAGE), _same(2, 1 days), false);
        _pastDue(id);
        m.step(id);
        assertEq(m.owed(address(g)), 0.002 ether);
        _mbooks();
    }

    /// 7. An agent that refuses its pay: the desk keeps it as its own owed, and the plan goes on.
    function test_attack7_anAgentThatRefusesItsPay() public {
        Rejecter r = new Rejecter();
        vm.prank(address(r));
        desk.register();
        uint256 id = _post(hirer, address(r), _same(2, STAGE), _same(2, 1 days), false);
        uint256 job = _job(id);
        vm.prank(address(r));
        desk.deliver(job, keccak256("w"));
        _acceptStage(id);
        assertEq(desk.owed(address(r)), 0.00098 ether);
        assertEq(m.plan(id).current, 1, "the next stage opened all the same");
        _mbooks();
    }

    /// 8. Nobody answers for the contract on the desk, and nobody delivers for the agent.
    function test_attack8_nobodyAnswersForTheContract() public {
        uint256 id = _post();
        uint256 job = _deliverStage(id);
        vm.startPrank(hirer);
        vm.expectRevert(FactorDesk.NotCustomer.selector);
        desk.accept(job);
        vm.expectRevert(FactorDesk.NotCustomer.selector);
        desk.reject(job);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(FactorDesk.NotAgent.selector);
        desk.deliver(job, keccak256("not mine"));
    }

    /// 9. Moving the desk job directly, around the contract: anyone may settle or refund on the desk, and the plan
    ///    picks it up at its next step. Nothing is lost in between.
    function test_attack9_theDeskMovedAroundTheContract() public {
        uint256 id = _post3();
        uint256 job1 = _deliverStage(id);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(stranger);
        desk.settle(job1);
        _mbooks();
        m.step(id);
        uint256 job2 = _job(id);
        _pastDue(id);
        vm.prank(stranger);
        desk.refund(job2);
        _mbooks(0.002 ether);
        uint256 before = hirer.balance;
        m.step(id);
        assertEq(hirer.balance - before, 0.005 ether);
        _mbooks();
    }

    /// 10. ETH forced in: it adds to nobody's claim. Plain ETH from anybody but the desk is refused.
    function test_attack10_forcedEthChangesNothing() public {
        uint256 id = _post();
        vm.deal(address(this), 1 ether);
        new ForceSend{value: 1 ether}(payable(address(m)));
        _pastDue(id);
        uint256 before = hirer.balance;
        m.step(id);
        assertEq(hirer.balance - before, 0.002 ether, "exactly the claim");
        assertEq(address(m).balance, 1 ether, "the forced ETH is nobody's");
    }

    function test_attack10_plainEthIsRefused() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok, bytes memory out) = address(m).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(bytes4(out), FactorMilestones.OnlyDesk.selector);
    }

    /// 11. A step sent with too little gas to pay: refused whole, so nothing lands in owed by the sender's choice.
    function test_attack11_tooLittleGasChangesNothing() public {
        uint256 id = _post();
        _pastDue(id);
        (bool ok,) = address(m).call{gas: 150_000}(abi.encodeCall(FactorMilestones.step, (id)));
        assertFalse(ok);
        assertEq(uint8(_stateOf(id)), uint8(FactorMilestones.State.Running));
        assertEq(m.owedTotal(), 0);
        m.step(id);
        assertEq(m.owedTotal(), 0);
        _mbooks();
    }

    /// 12. The desk never refuses the next stage: an agent barred after the post still gets its next stage locked, and
    ///     the desk refuses it only pool advances.
    function test_attack12_aBarredAgentsNextStageStillOpens() public {
        uint256 id = _post();
        _passStage(id);
        // agent a is barred on another job
        _fund(1 ether);
        _bond(agentA, 0.001 ether);
        uint256 other_ = _lock(agentA, 0.01 ether, false);
        _draw(agentA, other_, 0.001 ether, FactorDesk.Kind.Pool);
        vm.warp(block.timestamp + 2 days);
        desk.refund(other_);
        assertTrue(desk.agent(agentA).barred);
        uint256 id2 = _post();
        // the second plan's first stage is delivered and accepted: its next stage opens for a barred agent
        _passStage(id2);
        assertEq(m.plan(id2).current, 1);
        uint256 next = _job(id2);
        vm.prank(agentA);
        vm.expectRevert(FactorDesk.Barred.selector);
        desk.draw(next, 0.0001 ether, FactorDesk.Kind.Pool);
    }

    /// 13. Using stages to farm a score: each stage costs the desk's 2% as any job does, and all of them together are one
    ///     customer to the desk. It is never cheaper than hiring yourself on the desk directly.
    function test_attack13_stagesAreNoCheaperWayToAScore() public {
        uint256 start = agentA.balance + hirer.balance;
        uint256 id = _post(hirer, agentA, _same(6, STAGE), _same(6, 1 hours), false);
        for (uint256 i = 0; i < 6; ++i) {
            _passStage(id);
        }
        // the agent and the customer as one hand: what it cost is the 2% of each stage, as on the desk
        assertEq(start + 0.006 ether - (agentA.balance + hirer.balance), 0.00012 ether);
        assertEq(desk.agent(agentA).customers, 0, "under the fee floor, and in any case one customer");
        assertEq(desk.score(agentA), 60);
    }

    /// 14. A stage's time cannot be stretched: it is fixed at the post, and starts when the stage is locked on the desk.
    function test_attack14_theNextStagesTimeStartsAtTheAcceptance() public {
        uint256 id = _post(hirer, agentA, _same(2, STAGE), _list(1 days, 3 days), false);
        _deliverStage(id);
        vm.warp(block.timestamp + 20 hours);
        _acceptStage(id);
        assertEq(desk.job(_job(id)).dueAt, block.timestamp + 3 days);
    }

    /// 15. The desk's push of a returned stage arrives within its 50,000 gas: never in the desk's owed.
    function test_attack15_theDesksPushArrivesWithinItsGas() public {
        uint256 id = _post();
        uint256 job = _job(id);
        vm.prank(agentA);
        desk.decline(job);
        assertEq(desk.owed(address(m)), 0);
        m.step(id);
        _mbooks();
    }
}
