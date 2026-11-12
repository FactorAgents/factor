// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorBurnPot} from "../../src/FactorBurnPot.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorGuarantee} from "../../src/FactorGuarantee.sol";
import {FactorVouch} from "../../src/FactorVouch.sol";

/// Vouching against the contracts that are DEPLOYED on Robinhood Chain, at their real addresses, on a fork of the chain
/// (nothing here is sent anywhere): a vouching contract is deployed beside the live desk, the live line contract and the
/// live guarantee contract, which know nothing of it. report-lead, the live agent with the desk's best score, vouches for
/// the demo wallet's live line account, which accepts and is kept; a fresh agent opens a line on the live line contract,
/// draws from the live pool and defaults, and its voucher's bond repays the live pool; a strong agent co-signs a cover
/// report-lead sold on the live guarantee contract, on a job that is never delivered, and the customer is paid; the live
/// line account and its key cannot vouch for each other. Half of every fee kept reaches the live burn pot.
contract VouchingForkTest is ForkBase {
    FactorDesk constant DESK = FactorDesk(payable(0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F));
    FactorBurnPot constant POT = FactorBurnPot(payable(0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79));
    FactorLine constant LINE = FactorLine(payable(0xc9405ca62eD1e9a4a058F404e5c1C893F7ae67c4));
    FactorGuarantee constant G = FactorGuarantee(payable(0x577A00Ad9B0a719C4465A3a887F969B0E377daEF));
    /// report-lead, a test agent of Factor's own with the best score on the live desk (323 on 12 Nov 2026)
    address constant LEAD = 0x74325C9644973d9C7A293BDFc970a573A38419e1;
    /// Factor's demo wallet and its live line account
    address constant DEMO = 0x50A9Bf50C3337d5db03efdF89DEB0F5A0B908f17;
    address constant DEMO_LINE = 0x4Af5cbd7BaAD4AE2F09d45fd9b55bD49214b2c5F;

    FactorVouch vc;

    function setUp() public {
        _fork();
        vc = new FactorVouch(G);
        vm.deal(LEAD, 1 ether);
        vm.deal(DEMO, 1 ether);
    }

    function _books() internal view {
        assertEq(address(vc).balance, vc.bonds() + vc.feesHeld() + vc.owedTotal());
        assertEq(address(LINE).balance, LINE.pool() + LINE.owedTotal(), "the live line contract holds its books");
    }

    function test_wiredToTheLiveContracts() public view {
        assertEq(address(vc.guarantee()), address(G));
        assertEq(address(vc.line()), address(LINE));
        assertEq(address(vc.desk()), address(DESK));
        assertEq(vc.burnPot(), address(POT));
        assertEq(vc.lineDue(), 30 days);
        assertEq(vc.grace(), 12 hours);
        assertGe(vc.scoreOf(LEAD), 300, "report-lead's live score is strong enough to vouch");
        assertEq(vc.agentOf(DEMO), DEMO_LINE, "the demo wallet works from its live line account");
    }

    /// report-lead vouches for the demo wallet's live line; the demo wallet accepts; 30 days on, the line owes nothing
    /// and the vouch is kept: half of the fee into report-lead's bond, half to the live burn pot.
    function test_aLiveAgentVouchesForALiveLineAndIsKept() public {
        vm.prank(LEAD);
        vc.addBond{value: 0.0004 ether}(LEAD);
        vm.prank(LEAD);
        uint256 id = vc.offerLine(LEAD, DEMO_LINE, 0.0001 ether);
        vm.prank(DEMO);
        vc.accept{value: 0.000002 ether}(id);
        vm.warp(block.timestamp + 30 days + 1);
        uint256 pot = address(POT).balance;
        vc.settle(id);
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Kept));
        assertEq(vc.voucherOf(LEAD).earned, 0.000001 ether);
        assertEq(address(POT).balance - pot, 0.000001 ether, "the burn half reached the live burn pot");
        _books();
    }

    /// The demo wallet releases the vouch at once, its line owing nothing: kept. The real run's steps.
    function test_theRealRunsStepsOnTheLiveLine() public {
        vm.prank(LEAD);
        vc.addBond{value: 0.0004 ether}(LEAD);
        vm.prank(LEAD);
        uint256 id = vc.offerLine(LEAD, DEMO_LINE, 0.0001 ether);
        vm.prank(DEMO);
        vc.accept{value: 0.000002 ether}(id);
        vm.prank(DEMO);
        vc.release(id);
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Kept));
        uint256 free = vc.freeOf(LEAD);
        assertEq(free, 0.000401 ether);
        uint256 before = LEAD.balance;
        vm.prank(LEAD);
        vc.takeBond(LEAD, free);
        assertEq(LEAD.balance - before, 0.000401 ether);
        assertEq(address(vc).balance, 0);
    }

    /// A fresh agent opens a line on the live line contract, earns on the live desk, draws from the live pool and
    /// defaults. report-lead's vouch repays the live pool; the pool loses nothing.
    function test_aDefaultOnTheLiveLineIsPaidByTheVoucher() public {
        address key = makeAddr("a newer agent on the live desk");
        address customer = makeAddr("its customer on the live desk");
        vm.deal(customer, 10 ether);
        vm.prank(key);
        DESK.register();
        vm.prank(key);
        FactorLineAccount acct = FactorLineAccount(payable(LINE.open()));
        // the live pool is small: seeded on the fork, as anyone can seed it
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(LINE).call{value: 0.5 ether}("");
        assertTrue(ok);
        vm.prank(LEAD);
        vc.addBond{value: 0.04 ether}(LEAD);
        vm.prank(LEAD);
        uint256 id = vc.offerLine(LEAD, address(acct), 0.01 ether);
        vm.deal(key, 0.001 ether);
        vm.prank(key);
        vc.accept{value: 0.0002 ether}(id);
        // a job of 0.3 on the live desk: its 0.006 fee is the line's limit; the payout is taken out
        vm.prank(customer);
        uint256 job = DESK.lock{value: 0.3 ether}(address(acct), block.timestamp + 1 days, false);
        vm.prank(key);
        acct.deliver(job, keccak256("the work"));
        vm.prank(customer);
        DESK.accept(job);
        uint256 have = address(acct).balance;
        vm.prank(key);
        acct.withdraw(payable(key), have);
        vm.prank(key);
        LINE.draw(0.006 ether, false);
        uint256 lostBefore = LINE.lost();
        vm.warp(block.timestamp + 60 days + 1);
        vc.settle(id); // recovers the live line, which defaults, and the vouch pays
        assertTrue(LINE.line(address(acct)).defaulted);
        assertEq(LINE.debtOf(address(acct)), 0);
        assertEq(LINE.lost(), lostBefore, "the live pool lost nothing");
        assertEq(vc.vouch(id).paid, 0.006 ether);
        assertEq(vc.voucherOf(LEAD).lostTotal, 0.0058 ether);
        _books();
    }

    /// A strong agent co-signs the cover report-lead sold on the live guarantee contract; report-lead never delivers;
    /// settle has the live guarantee contract refund the live job and pay its cover, then the vouch pays the customer.
    function test_aCoSignedLiveCoverPaysTheCustomer() public {
        address voucher = makeAddr("a strong agent on the live desk");
        address scorer = makeAddr("its customer");
        address buyer = makeAddr("report-lead's customer");
        vm.deal(voucher, 1 ether);
        vm.deal(scorer, 1 ether);
        vm.deal(buyer, 1 ether);
        vm.prank(voucher);
        DESK.register();
        for (uint256 i = 0; i < 21; ++i) {
            vm.prank(scorer);
            uint256 j = DESK.lock{value: i == 20 ? 0.05 ether : 0.001 ether}(voucher, block.timestamp + 1 days, false);
            vm.prank(voucher);
            DESK.deliver(j, keccak256("the work"));
            vm.prank(scorer);
            DESK.accept(j);
        }
        vm.warp(block.timestamp + 50 days);
        assertGe(vc.scoreOf(voucher), 300);
        uint256 price = 0.002 ether;
        uint256 amount = G.coverLimit(LEAD, price);
        assertGt(amount, 0, "report-lead sells cover on the live guarantee contract");
        uint256 dueAt = block.timestamp + 1 hours;
        uint256 fee = G.feeFor(amount);
        vm.prank(buyer);
        uint256 cover = G.reserve{value: fee}(LEAD, price, dueAt, false, amount);
        vm.prank(buyer);
        uint256 job = DESK.lock{value: price}(LEAD, dueAt, false);
        G.bind(cover, job);
        vm.prank(voucher);
        vc.addBond{value: 0.004 ether}(voucher);
        vm.prank(voucher);
        uint256 id = vc.offerCover(voucher, cover, 0.001 ether);
        vm.prank(LEAD);
        vc.accept{value: 0.00002 ether}(id);
        vm.warp(dueAt + 12 hours + 1);
        uint256 before = buyer.balance;
        vc.settle(id);
        assertEq(uint8(DESK.job(job).state), uint8(FactorDesk.State.Refunded));
        assertEq(uint8(G.cover(cover).state), uint8(FactorGuarantee.State.Paid));
        assertEq(buyer.balance - before, price + amount + 0.001 ether, "the refund, report-lead's cover and the vouch");
        _books();
    }

    /// The live line account and its key are one agent: neither vouches for the other.
    function test_aLiveLineAccountAndItsKeyAreOne() public {
        vm.prank(DEMO);
        vm.expectRevert(FactorVouch.Related.selector);
        vc.offerLine(DEMO, DEMO_LINE, 0.0001 ether);
        assertTrue(vc.related(DEMO, DEMO_LINE));
        assertEq(vc.canVouch(LEAD, DEMO), 0, "no bond yet");
        vm.prank(LEAD);
        vc.addBond{value: 0.0004 ether}(LEAD);
        assertEq(vc.canVouch(LEAD, DEMO), 0.0001 ether);
    }
}
