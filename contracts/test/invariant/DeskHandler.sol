// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {ForceSend, Rejecter} from "../mocks/Actors.sol";

/// Everything anybody can do to the desk, in any order the fuzzer likes: customers lock jobs, agents draw all three
/// kinds of advance, deliver, decline or go silent, customers accept, reject or never come back, bonds go in and
/// out, the pool is filled, time passes, wallets start and stop refusing ETH, and ETH is forced in.
///
/// It checks every payout against the rulebook as it happens (a wrong one raises `wrong`), and keeps its own books
/// beside the desk's so the invariants can compare the two.
contract DeskHandler is Test {
    FactorDesk public immutable desk;
    address public immutable burnPot;
    address public immutable gateway;

    address[4] public agents; // three plain wallets and one that can refuse ETH
    address[4] public customers; // two plain wallets, one that can refuse ETH, and the first agent hiring itself
    Rejecter public shyAgent;
    Rejecter public shyCustomer;

    uint256[] public open; // jobs that are not closed yet

    // ---- the handler's own books ----
    uint256 public forced; // ETH pushed in without a call: in nobody's books
    uint256 public computeNet; // what compute advances sent to the gateway
    uint256 public declined;
    uint256 public closed;
    mapping(address agent => uint256) public lostBy; // what the pool lost to each agent
    bool public wrong;
    string public why;

    constructor(FactorDesk desk_) {
        desk = desk_;
        burnPot = desk_.burnPot();
        gateway = desk_.gateway();
        shyAgent = new Rejecter();
        shyAgent.setAccept(true);
        shyCustomer = new Rejecter();
        shyCustomer.setAccept(true);
        agents = [makeAddr("agent one"), makeAddr("agent two"), makeAddr("agent three"), address(shyAgent)];
        customers = [makeAddr("customer one"), makeAddr("customer two"), address(shyCustomer), agents[0]];
        for (uint256 i = 0; i < 4; ++i) {
            vm.prank(agents[i]);
            desk.register();
        }
    }

    function openCount() external view returns (uint256) {
        return open.length;
    }

    // ---------- internals ----------

    function _fail(string memory what) internal {
        if (!wrong) why = what;
        wrong = true;
    }

    /// What a wallet has been given: what reached it and what waits for it in the desk.
    function _got(address who) internal view returns (uint256) {
        return who.balance + desk.owed(who);
    }

    function _pick(uint256 seed) internal view returns (uint256 at, uint256 id, FactorDesk.Job memory j) {
        if (open.length == 0) return (0, 0, j);
        at = seed % open.length;
        id = open[at];
        j = desk.job(id);
    }

    function _close(uint256 at) internal {
        open[at] = open[open.length - 1];
        open.pop();
        closed += 1;
    }

    // ---------- the pool and the bonds ----------

    function fund(uint96 eth) external {
        uint256 a = bound(eth, 0.001 ether, 5 ether);
        vm.deal(address(this), a);
        (bool ok,) = address(desk).call{value: a}("");
        if (!ok) _fail("the desk refused ETH for the pool");
    }

    function force(uint64 eth) external {
        uint256 a = bound(eth, 1, 1 ether);
        vm.deal(address(this), a);
        new ForceSend{value: a}(payable(address(desk)));
        forced += a;
    }

    function bond(uint8 who, uint96 eth) external {
        address a = agents[who % 4];
        uint256 amount = bound(eth, 0.0001 ether, 1 ether);
        vm.deal(a, a.balance + amount);
        vm.prank(a);
        desk.addBond{value: amount}();
    }

    function unbond(uint8 who, uint96 eth) external {
        address a = agents[who % 4];
        FactorDesk.Agent memory rec = desk.agent(a);
        if (rec.bond == 0) return;
        uint256 amount = bound(eth, 1, rec.bond);
        uint256 before = _got(a);
        vm.prank(a);
        try desk.takeBond(amount) {
            if (rec.advancedNow != 0) _fail("a bond left while the agent owed the pool");
            if (_got(a) - before != amount) _fail("a bond did not come back whole");
        } catch {
            if (rec.advancedNow == 0) _fail("a bond could not be taken though nothing was owed");
        }
    }

    // ---------- a job ----------

    function lock(uint8 c, uint8 a, uint96 price, uint32 due, bool early) external {
        address from = customers[c % 4];
        uint256 p = bound(price, 0.001 ether, 3 ether);
        // mostly short jobs, so that due times really pass during a run
        uint256 d = due % 10 == 0 ? bound(due, 1 hours, 30 days) : bound(due, 1 hours, 3 days);
        vm.deal(from, from.balance + p);
        vm.prank(from);
        uint256 id = desk.lock{value: p}(agents[a % 4], block.timestamp + d, early);
        open.push(id);
    }

    function draw(uint256 seed, uint96 eth, uint8 kind) external {
        (, uint256 id, FactorDesk.Job memory j) = _pick(seed);
        if (id == 0) return;
        (uint256 early, uint256 fromPool) = desk.canDrawOn(id);
        FactorDesk.Kind k = FactorDesk.Kind(kind % 3);
        uint256 max = k == FactorDesk.Kind.Early ? early : fromPool;
        if (max == 0) return;
        uint256 amount = bound(eth, 1, max);
        uint256 fee = amount / 100;
        address to = k == FactorDesk.Kind.Compute ? gateway : j.agent;
        uint256 toBefore = _got(to);
        uint256 potBefore = _got(burnPot);
        uint256 poolBefore = desk.pool();
        vm.prank(j.agent);
        desk.draw(id, amount, k);
        if (_got(to) - toBefore != amount - fee) _fail("draw: the advance did not arrive less exactly its fee");
        if (_got(burnPot) - potBefore != fee) _fail("draw: the fee did not reach the burn pot");
        if (poolBefore - desk.pool() != (k == FactorDesk.Kind.Early ? 0 : amount)) {
            _fail("draw: the pool moved wrongly");
        }
        if (k == FactorDesk.Kind.Compute) computeNet += amount - fee;
    }

    function deliver(uint256 seed) external {
        (, uint256 id, FactorDesk.Job memory j) = _pick(seed);
        if (id == 0 || (j.state != FactorDesk.State.Locked && j.state != FactorDesk.State.Advanced)) return;
        if (block.timestamp > uint256(j.dueAt) + 12 hours) return;
        vm.prank(j.agent);
        desk.deliver(id, keccak256(abi.encode(id)));
    }

    function decline(uint256 seed) external {
        (uint256 at, uint256 id, FactorDesk.Job memory j) = _pick(seed);
        if (id == 0 || j.state != FactorDesk.State.Locked) return;
        uint256 before = _got(j.customer);
        vm.prank(j.agent);
        desk.decline(id);
        if (_got(j.customer) - before != j.price) _fail("decline: the customer did not get everything back");
        declined += 1;
        _close(at);
    }

    function accept(uint256 seed) external {
        (uint256 at, uint256 id, FactorDesk.Job memory j) = _pick(seed);
        if (id == 0 || j.state != FactorDesk.State.Delivered) return;
        _settle(at, id, j, true);
    }

    function settle(uint256 seed) external {
        (uint256 at, uint256 id, FactorDesk.Job memory j) = _pick(seed);
        if (id == 0 || j.state != FactorDesk.State.Delivered) return;
        if (block.timestamp < uint256(j.deliveredAt) + 24 hours) return;
        _settle(at, id, j, false);
    }

    function _settle(uint256 at, uint256 id, FactorDesk.Job memory j, bool byCustomer) internal {
        uint256 fee = (j.price * 200) / 10_000;
        uint256 agentBefore = _got(j.agent);
        uint256 customerBefore = _got(j.customer);
        uint256 poolBefore = desk.pool();
        if (byCustomer) {
            vm.prank(j.customer);
            desk.accept(id);
        } else {
            desk.settle(id);
        }
        if (desk.pool() - poolBefore != j.fromPool + fee) {
            _fail("settle: the pool did not get its advance and the fee");
        }
        if (j.customer != j.agent) {
            if (_got(j.agent) - agentBefore != j.price - j.early - j.fromPool - fee) {
                _fail("settle: the agent's payout");
            }
            if (_got(j.customer) != customerBefore) _fail("settle: the customer was paid");
        }
        _close(at);
    }

    function reject(uint256 seed) external {
        (uint256 at, uint256 id, FactorDesk.Job memory j) = _pick(seed);
        if (id == 0 || j.state != FactorDesk.State.Delivered) return;
        if (block.timestamp >= uint256(j.deliveredAt) + 24 hours) return;
        uint256 toCustomer = j.price / 2;
        uint256 left = j.price - toCustomer - j.early - j.fromPool;
        uint256 fee = ((j.price - toCustomer) * 200) / 10_000;
        if (fee > left) fee = left;
        uint256 agentBefore = _got(j.agent);
        uint256 customerBefore = _got(j.customer);
        uint256 poolBefore = desk.pool();
        vm.prank(j.customer);
        desk.reject(id);
        if (desk.pool() - poolBefore != j.fromPool + fee) _fail("reject: the pool was not repaid first");
        if (j.customer != j.agent) {
            if (_got(j.customer) - customerBefore != toCustomer) _fail("reject: the customer did not get half");
            if (_got(j.agent) - agentBefore != left - fee) _fail("reject: the agent's side");
        }
        _close(at);
    }

    function refund(uint256 seed) external {
        (uint256 at, uint256 id, FactorDesk.Job memory j) = _pick(seed);
        if (id == 0 || (j.state != FactorDesk.State.Locked && j.state != FactorDesk.State.Advanced)) return;
        if (block.timestamp <= uint256(j.dueAt) + 12 hours) return;
        uint256 bondBefore = desk.agent(j.agent).bond;
        uint256 lostBefore = desk.totalLost();
        uint256 poolBefore = desk.pool();
        uint256 customerBefore = _got(j.customer);
        desk.refund(id);
        uint256 fromBond = bondBefore < j.fromPool ? bondBefore : j.fromPool;
        uint256 lost = desk.totalLost() - lostBefore;
        if (lost != j.fromPool - fromBond) _fail("refund: the loss is not what the bond left uncovered");
        if (desk.pool() - poolBefore != fromBond) _fail("refund: the bond did not go to the pool");
        // an agent that hires itself and takes its own bond back in the same wallet is the one case where the
        // customer's wallet is also the agent's; its refund is still the price less the early advance
        if (_got(j.customer) - customerBefore != j.price - j.early) _fail("refund: the customer's money");
        lostBy[j.agent] += lost;
        _close(at);
    }

    /// An agent that owes nothing takes its bond out, has itself hired from its second wallet, draws everything
    /// its fees allow from the pool and never delivers. The refund comes later, like any other.
    function runOff(uint8 who, uint96 price) external {
        address a = agents[who % 4];
        FactorDesk.Agent memory rec = desk.agent(a);
        if (rec.barred || rec.feesPaid == 0 || rec.advancedNow != 0) return;
        if (rec.bond > 0) {
            vm.prank(a);
            desk.takeBond(rec.bond);
        }
        address from = customers[1];
        uint256 p = bound(price, 0.01 ether, 3 ether);
        vm.deal(from, from.balance + p);
        vm.prank(from);
        uint256 id = desk.lock{value: p}(a, block.timestamp + 1 hours, false);
        open.push(id);
        (, uint256 fromPool) = desk.canDrawOn(id);
        if (fromPool == 0) return;
        vm.prank(a);
        desk.draw(id, fromPool, FactorDesk.Kind.Pool);
    }

    // ---------- time, and wallets that refuse ----------

    function wait(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 minutes, 2 days));
    }

    function toggle(uint8 which) external {
        Rejecter r = which % 2 == 0 ? shyAgent : shyCustomer;
        r.setAccept(!r.accept());
    }

    function collect(uint8 which) external {
        address who = which % 2 == 0 ? address(shyAgent) : address(shyCustomer);
        uint256 waiting = desk.owed(who);
        if (waiting == 0) return;
        uint256 before = who.balance;
        try desk.collect(who) {
            if (who.balance - before != waiting) _fail("collect: not what was waiting");
        } catch {
            if (Rejecter(payable(who)).accept()) _fail("collect: a wallet that accepts was not paid");
        }
    }
}
