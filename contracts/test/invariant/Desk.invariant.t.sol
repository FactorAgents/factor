// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FactorTest} from "../FactorTest.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {DeskHandler} from "./DeskHandler.sol";

/// The desk's rules that must hold whatever anybody does, in whatever order. The handler does the doing and checks
/// each payout as it happens; each function here is one rule, checked after every step of every run.
contract DeskInvariantTest is FactorTest {
    DeskHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new DeskHandler(desk);
        // a pool to draw on and a few jobs, so the runs spend their steps on the rules
        handler.fund(5 ether);
        for (uint8 i = 0; i < 4; ++i) {
            handler.bond(i, 0.05 ether);
            handler.lock(i, i, 0.5 ether, 1 days, i % 2 == 0);
        }
        targetContract(address(handler));
    }

    function _agents() internal view returns (address[4] memory a) {
        for (uint256 i = 0; i < 4; ++i) {
            a[i] = handler.agents(i);
        }
    }

    // ---------- the four parts of the desk's ETH ----------

    /// Rule 12 of the rulebook's list: job money, bonds, waiting payouts and the pool are counted apart, and the
    /// desk holds exactly their sum (plus whatever was forced in, which is in nobody's books).
    function invariant_theDeskHoldsExactlyWhatItsBooksSay() public view {
        assertEq(
            address(desk).balance,
            desk.pool() + desk.held() + desk.bonds() + desk.owedTotal() + handler.forced(),
            "balance = pool + held + bonds + owed"
        );
    }

    /// Each total is the sum of what it is a total of, job by job and agent by agent.
    function invariant_everyTotalIsTheSumOfItsParts() public view {
        uint256 n = desk.jobCount();
        uint256 held;
        uint256 outByJobs;
        uint256 openJobs;
        for (uint256 id = 1; id <= n; ++id) {
            FactorDesk.Job memory j = desk.job(id);
            assertTrue(j.state != FactorDesk.State.None, "every number given out is a job");
            assertLe(j.early + j.fromPool, j.price / 2, "advances stop at half");
            if (
                j.state == FactorDesk.State.Locked || j.state == FactorDesk.State.Advanced
                    || j.state == FactorDesk.State.Delivered
            ) {
                held += j.price - j.early;
                outByJobs += j.fromPool;
                openJobs += 1;
            }
            if (j.state == FactorDesk.State.Locked) {
                assertEq(j.early + j.fromPool, 0, "a locked job has nothing drawn");
            }
            if (j.state == FactorDesk.State.Advanced) assertGt(j.early + j.fromPool, 0, "an advanced job has");
        }
        assertEq(desk.held(), held, "held = what open jobs hold");
        assertEq(desk.out(), outByJobs, "out = the pool advances on open jobs");
        assertEq(openJobs, handler.openCount(), "the handler and the desk agree on what is open");

        address[4] memory agents = _agents();
        uint256 bonds;
        uint256 outByAgents;
        uint256 marks;
        uint256 owed = desk.owed(address(burnPot)) + desk.owed(gateway);
        for (uint256 i = 0; i < 4; ++i) {
            FactorDesk.Agent memory a = desk.agent(agents[i]);
            bonds += a.bond;
            outByAgents += a.advancedNow;
            marks += uint256(a.settled) + a.settledAtHalf + a.notDelivered + a.unanswered;
            owed += desk.owed(agents[i]);
            assertEq(uint256(a.onTime) + a.late, a.settled, "every settled job was on time or late");
        }
        // the first agent is also a customer (it hires itself), so it is counted once
        for (uint256 i = 0; i < 3; ++i) {
            owed += desk.owed(handler.customers(i));
        }
        assertEq(desk.bonds(), bonds, "bonds = the agents' bonds");
        assertEq(desk.out(), outByAgents, "out = what the agents have out");
        assertEq(desk.owedTotal(), owed, "owed = what is waiting, wallet by wallet");
        assertEq(
            marks + handler.declined(), handler.closed(), "every closed job left exactly one mark, or was declined"
        );
        assertEq(n, handler.closed() + openJobs, "every job is open or closed");
    }

    // ---------- the pool ----------

    /// The pool only ever changes by what came in from outside, the job fees, and the losses.
    function invariant_thePoolIsWhatCameInPlusFeesLessLosses() public view {
        assertEq(desk.pool() + desk.out(), desk.totalPoolIn() + desk.totalJobFees() - desk.totalLost());
    }

    function invariant_thePoolNeverHasMoreThanFourFifthsOut() public view {
        assertLe(desk.out() * 10_000, (desk.pool() + desk.out()) * 8000);
    }

    /// The promise the limit rests on: no agent has out more than its bond and its fees, and the pool has never
    /// lost more to an agent than that agent's own jobs paid into it.
    function invariant_noAgentTakesMoreThanItPutIn() public view {
        address[4] memory agents = _agents();
        uint256 lost;
        for (uint256 i = 0; i < 4; ++i) {
            FactorDesk.Agent memory a = desk.agent(agents[i]);
            assertLe(a.advancedNow, a.bond + a.feesPaid, "out <= bond + fees paid");
            assertLe(handler.lostBy(agents[i]), a.feesPaid, "lost to it <= what its jobs paid in");
            lost += handler.lostBy(agents[i]);
            assertEq(a.barred, a.advancesNotRepaid + a.earlyKept > 0, "barred exactly when it failed with money");
            if (a.barred) {
                assertEq(desk.limit(agents[i]), 0);
                assertEq(desk.score(agents[i]), 0);
            }
            assertLe(desk.score(agents[i]), 1000);
        }
        assertEq(desk.totalLost(), lost, "every loss belongs to an agent");
    }

    // ---------- the fees ----------

    function invariant_everyAdvanceFeeReachesTheBurnPot() public view {
        assertEq(address(burnPot).balance + desk.owed(address(burnPot)), desk.totalAdvanceFees());
        assertLe(desk.totalAdvanceFees() * 100, desk.totalAdvanced(), "never more than 1%");
        assertEq(gateway.balance + desk.owed(gateway), handler.computeNet(), "the gateway has the compute advances");
    }

    /// Every payout the handler watched was exactly what the rulebook says.
    function invariant_everyPayoutWasByTheRulebook() public view {
        assertFalse(handler.wrong(), handler.why());
    }

    // ---------- one scripted run ----------

    /// The same rules along one scripted fortnight rather than a random walk, so that the slow things are certain
    /// to have happened under them: jobs that settle, that are rejected, that time out with a pool advance the
    /// bond does not cover, a wallet that refuses its payout, and ETH forced in.
    function test_aScriptedFortnightKeepsEveryRule() public {
        uint256 seed = 0;
        for (uint256 day = 0; day < 14; ++day) {
            for (uint8 i = 0; i < 4; ++i) {
                handler.lock(i, uint8(day) + i, uint96(0.2 ether + day * 0.03 ether), 26 hours, i != 1);
            }
            for (uint256 step = 0; step < 12; ++step) {
                seed = uint256(keccak256(abi.encode(seed, day, step)));
                handler.draw(seed, uint96(seed >> 8), uint8(seed >> 4));
                if (step % 3 == 0) handler.deliver(seed >> 16);
                if (step % 4 == 1) handler.accept(seed >> 24);
                if (step % 5 == 2) handler.reject(seed >> 32);
                if (step == 7 && day % 3 == 0) handler.decline(seed >> 40);
                _check();
            }
            if (day % 4 == 1) handler.unbond(uint8(day), type(uint96).max);
            if (day % 4 == 3) handler.bond(uint8(day), 0.02 ether);
            if (day % 5 == 2) handler.toggle(uint8(day));
            if (day % 6 == 4) handler.force(1 ether);
            if (day % 2 == 0) handler.fund(0.3 ether);
            // the one way the pool can lose: an agent whose limit is its fees takes all of it and goes silent
            if (day % 3 == 1) {
                for (uint8 i = 0; i < 4; ++i) {
                    handler.runOff(i, 2 ether);
                }
            }
            handler.wait(1 days);
            for (uint256 k = 0; k < 8; ++k) {
                handler.settle(k * 7 + day);
                handler.refund(k * 5 + day);
                handler.collect(uint8(k));
            }
            _check();
        }
        // and the slow things did happen
        assertGt(desk.totalLost(), 0, "an agent took the pool's money and did not deliver");
        assertGt(desk.totalJobFees(), 0);
        assertGt(desk.totalAdvanceFees(), 0);
        assertGt(handler.declined(), 0);
        assertGt(handler.closed(), 30);
        address[4] memory agents = _agents();
        uint256 halves;
        for (uint256 i = 0; i < 4; ++i) {
            halves += desk.agent(agents[i]).settledAtHalf;
        }
        assertGt(halves, 0, "a job settled at half");
    }

    function _check() internal view {
        invariant_theDeskHoldsExactlyWhatItsBooksSay();
        invariant_everyTotalIsTheSumOfItsParts();
        invariant_thePoolIsWhatCameInPlusFeesLessLosses();
        invariant_thePoolNeverHasMoreThanFourFifthsOut();
        invariant_noAgentTakesMoreThanItPutIn();
        invariant_everyAdvanceFeeReachesTheBurnPot();
        invariant_everyPayoutWasByTheRulebook();
    }
}
