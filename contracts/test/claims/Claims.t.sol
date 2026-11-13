// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeskBase} from "../DeskBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorClaims, FactorPayAccount} from "../../src/FactorClaims.sol";

/// A holder or a key that refuses ETH, or tries to come back in while it is paid.
contract Sink {
    bool public refuse;
    FactorClaims public c;
    bytes public again;

    constructor(FactorClaims c_) {
        c = c_;
    }

    function setRefuse(bool on) external {
        refuse = on;
    }

    function arm(bytes calldata data) external {
        again = data;
    }

    function run(address to, uint256 value, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory out) = to.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(out, 32), mload(out))
            }
        }
        return out;
    }

    receive() external payable {
        if (refuse) revert("no");
        if (again.length != 0) {
            bytes memory d = again;
            delete again;
            (bool ok,) = address(c).call(d);
            require(!ok, "came back in");
        }
    }
}

/// The rules of docs/LOCKED-PAY.md, and the attacks on them.
contract ClaimsTest is DeskBase {
    FactorClaims internal cl;
    address internal seller = makeAddr("a seller's key");
    address internal buyer = makeAddr("a buyer");
    address internal buyer2 = makeAddr("another buyer");
    address internal acct;

    uint256 internal constant PRICE = 0.01 ether; // the job's price
    uint256 internal constant FACE = 0.0098 ether; // less the desk's 2% job fee
    uint256 internal constant ASK = 0.0094 ether; // about 4% under the face

    function setUp() public override {
        super.setUp();
        cl = new FactorClaims(desk);
        vm.prank(seller);
        acct = cl.open();
    }

    // ---------- moves ----------

    function _job() internal returns (uint256 id) {
        return _lock(acct, PRICE, true);
    }

    function _list(uint256 job, uint256 price) internal returns (uint256 id) {
        vm.prank(seller);
        id = cl.list(job, price);
    }

    function _buy(address who, uint256 id) internal {
        uint256 p = cl.claim(id).price;
        vm.deal(who, who.balance + p);
        vm.prank(who);
        cl.buy{value: p}(id);
    }

    function _sold() internal returns (uint256 job, uint256 id) {
        job = _job();
        id = _list(job, ASK);
        _buy(buyer, id);
    }

    function _deliverAcct(uint256 job) internal {
        vm.prank(seller);
        cl.deliver(job, keccak256("the work"));
    }

    // ---------- the pay account ----------

    function test_openMakesARegisteredAccountAtTheKnownAddress() public view {
        assertEq(acct, cl.accountAddress(seller));
        assertEq(cl.keyOf(acct), seller);
        assertEq(cl.accountOf(seller), acct);
        assertTrue(desk.agent(acct).registered);
        assertEq(FactorPayAccount(payable(acct)).claims(), address(cl));
    }

    function test_openOnce() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.HasAccount.selector, acct));
        cl.open();
    }

    function test_theAccountObeysOnlyTheClaimsContract() public {
        vm.deal(acct, 1 ether);
        vm.prank(seller);
        vm.expectRevert(FactorPayAccount.OnlyClaims.selector);
        FactorPayAccount(payable(acct)).send_(payable(seller), 1 ether);
        vm.prank(seller);
        vm.expectRevert(FactorPayAccount.OnlyClaims.selector);
        FactorPayAccount(payable(acct)).call_(0, abi.encodeCall(FactorDesk.decline, (1)));
    }

    // ---------- the happy road ----------

    function test_listBuySettle_theHolderIsPaidTheFace() public {
        uint256 job = _job();
        uint256 id = _list(job, ASK);
        FactorClaims.Claim memory c = cl.claim(id);
        assertEq(c.face, FACE);
        assertEq(uint8(c.state), uint8(FactorClaims.State.Listed));
        assertEq(cl.claimOn(job), id);

        uint256 before = seller.balance;
        _buy(buyer, id);
        assertEq(seller.balance - before, ASK, "the buyer pays the seller directly");
        assertEq(address(cl).balance, 0, "the claims contract keeps nothing");
        assertEq(cl.claim(id).holder, buyer);

        _deliverAcct(job);
        _accept(job);
        assertEq(acct.balance, FACE, "the desk paid the pay account");
        cl.settle(id);
        assertEq(buyer.balance, FACE, "the holder has the face");
        assertEq(acct.balance, 0);
        c = cl.claim(id);
        assertEq(uint8(c.state), uint8(FactorClaims.State.Paid));
        assertEq(c.paid, FACE);
        assertEq(c.owing, 0);
        assertEq(cl.claimOn(job), 0);
        assertEq(cl.openOf(acct).length, 0);
    }

    function test_settleEndsADeliveryPastItsReviewOnTheDesk() public {
        (uint256 job, uint256 id) = _sold();
        _deliverAcct(job);
        vm.expectRevert(FactorClaims.NotEnded.selector);
        cl.settle(id);
        vm.warp(block.timestamp + 24 hours);
        cl.settle(id);
        assertEq(uint8(desk.job(job).state), uint8(FactorDesk.State.Settled));
        assertEq(buyer.balance, FACE);
    }

    function test_giveMovesThePayment() public {
        (uint256 job, uint256 id) = _sold();
        vm.prank(buyer);
        cl.give(id, buyer2);
        _deliverAcct(job);
        _accept(job);
        cl.sweep(acct);
        assertEq(buyer2.balance, FACE);
        assertEq(buyer.balance, 0);
    }

    function test_onlyTheHolderGives() public {
        (, uint256 id) = _sold();
        vm.prank(seller);
        vm.expectRevert(FactorClaims.NotHolder.selector);
        cl.give(id, seller);
    }

    // ---------- the rules of a listing ----------

    function test_priceAtMostATenthUnderTheFaceAndNeverOver() public {
        uint256 job = _job();
        uint256 min = (FACE * 9000) / 10_000;
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.BadPrice.selector, min, FACE));
        cl.list(job, min - 1);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.BadPrice.selector, min, FACE));
        cl.list(job, FACE + 1);
        _list(job, min);
    }

    function test_faceAtLeastTheMinimum() public {
        uint256 job = _lock(acct, 0.001 ether, false); // face 0.00098
        _list(job, 0.0009 ether);
    }

    function test_tooSmallAFace() public {
        uint256 job = _lock(acct, 0.001 ether, true);
        vm.prank(seller);
        cl.draw(job, 0.0005 ether, FactorDesk.Kind.Early); // face now 0.00048
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.TooSmall.selector, 0.0005 ether));
        cl.list(job, 0.00045 ether);
    }

    function test_anAdvanceDrawnBeforeListingComesOffTheFace() public {
        uint256 job = _job();
        vm.prank(seller);
        cl.draw(job, 0.002 ether, FactorDesk.Kind.Early);
        assertEq(cl.faceOf(job), FACE - 0.002 ether);
        uint256 id = _list(job, FACE - 0.002 ether);
        assertEq(cl.claim(id).face, FACE - 0.002 ether);
    }

    function test_onlyTheJobsOwnAccountLists_aFakeJob() public {
        // a job for another agent, and a job number that does not exist
        uint256 other_ = _lock(agentA, PRICE, false);
        vm.prank(seller);
        vm.expectRevert(FactorClaims.NotYourJob.selector);
        cl.list(other_, ASK);
        vm.prank(seller);
        vm.expectRevert(FactorClaims.NotYourJob.selector);
        cl.list(999, ASK);
        // a stranger without an account
        vm.prank(agentA);
        vm.expectRevert(FactorClaims.NoAccount.selector);
        cl.list(1, ASK);
    }

    function test_notOverdue() public {
        uint256 job = _job();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(seller);
        vm.expectRevert(FactorClaims.NotForSale.selector);
        cl.list(job, ASK);
    }

    function test_aDeliveredJobSellsUntilItsReviewEnds() public {
        uint256 job = _job();
        _deliverAcct(job);
        uint256 id = _list(job, ASK);
        vm.warp(block.timestamp + 24 hours);
        vm.deal(buyer, ASK);
        vm.prank(buyer);
        vm.expectRevert(FactorClaims.NotForSale.selector);
        cl.buy{value: ASK}(id);
    }

    function test_atMostTenOpen() public {
        for (uint256 i = 0; i < 10; ++i) {
            _list(_job(), ASK);
        }
        uint256 job = _job();
        vm.prank(seller);
        vm.expectRevert(FactorClaims.TooMany.selector);
        cl.list(job, ASK);
    }

    function test_unlistThenRelist() public {
        uint256 job = _job();
        uint256 id = _list(job, ASK);
        vm.prank(buyer);
        vm.expectRevert(FactorClaims.NotSeller.selector);
        cl.unlist(id);
        vm.prank(seller);
        cl.unlist(id);
        assertEq(uint8(cl.claim(id).state), uint8(FactorClaims.State.Closed));
        uint256 id2 = _list(job, FACE);
        assertEq(cl.claimOn(job), id2);
    }

    // ---------- buying ----------

    function test_buyExactPriceOnly() public {
        uint256 id = _list(_job(), ASK);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.WrongAmount.selector, ASK));
        cl.buy{value: ASK - 1}(id);
    }

    function test_theSellerCannotBuyItsOwn() public {
        uint256 id = _list(_job(), ASK);
        vm.deal(seller, 1 ether);
        vm.prank(seller);
        vm.expectRevert(FactorClaims.OwnClaim.selector);
        cl.buy{value: ASK}(id);
    }

    // ---------- attacks ----------

    function test_attack_doubleSell() public {
        (uint256 job, uint256 id) = _sold();
        // the same job again
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.Taken.selector, id));
        cl.list(job, ASK);
        // the same claim again
        vm.deal(buyer2, ASK);
        vm.prank(buyer2);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.WrongState.selector, FactorClaims.State.Sold));
        cl.buy{value: ASK}(id);
        // and unlisting what is sold
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.WrongState.selector, FactorClaims.State.Sold));
        cl.unlist(id);
    }

    function test_attack_sellAfterSettle() public {
        uint256 job = _job();
        uint256 id = _list(job, ASK);
        _deliverAcct(job);
        _accept(job);
        // listed but not bought: the job paid the account, and nobody can buy the claim now
        vm.deal(buyer, ASK);
        vm.prank(buyer);
        vm.expectRevert(FactorClaims.NotForSale.selector);
        cl.buy{value: ASK}(id);
        vm.prank(seller);
        vm.expectRevert(FactorClaims.NotForSale.selector);
        cl.list(job, ASK);
        cl.sweep(acct);
        assertEq(uint8(cl.claim(id).state), uint8(FactorClaims.State.Closed));
        vm.prank(seller);
        vm.expectRevert(FactorClaims.NotForSale.selector);
        cl.list(job, ASK);
        // the unsold payout is the key's
        vm.prank(seller);
        cl.withdraw(payable(seller), FACE);
    }

    function test_attack_declineOrDrawOnASoldJob() public {
        (uint256 job, uint256 id) = _sold();
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.HasClaim.selector, id));
        cl.decline(job);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.HasClaim.selector, id));
        cl.draw(job, 0.001 ether, FactorDesk.Kind.Early);
    }

    function test_attack_theKeyCannotWithdrawASoldPayout() public {
        (uint256 job, uint256 id) = _sold();
        _deliverAcct(job);
        _accept(job);
        assertEq(acct.balance, FACE);
        // the withdrawal settles the claim first, so nothing is left for the key
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.NotFree.selector, 0));
        cl.withdraw(payable(seller), 1);
        cl.settle(id);
        assertEq(buyer.balance, FACE);
        assertEq(uint8(cl.claim(id).state), uint8(FactorClaims.State.Paid));
    }

    function test_attack_strangersCannotRunTheAccount() public {
        uint256 job = _job();
        vm.prank(agentA);
        vm.expectRevert(FactorClaims.NoAccount.selector);
        cl.decline(job);
        vm.prank(agentA);
        vm.expectRevert(FactorClaims.NoAccount.selector);
        cl.withdraw(payable(agentA), 1);
        // an account of its own does not reach another's job
        vm.prank(agentA);
        cl.open();
        vm.prank(agentA);
        vm.expectRevert(FactorClaims.NotYourJob.selector);
        cl.deliver(job, bytes32(0));
    }

    function test_attack_nobodySendsETHToTheClaimsContract() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        (bool ok,) = address(cl).call{value: 1}("");
        assertFalse(ok);
    }

    function test_attack_reentryOnTheSellersPayment() public {
        Sink s = new Sink(cl);
        vm.prank(address(s));
        address a = cl.open();
        uint256 job = _lock(a, PRICE, false);
        vm.prank(address(s));
        uint256 id = cl.list(job, ASK);
        // on being paid, the seller tries to unlist what was just sold
        s.arm(abi.encodeCall(FactorClaims.unlist, (id)));
        _buy(buyer, id);
        assertEq(uint8(cl.claim(id).state), uint8(FactorClaims.State.Sold));
        assertEq(address(s).balance, ASK);
    }

    function test_attack_reentryOnTheHoldersPayment() public {
        Sink s = new Sink(cl);
        (uint256 job, uint256 id) = _sold();
        vm.prank(buyer);
        cl.give(id, address(s));
        s.arm(abi.encodeCall(FactorClaims.sweep, (acct)));
        _deliverAcct(job);
        _accept(job);
        cl.settle(id);
        assertEq(address(s).balance, FACE, "paid once");
        assertEq(acct.balance, 0);
    }

    function test_aHolderThatRefusesETHCollectsLater() public {
        Sink s = new Sink(cl);
        (uint256 job, uint256 id) = _sold();
        vm.prank(buyer);
        cl.give(id, address(s));
        s.setRefuse(true);
        _deliverAcct(job);
        _accept(job);
        cl.settle(id);
        assertEq(cl.owed(address(s)), FACE);
        assertEq(address(cl).balance, FACE);
        s.setRefuse(false);
        cl.collect(address(s));
        assertEq(address(s).balance, FACE);
        assertEq(address(cl).balance, 0);
    }

    function test_aSellerThatRefusesETHCannotSell() public {
        Sink s = new Sink(cl);
        vm.prank(address(s));
        address a = cl.open();
        uint256 job = _lock(a, PRICE, false);
        vm.prank(address(s));
        uint256 id = cl.list(job, ASK);
        s.setRefuse(true);
        vm.deal(buyer, ASK);
        vm.prank(buyer);
        vm.expectRevert(FactorClaims.PushFailed.selector);
        cl.buy{value: ASK}(id);
        assertEq(buyer.balance, ASK);
    }

    // ---------- when the job pays less: the refund path ----------

    function test_refund_theBuyerIsOwedWhatItPaid_paidFromTheDeskBond() public {
        // the seller has a desk bond in its pay account
        vm.deal(seller, 0.02 ether);
        vm.prank(seller);
        cl.addBond{value: 0.02 ether}();
        assertEq(desk.agent(acct).bond, 0.02 ether);

        (uint256 job, uint256 id) = _sold();
        // never delivered: past due and grace, anyone settles and the desk refunds the customer
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        cl.settle(id);
        assertEq(uint8(desk.job(job).state), uint8(FactorDesk.State.Refunded));
        FactorClaims.Claim memory c = cl.claim(id);
        assertEq(c.paid, 0);
        assertEq(c.owing, 0, "the bond paid it back at once");
        assertEq(buyer.balance, ASK, "the buyer has back what it paid");
        assertEq(desk.agent(acct).bond, 0.02 ether - ASK);
        assertEq(cl.debtOf(acct), 0);
    }

    function test_refund_aDebtWaitsForTheNextPayoutAndBlocksTheKey() public {
        (uint256 job, uint256 id) = _sold();
        uint256 job2 = _job(); // another job, not sold
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        cl.settle(id);
        assertEq(cl.claim(id).owing, ASK);
        assertEq(cl.debtOf(acct), ASK);
        assertEq(cl.debtsOf(acct).length, 1);
        assertEq(uint8(desk.job(job).state), uint8(FactorDesk.State.Refunded));
        assertEq(uint8(desk.job(job2).state), uint8(FactorDesk.State.Locked));
        // while it owes: no listing, no withdrawal
        uint256 job3 = _job();
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.Owes.selector, ASK));
        cl.list(job3, ASK);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.Owes.selector, ASK));
        cl.withdraw(payable(seller), 1);
    }

    function test_refund_theNextPayoutRepays() public {
        (, uint256 id) = _sold();
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        cl.settle(id);
        uint256 job3 = _job();
        _deliverAcct(job3);
        _accept(job3);
        cl.sweep(acct);
        assertEq(buyer.balance, ASK);
        assertEq(cl.debtOf(acct), 0);
        assertEq(cl.debtsOf(acct).length, 0);
        assertEq(acct.balance, FACE - ASK);
        vm.prank(seller);
        cl.withdraw(payable(seller), FACE - ASK);
        assertEq(seller.balance, ASK + FACE - ASK);
    }

    function test_rejected_theShortfallIsOwed() public {
        (uint256 job, uint256 id) = _sold();
        _deliverAcct(job);
        vm.prank(customer);
        desk.reject(job);
        cl.settle(id);
        // at half: 0.005 to the customer, 0.005 less 2% of it to the agent
        uint256 half = 0.005 ether - (0.005 ether * 200) / 10_000;
        FactorClaims.Claim memory c = cl.claim(id);
        assertEq(c.paid, half);
        assertEq(c.owing, ASK - half);
        assertEq(buyer.balance, half);
        assertEq(cl.totalOwedBack(), ASK - half);
    }

    function test_aPartialRepaymentKeepsTheRest() public {
        (, uint256 id) = _sold();
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        cl.settle(id);
        vm.deal(acct, 0.001 ether); // anyone may pay into the account
        cl.settle(id);
        assertEq(cl.claim(id).owing, ASK - 0.001 ether);
        assertEq(buyer.balance, 0.001 ether);
        assertEq(uint8(cl.claim(id).state), uint8(FactorClaims.State.Paid));
        // the holder can still hand on what is owed
        vm.prank(buyer);
        cl.give(id, buyer2);
        vm.deal(acct, 1 ether);
        cl.sweep(acct);
        assertEq(buyer2.balance, ASK - 0.001 ether);
    }

    function test_declineUnsold_isTheKeysBusiness() public {
        uint256 job = _job();
        uint256 id = _list(job, ASK);
        vm.prank(seller);
        cl.unlist(id);
        vm.prank(seller);
        cl.decline(job);
        assertEq(uint8(desk.job(job).state), uint8(FactorDesk.State.Declined));
    }

    function test_settleRefusesWhatHasNotEnded() public {
        (, uint256 id) = _sold();
        vm.expectRevert(FactorClaims.NotEnded.selector);
        cl.settle(id);
        vm.expectRevert(abi.encodeWithSelector(FactorClaims.WrongState.selector, FactorClaims.State.None));
        cl.settle(77);
    }

    function test_bondAndAdvanceThroughTheAccount() public {
        vm.deal(seller, 0.01 ether);
        vm.prank(seller);
        cl.addBond{value: 0.01 ether}();
        _fund(1 ether);
        uint256 job = _job();
        vm.prank(seller);
        cl.draw(job, 0.002 ether, FactorDesk.Kind.Pool);
        assertEq(desk.agent(acct).advancedNow, 0.002 ether);
        assertEq(acct.balance, 0.002 ether - 0.00002 ether);
        _deliverAcct(job);
        _accept(job);
        vm.prank(seller);
        cl.takeBond(0.01 ether);
        uint256 all = acct.balance;
        vm.prank(seller);
        cl.withdraw(payable(seller), all);
        assertEq(acct.balance, 0);
    }

    function testFuzz_holderGetsPayoutPlusDebtNeverMore(uint256 ask, bool deliver, bool reject_) public {
        uint256 min = (FACE * 9000) / 10_000;
        ask = bound(ask, min, FACE);
        uint256 job = _job();
        uint256 id = _list(job, ask);
        _buy(buyer, id);
        if (deliver) {
            _deliverAcct(job);
            if (reject_) {
                vm.prank(customer);
                desk.reject(job);
            } else {
                _accept(job);
            }
        } else {
            vm.warp(block.timestamp + 2 days);
        }
        cl.settle(id);
        FactorClaims.Claim memory c = cl.claim(id);
        assertEq(buyer.balance + c.owing, c.paid >= ask ? c.paid : ask);
        assertEq(address(cl).balance, cl.owedTotal());
    }
}
