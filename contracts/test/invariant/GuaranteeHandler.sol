// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorGuarantee} from "../../src/FactorGuarantee.sol";

/// A customer that refuses ETH while told to: its covers and refunds wait as owed.
contract Fussy {
    bool public refuse = true;

    function setRefuse(bool on) external {
        refuse = on;
    }

    receive() external payable {
        require(!refuse, "no");
    }
}

/// Everything anybody can do to guarantees and the desk together, in any order the fuzzer likes: agents bond, take
/// bond out and set offers (a plain agent, a line account run by its key, and one with the top score); customers
/// reserve cover, lock jobs on the terms they reserved or on others, tie them or let them lapse; agents draw, deliver
/// and decline, customers accept and reject, time passes, the desk refunds and settles, covers are closed, and refused
/// payouts are collected.
///
/// It checks each close against the desk as it happens (a wrong one raises `wrong`).
contract GuaranteeHandler is Test {
    FactorDesk public immutable desk;
    FactorLine public immutable line;
    FactorGuarantee public immutable g;

    address[4] public agents; // the desk addresses that sell cover
    address public lineKey;
    address[3] public customers;
    Fussy public fussy;
    address public scorer = makeAddr("guarantee scorer");

    uint256[] public jobs; // desk jobs locked by these customers

    bool public wrong;
    string public why;
    uint256 public reserves;
    uint256 public binds;
    uint256 public paid;
    uint256 public released;
    uint256 public declined;
    uint256 public lapsed;

    constructor(FactorDesk desk_, FactorLine line_, FactorGuarantee g_) {
        desk = desk_;
        line = line_;
        g = g_;
        agents[0] = makeAddr("guarantee agent one");
        agents[1] = makeAddr("guarantee agent two");
        lineKey = makeAddr("guarantee line key");
        agents[3] = makeAddr("guarantee agent with the top score");
        vm.prank(agents[0]);
        desk.register();
        vm.prank(agents[1]);
        desk.register();
        vm.prank(agents[3]);
        desk.register();
        vm.prank(lineKey);
        desk.register();
        vm.prank(lineKey);
        agents[2] = line.open();
        fussy = new Fussy();
        customers = [makeAddr("guarantee customer one"), makeAddr("guarantee customer two"), address(fussy)];
    }

    /// Twenty small jobs for each of the first three agents, so they can sell a quarter of a price.
    function scoreUp() external {
        for (uint256 a = 0; a < 3; ++a) {
            for (uint256 i = 0; i < 20; ++i) {
                vm.deal(scorer, scorer.balance + 0.001 ether);
                vm.prank(scorer);
                uint256 id = desk.lock{value: 0.001 ether}(agents[a], block.timestamp + 1 days, false);
                _deliverAs(a, id);
                vm.prank(scorer);
                desk.accept(id);
            }
        }
        vm.mockCall(address(desk), abi.encodeCall(FactorDesk.score, (agents[3])), abi.encode(uint256(900)));
    }

    function _fail(string memory what) internal {
        if (!wrong) why = what;
        wrong = true;
    }

    function _runner(uint256 a) internal view returns (address) {
        return a == 2 ? lineKey : agents[a];
    }

    function _deliverAs(uint256 a, uint256 id) internal {
        if (a == 2) {
            vm.prank(lineKey);
            FactorLineAccount(payable(agents[2])).deliver(id, keccak256("the work"));
        } else {
            vm.prank(agents[a]);
            desk.deliver(id, keccak256("the work"));
        }
    }

    function _agentIndex(address who) internal view returns (uint256) {
        for (uint256 i = 0; i < 4; ++i) {
            if (agents[i] == who) return i;
        }
        return 0;
    }

    function jobCount() external view returns (uint256) {
        return jobs.length;
    }

    // ---------- the agents ----------

    function bond(uint8 a, uint256 amount) external {
        amount = bound(amount, 1, 2 ether);
        address agent = agents[a % 4];
        vm.deal(address(this), address(this).balance + amount);
        g.addBond{value: amount}(agent);
    }

    function takeBond(uint8 a, uint256 amount) external {
        address agent = agents[a % 4];
        uint256 free = g.freeOf(agent);
        if (free == 0) return;
        amount = bound(amount, 1, free);
        uint256 before = agent.balance;
        uint256 owedBefore = g.owed(agent);
        vm.prank(_runner(a % 4));
        g.takeBond(agent, amount);
        if (agent.balance + g.owed(agent) != before + owedBefore + amount) _fail("bond taken out did not go to the agent");
    }

    function offer(uint8 a, uint256 amount) external {
        amount = bound(amount, 0, 2 ether);
        if (amount != 0 && amount < 0.0001 ether) amount = 0.0001 ether;
        vm.prank(_runner(a % 4));
        g.setOffer(agents[a % 4], amount);
    }

    // ---------- hiring with cover ----------

    function reserve(uint8 c, uint8 a, uint256 price, uint256 amount, bool early, uint256 dueIn) external {
        address customer = customers[c % 3];
        address agent = agents[a % 4];
        price = bound(price, 0.001 ether, 2 ether);
        dueIn = bound(dueIn, 1 hours, 1 days);
        uint256 cap = g.coverLimit(agent, price);
        if (cap < 0.0001 ether) return;
        amount = bound(amount, 0.0001 ether, cap);
        uint256 fee = g.feeFor(amount);
        vm.deal(customer, customer.balance + fee);
        vm.prank(customer);
        g.reserve{value: fee}(agent, price, block.timestamp + dueIn, early, amount);
        reserves += 1;
    }

    /// The whole flow at once, as the site and the kit do it: reserve, lock on those terms, tie.
    function hire(uint8 c, uint8 a, uint256 price, uint256 amount, bool early, uint256 dueIn) external {
        address customer = customers[c % 3];
        address agent = agents[a % 4];
        price = bound(price, 0.001 ether, 2 ether);
        dueIn = bound(dueIn, 1 hours, 1 days);
        uint256 cap = g.coverLimit(agent, price);
        if (cap < 0.0001 ether) return;
        amount = bound(amount, 0.0001 ether, cap);
        uint256 fee = g.feeFor(amount);
        uint256 dueAt = block.timestamp + dueIn;
        vm.deal(customer, customer.balance + fee + price);
        vm.prank(customer);
        uint256 id = g.reserve{value: fee}(agent, price, dueAt, early, amount);
        reserves += 1;
        vm.prank(customer);
        uint256 job = desk.lock{value: price}(agent, dueAt, early);
        jobs.push(job);
        vm.prank(customer);
        g.bindLatest();
        binds += 1;
        if (g.coverOf(job) != id) _fail("bindLatest tied another job");
    }

    /// Lock the job a reservation was for (or, when `same` is false, one a little different).
    function lock(uint256 seed, bool same) external {
        uint256 n = g.coverCount();
        if (n == 0) return;
        FactorGuarantee.Cover memory c = g.cover(bound(seed, 1, n));
        if (c.dueAt < block.timestamp + 1 hours) return; // the desk would refuse it now
        uint256 price = same ? c.price : c.price + 1;
        vm.deal(c.customer, c.customer.balance + price);
        vm.prank(c.customer);
        jobs.push(desk.lock{value: price}(c.agent, c.dueAt, c.allowEarly));
    }

    function bind(uint256 seed, uint256 jobSeed) external {
        uint256 n = g.coverCount();
        if (n == 0 || jobs.length == 0) return;
        uint256 id = bound(seed, 1, n);
        uint256 job = jobs[jobSeed % jobs.length];
        try g.bind(id, job) {
            binds += 1;
            FactorGuarantee.Cover memory c = g.cover(id);
            FactorDesk.Job memory j = desk.job(job);
            if (j.customer != c.customer || j.agent != c.agent || j.price != c.price || job <= c.afterJob) {
                _fail("a cover was tied to a job that is not its own");
            }
        } catch {}
    }

    function bindLatest(uint8 c) external {
        vm.prank(customers[c % 3]);
        try g.bindLatest() {
            binds += 1;
        } catch {}
    }

    function lapse(uint256 seed) external {
        uint256 n = g.coverCount();
        if (n == 0) return;
        try g.lapse(bound(seed, 1, n)) {
            lapsed += 1;
        } catch {}
    }

    // ---------- the desk ----------

    function draw(uint256 jobSeed, uint256 amount, bool early) external {
        if (jobs.length == 0) return;
        uint256 id = jobs[jobSeed % jobs.length];
        FactorDesk.Job memory j = desk.job(id);
        uint256 a = _agentIndex(j.agent);
        if (a == 2) return; // the line account's advances are the line's tests'
        (uint256 e, uint256 p) = desk.canDrawOn(id);
        uint256 room = early ? e : p;
        if (room == 0) return;
        amount = bound(amount, 1, room);
        vm.prank(j.agent);
        desk.draw(id, amount, early ? FactorDesk.Kind.Early : FactorDesk.Kind.Pool);
    }

    function deliver(uint256 jobSeed) external {
        if (jobs.length == 0) return;
        uint256 id = jobs[jobSeed % jobs.length];
        FactorDesk.Job memory j = desk.job(id);
        if (j.state != FactorDesk.State.Locked && j.state != FactorDesk.State.Advanced) return;
        if (block.timestamp > uint256(j.dueAt) + 12 hours) return;
        _deliverAs(_agentIndex(j.agent), id);
    }

    function decline(uint256 jobSeed) external {
        if (jobs.length == 0) return;
        uint256 id = jobs[jobSeed % jobs.length];
        FactorDesk.Job memory j = desk.job(id);
        if (j.state != FactorDesk.State.Locked) return;
        uint256 a = _agentIndex(j.agent);
        if (a == 2) {
            vm.prank(lineKey);
            FactorLineAccount(payable(agents[2])).decline(id);
        } else {
            vm.prank(j.agent);
            desk.decline(id);
        }
    }

    function answer(uint256 jobSeed, bool accept) external {
        if (jobs.length == 0) return;
        uint256 id = jobs[jobSeed % jobs.length];
        FactorDesk.Job memory j = desk.job(id);
        if (j.state != FactorDesk.State.Delivered || block.timestamp >= uint256(j.deliveredAt) + 24 hours) return;
        vm.prank(j.customer);
        if (accept) desk.accept(id);
        else desk.reject(id);
    }

    function deskCloses(uint256 jobSeed) external {
        if (jobs.length == 0) return;
        uint256 id = jobs[jobSeed % jobs.length];
        try desk.refund(id) {} catch {}
        try desk.settle(id) {} catch {}
    }

    function warp(uint256 s) external {
        vm.warp(block.timestamp + bound(s, 1, 2 days));
    }

    // ---------- covers end ----------

    function close(uint256 jobSeed) external {
        if (jobs.length == 0) return;
        // the first job from the seed on whose cover is still tied: that is what the keeper looks for
        uint256 job;
        uint256 id;
        for (uint256 k = 0; k < jobs.length; ++k) {
            job = jobs[(jobSeed + k) % jobs.length];
            id = g.coverOf(job);
            if (id != 0 && g.cover(id).state == FactorGuarantee.State.Bound) break;
            id = 0;
        }
        if (id == 0) return;
        FactorGuarantee.Cover memory before = g.cover(id);
        uint256 got = before.customer.balance + g.owed(before.customer);
        try g.close(job) {
            FactorGuarantee.Cover memory c = g.cover(id);
            FactorDesk.State s = desk.job(job).state;
            // what reached the customer in this call: the cover, the fee back, or a refund the desk was asked for first
            uint256 came = c.customer.balance + g.owed(c.customer) - got;
            if (c.state == FactorGuarantee.State.Paid) {
                paid += 1;
                if (s != FactorDesk.State.Refunded) _fail("cover paid on a job that was not refunded");
                if (came < c.amount) _fail("the customer was not paid the cover");
            } else if (c.state == FactorGuarantee.State.Released) {
                released += 1;
                if (s != FactorDesk.State.Settled && s != FactorDesk.State.SettledAtHalf) {
                    _fail("cover released on a job that did not settle");
                }
                if (came != 0) _fail("a released cover paid the customer");
            } else if (c.state == FactorGuarantee.State.Declined) {
                declined += 1;
                if (s != FactorDesk.State.Declined) _fail("cover ended as declined on a job not declined");
                if (came != c.fee) _fail("a declined cover did not return the fee, exactly");
            } else {
                _fail("close left a cover open");
            }
        } catch {}
    }

    function collect(uint8 who, bool letIn) external {
        fussy.setRefuse(!letIn);
        address w = who % 2 == 0 ? address(fussy) : agents[who % 4];
        if (g.owed(w) == 0) return;
        try g.collect(w) {} catch {}
    }
}
