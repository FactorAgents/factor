// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorMilestones} from "../../src/FactorMilestones.sol";
import {Rejecter} from "../mocks/Actors.sol";

/// Random moves over milestone plans and the desk together. Every move anybody can make: posting, the agent delivering,
/// declining and drawing, the customer accepting and rejecting, the desk's own settling and refunding around the
/// contract, stepping, collecting, time. Each payout is checked as it happens against the rulebook; `wrong` stays false
/// unless something broke a rule.
contract MilestoneHandler is CommonBase, StdCheats, StdUtils {
    FactorDesk public desk;
    FactorMilestones public m;
    address[4] public agents;
    address[3] public customers;
    Rejecter public refuser;

    bool public wrong;
    string public why;

    uint256 public posts;
    uint256 public delivered;
    uint256 public accepted;
    uint256 public rejected;
    uint256 public declined;
    uint256 public stepped;
    uint256 public done;
    uint256 public missed;
    uint256 public draws;

    constructor(FactorDesk desk_, FactorMilestones m_) {
        desk = desk_;
        m = m_;
        refuser = new Rejecter();
        for (uint256 i = 0; i < 4; ++i) {
            agents[i] = makeAddr(string.concat("milestone agent ", vm.toString(i)));
            vm.prank(agents[i]);
            desk.register();
            vm.deal(agents[i], 1 ether);
            vm.prank(agents[i]);
            desk.addBond{value: 0.05 ether}();
        }
        customers[0] = makeAddr("milestone customer a");
        customers[1] = makeAddr("milestone customer b");
        customers[2] = address(refuser); // refuses ETH until a collect makes it take it
    }

    function _say(string memory what) internal {
        wrong = true;
        why = what;
    }

    function _id(uint256 seed) internal view returns (uint256) {
        uint256 n = m.planCount();
        return n == 0 ? 0 : (seed % n) + 1;
    }

    function _running(uint256 seed) internal view returns (uint256 id, uint256 job) {
        id = _id(seed);
        if (id == 0 || m.plan(id).state != FactorMilestones.State.Running) return (0, 0);
        job = m.currentJob(id);
    }

    function post(uint8 who, uint8 agent, uint8 n, uint256 seed, bool early) external {
        uint256 count = bound(n, 2, 6);
        uint256[] memory prices = new uint256[](count);
        uint256[] memory times = new uint256[](count);
        uint256 total;
        for (uint256 i = 0; i < count; ++i) {
            prices[i] = bound(uint256(keccak256(abi.encode(seed, i))), 0.001 ether, 0.2 ether);
            // mostly short, so most runs reach every ending; now and then one that runs long
            uint256 t = uint256(keccak256(abi.encode(seed, i, "t")));
            times[i] = t % 8 == 0 ? bound(t, 1 hours, 30 days) : bound(t, 1 hours, 2 days);
            total += prices[i];
        }
        address c = customers[who % 3];
        vm.deal(c, c.balance + total);
        vm.prank(c);
        m.post{value: total}(agents[agent % 4], prices, times, early, keccak256("terms"));
        posts++;
    }

    function deliver(uint256 seed) external {
        (uint256 id, uint256 job) = _running(seed);
        if (id == 0) return;
        FactorDesk.Job memory j = desk.job(job);
        if (j.state != FactorDesk.State.Locked && j.state != FactorDesk.State.Advanced) return;
        if (block.timestamp > uint256(j.dueAt) + desk.GRACE()) return;
        vm.prank(j.agent);
        desk.deliver(job, keccak256(abi.encode("work", job)));
        delivered++;
    }

    function draw(uint256 seed, uint96 amount, bool early) external {
        (uint256 id, uint256 job) = _running(seed);
        if (id == 0) return;
        (uint256 e, uint256 p) = desk.canDrawOn(job);
        uint256 room = early ? e : p;
        if (room < 1000) return;
        uint256 a = bound(amount, 1000, room);
        vm.prank(desk.job(job).agent);
        desk.draw(job, a, early ? FactorDesk.Kind.Early : FactorDesk.Kind.Pool);
        draws++;
    }

    function decline(uint256 seed) external {
        (uint256 id, uint256 job) = _running(seed);
        if (id == 0) return;
        FactorDesk.Job memory j = desk.job(job);
        if (j.state != FactorDesk.State.Locked) return;
        vm.prank(j.agent);
        desk.decline(job);
        declined++;
    }

    function accept(uint256 seed) external {
        (uint256 id, uint256 job) = _running(seed);
        if (id == 0 || desk.job(job).state != FactorDesk.State.Delivered) return;
        FactorMilestones.Plan memory p = m.plan(id);
        uint256 price = desk.job(job).price;
        uint256 agentBefore = p.agent.balance + desk.owed(p.agent);
        vm.prank(p.customer);
        m.accept(id);
        FactorDesk.Job memory j = desk.job(job);
        uint256 toAgent = price - j.early - j.fromPool - (price * 200) / 10_000;
        if (p.agent.balance + desk.owed(p.agent) - agentBefore != toAgent) _say("an accept paid the agent the wrong amount");
        _afterPaid(id, p);
        accepted++;
    }

    function reject(uint256 seed) external {
        (uint256 id, uint256 job) = _running(seed);
        if (id == 0) return;
        FactorDesk.Job memory j = desk.job(job);
        if (j.state != FactorDesk.State.Delivered || block.timestamp >= uint256(j.deliveredAt) + desk.REVIEW()) return;
        FactorMilestones.Plan memory p = m.plan(id);
        uint256 before = p.customer.balance + m.owed(p.customer);
        vm.prank(p.customer);
        m.reject(id);
        uint256 back = p.customer.balance + m.owed(p.customer) - before;
        if (back != j.price / 2 + p.left) _say("a reject did not send back half of the stage and the rest");
        if (m.plan(id).state != FactorMilestones.State.Rejected) _say("a reject did not end the plan");
        rejected++;
    }

    /// The desk's own clock, around the contract: anyone settles a delivered stage after 24 hours, or refunds one past
    /// its due time and grace.
    function deskCloses(uint256 seed) external {
        (uint256 id, uint256 job) = _running(seed);
        if (id == 0) return;
        FactorDesk.Job memory j = desk.job(job);
        if (j.state == FactorDesk.State.Delivered && block.timestamp >= uint256(j.deliveredAt) + desk.REVIEW()) {
            desk.settle(job);
        } else if (
            (j.state == FactorDesk.State.Locked || j.state == FactorDesk.State.Advanced)
                && block.timestamp > uint256(j.dueAt) + desk.GRACE()
        ) {
            desk.refund(job);
        }
    }

    function step(uint256 seed) external {
        (uint256 id, uint256 job) = _running(seed);
        if (id == 0) return;
        FactorDesk.Job memory j = desk.job(job);
        bool due = j.state == FactorDesk.State.Settled || j.state == FactorDesk.State.Refunded
            || j.state == FactorDesk.State.Declined
            || (j.state == FactorDesk.State.Delivered && block.timestamp >= uint256(j.deliveredAt) + desk.REVIEW())
            || (
                (j.state == FactorDesk.State.Locked || j.state == FactorDesk.State.Advanced)
                    && block.timestamp > uint256(j.dueAt) + desk.GRACE()
            );
        FactorMilestones.Plan memory p = m.plan(id);
        uint256 before = p.customer.balance + m.owed(p.customer);
        if (!due) {
            try m.step(id) {
                _say("a step went through before its time");
            } catch {}
            return;
        }
        m.step(id);
        stepped++;
        FactorMilestones.State s = m.plan(id).state;
        uint256 back = p.customer.balance + m.owed(p.customer) - before;
        if (s == FactorMilestones.State.Missed) {
            missed++;
            if (back != desk.job(job).price - desk.job(job).early + p.left) _say("a miss sent back the wrong amount");
        } else if (s == FactorMilestones.State.Declined) {
            if (back != desk.job(job).price + p.left) _say("a decline sent back the wrong amount");
        } else {
            if (back != 0) _say("a paid stage sent the customer something");
            _afterPaid(id, p);
        }
    }

    function _afterPaid(uint256 id, FactorMilestones.Plan memory before) internal {
        FactorMilestones.Plan memory p = m.plan(id);
        if (before.current + 1 == before.count) {
            if (p.state != FactorMilestones.State.Done) _say("the last stage paid and the plan is not done");
            done++;
            return;
        }
        if (p.current != before.current + 1) _say("the next stage did not open");
        uint256 job = m.currentJob(id);
        FactorMilestones.Stage[] memory s = m.stages(id);
        if (desk.job(job).dueAt != block.timestamp + s[p.current].time) _say("the next stage is not due its own time from now");
        if (desk.job(job).price != s[p.current].price) _say("the next stage has the wrong price");
    }

    function collect() external {
        if (m.owed(address(refuser)) == 0) return;
        refuser.setAccept(true);
        m.collect(address(refuser));
        refuser.setAccept(false);
    }

    function warp(uint32 by) external {
        vm.warp(block.timestamp + bound(by, 1 minutes, 3 days));
    }
}
