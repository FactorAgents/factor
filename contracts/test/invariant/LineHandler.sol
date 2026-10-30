// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";

/// Everything anybody can do to lines and the desk together, in any order the fuzzer likes: agents open lines, bond
/// at their line accounts, are hired and paid there, draw on the line and on the desk (all three kinds), deliver or
/// go silent, repay, sweep, withdraw and take their bonds out; customers hire, strangers repay, time passes, lines
/// are recovered and default, and the pool is seeded.
///
/// It checks each draw and each payout against the rulebook as it happens (a wrong one raises `wrong`).
contract LineHandler is Test {
    FactorDesk public immutable desk;
    FactorLine public immutable line;
    address public immutable burnPot;
    address public immutable gateway;

    address[4] public keys;
    address public customer = makeAddr("line customer");
    address public stranger = makeAddr("line stranger");

    struct Open {
        uint256 id;
        uint8 who;
    }

    Open[] public jobs; // desk jobs for line accounts that are not closed yet

    bool public wrong;
    string public why;
    uint256 public draws;
    uint256 public deskDraws;
    uint256 public recovers;

    constructor(FactorDesk desk_, FactorLine line_) {
        desk = desk_;
        line = line_;
        burnPot = desk_.burnPot();
        gateway = desk_.gateway();
        keys =
            [makeAddr("line key one"), makeAddr("line key two"), makeAddr("line key three"), makeAddr("line key four")];
        for (uint256 i = 0; i < 4; ++i) {
            vm.prank(keys[i]);
            desk.register();
        }
    }

    function _fail(string memory what) internal {
        if (!wrong) why = what;
        wrong = true;
    }

    function _key(uint8 i) internal view returns (address) {
        return keys[i % 4];
    }

    function _acct(uint8 i) internal view returns (FactorLineAccount) {
        return FactorLineAccount(payable(line.accountOf(_key(i))));
    }

    function accountOf(uint256 i) external view returns (address) {
        return line.accountOf(keys[i]);
    }

    function jobCount() external view returns (uint256) {
        return jobs.length;
    }

    /// The rule that must hold at every draw, from either side: what the desk has out with the account and what the
    /// line is owed together are never more than the account's bond and fees.
    function _countedOnce(address acct) internal {
        FactorDesk.Agent memory a = desk.agent(acct);
        if (a.advancedNow + line.debtOf(acct) > a.bond + a.feesPaid) {
            _fail("a draw went past bond + fees, counted once");
        }
    }

    // ---------- the moves ----------

    function seed(uint256 amount) external {
        amount = bound(amount, 0.001 ether, 2 ether);
        vm.deal(address(this), amount);
        (bool ok,) = address(line).call{value: amount}("");
        if (!ok) _fail("a seed was refused");
    }

    function open(uint8 i) external {
        address k = _key(i);
        if (line.accountOf(k) != address(0) || desk.agent(k).barred) return;
        vm.prank(k);
        line.open();
    }

    function bond(uint8 i, uint256 amount) external {
        FactorLineAccount a = _acct(i);
        if (address(a) == address(0)) return;
        amount = bound(amount, 1, 0.2 ether);
        address k = _key(i);
        vm.deal(k, k.balance + amount);
        vm.prank(k);
        a.addBond{value: amount}(0);
    }

    function hire(uint8 i, uint256 price, bool early) external {
        FactorLineAccount a = _acct(i);
        if (address(a) == address(0)) return;
        price = bound(price, 0.001 ether, 1 ether);
        vm.deal(customer, customer.balance + price);
        vm.prank(customer);
        uint256 id = desk.lock{value: price}(address(a), block.timestamp + 1 days, early);
        jobs.push(Open(id, i % 4));
    }

    function deskDraw(uint256 j, uint256 amount, uint8 kind) external {
        if (jobs.length == 0) return;
        Open memory o = jobs[j % jobs.length];
        FactorDesk.Kind k = FactorDesk.Kind(kind % 3);
        (uint256 early, uint256 fromPool) = desk.canDrawOn(o.id);
        uint256 most = k == FactorDesk.Kind.Early ? early : fromPool;
        if (most == 0) return;
        amount = bound(amount, 1, most);
        FactorLineAccount a = _acct(o.who);
        vm.prank(_key(o.who));
        try a.drawAdvance(o.id, amount, k) {
            deskDraws += 1;
            _countedOnce(address(a));
        } catch {}
    }

    function deliverAndAccept(uint256 j) external {
        if (jobs.length == 0) return;
        uint256 at = j % jobs.length;
        Open memory o = jobs[at];
        FactorDesk.Job memory job = desk.job(o.id);
        if (block.timestamp > uint256(job.dueAt) + 12 hours) return;
        FactorLineAccount a = _acct(o.who);
        uint256 before = address(a).balance;
        vm.prank(_key(o.who));
        a.deliver(o.id, keccak256("w"));
        vm.prank(customer);
        desk.accept(o.id);
        uint256 toAgent = job.price - job.early - job.fromPool - (job.price * 200) / 10_000;
        if (address(a).balance - before != toAgent) _fail("a job's payout did not land in the line account");
        _drop(at);
    }

    function refundLate(uint256 j) external {
        if (jobs.length == 0) return;
        uint256 at = j % jobs.length;
        Open memory o = jobs[at];
        FactorDesk.Job memory job = desk.job(o.id);
        if (block.timestamp <= uint256(job.dueAt) + 12 hours) vm.warp(uint256(job.dueAt) + 12 hours + 1);
        desk.refund(o.id);
        _drop(at);
    }

    function lineDraw(uint8 i, uint256 amount, bool compute) external {
        address k = _key(i);
        uint256 can = line.canDraw(k);
        if (can < line.MIN_DRAW()) return;
        amount = bound(amount, line.MIN_DRAW(), can);
        address acct = line.accountOf(k);
        uint256 debtBefore = line.debtOf(acct);
        uint256 keyBefore = k.balance;
        uint256 gwBefore = gateway.balance;
        uint256 potBefore = burnPot.balance;
        vm.prank(k);
        line.draw(amount, compute);
        draws += 1;
        uint256 net = amount - (amount * 200) / 10_000;
        if (line.debtOf(acct) != debtBefore + amount) _fail("a draw did not owe the whole amount");
        if (burnPot.balance - potBefore != (amount * 100) / 10_000) _fail("the burn half went astray");
        if (compute) {
            if (gateway.balance - gwBefore != net || k.balance != keyBefore) _fail("compute reached somewhere else");
        } else if (k.balance - keyBefore != net) {
            _fail("cash did not reach the key");
        }
        _countedOnce(acct);
    }

    function repay(uint8 i, uint256 amount) external {
        address acct = line.accountOf(_key(i));
        uint256 d = line.debtOf(acct);
        if (d == 0) return;
        amount = bound(amount, 1, d);
        vm.deal(stranger, stranger.balance + amount);
        vm.prank(stranger);
        line.repay{value: amount}(acct);
    }

    function sweep(uint8 i) external {
        FactorLineAccount a = _acct(i);
        if (address(a) == address(0)) return;
        uint256 d = line.debtOf(address(a));
        uint256 b = address(a).balance;
        uint256 paid = a.sweep();
        if (paid != (d < b ? d : b)) _fail("a sweep paid the wrong amount");
    }

    function withdraw(uint8 i, uint256 amount) external {
        FactorLineAccount a = _acct(i);
        if (address(a) == address(0)) return;
        address k = _key(i);
        vm.prank(k);
        try a.withdraw(payable(k), bound(amount, 0, address(a).balance)) {
            if (line.debtOf(address(a)) != 0) _fail("ETH left the account while the line was owed");
        } catch {}
    }

    function takeBond(uint8 i, uint256 amount) external {
        FactorLineAccount a = _acct(i);
        if (address(a) == address(0)) return;
        uint256 b = desk.agent(address(a)).bond;
        if (b == 0) return;
        bool owing = line.debtOf(address(a)) != 0;
        vm.prank(_key(i));
        try a.takeBond(bound(amount, 1, b)) {
            if (owing) _fail("a bond left while the line was owed");
        } catch {}
    }

    function wait(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 minutes, 20 days));
    }

    /// Time runs on to when the line can be recovered, if it is not there yet, and anyone recovers it.
    function recover(uint8 i) external {
        address acct = line.accountOf(_key(i));
        if (acct == address(0) || line.debtOf(acct) == 0) return;
        FactorLine.Line memory l = line.line(acct);
        uint256 at = uint256(l.dueAt) + 30 days;
        if (!l.defaulted && block.timestamp <= at) vm.warp(at + 1);
        uint256 debtBefore = l.debt;
        uint256 have = acct.balance;
        line.recover(acct);
        recovers += 1;
        l = line.line(acct);
        if (l.debt > debtBefore - (have < debtBefore ? have : debtBefore)) {
            _fail("recover did not use the account's ETH");
        }
        if (l.debt > 0 && !l.defaulted) _fail("a line still owed after recovery did not default");
    }

    function _drop(uint256 at) internal {
        jobs[at] = jobs[jobs.length - 1];
        jobs.pop();
    }

    receive() external payable {}
}
