// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GuaranteeBase} from "./GuaranteeBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorGuarantee} from "../../src/FactorGuarantee.sol";
import {FactorAccount} from "../../src/FactorAccount.sol";
import {Rejecter} from "../mocks/Actors.sol";

/// Every rule of docs/GUARANTEES.md, one by one, with its examples to the wei.
contract GuaranteeTest is GuaranteeBase {
    // ---------- the contract itself ----------

    function test_readsTheDeskAndHasNoOwner() public view {
        assertEq(address(g.desk()), address(desk));
        assertEq(address(g.line()), address(line));
        assertEq(g.burnPot(), desk.burnPot());
        assertEq(g.minJob(), 0.001 ether);
        assertEq(g.minDue(), 1 hours);
        assertEq(g.maxDue(), 30 days);
        assertEq(g.grace(), 12 hours);
        assertEq(g.review(), 24 hours);
        assertEq(g.FEE_BPS(), 100);
        assertEq(g.MIN_COVER(), 0.0001 ether);
        assertEq(g.WINDOW(), 1 hours);
        assertEq(g.coverCount(), 0);
    }

    function test_aDeskIsNeeded() public {
        vm.expectRevert(FactorGuarantee.ZeroAddress.selector);
        new FactorGuarantee(FactorDesk(payable(address(0))), line);
    }

    function test_theLineMustBeTheDesks() public {
        FactorDesk other = new FactorDesk(address(burnPot), gateway);
        vm.expectRevert(FactorGuarantee.WrongDesk.selector);
        new FactorGuarantee(other, line);
    }

    function test_worksWithoutALineContract() public {
        FactorGuarantee plain = new FactorGuarantee(desk, FactorLine(payable(address(0))));
        assertEq(plain.keyOf(agentA), address(0));
        _score200(agentA);
        assertEq(plain.scoreOf(agentA), 200);
    }

    function test_takesNoPlainEth() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(g).call{value: 1 ether}("");
        assertFalse(ok, "plain ETH is refused: every wei here is a bond, a fee or a payout");
    }

    // ---------- the bond ----------

    function test_anyoneBondsARegisteredAgent() public {
        vm.expectEmit(address(g));
        emit FactorGuarantee.BondAdded(agentA, address(this), 0.1 ether, 0.1 ether);
        _gbond(agentA, 0.1 ether);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        g.addBond{value: 0.05 ether}(agentA);
        assertEq(g.bondOf(agentA).bond, 0.15 ether);
        assertEq(g.bonds(), 0.15 ether);
        assertEq(g.freeOf(agentA), 0.15 ether);
        _gbooks();
    }

    function test_aBondNeedsARegisteredAgentAndSomeEth() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(FactorGuarantee.NotRegistered.selector);
        g.addBond{value: 0.1 ether}(stranger);
        vm.expectRevert(FactorGuarantee.ZeroAmount.selector);
        g.addBond{value: 0}(agentA);
    }

    function test_onlyTheAgentTakesItsBondAndItGoesToTheAgent() public {
        _gbond(agentA, 0.1 ether);
        vm.prank(stranger);
        vm.expectRevert(FactorGuarantee.NotAgent.selector);
        g.takeBond(agentA, 0.1 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.OverFree.selector, 0.1 ether));
        g.takeBond(agentA, 0.1 ether + 1);
        vm.prank(agentA);
        vm.expectRevert(FactorGuarantee.ZeroAmount.selector);
        g.takeBond(agentA, 0);
        uint256 before = agentA.balance;
        vm.expectEmit(address(g));
        emit FactorGuarantee.BondTaken(agentA, 0.04 ether, 0.06 ether);
        vm.prank(agentA);
        g.takeBond(agentA, 0.04 ether);
        assertEq(agentA.balance - before, 0.04 ether);
        assertEq(g.bondOf(agentA).bond, 0.06 ether);
        _gbooks();
    }

    function test_aCoverHeldBackCannotLeave() public {
        _ready(agentA, 0.1 ether, 0.1 ether);
        _hire(buyer, agentA, 0.4 ether, 0.08 ether, false);
        assertEq(g.freeOf(agentA), 0.02 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.OverFree.selector, 0.02 ether));
        g.takeBond(agentA, 0.02 ether + 1);
        vm.prank(agentA);
        g.takeBond(agentA, 0.02 ether);
        assertEq(g.bondOf(agentA).bond, 0.08 ether);
        assertEq(g.bondOf(agentA).reserved, 0.08 ether);
        _gbooks();
    }

    function test_onlyTheAgentSetsItsOffer() public {
        vm.prank(stranger);
        vm.expectRevert(FactorGuarantee.NotAgent.selector);
        g.setOffer(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.TooSmall.selector, 0.0001 ether));
        g.setOffer(agentA, 0.0001 ether - 1);
        vm.expectEmit(address(g));
        emit FactorGuarantee.OfferSet(agentA, 0.02 ether);
        vm.prank(agentA);
        g.setOffer(agentA, 0.02 ether);
        assertEq(g.bondOf(agentA).offer, 0.02 ether);
        vm.prank(agentA);
        g.setOffer(agentA, 0);
        assertEq(g.bondOf(agentA).offer, 0, "0: no cover sold");
    }

    // ---------- how much cover ----------

    function test_noCoverUnderAScoreOf200() public {
        for (uint256 i = 0; i < 19; ++i) {
            _settleFor(scorer, agentA, 0.001 ether);
        }
        assertEq(desk.score(agentA), 190);
        _gbond(agentA, 1 ether);
        _offer(agentA, 1 ether);
        assertEq(g.coverLimit(agentA, 1 ether), 0);
        uint256 dueAt = block.timestamp + 1 days;
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.OverLimit.selector, 0));
        g.reserve{value: 0.000001 ether}(agentA, 1 ether, dueAt, false, 0.0001 ether);
        _settleFor(scorer, agentA, 0.001 ether);
        assertEq(desk.score(agentA), 200, "twenty settled jobs: a score of 200");
        assertEq(g.coverLimit(agentA, 1 ether), 0.25 ether, "a quarter of the price");
    }

    function test_theScoreSetsTheShareInSteps() public {
        _gbond(agentA, 10 ether);
        _offer(agentA, 10 ether);
        uint256[10] memory scores = [uint256(0), 199, 200, 399, 400, 599, 600, 799, 800, 1000];
        uint256[10] memory cover =
            [uint256(0), 0, 0.25 ether, 0.25 ether, 0.5 ether, 0.5 ether, 0.75 ether, 0.75 ether, 1 ether, 1 ether];
        for (uint256 i = 0; i < 10; ++i) {
            _mockScore(agentA, scores[i]);
            assertEq(g.scoreOf(agentA), scores[i]);
            assertEq(g.coverLimit(agentA, 1 ether), cover[i]);
        }
    }

    function test_aRealScoreOf800CoversTheWholePrice() public {
        _score800(agentA);
        _gbond(agentA, 1 ether);
        _offer(agentA, 1 ether);
        assertEq(g.coverLimit(agentA, 0.5 ether), 0.5 ether);
        (, uint256 job) = _hire(buyer, agentA, 0.5 ether, 0.5 ether, false);
        assertEq(g.cover(g.coverOf(job)).amount, 0.5 ether);
    }

    function test_theLimitIsTheSmallestOfShareOfferAndFreeBond() public {
        _mockScore(agentA, 1000);
        _gbond(agentA, 0.3 ether);
        _offer(agentA, 0.2 ether);
        assertEq(g.coverLimit(agentA, 0.1 ether), 0.1 ether, "the price's share");
        assertEq(g.coverLimit(agentA, 1 ether), 0.2 ether, "the offer");
        _offer(agentA, 1 ether);
        assertEq(g.coverLimit(agentA, 1 ether), 0.3 ether, "the free bond");
        _hire(buyer, agentA, 1 ether, 0.25 ether, false);
        assertEq(g.coverLimit(agentA, 1 ether), 0.05 ether, "what is free after a cover");
    }

    // ---------- reserving ----------

    function test_aReservationHoldsTheCoverBackAndTheFee() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        uint256 dueAt = block.timestamp + 1 days;
        // the example of the rulebook: a 0.04 job with 0.01 of cover (a quarter, at a score of 200), fee 0.0001
        vm.deal(buyer, 1 ether);
        uint256 jobsBefore = desk.jobCount();
        vm.expectEmit(address(g));
        emit FactorGuarantee.Reserved(
            1, buyer, agentA, 0.01 ether, 0.0001 ether, 0.04 ether, dueAt, false, block.timestamp + 1 hours
        );
        vm.prank(buyer);
        uint256 id = g.reserve{value: 0.0001 ether}(agentA, 0.04 ether, dueAt, false, 0.01 ether);
        assertEq(id, 1);
        FactorGuarantee.Cover memory c = g.cover(id);
        assertEq(c.customer, buyer);
        assertEq(c.agent, agentA);
        assertEq(c.price, 0.04 ether);
        assertEq(c.dueAt, dueAt);
        assertEq(c.amount, 0.01 ether);
        assertEq(c.fee, 0.0001 ether);
        assertEq(c.afterJob, jobsBefore);
        assertEq(c.expiresAt, block.timestamp + 1 hours);
        assertEq(uint8(c.state), uint8(FactorGuarantee.State.Reserved));
        assertEq(g.latestOf(buyer), id);
        assertEq(g.bondOf(agentA).reserved, 0.01 ether);
        assertEq(g.reserved(), 0.01 ether);
        assertEq(g.feesHeld(), 0.0001 ether);
        assertEq(g.freeOf(agentA), 0.09 ether);
        _gbooks();
    }

    function test_aReservationIsRefusedForEachRule() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        uint256 dueAt = block.timestamp + 1 days;
        vm.deal(buyer, 1 ether);
        vm.deal(agentA, 1 ether);
        vm.startPrank(agentA);
        vm.expectRevert(FactorGuarantee.SelfCover.selector);
        g.reserve{value: 0.0001 ether}(agentA, 0.04 ether, dueAt, false, 0.01 ether);
        vm.stopPrank();
        vm.startPrank(buyer);
        vm.expectRevert(FactorGuarantee.NotRegistered.selector);
        g.reserve{value: 0.0001 ether}(stranger, 0.04 ether, dueAt, false, 0.01 ether);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.JobTooSmall.selector, 0.001 ether));
        g.reserve{value: 0.000001 ether}(agentA, 0.001 ether - 1, dueAt, false, 0.0001 ether);
        vm.expectRevert(FactorGuarantee.BadDueTime.selector);
        g.reserve{value: 0.0001 ether}(agentA, 0.04 ether, block.timestamp + 1 hours - 1, false, 0.01 ether);
        vm.expectRevert(FactorGuarantee.BadDueTime.selector);
        g.reserve{value: 0.0001 ether}(agentA, 0.04 ether, block.timestamp + 30 days + 1, false, 0.01 ether);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.TooSmall.selector, 0.0001 ether));
        g.reserve{value: 0}(agentA, 0.04 ether, dueAt, false, 0.0001 ether - 1);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.OverLimit.selector, 0.01 ether));
        g.reserve{value: 0.000101 ether}(agentA, 0.04 ether, dueAt, false, 0.0101 ether);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.WrongFee.selector, 0.0001 ether));
        g.reserve{value: 0.0001 ether - 1}(agentA, 0.04 ether, dueAt, false, 0.01 ether);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.WrongFee.selector, 0.0001 ether));
        g.reserve{value: 0.0001 ether + 1}(agentA, 0.04 ether, dueAt, false, 0.01 ether);
        // the edges themselves are fine
        g.reserve{value: 0.0001 ether}(agentA, 0.04 ether, block.timestamp + 1 hours, false, 0.01 ether);
        g.reserve{value: 0.000001 ether}(agentA, 0.001 ether, block.timestamp + 30 days, true, 0.0001 ether);
        vm.stopPrank();
        _gbooks();
    }

    function test_noOfferNoCover() public {
        _score200(agentA);
        _gbond(agentA, 0.1 ether);
        assertEq(g.coverLimit(agentA, 1 ether), 0, "an agent that set no offer sells no cover");
        _offer(agentA, 0.05 ether);
        assertEq(g.coverLimit(agentA, 1 ether), 0.05 ether);
    }

    function test_noBondNoCover() public {
        _score200(agentA);
        _offer(agentA, 0.05 ether);
        assertEq(g.coverLimit(agentA, 1 ether), 0);
    }

    // ---------- tying it to the job ----------

    function test_bindTiesTheJobLockedOnTheTermsReserved() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        uint256 dueAt = block.timestamp + 1 days;
        uint256 id = _reserve(buyer, agentA, 0.04 ether, dueAt, true, 0.01 ether);
        uint256 job = _lockAt(buyer, agentA, 0.04 ether, dueAt, true);
        vm.expectEmit(address(g));
        emit FactorGuarantee.Bound(id, job, agentA);
        vm.prank(stranger); // anyone
        g.bind(id, job);
        assertEq(g.coverOf(job), id);
        FactorGuarantee.Cover memory c = g.cover(id);
        assertEq(c.job, job);
        assertEq(uint8(c.state), uint8(FactorGuarantee.State.Bound));
        FactorGuarantee.Bond memory b = g.bondOf(agentA);
        assertEq(b.covers, 1);
        assertEq(b.coveredTotal, 0.01 ether);
        assertEq(g.totalCovered(), 0.01 ether);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.WrongState.selector, FactorGuarantee.State.Bound));
        g.bind(id, job);
    }

    function test_bindChecksEveryTerm() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        _ready(agentB, 0.1 ether, 0.05 ether);
        uint256 dueAt = block.timestamp + 1 days;
        uint256 id = _reserve(buyer, agentA, 0.04 ether, dueAt, false, 0.01 ether);
        uint256[5] memory wrong = [
            _lockAt(other, agentA, 0.04 ether, dueAt, false), // another customer
            _lockAt(buyer, agentB, 0.04 ether, dueAt, false), // another agent
            _lockAt(buyer, agentA, 0.05 ether, dueAt, false), // another price
            _lockAt(buyer, agentA, 0.04 ether, dueAt + 1, false), // another due time
            _lockAt(buyer, agentA, 0.04 ether, dueAt, true) // early allowed
        ];
        for (uint256 i = 0; i < 5; ++i) {
            vm.expectRevert(FactorGuarantee.NotTheJob.selector);
            g.bind(id, wrong[i]);
        }
        vm.expectRevert(FactorGuarantee.NotTheJob.selector);
        g.bind(id, 999); // no such job
        uint256 right = _lockAt(buyer, agentA, 0.04 ether, dueAt, false);
        g.bind(id, right);
    }

    function test_onlyAJobLockedAfterTheReservation() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        uint256 dueAt = block.timestamp + 1 days;
        uint256 old = _lockAt(buyer, agentA, 0.04 ether, dueAt, false);
        uint256 id = _reserve(buyer, agentA, 0.04 ether, dueAt, false, 0.01 ether);
        vm.expectRevert(FactorGuarantee.NotTheJob.selector);
        g.bind(id, old);
    }

    function test_withinTheHourThenItLapses() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        uint256 dueAt = block.timestamp + 1 days;
        uint256 id = _reserve(buyer, agentA, 0.04 ether, dueAt, false, 0.01 ether);
        uint256 job = _lockAt(buyer, agentA, 0.04 ether, dueAt, false);
        uint256 end = block.timestamp + 1 hours;
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.TooSoon.selector, end + 1));
        g.lapse(id);
        vm.warp(end + 1);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.Expired.selector, end));
        g.bind(id, job);
        // the fee is split as if the cover had run: the agent held its bond for the hour
        (, uint256 burned, uint256 toAgent) = _halves(0.01 ether);
        uint256 potBefore = address(burnPot).balance;
        uint256 agentBefore = agentA.balance;
        vm.expectEmit(address(g));
        emit FactorGuarantee.Closed(id, 0, agentA, FactorGuarantee.State.Lapsed, 0, toAgent, burned, 0);
        vm.prank(stranger);
        g.lapse(id);
        assertEq(address(burnPot).balance - potBefore, burned);
        assertEq(agentA.balance - agentBefore, toAgent);
        assertEq(g.freeOf(agentA), 0.1 ether);
        assertEq(g.bondOf(agentA).lapsed, 1);
        assertEq(g.feesHeld(), 0);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.WrongState.selector, FactorGuarantee.State.Lapsed));
        g.lapse(id);
        _gbooks();
    }

    function test_tiedAtTheLastSecondOfTheHour() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        uint256 dueAt = block.timestamp + 1 days;
        uint256 id = _reserve(buyer, agentA, 0.04 ether, dueAt, false, 0.01 ether);
        vm.warp(block.timestamp + 1 hours);
        uint256 job = _lockAt(buyer, agentA, 0.04 ether, dueAt, false);
        g.bind(id, job);
        assertEq(g.coverOf(job), id);
    }

    function test_oneCoverPerJob() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        uint256 dueAt = block.timestamp + 1 days;
        uint256 a = _reserve(buyer, agentA, 0.04 ether, dueAt, false, 0.01 ether);
        uint256 b = _reserve(buyer, agentA, 0.04 ether, dueAt, false, 0.01 ether);
        uint256 job = _lockAt(buyer, agentA, 0.04 ether, dueAt, false);
        g.bind(a, job);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.JobCovered.selector, a));
        g.bind(b, job);
        // two identical jobs: the second reservation takes the second one
        uint256 job2 = _lockAt(buyer, agentA, 0.04 ether, dueAt, false);
        g.bind(b, job2);
        assertEq(g.coverOf(job2), b);
    }

    function test_bindLatestTiesTheCallersLatestToTheNewestJob() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        uint256 dueAt = block.timestamp + 1 days;
        uint256 id = _reserve(buyer, agentA, 0.04 ether, dueAt, false, 0.01 ether);
        uint256 job = _lockAt(buyer, agentA, 0.04 ether, dueAt, false);
        vm.prank(buyer);
        g.bindLatest();
        assertEq(g.coverOf(job), id);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.WrongState.selector, FactorGuarantee.State.None));
        g.bindLatest();
    }

    function test_aPasskeyAccountHiresWithCoverInOneOrder() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        address walletKey = makeAddr("a passkey account's wallet key");
        FactorAccount.Key memory first =
            FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(uint256(uint160(walletKey))), bytes32(0));
        address payable fa = payable(accounts.create(first, ""));
        vm.deal(fa, 1 ether);
        uint256 dueAt = block.timestamp + 1 days;
        FactorAccount.Call[] memory calls = new FactorAccount.Call[](3);
        calls[0] = FactorAccount.Call(
            address(g),
            0.0001 ether,
            abi.encodeCall(FactorGuarantee.reserve, (agentA, 0.04 ether, dueAt, false, 0.01 ether))
        );
        calls[1] = FactorAccount.Call(address(desk), 0.04 ether, abi.encodeCall(FactorDesk.lock, (agentA, dueAt, false)));
        calls[2] = FactorAccount.Call(address(g), 0, abi.encodeCall(FactorGuarantee.bindLatest, ()));
        vm.prank(walletKey);
        FactorAccount(fa).run(calls);
        uint256 job = desk.jobCount();
        assertEq(desk.job(job).customer, fa);
        assertEq(g.coverOf(job), 1);
        assertEq(g.cover(1).customer, fa);
        // all of it or none: a lock the desk refuses undoes the reservation too
        calls[1] = FactorAccount.Call(address(desk), 0.04 ether, abi.encodeCall(FactorDesk.lock, (agentA, dueAt + 31 days, false)));
        vm.prank(walletKey);
        vm.expectRevert();
        FactorAccount(fa).run(calls);
        assertEq(g.coverCount(), 1);
        _gbooks();
    }

    // ---------- how a cover ends ----------

    function test_aDeliveredJobReleasesTheCoverAndSplitsTheFee() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        (uint256 id, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        _deliver(agentA, job);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.NotFinished.selector, FactorDesk.State.Delivered));
        g.close(job);
        _accept(job);
        uint256 potBefore = address(burnPot).balance;
        uint256 agentBefore = agentA.balance;
        uint256 buyerBefore = buyer.balance;
        // the example: the agent gets 0.00005 and the burn 0.00005, and the 0.01 is free in the bond again
        vm.expectEmit(address(g));
        emit FactorGuarantee.Closed(id, job, agentA, FactorGuarantee.State.Released, 0, 0.00005 ether, 0.00005 ether, 0);
        vm.prank(stranger);
        g.close(job);
        assertEq(address(burnPot).balance - potBefore, 0.00005 ether);
        assertEq(agentA.balance - agentBefore, 0.00005 ether);
        assertEq(buyer.balance, buyerBefore);
        FactorGuarantee.Bond memory b = g.bondOf(agentA);
        assertEq(b.bond, 0.1 ether);
        assertEq(b.reserved, 0);
        assertEq(b.released, 1);
        assertEq(b.feesEarned, 0.00005 ether);
        assertEq(g.totalFees(), 0.0001 ether);
        assertEq(g.totalBurned(), 0.00005 ether);
        assertEq(uint8(g.cover(id).state), uint8(FactorGuarantee.State.Released));
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.WrongState.selector, FactorGuarantee.State.Released));
        g.close(job);
        _gbooks();
        _books();
    }

    function test_aRejectedJobPaysNoCover() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        (uint256 id, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        _deliver(agentA, job);
        vm.prank(buyer);
        desk.reject(job);
        uint256 buyerBefore = buyer.balance;
        g.close(job);
        assertEq(buyer.balance, buyerBefore, "settled at half: the customer has half from the desk and no cover");
        assertEq(uint8(g.cover(id).state), uint8(FactorGuarantee.State.Released));
        assertEq(g.bondOf(agentA).bond, 0.1 ether);
        _gbooks();
    }

    function test_aDeclinedJobReleasesTheCoverAndReturnsTheFee() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        (uint256 id, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        vm.prank(agentA);
        desk.decline(job);
        uint256 buyerBefore = buyer.balance;
        uint256 agentBefore = agentA.balance;
        vm.expectEmit(address(g));
        emit FactorGuarantee.Closed(id, job, agentA, FactorGuarantee.State.Declined, 0, 0, 0, 0.0001 ether);
        g.close(job);
        assertEq(buyer.balance - buyerBefore, 0.0001 ether, "the fee back");
        assertEq(agentA.balance, agentBefore, "the agent earns nothing from a cover it declined");
        FactorGuarantee.Bond memory b = g.bondOf(agentA);
        assertEq(b.declined, 1);
        assertEq(b.reserved, 0);
        assertEq(b.bond, 0.1 ether);
        assertEq(g.totalFees(), 0);
        _gbooks();
    }

    function test_aJobNotDeliveredPaysTheCoverFromTheBond() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        (uint256 id, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        FactorDesk.Job memory j = desk.job(job);
        vm.warp(uint256(j.dueAt) + 12 hours);
        vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.NotFinished.selector, FactorDesk.State.Locked));
        g.close(job);
        vm.warp(block.timestamp + 1);
        uint256 buyerBefore = buyer.balance;
        uint256 potBefore = address(burnPot).balance;
        // the example: the customer gets the desk's refund and 0.01 from the bond
        vm.expectEmit(address(g));
        emit FactorGuarantee.Closed(id, job, agentA, FactorGuarantee.State.Paid, 0.01 ether, 0.00005 ether, 0.00005 ether, 0);
        vm.prank(stranger);
        g.close(job);
        assertEq(uint8(desk.job(job).state), uint8(FactorDesk.State.Refunded), "close refunded it on the desk first");
        assertEq(buyer.balance - buyerBefore, 0.04 ether + 0.01 ether);
        assertEq(address(burnPot).balance - potBefore, 0.00005 ether);
        FactorGuarantee.Bond memory b = g.bondOf(agentA);
        assertEq(b.bond, 0.09 ether);
        assertEq(b.reserved, 0);
        assertEq(b.paid, 1);
        assertEq(b.paidTotal, 0.01 ether);
        assertEq(g.totalPaid(), 0.01 ether);
        assertEq(g.bonds(), 0.09 ether);
        assertEq(desk.agent(agentA).unanswered, 1, "the desk keeps its own mark");
        _gbooks();
        _books();
    }

    function test_anAgentThatDrewAndVanishedPaysTheCoverToo() public {
        _fund(1 ether);
        _ready(agentA, 0.1 ether, 0.05 ether);
        _bond(agentA, 0.01 ether); // its desk bond, for a pool advance
        (, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, true);
        _draw(agentA, job, 0.01 ether, FactorDesk.Kind.Early);
        _draw(agentA, job, 0.005 ether, FactorDesk.Kind.Pool);
        uint256 buyerBefore = buyer.balance;
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        g.close(job);
        // the desk refunds the price less the early advance; the cover makes up for it, and more
        assertEq(buyer.balance - buyerBefore, 0.04 ether - 0.01 ether + 0.01 ether);
        assertTrue(desk.agent(agentA).barred);
        _gbooks();
        _books();
    }

    function test_closeAfterTheDeskWasRefundedByItself() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        (, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        desk.refund(job); // the keeper, or anyone, before the cover is closed
        uint256 buyerBefore = buyer.balance;
        g.close(job);
        assertEq(buyer.balance - buyerBefore, 0.01 ether);
    }

    function test_aDeliveryInTheGraceReleases() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        (uint256 id, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        vm.warp(block.timestamp + 1 days + 12 hours);
        _deliver(agentA, job);
        assertTrue(desk.job(job).late);
        vm.warp(block.timestamp + 24 hours);
        // the customer never answered: close settles it on the desk first
        g.close(job);
        assertEq(uint8(desk.job(job).state), uint8(FactorDesk.State.Settled));
        assertEq(uint8(g.cover(id).state), uint8(FactorGuarantee.State.Released));
        _gbooks();
    }

    function test_closeNeedsACover() public {
        vm.expectRevert(FactorGuarantee.NoCover.selector);
        g.close(1);
        _ready(agentA, 0.1 ether, 0.05 ether);
        uint256 dueAt = block.timestamp + 1 days;
        _reserve(buyer, agentA, 0.04 ether, dueAt, false, 0.01 ether);
        uint256 job = _lockAt(buyer, agentA, 0.04 ether, dueAt, false);
        vm.expectRevert(FactorGuarantee.NoCover.selector);
        g.close(job); // reserved, never tied
    }

    function test_aRefusedPayoutIsKeptAsOwed() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        Rejecter wall = new Rejecter();
        (, uint256 job) = _hire(address(wall), agentA, 0.04 ether, 0.01 ether, false);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        g.close(job);
        assertEq(g.owed(address(wall)), 0.01 ether, "the cover waits for the customer");
        assertEq(desk.owed(address(wall)), 0.04 ether, "and so does the desk's refund, on the desk");
        _gbooks();
        vm.expectRevert(FactorGuarantee.PushFailed.selector);
        g.collect(address(wall));
        wall.setAccept(true);
        g.collect(address(wall));
        assertEq(address(wall).balance, 0.01 ether);
        vm.expectRevert(FactorGuarantee.NothingOwed.selector);
        g.collect(address(wall));
        _gbooks();
    }

    function test_collectToAnotherAddress() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        Rejecter wall = new Rejecter();
        (, uint256 job) = _hire(address(wall), agentA, 0.04 ether, 0.01 ether, false);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        g.close(job);
        address to = makeAddr("somewhere else");
        vm.prank(address(wall));
        vm.expectRevert(FactorGuarantee.ZeroAddress.selector);
        g.collectTo(payable(address(0)));
        vm.prank(address(wall));
        g.collectTo(payable(to));
        assertEq(to.balance, 0.01 ether);
        _gbooks();
    }

    function test_anAgentThatRefusesItsHalfHasItKept() public {
        Rejecter wall = new Rejecter();
        vm.prank(address(wall));
        desk.register();
        _ready(address(wall), 0.1 ether, 0.05 ether);
        (, uint256 job) = _hire(buyer, address(wall), 0.04 ether, 0.01 ether, false);
        vm.prank(address(wall));
        desk.deliver(job, keccak256("the work"));
        vm.prank(buyer);
        desk.accept(job);
        g.close(job);
        assertEq(g.owed(address(wall)), 0.00005 ether);
        _gbooks();
    }

    function test_monthByMonthEachMonthHasItsOwnCover() public {
        _ready(agentA, 0.1 ether, 0.05 ether);
        (uint256 m1, uint256 job1) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        _deliver(agentA, job1);
        _accept(job1);
        g.close(job1);
        (uint256 m2, uint256 job2) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        assertTrue(m1 != m2 && job1 != job2);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        g.close(job2);
        FactorGuarantee.Bond memory b = g.bondOf(agentA);
        assertEq(b.released, 1);
        assertEq(b.paid, 1);
        assertEq(b.covers, 2);
        assertEq(b.coveredTotal, 0.02 ether);
    }

    // ---------- a line account ----------

    function test_aLineAccountSellsCoverRunByItsKey() public {
        FactorLineAccount acct = _open(agentA);
        _score200(agentA); // the key's record
        assertEq(desk.score(address(acct)), 0);
        assertEq(g.keyOf(address(acct)), agentA);
        assertEq(g.scoreOf(address(acct)), 200, "the better of its two addresses");
        _gbond(address(acct), 0.1 ether);
        vm.prank(stranger);
        vm.expectRevert(FactorGuarantee.NotAgent.selector);
        g.setOffer(address(acct), 0.05 ether);
        vm.prank(agentA);
        g.setOffer(address(acct), 0.05 ether);
        (, uint256 job) = _hire(buyer, address(acct), 0.04 ether, 0.01 ether, false);
        vm.prank(agentA);
        acct.deliver(job, keccak256("the work"));
        vm.prank(buyer);
        desk.accept(job);
        uint256 before = address(acct).balance;
        g.close(job);
        assertEq(address(acct).balance - before, 0.00005 ether, "the agent's half reaches its line account");
        // its key takes bond out: it goes to the line account, which pays the line first
        _seed(1 ether);
        _lineBond(agentA, 0.01 ether);
        _lineDraw(agentA, 0.005 ether, false);
        vm.prank(agentA);
        g.takeBond(address(acct), 0.02 ether);
        assertEq(address(acct).balance - before, 0.02005 ether);
        acct.sweep();
        assertEq(line.debtOf(address(acct)), 0, "the line was repaid out of it");
        // the key cannot hire its own account with cover
        vm.deal(agentA, 1 ether);
        uint256 dueAt = block.timestamp + 1 days;
        vm.prank(agentA);
        vm.expectRevert(FactorGuarantee.SelfCover.selector);
        g.reserve{value: 0.0001 ether}(address(acct), 0.04 ether, dueAt, false, 0.01 ether);
        _gbooks();
    }

    function test_aLineAccountSellsNoCoverOnceBarredOrDefaulted() public {
        FactorLineAccount acct = _open(agentA);
        _score200(address(acct));
        assertEq(g.scoreOf(address(acct)), 200);
        // the key barred on the desk
        _barOnDesk(agentA);
        assertEq(g.scoreOf(address(acct)), 0);
        // and another agent whose line defaulted (its desk record is clean)
        FactorLineAccount acctB = _open(agentB);
        _score200(address(acctB));
        vm.prank(agentB);
        acctB.withdraw(payable(agentB), address(acctB).balance);
        _seed(1 ether);
        _lineBond(agentB, 0.001 ether);
        _lineDraw(agentB, line.canDraw(agentB), false);
        vm.warp(block.timestamp + 61 days);
        line.recover(address(acctB));
        assertTrue(line.line(address(acctB)).defaulted);
        assertGe(desk.score(address(acctB)), 200, "the desk still scores it");
        assertEq(g.scoreOf(address(acctB)), 0, "the guarantee does not");
    }

    // ---------- fuzzed ----------

    /// Any cover splits to the wei: the fee is 1%, its burn half rounded down, the agent's half the rest.
    function testFuzz_anyCoverSplitsToTheWei(uint256 amount) public {
        amount = bound(amount, 0.0001 ether, 1 ether);
        _mockScore(agentA, 800);
        _gbond(agentA, 1 ether);
        _offer(agentA, 1 ether);
        (uint256 fee, uint256 burned, uint256 toAgent) = _halves(amount);
        assertEq(g.feeFor(amount), fee);
        (, uint256 job) = _hire(buyer, agentA, 1 ether, amount, false);
        _deliver(agentA, job);
        _accept(job);
        uint256 potBefore = address(burnPot).balance;
        uint256 agentBefore = agentA.balance;
        g.close(job);
        assertEq(address(burnPot).balance - potBefore, burned);
        assertEq(agentA.balance - agentBefore, toAgent);
        assertEq(burned + toAgent, fee);
        assertGt(fee, 0, "never rounded to nothing");
        _gbooks();
    }

    /// Any bond, covers and withdrawals: what is held back is never more than the bond, and never leaves it.
    function testFuzz_coversNeverPassTheBond(uint256 bond, uint256 a, uint256 b, uint256 out) public {
        bond = bound(bond, 0.0001 ether, 2 ether);
        _mockScore(agentA, 1000);
        _gbond(agentA, bond);
        _offer(agentA, 10 ether);
        a = bound(a, 0.0001 ether, 2 ether);
        b = bound(b, 0.0001 ether, 2 ether);
        uint256 dueAt = block.timestamp + 1 days;
        if (a <= g.freeOf(agentA)) _reserve(buyer, agentA, 2 ether, dueAt, false, a);
        if (b <= g.freeOf(agentA)) _reserve(other, agentA, 2 ether, dueAt, false, b);
        FactorGuarantee.Bond memory s = g.bondOf(agentA);
        assertLe(s.reserved, s.bond);
        out = bound(out, 1, 3 ether);
        vm.prank(agentA);
        if (out > s.bond - s.reserved) {
            vm.expectRevert(abi.encodeWithSelector(FactorGuarantee.OverFree.selector, s.bond - s.reserved));
            g.takeBond(agentA, out);
        } else {
            g.takeBond(agentA, out);
        }
        assertLe(g.bondOf(agentA).reserved, g.bondOf(agentA).bond);
        _gbooks();
    }
}
