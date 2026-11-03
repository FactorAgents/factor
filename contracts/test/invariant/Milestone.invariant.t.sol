// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {FactorTest} from "../FactorTest.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorMilestones} from "../../src/FactorMilestones.sol";
import {MilestoneHandler} from "./MilestoneHandler.sol";

/// The milestones' rules that must hold whatever anybody does, in whatever order, beside the desk. The handler does the
/// doing and checks each payout as it happens; each function here is one rule, checked after every step.
contract MilestoneInvariantTest is FactorTest {
    MilestoneHandler internal handler;
    FactorMilestones internal m;

    function setUp() public override {
        super.setUp();
        m = new FactorMilestones(desk);
        handler = new MilestoneHandler(desk, m);
        vm.deal(address(this), 5 ether);
        (bool ok,) = address(desk).call{value: 2 ether}("");
        assertTrue(ok);
        targetContract(address(handler));
        bytes4[] memory moves = new bytes4[](15);
        moves[0] = MilestoneHandler.post.selector;
        moves[1] = MilestoneHandler.deliver.selector;
        moves[2] = MilestoneHandler.deliver.selector; // most stages are delivered
        moves[3] = MilestoneHandler.deliver.selector;
        moves[4] = MilestoneHandler.accept.selector;
        moves[5] = MilestoneHandler.accept.selector;
        moves[6] = MilestoneHandler.accept.selector;
        moves[7] = MilestoneHandler.reject.selector;
        moves[8] = MilestoneHandler.decline.selector;
        moves[9] = MilestoneHandler.draw.selector;
        moves[10] = MilestoneHandler.deskCloses.selector;
        moves[11] = MilestoneHandler.step.selector;
        moves[12] = MilestoneHandler.step.selector;
        moves[13] = MilestoneHandler.collect.selector;
        moves[14] = MilestoneHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: moves}));
    }

    /// The books as they should be, worked out plan by plan from what each one is.
    function _worked() internal view returns (uint256 held, uint256 atDesk, uint256 backHere) {
        uint256 n = m.planCount();
        for (uint256 id = 1; id <= n; ++id) {
            FactorMilestones.Plan memory p = m.plan(id);
            if (p.state != FactorMilestones.State.Running) continue;
            FactorMilestones.Stage[] memory s = m.stages(id);
            uint256 left;
            for (uint256 i = p.current + 1; i < s.length; ++i) {
                left += s[i].price;
            }
            assertEq(p.left, left, "a running plan holds exactly its stages after the current one");
            held += left;
            FactorDesk.Job memory j = desk.job(s[p.current].job);
            // a stage the desk settled around the contract is still counted at the desk until a step
            atDesk += s[p.current].price;
            if (j.state == FactorDesk.State.Refunded) backHere += j.price - j.early;
            else if (j.state == FactorDesk.State.Declined) backHere += j.price;
        }
    }

    /// Nothing the handler saw was against the rulebook.
    function invariant_everyMoveKeptTheRules() public view {
        assertFalse(handler.wrong(), handler.why());
    }

    /// The contract holds exactly its books: the stages held, what it owes wallets, and any stage the desk has sent back
    /// that has not been stepped yet.
    function invariant_theBalanceIsExactlyTheBooks() public view {
        (,, uint256 backHere) = _worked();
        assertEq(address(m).balance, m.held() + m.owedTotal() + backHere);
    }

    /// Each of the books is exactly the sum of what every plan should have there.
    function invariant_eachBookIsTheSumOfItsPlans() public view {
        (uint256 held, uint256 atDesk,) = _worked();
        assertEq(m.held(), held, "held");
        assertEq(m.atDesk(), atDesk, "at the desk");
    }

    /// Every budget is held, on the desk, paid or returned, and nowhere twice. What the desk kept of a stage (its job
    /// fee, an early advance, the agent's half of a reject) is the agent's or the pool's, and counted as neither paid
    /// nor returned.
    function invariant_everyBudgetIsSomewhereOnce() public view {
        uint256 kept;
        uint256 n = m.planCount();
        for (uint256 id = 1; id <= n; ++id) {
            FactorMilestones.Plan memory p = m.plan(id);
            if (p.state == FactorMilestones.State.Running || p.state == FactorMilestones.State.Done) continue;
            FactorDesk.Job memory j = desk.job(m.currentJob(id));
            if (j.state == FactorDesk.State.Refunded) kept += j.early;
            else if (j.state == FactorDesk.State.SettledAtHalf) kept += j.price - j.price / 2;
        }
        assertEq(m.totalBudgets(), m.held() + m.atDesk() + m.totalPaid() + m.totalReturned() + kept);
    }

    /// Every stage on the desk is the contract's job, for the plan's agent, at the stage's price, pointing back; a stage
    /// not reached yet has no job; only one stage of a plan is ever open on the desk.
    function invariant_oneStageAtATime() public view {
        uint256 n = m.planCount();
        for (uint256 id = 1; id <= n; ++id) {
            FactorMilestones.Plan memory p = m.plan(id);
            FactorMilestones.Stage[] memory s = m.stages(id);
            assertGe(s.length, 2);
            assertLe(s.length, 6);
            for (uint256 i = 0; i < s.length; ++i) {
                if (i > p.current) {
                    assertEq(s[i].job, 0, "a stage after the current one is not on the desk");
                    continue;
                }
                FactorDesk.Job memory j = desk.job(s[i].job);
                assertEq(m.planOfJob(s[i].job), id);
                assertEq(j.customer, address(m));
                assertEq(j.agent, p.agent);
                assertEq(j.price, s[i].price);
                assertEq(j.allowEarly, p.allowEarly);
                if (i < p.current) assertEq(uint8(j.state), uint8(FactorDesk.State.Settled), "a passed stage was paid");
            }
        }
    }

    /// The desk's books are untouched by all of it.
    function invariant_theDeskStillHoldsItsBooks() public view {
        assertEq(address(desk).balance, desk.pool() + desk.held() + desk.bonds() + desk.owedTotal());
    }

    /// Nothing stuck: run time far forward, step every plan until it ends, and no ETH is left in the contract but what
    /// wallets refused. This runs at the end of every sequence.
    function afterInvariant() external {
        uint256 n = m.planCount();
        // each round a stage is refunded or settled by the desk's clock, and the next one opens
        for (uint256 round = 0; round < 7; ++round) {
            vm.warp(block.timestamp + 32 days);
            for (uint256 id = 1; id <= n; ++id) {
                if (m.plan(id).state == FactorMilestones.State.Running) m.step(id);
            }
        }
        for (uint256 id = 1; id <= n; ++id) {
            assertTrue(m.plan(id).state != FactorMilestones.State.Running, "every plan can be ended by anyone");
        }
        assertEq(m.held(), 0, "nothing held");
        assertEq(m.atDesk(), 0, "nothing at the desk");
        assertEq(address(m).balance, m.owedTotal(), "all that is left is what wallets refused");
        console.log("posts %s, delivered %s, accepted %s", handler.posts(), handler.delivered(), handler.accepted());
        console.log("rejected %s, declined %s, stepped %s", handler.rejected(), handler.declined(), handler.stepped());
        console.log("done %s, missed %s, draws %s", handler.done(), handler.missed(), handler.draws());
    }
}
