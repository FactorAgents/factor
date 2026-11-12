// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorGuarantee} from "../../src/FactorGuarantee.sol";
import {FactorVouch} from "../../src/FactorVouch.sol";

/// A customer that refuses ETH while told to: what a vouch pays it waits as owed.
contract FussyVouchCustomer {
    bool public refuse = true;

    function setRefuse(bool on) external {
        refuse = on;
    }

    receive() external payable {
        require(!refuse, "no");
    }
}

/// Everything anybody can do to vouches, lines, covers and the desk together, in any order the fuzzer likes: two
/// vouchers (a plain wallet and a line account run by its key) bond, take bond out, offer on two lines and on covers
/// and withdraw offers; the lines' keys and the covered agent accept and release; the lines earn, bond, draw, repay and
/// are recovered; customers hire with cover, and jobs are delivered, accepted, rejected and declined; time passes;
/// vouches are settled; refused payouts are collected.
///
/// It checks each settle against the line's or the cover's own state as it happens (a wrong one raises `wrong`).
contract VouchHandler is Test {
    FactorDesk public immutable desk;
    FactorLine public immutable line;
    FactorGuarantee public immutable g;
    FactorVouch public immutable vc;

    address[2] public vouchers; // desk addresses: a plain wallet and a line account
    address public voucherKey; // the key of the second
    address[2] public keys; // the newer agents' keys
    address[2] public accounts; // their line accounts
    address public covered = makeAddr("vouch covered agent");
    address public customer = makeAddr("vouch customer");
    FussyVouchCustomer public fussy;
    address public scorer = makeAddr("vouch scorer");

    uint256[] public covers;
    uint256[] public coverJobs;

    bool public wrong;
    string public why;
    uint256 public offers;
    uint256 public accepted;
    uint256 public kept;
    uint256 public fails;
    uint256 public returned;
    uint256 public withdrawn;

    constructor(FactorDesk desk_, FactorLine line_, FactorGuarantee g_, FactorVouch vc_) {
        desk = desk_;
        line = line_;
        g = g_;
        vc = vc_;
        vouchers[0] = makeAddr("vouch voucher one");
        voucherKey = makeAddr("vouch voucher two's key");
        keys[0] = makeAddr("vouch newer key one");
        keys[1] = makeAddr("vouch newer key two");
        fussy = new FussyVouchCustomer();
        address[5] memory reg = [vouchers[0], voucherKey, keys[0], keys[1], covered];
        for (uint256 i = 0; i < 5; ++i) {
            vm.prank(reg[i]);
            desk.register();
        }
    }

    /// Strong scores for the vouchers (thirty jobs and fifty days), 200 for the covered agent, then the lines opened.
    function setUpScores() external {
        for (uint256 i = 0; i < 21; ++i) {
            _job(scorer, vouchers[0], i == 20 ? 0.05 ether : 0.001 ether);
            _job(scorer, voucherKey, i == 20 ? 0.05 ether : 0.001 ether);
            if (i < 20) _job(scorer, covered, 0.001 ether);
        }
        vm.warp(block.timestamp + 50 days);
        vm.prank(voucherKey);
        vouchers[1] = line.open();
        for (uint256 i = 0; i < 2; ++i) {
            vm.prank(keys[i]);
            accounts[i] = line.open();
        }
        vm.deal(address(this), 2 ether);
        g.addBond{value: 1 ether}(covered);
        vm.prank(covered);
        g.setOffer(covered, 1 ether);
    }

    function _job(address from, address agent, uint256 price) internal {
        vm.deal(from, from.balance + price);
        vm.prank(from);
        uint256 id = desk.lock{value: price}(agent, block.timestamp + 1 days, false);
        vm.prank(agent);
        desk.deliver(id, keccak256("w"));
        vm.prank(from);
        desk.accept(id);
    }

    function _runner(address who) internal view returns (address) {
        address k = line.keyOf(who);
        return k == address(0) ? who : k;
    }

    function _fail(string memory s) internal {
        wrong = true;
        why = s;
    }

    /// A vouch in `state`, looked for from a number the fuzzer picks, so the runs spend their steps on live vouches.
    function _find(uint256 i, FactorVouch.State state) internal view returns (uint256 id, bool ok) {
        uint256 n = vc.vouchCount();
        for (uint256 k = 0; k < n; ++k) {
            id = 1 + ((i + k) % n);
            if (vc.vouch(id).state == state) return (id, true);
        }
        return (0, false);
    }

    // ---------- the vouchers ----------

    function bond(uint8 v, uint96 amount) external {
        amount = uint96(bound(amount, 0.0001 ether, 0.5 ether));
        vm.deal(address(this), address(this).balance + amount);
        vc.addBond{value: amount}(vouchers[v % 2]);
    }

    function takeBond(uint8 v, uint96 amount) external {
        address who = vouchers[v % 2];
        uint256 free = vc.freeOf(who);
        if (free == 0) return;
        amount = uint96(bound(amount, 1, free));
        vm.prank(_runner(who));
        vc.takeBond(who, amount);
    }

    function offerLine(uint8 v, uint8 l, uint96 amount) external {
        address who = vouchers[v % 2];
        uint256 can = vc.canVouch(who, accounts[l % 2]);
        if (can < 0.0001 ether) return;
        amount = uint96(bound(amount, 0.0001 ether, can));
        vm.prank(_runner(who));
        try vc.offerLine(who, accounts[l % 2], amount) {
            offers += 1;
        } catch {}
    }

    function offerCover(uint8 v, uint256 c, uint96 amount) external {
        if (covers.length == 0) return;
        address who = vouchers[v % 2];
        uint256 can = vc.canVouch(who, covered);
        if (can < 0.0001 ether) return;
        amount = uint96(bound(amount, 0.0001 ether, can));
        vm.prank(_runner(who));
        try vc.offerCover(who, covers[c % covers.length], amount) {
            offers += 1;
        } catch {}
    }

    function withdraw(uint256 i, bool byVoucher) external {
        (uint256 id, bool ok) = _find(i, FactorVouch.State.Offered);
        if (!ok) return;
        vm.prank(byVoucher ? _runner(vc.vouch(id).voucher) : scorer);
        try vc.withdraw(id) {
            withdrawn += 1;
        } catch {}
    }

    // ---------- the vouched agents ----------

    function accept(uint256 i) external {
        (uint256 id, bool ok) = _find(i, FactorVouch.State.Offered);
        if (!ok) return;
        FactorVouch.Vouch memory v = vc.vouch(id);
        if (v.state != FactorVouch.State.Offered) return;
        address by = _runner(v.agent);
        vm.deal(by, by.balance + v.fee);
        vm.prank(by);
        try vc.accept{value: v.fee}(id) {
            accepted += 1;
        } catch {}
    }

    function release(uint256 i) external {
        (uint256 id, bool ok) = _find(i, FactorVouch.State.Active);
        if (!ok) return;
        FactorVouch.Vouch memory v = vc.vouch(id);
        if (v.state != FactorVouch.State.Active || v.kind != FactorVouch.Kind.Line) return;
        vm.prank(_runner(v.agent));
        try vc.release(id) {
            kept += 1;
            if (line.debtOf(v.agent) != 0) _fail("released while the line owes");
        } catch {}
    }

    // ---------- the lines ----------

    function earn(uint8 l, uint96 price) external {
        price = uint96(bound(price, 0.001 ether, 0.5 ether));
        address acct = accounts[l % 2];
        vm.deal(customer, customer.balance + price);
        vm.prank(customer);
        uint256 id = desk.lock{value: price}(acct, block.timestamp + 1 days, false);
        vm.prank(keys[l % 2]);
        FactorLineAccount(payable(acct)).deliver(id, keccak256("w"));
        vm.prank(customer);
        desk.accept(id);
        // the key takes out what the line does not need, so a default leaves the fees' part unpaid
        FactorLineAccount(payable(acct)).sweep();
        uint256 have = acct.balance;
        if (have > 0 && line.debtOf(acct) == 0) {
            vm.prank(keys[l % 2]);
            FactorLineAccount(payable(acct)).withdraw(payable(keys[l % 2]), have);
        }
    }

    function lineBond(uint8 l, uint96 amount) external {
        amount = uint96(bound(amount, 0.0001 ether, 0.05 ether));
        address k = keys[l % 2];
        vm.deal(k, k.balance + amount);
        vm.prank(k);
        FactorLineAccount(payable(accounts[l % 2])).addBond{value: amount}(0);
    }

    function draw(uint8 l, uint96 amount) external {
        address k = keys[l % 2];
        uint256 can = line.canDraw(k);
        if (can < 0.0001 ether) return;
        amount = uint96(bound(amount, 0.0001 ether, can));
        vm.prank(k);
        try line.draw(amount, false) {} catch {}
    }

    function repay(uint8 l, uint96 amount) external {
        address acct = accounts[l % 2];
        uint256 debt = line.debtOf(acct);
        if (debt == 0) return;
        amount = uint96(bound(amount, 1, debt));
        vm.deal(address(this), address(this).balance + amount);
        line.repay{value: amount}(acct);
    }

    function recover(uint8 l) external {
        try line.recover(accounts[l % 2]) {} catch {}
    }

    // ---------- covers and jobs ----------

    function hireCovered(bool toFussy) external {
        address who = toFussy ? address(fussy) : customer;
        uint256 dueAt = block.timestamp + 1 days;
        uint256 cap = g.coverLimit(covered, 0.04 ether);
        if (cap < 0.0001 ether) return;
        uint256 fee = g.feeFor(cap);
        vm.deal(who, who.balance + fee + 0.04 ether);
        vm.prank(who);
        uint256 id = g.reserve{value: fee}(covered, 0.04 ether, dueAt, false, cap);
        vm.prank(who);
        uint256 job = desk.lock{value: 0.04 ether}(covered, dueAt, false);
        g.bind(id, job);
        covers.push(id);
        coverJobs.push(job);
    }

    function deliver(uint256 j) external {
        if (coverJobs.length == 0) return;
        vm.prank(covered);
        try desk.deliver(coverJobs[j % coverJobs.length], keccak256("w")) {} catch {}
    }

    function answer(uint256 j, bool yes) external {
        if (coverJobs.length == 0) return;
        uint256 job = coverJobs[j % coverJobs.length];
        vm.prank(desk.job(job).customer);
        if (yes) {
            try desk.accept(job) {} catch {}
        } else {
            try desk.reject(job) {} catch {}
        }
    }

    function decline(uint256 j) external {
        if (coverJobs.length == 0) return;
        vm.prank(covered);
        try desk.decline(coverJobs[j % coverJobs.length]) {} catch {}
    }

    // ---------- time, settling, collecting ----------

    function warp(uint32 by) external {
        vm.warp(block.timestamp + bound(by, 1 minutes, 20 days));
    }

    function settle(uint256 i) external {
        (uint256 id, bool ok) = _find(i, FactorVouch.State.Active);
        if (!ok) return;
        FactorVouch.Vouch memory before = vc.vouch(id);
        try vc.settle(id) {
            FactorVouch.Vouch memory v = vc.vouch(id);
            if (v.kind == FactorVouch.Kind.Line) {
                FactorLine.Line memory l = line.line(address(uint160(v.subject)));
                if (v.state == FactorVouch.State.Failed) {
                    fails += 1;
                    if (!l.defaulted) _fail("a line vouch failed on a line that did not default");
                    if (v.paidTo != address(line)) _fail("a line's loss paid somewhere else");
                    if (v.paid > before.amount + before.fee) _fail("paid more than the fee and the amount");
                } else if (v.state == FactorVouch.State.Kept) {
                    kept += 1;
                    if (block.timestamp <= v.endsAt) _fail("a line vouch kept before its end");
                } else {
                    _fail("a line vouch ended neither kept nor failed");
                }
            } else {
                FactorGuarantee.State cs = g.cover(v.subject).state;
                if (v.state == FactorVouch.State.Kept) {
                    kept += 1;
                    if (cs != FactorGuarantee.State.Released) _fail("kept on a cover not released");
                } else if (v.state == FactorVouch.State.Failed) {
                    fails += 1;
                    if (cs != FactorGuarantee.State.Paid) _fail("failed on a cover not paid");
                    if (v.paid != before.amount) _fail("a cover vouch paid other than its amount");
                    if (v.paidTo != g.cover(v.subject).customer) _fail("a cover vouch paid someone not the customer");
                } else if (v.state == FactorVouch.State.Returned) {
                    returned += 1;
                    if (cs != FactorGuarantee.State.Declined) _fail("returned on a cover not declined");
                } else {
                    _fail("a cover vouch ended in another state");
                }
            }
        } catch {}
    }

    function collect(bool pay) external {
        fussy.setRefuse(!pay);
        if (vc.owed(address(fussy)) > 0 && pay) vc.collect(address(fussy));
    }

    receive() external payable {}
}
