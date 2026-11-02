// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BountyBase} from "./BountyBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorBounty} from "../../src/FactorBounty.sol";
import {Rejecter} from "../mocks/Actors.sol";

/// Every rule of docs/BOUNTIES.md, one by one, with its examples to the wei.
contract BountyTest is BountyBase {
    // ---------- the contract ----------

    function test_readsTheDesk() public view {
        assertEq(address(b.desk()), address(desk));
        assertEq(address(b.line()), address(line));
        assertEq(b.burnPot(), desk.burnPot());
        assertGe(b.MIN_PRIZE(), desk.MIN_JOB());
    }

    function test_numbers() public view {
        assertEq(b.BURN_BPS(), 100);
        assertEq(b.BOND_BPS(), 100);
        assertEq(b.MIN_PRIZE(), 0.005 ether);
        assertEq(b.MAX_ENTRIES(), 25);
        assertEq(b.MIN_OPEN(), 1 hours);
        assertEq(b.MAX_OPEN(), 30 days);
        assertEq(b.PICK_TIME(), 3 days);
        assertEq(b.DELIVER_TIME(), 3 days);
        assertEq(b.feeFor(0.1 ether), 0.001 ether);
        assertEq(b.bondFor(0.1 ether), 0.001 ether);
    }

    function test_constructor_refusesNoDeskAndAnotherDesksLine() public {
        vm.expectRevert(FactorBounty.ZeroAddress.selector);
        new FactorBounty(FactorDesk(payable(address(0))), line);
        FactorDesk otherDesk = new FactorDesk(address(burnPot), gateway);
        vm.expectRevert(FactorBounty.WrongDesk.selector);
        new FactorBounty(otherDesk, line);
    }

    function test_constructor_refusesADeskWhoseRulesDoNotFit() public {
        vm.mockCall(address(desk), abi.encodeWithSignature("MIN_JOB()"), abi.encode(0.01 ether));
        vm.expectRevert(FactorBounty.DeskRules.selector);
        new FactorBounty(desk, line);
        vm.clearMockedCalls();
        vm.mockCall(address(desk), abi.encodeWithSignature("MIN_DUE()"), abi.encode(4 days));
        vm.expectRevert(FactorBounty.DeskRules.selector);
        new FactorBounty(desk, line);
        vm.clearMockedCalls();
        vm.mockCall(address(desk), abi.encodeWithSignature("MAX_DUE()"), abi.encode(2 days));
        vm.expectRevert(FactorBounty.DeskRules.selector);
        new FactorBounty(desk, line);
    }

    function test_worksWithNoLineContract() public {
        FactorBounty alone = new FactorBounty(desk, FactorLine(payable(address(0))));
        assertEq(alone.keyOf(agentA), address(0));
        vm.deal(poster, 1 ether);
        vm.prank(poster);
        uint256 id = alone.post{value: PRIZE + FEE}(PRIZE, block.timestamp + 1 days, 0, TASK);
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        alone.enter{value: BOND}(id, agentA, keccak256("work"));
        assertEq(alone.scoreOf(agentA), 0);
        assertEq(alone.entrants(id).length, 1);
    }

    // ---------- posting ----------

    function test_post_holdsThePrizeAndTheOnePercent() public {
        uint256 id = _post();
        FactorBounty.Bounty memory x = b.bounty(id);
        assertEq(id, 1);
        assertEq(b.bountyCount(), 1);
        assertEq(x.poster, poster);
        assertEq(x.prize, PRIZE);
        assertEq(x.fee, FEE);
        assertEq(x.bond, BOND);
        assertEq(x.deadline, block.timestamp + 1 days);
        assertEq(x.minScore, 0);
        assertEq(x.task, TASK);
        assertEq(uint8(x.state), uint8(FactorBounty.State.Open));
        assertEq(address(b).balance, 0.00505 ether, "the poster sent 0.00505");
        assertEq(b.held(), 0.00505 ether);
        assertEq(b.totalPrizes(), PRIZE);
        _bbooks();
    }

    function test_post_emits() public {
        vm.deal(poster, 1 ether);
        vm.expectEmit(true, true, false, true, address(b));
        emit FactorBounty.Posted(1, poster, PRIZE, FEE, BOND, block.timestamp + 1 days, 7, TASK);
        vm.prank(poster);
        b.post{value: PRIZE + FEE}(PRIZE, block.timestamp + 1 days, 7, TASK);
    }

    function test_post_refusesASmallerPrize() public {
        vm.deal(poster, 1 ether);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.TooSmall.selector, 0.005 ether));
        b.post{value: 0.00505 ether}(0.005 ether - 1, block.timestamp + 1 days, 0, TASK);
    }

    function test_post_refusesTheWrongValue() public {
        vm.deal(poster, 1 ether);
        vm.startPrank(poster);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.WrongValue.selector, PRIZE + FEE));
        b.post{value: PRIZE}(PRIZE, block.timestamp + 1 days, 0, TASK);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.WrongValue.selector, PRIZE + FEE));
        b.post{value: PRIZE + FEE + 1}(PRIZE, block.timestamp + 1 days, 0, TASK);
    }

    function test_post_deadlineFromAnHourToThirtyDays() public {
        vm.deal(poster, 1 ether);
        vm.startPrank(poster);
        vm.expectRevert(FactorBounty.BadDeadline.selector);
        b.post{value: PRIZE + FEE}(PRIZE, block.timestamp + 1 hours - 1, 0, TASK);
        vm.expectRevert(FactorBounty.BadDeadline.selector);
        b.post{value: PRIZE + FEE}(PRIZE, block.timestamp + 30 days + 1, 0, TASK);
        b.post{value: PRIZE + FEE}(PRIZE, block.timestamp + 1 hours, 0, TASK);
        b.post{value: PRIZE + FEE}(PRIZE, block.timestamp + 30 days, 0, TASK);
    }

    function test_post_refusesAScoreOverTheTopAndNoTask() public {
        vm.deal(poster, 1 ether);
        vm.startPrank(poster);
        vm.expectRevert(FactorBounty.BadScore.selector);
        b.post{value: PRIZE + FEE}(PRIZE, block.timestamp + 1 days, 1001, TASK);
        vm.expectRevert(FactorBounty.NoTask.selector);
        b.post{value: PRIZE + FEE}(PRIZE, block.timestamp + 1 days, 0, bytes32(0));
        b.post{value: PRIZE + FEE}(PRIZE, block.timestamp + 1 days, 1000, TASK);
    }

    // ---------- entering ----------

    function test_enter_commitsTheHashAndHoldsTheBond() public {
        uint256 id = _post();
        bytes32 h = _hash(id, agentA);
        vm.deal(agentA, 1 ether);
        vm.expectEmit(true, true, true, true, address(b));
        emit FactorBounty.Entered(id, agentA, agentA, h, 1);
        vm.prank(agentA);
        b.enter{value: BOND}(id, agentA, h);
        assertEq(b.entryOf(id, agentA).hash, h);
        assertEq(b.entryOf(id, agentA).at, block.timestamp);
        assertEq(b.entrants(id)[0], agentA);
        assertEq(b.bonds(), BOND);
        _bbooks();
    }

    function test_entryHash_holdsTheContractTheBountyTheAgentAndTheWork() public view {
        bytes32 w = keccak256("the work");
        assertEq(b.entryHash(1, agentA, w), keccak256(abi.encode(address(b), uint256(1), agentA, w)));
        assertTrue(b.entryHash(1, agentA, w) != b.entryHash(1, agentB, w), "the address is in it");
        assertTrue(b.entryHash(1, agentA, w) != b.entryHash(2, agentA, w), "the bounty is in it");
        assertTrue(b.entryHash(1, agentA, w) != b.entryHash(1, agentA, keccak256("other")), "the work is in it");
    }

    function test_enter_refusesTheWrongBond() public {
        uint256 id = _post();
        vm.deal(agentA, 1 ether);
        vm.startPrank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.WrongValue.selector, BOND));
        b.enter{value: BOND - 1}(id, agentA, keccak256("work"));
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.WrongValue.selector, BOND));
        b.enter{value: BOND + 1}(id, agentA, keccak256("work"));
    }

    function test_enter_refusesNoHash() public {
        uint256 id = _post();
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(FactorBounty.NoHash.selector);
        b.enter{value: BOND}(id, agentA, bytes32(0));
    }

    function test_enter_refusesABountyThatDoesNotExist() public {
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.WrongState.selector, FactorBounty.State.None));
        b.enter{value: BOND}(7, agentA, keccak256("work"));
    }

    function test_enter_endsExactlyAtTheDeadline() public {
        uint256 id = _post();
        vm.warp(uint256(b.bounty(id).deadline) - 1);
        _enter(id, agentA);
        vm.warp(b.bounty(id).deadline);
        vm.deal(agentB, 1 ether);
        vm.prank(agentB);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.TooLate.selector, uint256(b.bounty(id).deadline)));
        b.enter{value: BOND}(id, agentB, keccak256("work"));
    }

    function test_enter_atMostTwentyFive() public {
        uint256 id = _post();
        for (uint256 i = 0; i < 25; ++i) {
            address a = makeAddr(string.concat("an agent ", vm.toString(i)));
            vm.prank(a);
            desk.register();
            _enter(id, a);
        }
        assertEq(b.entrants(id).length, 25);
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(FactorBounty.Full.selector);
        b.enter{value: BOND}(id, agentA, keccak256("work"));
    }

    function test_enter_holdsToTheMinimumScore() public {
        uint256 id = _post(poster, PRIZE, 1 days, 200);
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.ScoreTooLow.selector, 0, 200));
        b.enter{value: BOND}(id, agentA, keccak256("work"));
        _score200(agentA);
        assertGe(desk.score(agentA), 200);
        vm.prank(agentA);
        b.enter{value: BOND}(id, agentA, keccak256("work"));
        assertEq(b.entrants(id).length, 1);
    }

    function test_enter_bondIsOnePercentOfThePrize() public {
        uint256 id = _post(poster, 1 ether, 1 days, 0);
        assertEq(b.bounty(id).bond, 0.01 ether);
        _enter(id, agentA);
        assertEq(b.bonds(), 0.01 ether);
    }

    // ---------- the pick ----------

    function test_pick_locksThePrizeOnTheDeskAndBurnsTheOnePercent() public {
        uint256 id = _post();
        _enter(id, agentA);
        _enter(id, agentB);
        _toDeadline(id);
        uint256 pot = address(burnPot).balance;
        uint256 heldBefore = desk.held();
        vm.expectEmit(true, true, true, true, address(b));
        emit FactorBounty.Picked(id, agentA, 1, FEE, block.timestamp + 3 days);
        uint256 job = _pick(id, agentA);
        FactorDesk.Job memory j = desk.job(job);
        assertEq(j.customer, address(b), "the contract is the desk's customer");
        assertEq(j.agent, agentA);
        assertEq(j.price, PRIZE);
        assertEq(j.dueAt, block.timestamp + 3 days);
        assertFalse(j.allowEarly, "no early half");
        assertEq(uint8(j.state), uint8(FactorDesk.State.Locked));
        assertEq(desk.held() - heldBefore, PRIZE);
        assertEq(address(burnPot).balance - pot, FEE, "the 1% reached the burn pot");
        assertEq(b.totalBurned(), FEE);
        assertEq(b.bountyOfJob(job), id);
        FactorBounty.Bounty memory x = b.bounty(id);
        assertEq(uint8(x.state), uint8(FactorBounty.State.Picked));
        assertEq(x.winner, agentA);
        assertEq(x.job, job);
        assertEq(b.atDesk(), PRIZE);
        assertEq(b.held(), 0);
        _bbooks();
    }

    function test_pick_onlyThePoster() public {
        uint256 id = _post();
        _enter(id, agentA);
        _toDeadline(id);
        vm.prank(stranger);
        vm.expectRevert(FactorBounty.NotPoster.selector);
        b.pick(id, agentA);
    }

    function test_pick_notBeforeTheDeadline() public {
        uint256 id = _post();
        _enter(id, agentA);
        uint256 d = b.bounty(id).deadline;
        vm.warp(d - 1);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.TooSoon.selector, d));
        b.pick(id, agentA);
    }

    function test_pick_endsExactlyThreeDaysAfterTheDeadline() public {
        uint256 id = _post();
        _enter(id, agentA);
        uint256 d = b.bounty(id).deadline;
        vm.warp(d + 3 days);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.TooLate.selector, d + 3 days));
        b.pick(id, agentA);
        vm.warp(d + 3 days - 1);
        _pick(id, agentA);
    }

    function test_pick_onlyAnEntrant() public {
        uint256 id = _post();
        _enter(id, agentA);
        _toDeadline(id);
        vm.prank(poster);
        vm.expectRevert(FactorBounty.NotAnEntrant.selector);
        b.pick(id, agentB);
    }

    function test_pick_onlyOnce() public {
        (uint256 id,) = _picked(agentA, _one(agentB));
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.WrongState.selector, FactorBounty.State.Picked));
        b.pick(id, agentB);
    }

    // ---------- a win ----------

    function test_win_paidThroughTheDeskToTheWei() public {
        (uint256 id, uint256 job) = _picked(agentA, _two(agentB, agentC));
        uint256 aBefore = agentA.balance;
        uint256 pool = desk.pool();
        _deliverProof(agentA, job, b.entryOf(id, agentA).hash);
        vm.prank(stranger);
        b.close(id);
        FactorBounty.Bounty memory x = b.bounty(id);
        assertEq(uint8(x.state), uint8(FactorBounty.State.Won));
        assertEq(uint8(desk.job(job).state), uint8(FactorDesk.State.Settled));
        // the desk's 2% of the prize to the pool, the winner the rest plus its bond
        assertEq(desk.pool() - pool, 0.0001 ether, "the job fee to the pool");
        assertEq(agentA.balance - aBefore, 0.0049 ether + BOND, "98% of the prize, and its bond");
        assertEq(b.bonds(), 0, "all bonds back");
        assertEq(b.atDesk(), 0);
        assertEq(b.totalWon(), PRIZE);
        _bbooks();
    }

    function test_win_countsOnTheDeskRecord() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        _deliverProof(agentA, job, b.entryOf(id, agentA).hash);
        b.close(id);
        FactorDesk.Agent memory a = desk.agent(agentA);
        assertEq(a.settled, 1);
        assertEq(a.onTime, 1);
        assertEq(a.feesPaid, 0.0001 ether);
        assertEq(a.volume, PRIZE);
        assertEq(desk.feesFrom(agentA, address(b)), 0.0001 ether);
        assertEq(desk.limit(agentA), 0.0001 ether, "the fee counts toward its limit");
        assertEq(desk.score(agentA), 10, "10 for the job; the fee is under the first point");
        (uint32 accepted,) = desk.customers(address(b));
        assertEq(accepted, 1);
    }

    function test_win_allBountiesAreOneCustomerToTheDesk() public {
        // ten wins of 0.05 ETH from ten posters: 0.001 in fees from the one customer, the contract
        for (uint256 i = 0; i < 2; ++i) {
            address p = makeAddr(string.concat("poster ", vm.toString(i)));
            uint256 id = _post(p, 0.05 ether, 1 days, 0);
            _enter(id, agentA);
            _toDeadline(id);
            uint256 job = _pick(id, agentA);
            _deliverProof(agentA, job, b.entryOf(id, agentA).hash);
            b.close(id);
        }
        assertEq(desk.agent(agentA).customers, 1, "one customer however many posters");
        assertEq(desk.feesFrom(agentA, address(b)), 0.002 ether);
    }

    function test_win_bondsCanGoBackAtThePick() public {
        (uint256 id, uint256 job) = _picked(agentA, _two(agentB, agentC));
        uint256 bBefore = agentB.balance;
        uint256 cBefore = agentC.balance;
        uint256 aBefore = agentA.balance;
        vm.prank(stranger);
        b.returnBonds(id);
        assertEq(agentB.balance - bBefore, BOND);
        assertEq(agentC.balance - cBefore, BOND);
        assertEq(agentA.balance, aBefore, "not the winner's");
        assertEq(b.bonds(), BOND);
        assertTrue(b.bounty(id).bondsBack);
        vm.expectRevert(FactorBounty.BondsAlreadyBack.selector);
        b.returnBonds(id);
        // the close then pays only the winner's bond
        _deliverProof(agentA, job, b.entryOf(id, agentA).hash);
        b.close(id);
        assertEq(agentB.balance - bBefore, BOND, "not twice");
        assertEq(agentA.balance - aBefore, 0.0049 ether + BOND);
        assertEq(b.bonds(), 0);
        _bbooks();
    }

    function test_returnBonds_onlyWhilePicked() public {
        uint256 id = _post();
        _enter(id, agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.WrongState.selector, FactorBounty.State.Open));
        b.returnBonds(id);
    }

    function test_win_aWrongProofWaitsForTheDesksClock() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        _deliverProof(agentA, job, keccak256("something else"));
        uint256 at = desk.job(job).deliveredAt + desk.REVIEW();
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.TooSoon.selector, at));
        b.close(id);
        vm.warp(at);
        uint256 before = agentA.balance;
        b.close(id);
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Won));
        assertEq(agentA.balance - before, 0.0049 ether + BOND);
        _bbooks();
    }

    function test_win_theDeskSettledItFirst() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        _deliverProof(agentA, job, keccak256("something else"));
        vm.warp(block.timestamp + 1 days);
        desk.settle(job);
        b.close(id);
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Won));
        assertEq(b.totalWon(), PRIZE);
        _bbooks();
    }

    function test_win_aLateDeliveryCountsAndIsMarkedLate() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        vm.warp(block.timestamp + 3 days + 1 hours);
        _deliverProof(agentA, job, b.entryOf(id, agentA).hash);
        b.close(id);
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Won));
        assertEq(desk.agent(agentA).late, 1);
    }

    function test_win_aPoolAdvanceIsRepaid() public {
        _fund(1 ether);
        _bond(agentA, 0.01 ether);
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        uint256 before = agentA.balance;
        _draw(agentA, job, 0.001 ether, FactorDesk.Kind.Pool);
        _deliverProof(agentA, job, b.entryOf(id, agentA).hash);
        b.close(id);
        assertEq(desk.agent(agentA).advancedNow, 0);
        assertEq(desk.agent(agentA).advancesRepaid, 1);
        // 0.00099 from the advance, then 0.005 - 0.001 - 0.0001, and its bond
        assertEq(agentA.balance - before, 0.00099 ether + 0.0039 ether + BOND);
        _bbooks();
    }

    function test_close_tooSoonWhileTheWinnerHasTime() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        uint256 at = uint256(desk.job(job).dueAt) + 12 hours;
        vm.warp(at);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.TooSoon.selector, at + 1));
        b.close(id);
    }

    function test_close_onlyOnce() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        _deliverProof(agentA, job, b.entryOf(id, agentA).hash);
        b.close(id);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.WrongState.selector, FactorBounty.State.Won));
        b.close(id);
    }

    function test_close_refusesABountyThatDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.WrongState.selector, FactorBounty.State.None));
        b.close(9);
    }

    // ---------- no pick ----------

    function test_unpicked_splitBetweenTheEntrantsToTheWei() public {
        uint256 id = _post();
        address[4] memory who = [agentA, agentB, agentC, agentD];
        for (uint256 i = 0; i < 4; ++i) {
            _enter(id, who[i]);
        }
        uint256[4] memory before;
        for (uint256 i = 0; i < 4; ++i) {
            before[i] = who[i].balance;
        }
        uint256 pot = address(burnPot).balance;
        uint256 posterBefore = poster.balance;
        _toSplit(id);
        vm.prank(stranger);
        b.close(id);
        for (uint256 i = 0; i < 4; ++i) {
            assertEq(who[i].balance - before[i], 0.00125 ether + BOND, "a share and the bond");
        }
        assertEq(address(burnPot).balance - pot, FEE, "the 1% burned");
        assertEq(poster.balance, posterBefore, "the poster loses it");
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Unpicked));
        assertEq(b.totalSplit(), PRIZE);
        assertEq(address(b).balance, 0);
        _bbooks();
    }

    function test_unpicked_notBeforeThreeDaysAfterTheDeadline() public {
        uint256 id = _post();
        _enter(id, agentA);
        uint256 at = uint256(b.bounty(id).deadline) + 3 days;
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.TooSoon.selector, at));
        b.close(id);
        vm.warp(at);
        b.close(id);
    }

    function test_unpicked_dustGoesToTheBurn() public {
        uint256 id = _post(poster, 0.005 ether + 1, 1 days, 0);
        address[3] memory who = [agentA, agentB, agentC];
        for (uint256 i = 0; i < 3; ++i) {
            _enter(id, who[i]);
        }
        uint256 pot = address(burnPot).balance;
        _toSplit(id);
        b.close(id);
        uint256 prize = 0.005 ether + 1;
        uint256 share = prize / 3;
        assertEq(address(burnPot).balance - pot, b.feeFor(prize) + (prize - share * 3), "the 1% and the dust");
        assertEq(address(b).balance, 0, "not a wei left");
    }

    function test_unpicked_aSoleEntrantHasItAll() public {
        uint256 id = _post();
        _enter(id, agentA);
        uint256 before = agentA.balance;
        _toSplit(id);
        b.close(id);
        assertEq(agentA.balance - before, PRIZE + BOND);
        assertEq(desk.agent(agentA).settled, 0, "a split is not a job");
    }

    function test_unpicked_tooLateToPickAfterASplit() public {
        uint256 id = _post();
        _enter(id, agentA);
        _toSplit(id);
        b.close(id);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.WrongState.selector, FactorBounty.State.Unpicked));
        b.pick(id, agentA);
    }

    function test_unpicked_aSplitTakesNoJobFee() public {
        uint256 id = _post();
        _enter(id, agentA);
        _enter(id, agentB);
        uint256 pool = desk.pool();
        _toSplit(id);
        b.close(id);
        assertEq(desk.pool(), pool, "no job, so no job fee");
    }

    // ---------- no entries ----------

    function test_empty_everythingBackFromTheDeadline() public {
        uint256 id = _post();
        uint256 d = b.bounty(id).deadline;
        vm.warp(d - 1);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.TooSoon.selector, d));
        b.close(id);
        vm.warp(d);
        uint256 before = poster.balance;
        uint256 pot = address(burnPot).balance;
        vm.prank(stranger);
        b.close(id);
        assertEq(poster.balance - before, PRIZE + FEE, "the prize and the 1%");
        assertEq(address(burnPot).balance, pot, "nothing burned");
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Empty));
        assertEq(b.totalReturned(), PRIZE);
        assertEq(address(b).balance, 0);
        _bbooks();
    }

    // ---------- the winner does not deliver ----------

    function test_undelivered_splitBetweenTheOthersToTheWei() public {
        (uint256 id, uint256 job) = _picked(agentA, _two(agentB, agentC));
        uint256 aBefore = agentA.balance;
        uint256 bBefore = agentB.balance;
        uint256 cBefore = agentC.balance;
        uint256 posterBefore = poster.balance;
        vm.warp(uint256(desk.job(job).dueAt) + 12 hours + 1);
        uint256 pot = address(burnPot).balance;
        vm.prank(stranger);
        b.close(id);
        assertEq(uint8(desk.job(job).state), uint8(FactorDesk.State.Refunded), "refunded on the desk");
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Undelivered));
        uint256 share = (PRIZE + BOND) / 2;
        assertEq(agentB.balance - bBefore, share + BOND);
        assertEq(agentC.balance - cBefore, share + BOND);
        assertEq(agentA.balance, aBefore, "the winner loses its bond");
        assertEq(poster.balance, posterBefore, "the poster has nothing back");
        assertEq(address(burnPot).balance - pot, (PRIZE + BOND) - share * 2, "the dust");
        assertEq(address(b).balance, 0);
        assertEq(b.totalSplit(), PRIZE);
        _bbooks();
    }

    function test_undelivered_theExampleOfTheRulebook() public {
        address[] memory also = new address[](3);
        also[0] = agentB;
        also[1] = agentC;
        also[2] = agentD;
        (uint256 id, uint256 job) = _picked(agentA, also);
        uint256 before = agentB.balance;
        vm.warp(uint256(desk.job(job).dueAt) + 12 hours + 1);
        uint256 pot = address(burnPot).balance;
        b.close(id);
        assertEq(agentB.balance - before, 0.001683333333333333 ether + BOND);
        assertEq(address(burnPot).balance - pot, 1, "1 wei of dust");
    }

    function test_undelivered_aDeclineEndsItAtOnce() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        vm.prank(agentA);
        desk.decline(job);
        assertEq(address(b).balance, PRIZE + 2 * BOND, "the desk paid the contract back");
        _bbooks(PRIZE);
        uint256 before = agentB.balance;
        b.close(id);
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Undelivered));
        assertEq(agentB.balance - before, PRIZE + BOND + BOND);
        assertEq(address(b).balance, 0);
        _bbooks();
    }

    function test_undelivered_theDeskRefundedItFirst() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        vm.warp(uint256(desk.job(job).dueAt) + 12 hours + 1);
        desk.refund(job);
        _bbooks(PRIZE);
        b.close(id);
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Undelivered));
        _bbooks();
    }

    function test_undelivered_noOtherEntrant_backToThePoster() public {
        address[] memory none = new address[](0);
        (uint256 id, uint256 job) = _picked(agentA, none);
        vm.warp(uint256(desk.job(job).dueAt) + 12 hours + 1);
        uint256 before = poster.balance;
        uint256 pot = address(burnPot).balance;
        b.close(id);
        assertEq(poster.balance - before, PRIZE, "the prize back, not the 1%");
        assertEq(address(burnPot).balance - pot, BOND, "the winner's bond burned");
        assertEq(b.totalReturned(), PRIZE);
        assertEq(address(b).balance, 0);
        _bbooks();
    }

    function test_undelivered_afterBondsWentBack() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        b.returnBonds(id);
        uint256 before = agentB.balance;
        vm.warp(uint256(desk.job(job).dueAt) + 12 hours + 1);
        b.close(id);
        assertEq(agentB.balance - before, PRIZE + BOND, "the prize and the winner's bond, its own bond not twice");
        assertEq(address(b).balance, 0);
        _bbooks();
    }

    function test_undelivered_aPoolAdvanceBarsTheWinnerAndTheContractIsWhole() public {
        _fund(1 ether);
        _bond(agentA, 0.01 ether);
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        _draw(agentA, job, 0.001 ether, FactorDesk.Kind.Pool);
        vm.warp(uint256(desk.job(job).dueAt) + 12 hours + 1);
        uint256 before = agentB.balance;
        b.close(id);
        assertTrue(desk.agent(agentA).barred);
        assertEq(agentB.balance - before, PRIZE + BOND + BOND, "the whole prize came back");
        _bbooks();
    }

    function test_undelivered_noMarkOnTheRecordWithoutADraw() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        vm.warp(uint256(desk.job(job).dueAt) + 12 hours + 1);
        b.close(id);
        assertEq(desk.agent(agentA).unanswered, 1);
        assertFalse(desk.agent(agentA).barred);
    }

    // ---------- who enters ----------

    function test_lineAccount_itsKeyEntersForIt() public {
        _open(agentA);
        FactorLineAccount acct = _acct(agentA);
        uint256 id = _post();
        bytes32 h = _hash(id, address(acct));
        vm.deal(agentA, 1 ether);
        vm.expectEmit(true, true, true, true, address(b));
        emit FactorBounty.Entered(id, address(acct), agentA, h, 1);
        vm.prank(agentA);
        b.enter{value: BOND}(id, address(acct), h);
        _toDeadline(id);
        uint256 job = _pick(id, address(acct));
        vm.prank(agentA);
        acct.deliver(job, h);
        b.close(id);
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Won));
        assertEq(address(acct).balance, 0.0049 ether + BOND, "the prize and the bond to the account");
        assertEq(desk.agent(address(acct)).settled, 1, "the win counts on the account");
        _bbooks();
    }

    function test_lineAccount_aSplitRepaysTheLineFirstWhenSwept() public {
        _seed(1 ether);
        _open(agentA);
        FactorLineAccount acct = _acct(agentA);
        _lineBond(agentA, 0.001 ether);
        _lineDraw(agentA, 0.0005 ether, false);
        uint256 id = _post();
        _enterAs(agentA, id, address(acct));
        _toSplit(id);
        b.close(id);
        assertEq(address(acct).balance, PRIZE + BOND);
        acct.sweep();
        assertEq(line.debtOf(address(acct)), 0, "the line was repaid first");
    }

    function test_lineAccount_itsKeyAndItCountAsOne() public {
        _open(agentA);
        FactorLineAccount acct = _acct(agentA);
        uint256 id = _post();
        _enter(id, agentA);
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(FactorBounty.AlreadyIn.selector);
        b.enter{value: BOND}(id, address(acct), keccak256("work"));
        uint256 id2 = _post();
        _enterAs(agentA, id2, address(acct));
        vm.prank(agentA);
        vm.expectRevert(FactorBounty.AlreadyIn.selector);
        b.enter{value: BOND}(id2, agentA, keccak256("work"));
    }

    function test_lineAccount_scoreIsTheBetterOfItsTwoAddresses() public {
        _score200(agentA);
        _open(agentA);
        FactorLineAccount acct = _acct(agentA);
        assertGe(b.scoreOf(address(acct)), 200, "its key's");
        uint256 id = _post(poster, PRIZE, 1 days, 200);
        _enterAs(agentA, id, address(acct));
        assertEq(b.entrants(id).length, 1);
    }

    function test_lineAccount_scoreKeepsTheAccountsOwnWhenItIsBetter() public {
        _open(agentA);
        FactorLineAccount acct = _acct(agentA);
        _score200(address(acct));
        assertEq(desk.score(agentA), 0);
        assertGe(b.scoreOf(address(acct)), 200, "the account's own");
    }

    function test_passkeyAccountStyle_aContractEntersLikeAnyAddress() public {
        Rejecter wallet = new Rejecter();
        wallet.setAccept(true);
        vm.prank(address(wallet));
        desk.register();
        uint256 id = _post();
        _enter(id, address(wallet));
        assertEq(b.entrants(id)[0], address(wallet));
    }

    // ---------- refused payouts ----------

    function test_collect_aRefusedPayoutWaitsAndGoesOnlyToItsOwner() public {
        Rejecter wallet = new Rejecter();
        vm.prank(address(wallet));
        desk.register();
        uint256 id = _post();
        _enter(id, address(wallet));
        _enter(id, agentA);
        _toSplit(id);
        uint256 before = agentA.balance;
        b.close(id);
        assertEq(agentA.balance - before, PRIZE / 2 + BOND, "the other entrant is paid");
        assertEq(b.owed(address(wallet)), PRIZE / 2 + BOND);
        assertEq(b.owedTotal(), PRIZE / 2 + BOND);
        _bbooks();
        vm.expectRevert(FactorBounty.PushFailed.selector);
        b.collect(address(wallet));
        wallet.setAccept(true);
        b.collect(address(wallet));
        assertEq(address(wallet).balance, PRIZE / 2 + BOND);
        assertEq(b.owedTotal(), 0);
        vm.expectRevert(FactorBounty.NothingOwed.selector);
        b.collect(address(wallet));
    }

    function test_collectTo_sendsYourOwnElsewhere() public {
        Rejecter wallet = new Rejecter();
        vm.prank(address(wallet));
        desk.register();
        uint256 id = _post();
        _enter(id, address(wallet));
        _toSplit(id);
        b.close(id);
        vm.prank(address(wallet));
        vm.expectRevert(FactorBounty.ZeroAddress.selector);
        b.collectTo(payable(address(0)));
        vm.prank(address(wallet));
        b.collectTo(payable(agentD));
        assertEq(agentD.balance, BOND + PRIZE);
        assertEq(b.owedTotal(), 0);
    }

    function test_collectTo_aRefusingTargetIsRefused() public {
        Rejecter wallet = new Rejecter();
        Rejecter target = new Rejecter();
        vm.prank(address(wallet));
        desk.register();
        uint256 id = _post();
        _enter(id, address(wallet));
        _toSplit(id);
        b.close(id);
        vm.prank(address(wallet));
        vm.expectRevert(FactorBounty.PushFailed.selector);
        b.collectTo(payable(address(target)));
        assertEq(b.owed(address(wallet)), PRIZE + BOND, "kept");
    }

    function test_owed_aPosterThatRefusesItsReturn() public {
        Rejecter wallet = new Rejecter();
        vm.deal(address(wallet), 1 ether);
        vm.prank(address(wallet));
        uint256 id = b.post{value: PRIZE + FEE}(PRIZE, block.timestamp + 1 days, 0, TASK);
        _toDeadline(id);
        b.close(id);
        assertEq(b.owed(address(wallet)), PRIZE + FEE);
        _bbooks();
    }

    function test_gasShort_nobodyCanForceAPayoutIntoOwed() public {
        uint256 id = _post();
        _enter(id, agentA);
        _toSplit(id);
        vm.expectRevert(FactorBounty.GasShort.selector);
        b.close{gas: 90_000}(id);
        assertEq(b.owedTotal(), 0);
        b.close(id);
        assertEq(b.owedTotal(), 0);
    }

    // ---------- views ----------

    function test_aNumberNeverGivenOutReadsAsNone() public view {
        assertEq(uint8(b.bounty(99).state), uint8(FactorBounty.State.None));
        assertEq(b.entrants(99).length, 0);
        assertEq(b.entryOf(99, agentA).at, 0);
        assertEq(b.bountyOfJob(99), 0);
    }

    // ---------- fuzzed ----------

    /// Any prize and any number of entrants, unpicked: each gets the same share and its bond, the rest is burned, and the
    /// contract ends empty.
    function testFuzz_unpickedSplitsToTheWei(uint96 prize_, uint8 n_, uint32 extraOpen) public {
        uint256 prize = bound(prize_, 0.005 ether, 50 ether);
        uint256 n = bound(n_, 1, 25);
        uint256 id = _post(poster, prize, bound(extraOpen, 1 hours, 30 days), 0);
        address[] memory who = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            who[i] = makeAddr(string.concat("fuzz agent ", vm.toString(i)));
            vm.prank(who[i]);
            desk.register();
            _enter(id, who[i]);
        }
        uint256 pot = address(burnPot).balance;
        _toSplit(id);
        b.close(id);
        uint256 share = prize / n;
        uint256 bond = b.bounty(id).bond;
        for (uint256 i = 0; i < n; ++i) {
            assertEq(who[i].balance, share + bond);
        }
        assertEq(address(burnPot).balance - pot, b.feeFor(prize) + prize - share * n);
        assertEq(address(b).balance, 0);
        _bbooks();
    }

    /// Any prize and number of entrants, the winner gone: the others share the prize and its bond to the wei.
    function testFuzz_undeliveredSplitsToTheWei(uint96 prize_, uint8 n_) public {
        uint256 prize = bound(prize_, 0.005 ether, 50 ether);
        uint256 n = bound(n_, 1, 25);
        uint256 id = _post(poster, prize, 1 days, 0);
        address[] memory who = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            who[i] = makeAddr(string.concat("fuzz agent ", vm.toString(i)));
            vm.prank(who[i]);
            desk.register();
            _enter(id, who[i]);
        }
        _toDeadline(id);
        uint256 job = _pick(id, who[0]);
        uint256 posterBefore = poster.balance;
        vm.warp(uint256(desk.job(job).dueAt) + 12 hours + 1);
        uint256 pot = address(burnPot).balance;
        b.close(id);
        uint256 bond = b.bounty(id).bond;
        if (n == 1) {
            assertEq(poster.balance - posterBefore, prize);
            assertEq(address(burnPot).balance - pot, bond);
        } else {
            uint256 share = (prize + bond) / (n - 1);
            for (uint256 i = 1; i < n; ++i) {
                assertEq(who[i].balance, share + bond);
            }
            assertEq(address(burnPot).balance - pot, prize + bond - share * (n - 1));
        }
        assertEq(who[0].balance, 0, "the winner's bond was forfeited");
        assertEq(address(b).balance, 0);
        _bbooks();
    }

    /// Any prize: a win pays the winner 98% and its bond, the pool 2%, the burn 1%.
    function testFuzz_aWinPaysToTheWei(uint96 prize_) public {
        uint256 prize = bound(prize_, 0.005 ether, 50 ether);
        uint256 id = _post(poster, prize, 1 days, 0);
        _enter(id, agentA);
        _toDeadline(id);
        uint256 pot = address(burnPot).balance;
        uint256 pool = desk.pool();
        uint256 job = _pick(id, agentA);
        _deliverProof(agentA, job, b.entryOf(id, agentA).hash);
        uint256 before = agentA.balance;
        b.close(id);
        uint256 fee = (prize * 200) / 10_000;
        assertEq(agentA.balance - before, prize - fee + b.bounty(id).bond);
        assertEq(desk.pool() - pool, fee);
        assertEq(address(burnPot).balance - pot, b.feeFor(prize));
        assertEq(address(b).balance, 0);
        _bbooks();
    }
}
