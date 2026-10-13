// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeskBase} from "./DeskBase.sol";
import {FactorDesk} from "../src/FactorDesk.sol";

/// A wallet with code on it that does what it is told when it is paid: refuses, or calls back into whoever paid it.
contract Hostile {
    bool public refuse;
    bytes public armed;
    uint256 public tries;
    uint256 public wins;

    function set(bool refuse_, bytes calldata armed_) external {
        refuse = refuse_;
        armed = armed_;
    }

    receive() external payable {
        require(!refuse, "no");
        if (armed.length != 0) {
            tries += 1;
            (bool ok,) = msg.sender.call(armed);
            if (ok) wins += 1;
        }
    }
}

/// The twelve attacks of docs/RULEBOOK.md section 7, each carried out against the desk, in the rulebook's order.
contract DeskAttacksTest is DeskBase {
    uint256 internal constant PAST_DUE = 1 days + 12 hours + 1;

    function _refundLate(uint256 id) internal {
        vm.warp(block.timestamp + PAST_DUE);
        desk.refund(id);
    }

    // ---------- 1. hire yourself to build a limit, then take the pool's money and run ----------

    /// Any number of jobs, any price, any bond, settled or rejected between its own two wallets: after it has
    /// taken everything the pool will give it and gone silent, the crook is never ahead and the pool is never
    /// behind.
    function testFuzz_attack01_hiringYourselfNeverPaysForItself(uint8 jobs, uint96 price, uint96 bondIn, bool rejecting)
        public
    {
        uint256 n = bound(jobs, 1, 12);
        uint256 p = bound(price, 0.001 ether, 50 ether);
        uint256 b = bound(bondIn, 0, 5 ether);
        _fund(100 ether);
        address crook = makeAddr("crook");
        address second = makeAddr("the crook's second wallet");
        vm.prank(crook);
        desk.register();
        uint256 start = p * (n + 1) + b;
        vm.deal(second, start);
        uint256 poolStart = desk.pool();

        for (uint256 i = 0; i < n; ++i) {
            vm.prank(second);
            uint256 own = desk.lock{value: p}(crook, block.timestamp + 1 hours, false);
            _deliver(crook, own);
            vm.prank(second);
            if (rejecting) desk.reject(own);
            else desk.accept(own);
            vm.prank(crook);
            payable(second).transfer(crook.balance);
        }
        if (b > 0) {
            vm.prank(second);
            payable(crook).transfer(b);
            vm.prank(crook);
            desk.addBond{value: b}();
        }

        // the run: everything the pool will advance on one more job, and silence
        vm.prank(second);
        uint256 id = desk.lock{value: p}(crook, block.timestamp + 1 hours, false);
        (, uint256 fromPool) = desk.canDrawOn(id);
        if (fromPool > 0) _draw(crook, id, fromPool, FactorDesk.Kind.Pool);
        vm.warp(block.timestamp + 13 hours + 1);
        desk.refund(id);

        // whatever is left of its bond is still its own
        uint256 left = desk.agent(crook).bond;
        if (left > 0) {
            vm.prank(crook);
            desk.takeBond(left);
        }
        vm.prank(crook);
        payable(second).transfer(crook.balance);

        assertLe(second.balance, start, "the crook is never ahead");
        assertGe(desk.pool(), poolStart, "the pool is never behind");
        assertEq(desk.out(), 0);
        _books();
    }

    /// The same with the advance spread over many jobs at once: the limit is across all of them.
    function test_attack01_spreadingTheDrawOverManyJobsChangesNothing() public {
        _fund(10 ether);
        address crook = makeAddr("crook");
        address second = makeAddr("the crook's second wallet");
        vm.prank(crook);
        desk.register();
        vm.deal(second, 100 ether);
        for (uint256 i = 0; i < 5; ++i) {
            vm.prank(second);
            uint256 own = desk.lock{value: 1 ether}(crook, block.timestamp + 1 hours, false);
            _deliver(crook, own);
            vm.prank(second);
            desk.accept(own);
        }
        assertEq(desk.limit(crook), 0.1 ether);
        uint256 poolStart = desk.pool() - 0.1 ether; // before its own fees went in

        uint256[4] memory ids;
        for (uint256 i = 0; i < 4; ++i) {
            vm.prank(second);
            ids[i] = desk.lock{value: 1 ether}(crook, block.timestamp + 1 hours, false);
        }
        _draw(crook, ids[0], 0.04 ether, FactorDesk.Kind.Pool);
        _draw(crook, ids[1], 0.04 ether, FactorDesk.Kind.Compute);
        _draw(crook, ids[2], 0.02 ether, FactorDesk.Kind.Pool);
        vm.prank(crook);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.OverLimit.selector, 0));
        desk.draw(ids[3], 1, FactorDesk.Kind.Pool);

        vm.warp(block.timestamp + 13 hours + 1);
        for (uint256 i = 0; i < 4; ++i) {
            desk.refund(ids[i]);
        }
        assertEq(desk.totalLost(), 0.1 ether, "it took exactly what its jobs had paid in");
        assertEq(desk.pool(), poolStart, "so the pool is where it was before the crook came");
        _books();
    }

    // ---------- 2. deliver rubbish and get paid ----------

    function test_attack02_rubbishEarnsHalfAtMostAndAMark() public {
        _fund(1 ether);
        _bond(agentA, 0.5 ether);
        uint256 walletBefore = agentA.balance;
        uint256 id = _lock(agentA, 1 ether, false);
        _draw(agentA, id, 0.5 ether, FactorDesk.Kind.Pool);
        vm.prank(agentA);
        desk.deliver(id, keccak256("rubbish"));
        vm.prank(customer);
        desk.reject(id);

        assertEq(customer.balance, 0.5 ether, "the customer has half back");
        assertLe(agentA.balance - walletBefore, 0.5 ether, "the agent made half at most");
        assertEq(desk.pool(), 1 ether, "and the pool was repaid before it kept anything");
        FactorDesk.Agent memory a = desk.agent(agentA);
        assertEq(a.settledAtHalf, 1, "its record shows it");
        assertEq(a.settled, 0);

        // an honest agent on the same job stands better in money and in score
        uint256 honest = _lock(agentB, 1 ether, false);
        _deliver(agentB, honest);
        _accept(honest);
        assertEq(agentB.balance, 0.98 ether);
        assertGt(desk.score(agentB), desk.score(agentA));
        _books();
    }

    // ---------- 3. reject good work to pay half ----------

    function test_attack03_rejectingGoodWorkCostsHalfEveryTimeAndIsPublic() public {
        for (uint256 i = 0; i < 3; ++i) {
            uint256 id = _lock(agentA, 1 ether, false);
            _deliver(agentA, id);
            vm.prank(customer);
            desk.reject(id);
        }
        assertEq(customer.balance, 1.5 ether, "three jobs cost it 1.5 ETH: half the price each time");
        assertEq(agentA.balance, 3 * 0.49 ether, "the agent kept its half each time, less the fee on it");
        (uint32 accepted, uint32 rejected) = desk.customers(customer);
        assertEq(accepted, 0);
        assertEq(rejected, 3, "and anyone can see how this customer treats agents");

        // so the agent declines its next job, and loses nothing by it
        uint256 next = _lock(agentA, 1 ether, false);
        vm.prank(agentA);
        desk.decline(next);
        assertEq(customer.balance, 2.5 ether);
        assertEq(desk.agent(agentA).settledAtHalf, 3);
        _books();
    }

    function test_attack03_withAnEarlyAdvanceTheAgentAlreadyHoldsItsHalf() public {
        uint256 id = _lock(agentA, 1 ether, true);
        _draw(agentA, id, 0.5 ether, FactorDesk.Kind.Early);
        assertEq(agentA.balance, 0.495 ether);
        _deliver(agentA, id);
        vm.prank(customer);
        desk.reject(id);
        assertEq(agentA.balance, 0.495 ether, "rejecting takes nothing back from the agent");
        assertEq(customer.balance, 0.5 ether);
        _books();
    }

    // ---------- 4. take the early advance and disappear ----------

    function test_attack04_theEarlyAdvanceIsTheCustomersChoiceNeverMoreThanHalfAndMarksForGood() public {
        _fund(1 ether);
        _bond(agentA, 1 ether);
        // a customer who did not switch it on cannot lose a wei this way
        uint256 safe = _lockFrom(other, agentA, 1 ether, false);
        vm.prank(agentA);
        vm.expectRevert(FactorDesk.EarlyNotAllowed.selector);
        desk.draw(safe, 0.1 ether, FactorDesk.Kind.Early);

        uint256 id = _lock(agentA, 1 ether, true);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.OverHalf.selector, 0.5 ether));
        desk.draw(id, 0.5 ether + 1, FactorDesk.Kind.Early);
        _draw(agentA, id, 0.5 ether, FactorDesk.Kind.Early);

        vm.warp(block.timestamp + PAST_DUE);
        desk.refund(id);
        desk.refund(safe);
        assertEq(customer.balance, 0.5 ether, "the half it did not allow is back");
        assertEq(other.balance, 1 ether, "the careful customer is whole");

        FactorDesk.Agent memory a = desk.agent(agentA);
        assertEq(a.earlyKept, 1);
        assertTrue(a.barred);
        assertEq(desk.score(agentA), 0);
        assertEq(desk.limit(agentA), 0, "its bond buys it nothing with the pool any more");
        uint256 next = _lock(agentA, 1 ether, false);
        vm.prank(agentA);
        vm.expectRevert(FactorDesk.Barred.selector);
        desk.draw(next, 0.01 ether, FactorDesk.Kind.Pool);
        assertEq(desk.pool(), 1 ether, "the pool was never in it");
        _books();
    }

    // ---------- 5. never come back to accept ----------

    function test_attack05_aSilentCustomerCannotHoldTheAgentsMoney() public {
        uint256 id = _lock(agentA, 1 ether, false);
        _deliver(agentA, id);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(stranger);
        desk.settle(id);
        assertEq(agentA.balance, 0.98 ether);
        assertEq(stranger.balance, 0, "settling pays the caller nothing");

        // and the customer has no move left
        vm.startPrank(customer);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Settled));
        desk.reject(id);
        vm.stopPrank();
        vm.warp(block.timestamp + 60 days);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Settled));
        desk.refund(id);
        _books();
    }

    // ---------- 6. drain the pool with many agents at once ----------

    function test_attack06_manyAgentsAtOnceCannotDrainThePool() public {
        _fund(1 ether);
        uint256 count = 30;
        address[] memory crowd = new address[](count);
        uint256[] memory ids = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            crowd[i] = address(uint160(0xA6E000 + i));
            vm.prank(crowd[i]);
            desk.register();
            ids[i] = _lock(crowd[i], 0.1 ether, false);
            // new wallets have no limit, however many there are
            vm.prank(crowd[i]);
            vm.expectRevert(abi.encodeWithSelector(FactorDesk.OverLimit.selector, 0));
            desk.draw(ids[i], 1, FactorDesk.Kind.Pool);
        }

        // so each posts a bond. The pool still never has more than four fifths out.
        uint256 drew;
        for (uint256 i = 0; i < count; ++i) {
            _bond(crowd[i], 0.05 ether);
            vm.prank(crowd[i]);
            if (drew < 16) {
                desk.draw(ids[i], 0.05 ether, FactorDesk.Kind.Pool);
                drew += 1;
            } else {
                vm.expectRevert(abi.encodeWithSelector(FactorDesk.PoolShort.selector, 0));
                desk.draw(ids[i], 0.05 ether, FactorDesk.Kind.Pool);
            }
        }
        assertEq(desk.out(), 0.8 ether);
        assertEq(desk.pool(), 0.2 ether, "the last fifth never left");

        // all of them vanish: every bond pays for its own advance and the pool is whole
        vm.warp(block.timestamp + PAST_DUE);
        for (uint256 i = 0; i < count; ++i) {
            desk.refund(ids[i]);
        }
        assertEq(desk.pool(), 1 ether);
        assertEq(desk.totalLost(), 0);
        assertEq(customer.balance, count * 0.1 ether, "and every customer payment came back");
        assertTrue(desk.agent(crowd[0]).barred);
        assertFalse(desk.agent(crowd[29]).barred, "the ones that drew nothing are not marked");
        _books();
    }

    // ---------- 7. take the bond out just before failing ----------

    function test_attack07_theBondCannotLeaveWhileAnythingIsOwed() public {
        _fund(1 ether);
        _bond(agentA, 0.05 ether);
        uint256 one = _lock(agentA, 0.1 ether, false);
        uint256 two = _lock(agentA, 0.1 ether, false);
        _draw(agentA, one, 0.03 ether, FactorDesk.Kind.Pool);
        _draw(agentA, two, 0.02 ether, FactorDesk.Kind.Compute);

        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.OwesThePool.selector, 0.05 ether));
        desk.takeBond(1);

        // repaying one job does not free the bond while the other is still out
        _deliver(agentA, one);
        _accept(one);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.OwesThePool.selector, 0.02 ether));
        desk.takeBond(1);

        // not at the last moment either: past the due time, before anyone has called refund
        vm.warp(block.timestamp + PAST_DUE);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.OwesThePool.selector, 0.02 ether));
        desk.takeBond(0.05 ether);

        desk.refund(two);
        assertEq(desk.agent(agentA).bond, 0.03 ether, "the bond paid for the advance");
        assertEq(desk.totalLost(), 0);
        vm.prank(agentA);
        desk.takeBond(0.03 ether);
        _books();
    }

    // ---------- 8. spam an agent with dust jobs to stain its record ----------

    function test_attack08_jobsAnAgentNeverTouchedDoNotStainItsRecord() public {
        // an agent with a record worth staining
        uint256 first = _lock(agentA, 1 ether, false);
        _deliver(agentA, first);
        _accept(first);
        uint256 scoreBefore = desk.score(agentA);
        uint256 limitBefore = desk.limit(agentA);

        address spammer = makeAddr("spammer");
        vm.deal(spammer, 1 ether);
        vm.prank(spammer);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.TooSmall.selector, 0.001 ether));
        desk.lock{value: 0.0009 ether}(agentA, block.timestamp + 1 hours, true);

        uint256[] memory ids = new uint256[](40);
        for (uint256 i = 0; i < 40; ++i) {
            vm.prank(spammer);
            ids[i] = desk.lock{value: 0.001 ether}(agentA, block.timestamp + 1 hours, i % 2 == 0);
        }
        // the agent may decline one, and that leaves no mark either
        vm.prank(agentA);
        desk.decline(ids[0]);
        // the rest it ignores, and they come back to the spammer by themselves
        vm.warp(block.timestamp + 13 hours + 1);
        for (uint256 i = 1; i < 40; ++i) {
            desk.refund(ids[i]);
        }

        FactorDesk.Agent memory a = desk.agent(agentA);
        assertEq(a.notDelivered, 0, "not one mark");
        assertEq(a.unanswered, 39, "they are counted as what they are");
        assertFalse(a.barred);
        assertEq(a.settledAtHalf, 0);
        assertEq(desk.score(agentA), scoreBefore, "the score has not moved");
        assertEq(desk.limit(agentA), limitBefore);
        assertEq(spammer.balance, 1 ether, "and the spammer spent only gas");
        _books();
    }

    // ---------- 9. a wallet that refuses ETH, to block a payout ----------

    function test_attack09_aRefusingWalletBlocksNobodyElse() public {
        _fund(1 ether);
        Hostile shy = new Hostile();
        shy.set(true, "");
        vm.prank(address(shy));
        desk.register();
        _bond(address(shy), 0.05 ether);

        // as an agent: its own draw and its own settlement go through, and the pool is repaid
        uint256 id = _lock(address(shy), 0.1 ether, true);
        vm.startPrank(address(shy));
        desk.draw(id, 0.03 ether, FactorDesk.Kind.Pool);
        desk.draw(id, 0.02 ether, FactorDesk.Kind.Early);
        vm.stopPrank();
        assertEq(desk.owed(address(shy)), 0.0495 ether, "both advances wait for it, less their fees");
        _deliver(address(shy), id);
        _accept(id);
        assertEq(desk.pool(), 1 ether + 0.002 ether);
        assertEq(desk.out(), 0);
        assertEq(desk.owed(address(shy)), 0.0495 ether + 0.1 ether - 0.05 ether - 0.002 ether);

        // as a customer: a rejection still pays the agent, a refund still clears the job
        uint256 rejected = _lockFrom(address(shy), agentA, 1 ether, false);
        uint256 silent = _lockFrom(address(shy), agentB, 1 ether, false);
        _deliver(agentA, rejected);
        vm.prank(address(shy));
        desk.reject(rejected);
        assertEq(agentA.balance, 0.49 ether, "the agent has its side");
        _refundLate(silent);
        assertEq(desk.held(), 0);

        // and meanwhile everybody else's jobs run as if it were not there
        uint256 normal = _lock(agentB, 1 ether, false);
        _deliver(agentB, normal);
        _accept(normal);
        assertEq(agentB.balance, 0.98 ether);
        _books();

        // its money is all there when it stops refusing
        uint256 waiting = desk.owed(address(shy));
        assertEq(waiting, 0.0975 ether + 0.5 ether + 1 ether);
        shy.set(false, "");
        desk.collect(address(shy));
        assertEq(address(shy).balance, waiting);
        assertEq(desk.owedTotal(), 0);
        _books();
    }

    /// The compute gateway is a fixed address. If it ever refused ETH, compute advances would wait for it and
    /// nothing else would stop.
    function test_attack09_aGatewayThatRefusesDoesNotStopADraw() public {
        Hostile shyGateway = new Hostile();
        shyGateway.set(true, "");
        FactorDesk d = new FactorDesk(address(burnPot), address(shyGateway));
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(d).call{value: 1 ether}("");
        assertTrue(ok);
        vm.deal(agentA, 0.05 ether);
        vm.startPrank(agentA);
        d.register();
        d.addBond{value: 0.05 ether}();
        vm.stopPrank();
        vm.deal(customer, 0.1 ether);
        vm.prank(customer);
        uint256 id = d.lock{value: 0.1 ether}(agentA, block.timestamp + 1 days, false);
        vm.prank(agentA);
        d.draw(id, 0.05 ether, FactorDesk.Kind.Compute);
        assertEq(d.owed(address(shyGateway)), 0.0495 ether);
        assertEq(uint8(d.job(id).state), uint8(FactorDesk.State.Advanced));
        assertEq(address(d).balance, d.pool() + d.held() + d.bonds() + d.owedTotal());
    }

    // ---------- 10. call a function in the middle of another one ----------

    /// A customer wallet that calls back while it is being refunded: to be refunded twice, to accept another job
    /// in mid-flight, to collect. None of it gets in.
    function test_attack10_aCustomerCannotReenter() public {
        Hostile h = new Hostile();
        uint256 a = _lockFrom(address(h), agentA, 1 ether, false);
        uint256 b = _lockFrom(address(h), agentA, 1 ether, false);
        uint256 c = _lockFrom(address(h), agentA, 1 ether, false);
        _deliver(agentA, b);

        // declined: paid back, it tries to accept its other job in the middle
        h.set(false, abi.encodeCall(FactorDesk.accept, (b)));
        vm.prank(agentA);
        desk.decline(a);
        assertEq(h.tries(), 1, "it did try");
        assertEq(h.wins(), 0);
        assertEq(uint8(desk.job(b).state), uint8(FactorDesk.State.Delivered));
        assertEq(address(h).balance, 1 ether);

        // rejected: paid its half, it tries to reject the same job again
        h.set(false, abi.encodeCall(FactorDesk.reject, (b)));
        vm.prank(address(h));
        desk.reject(b);
        assertEq(h.tries(), 2);
        assertEq(h.wins(), 0);
        assertEq(address(h).balance, 1.5 ether, "half, once");

        // refunded: it tries to be refunded a second time
        h.set(false, abi.encodeCall(FactorDesk.refund, (c)));
        _refundLate(c);
        assertEq(h.tries(), 3);
        assertEq(h.wins(), 0);
        assertEq(address(h).balance, 2.5 ether, "refunded once");
        assertEq(desk.held(), 0);
        _books();
    }

    /// The one payout that hands over all the gas is collect(). A wallet that calls collect() again from inside
    /// it is paid once.
    function test_attack10_collectPaysOnce() public {
        Hostile h = new Hostile();
        h.set(true, "");
        uint256 id = _lockFrom(address(h), agentA, 1 ether, false);
        vm.prank(agentA);
        desk.decline(id);
        assertEq(desk.owed(address(h)), 1 ether);
        // a second job's money sits in the desk, to be stolen if a double payout were possible
        _lock(agentA, 1 ether, false);

        h.set(false, abi.encodeCall(FactorDesk.collect, (address(h))));
        desk.collect(address(h));
        assertEq(h.tries(), 1);
        assertEq(h.wins(), 0);
        assertEq(address(h).balance, 1 ether, "once");
        assertEq(desk.held(), 1 ether, "the other job's money is untouched");
        _books();
    }

    function test_attack10_anAgentCannotReenter() public {
        _fund(1 ether);
        Hostile h = new Hostile();
        vm.prank(address(h));
        desk.register();
        _bond(address(h), 0.5 ether);
        uint256 a = _lock(address(h), 1 ether, true);
        uint256 b = _lock(address(h), 1 ether, true);

        // paid an advance, it tries to draw the pool's limit a second time on the other job
        h.set(false, abi.encodeCall(FactorDesk.draw, (b, 0.4 ether, FactorDesk.Kind.Pool)));
        vm.prank(address(h));
        desk.draw(a, 0.4 ether, FactorDesk.Kind.Pool);
        assertEq(h.tries(), 1);
        assertEq(h.wins(), 0);
        assertEq(desk.out(), 0.4 ether, "one advance");

        // paid for a settled job, it tries to take its bond while the other job could still be drawn on
        _deliver(address(h), a);
        h.set(false, abi.encodeCall(FactorDesk.takeBond, (0.5 ether)));
        _accept(a);
        assertEq(h.tries(), 2);
        assertEq(h.wins(), 0);
        assertEq(desk.agent(address(h)).bond, 0.5 ether);

        // paid its bond back, it tries to take the same bond again
        h.set(false, abi.encodeCall(FactorDesk.takeBond, (0.25 ether)));
        vm.prank(address(h));
        desk.takeBond(0.25 ether);
        assertEq(h.tries(), 3);
        assertEq(h.wins(), 0);
        assertEq(desk.agent(address(h)).bond, 0.25 ether, "taken once");
        _books();
    }

    // ---------- 11. race the deadline ----------

    /// At any moment in a job's life exactly one of the two is possible: the agent delivers, or the job is
    /// refunded. The line between them is the due time plus the 12 hours of grace, and whichever is in the block
    /// first stands.
    function testFuzz_attack11_exactlyOneOfDeliverAndRefundIsPossibleAtAnyMoment(uint32 after_) public {
        _fund(1 ether);
        _bond(agentA, 0.5 ether);
        uint256 id = _lock(agentA, 1 ether, false); // due in a day
        _draw(agentA, id, 0.2 ether, FactorDesk.Kind.Pool);
        uint256 dt = bound(after_, 0, 4 days);
        vm.warp(block.timestamp + dt);

        uint256 snap = vm.snapshotState();
        vm.prank(agentA);
        (bool canDeliver,) = address(desk).call(abi.encodeCall(FactorDesk.deliver, (id, keccak256("the work"))));
        vm.revertToState(snap);
        (bool canRefund,) = address(desk).call(abi.encodeCall(FactorDesk.refund, (id)));
        vm.revertToState(snap);

        assertTrue(canDeliver != canRefund, "never both, never neither");
        assertEq(canDeliver, dt <= 1 days + 12 hours, "a delivery is valid through the grace, a refund only after");

        if (canDeliver) {
            _deliver(agentA, id);
            vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Delivered));
            desk.refund(id);
        } else {
            desk.refund(id);
            vm.prank(agentA);
            vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Refunded));
            desk.deliver(id, keccak256("too late"));
        }
        _books();
    }

    /// The same at the other deadline: within the customer's 24 hours only the customer decides; from then on
    /// anyone settles and the customer can no longer reject.
    function testFuzz_attack11_theCustomerRejectsOrAnyoneSettlesNeverBoth(uint32 after_) public {
        uint256 id = _lock(agentA, 1 ether, false);
        _deliver(agentA, id);
        uint256 dt = bound(after_, 0, 3 days);
        vm.warp(block.timestamp + dt);

        uint256 snap = vm.snapshotState();
        vm.prank(customer);
        (bool canReject,) = address(desk).call(abi.encodeCall(FactorDesk.reject, (id)));
        vm.revertToState(snap);
        vm.prank(stranger);
        (bool canSettle,) = address(desk).call(abi.encodeCall(FactorDesk.settle, (id)));
        vm.revertToState(snap);

        assertTrue(canReject != canSettle, "never both, never neither");
        assertEq(canReject, dt < 24 hours);
    }

    // ---------- 12. use job money to cover pool losses ----------

    /// The pool loses money while other customers' jobs are open. Every one of those payments is still there, to
    /// the wei, whatever happens to each job afterwards, and the desk never dips into one part to pay another.
    function test_attack12_aPoolLossNeverTouchesAnyJobsMoney() public {
        _fund(0.05 ether); // a small pool, so the loss is most of it
        address crook = makeAddr("crook");
        vm.prank(crook);
        desk.register();
        for (uint256 i = 0; i < 2; ++i) {
            uint256 own = _lockFrom(other, crook, 1 ether, false);
            _deliver(crook, own);
            vm.prank(other);
            desk.accept(own);
        }
        assertEq(desk.limit(crook), 0.04 ether);
        assertEq(desk.pool(), 0.09 ether);

        // five other jobs, in every open state
        address[5] memory who = [makeAddr("c1"), makeAddr("c2"), makeAddr("c3"), makeAddr("c4"), makeAddr("c5")];
        uint256[5] memory ids;
        for (uint256 i = 0; i < 5; ++i) {
            ids[i] = _lockFrom(who[i], agentB, 1 ether, i == 1 || i == 4);
        }
        _draw(agentB, ids[1], 0.3 ether, FactorDesk.Kind.Early);
        _deliver(agentB, ids[2]);
        _deliver(agentB, ids[3]);
        _draw(agentB, ids[4], 0.5 ether, FactorDesk.Kind.Early);
        uint256 jobsHold = 1 ether + 0.7 ether + 1 ether + 1 ether + 0.5 ether;

        // the crook takes the pool's money and goes
        uint256 bad = _lockFrom(other, crook, 1 ether, false);
        _draw(crook, bad, 0.04 ether, FactorDesk.Kind.Pool);
        _refundLate(bad);
        assertEq(desk.totalLost(), 0.04 ether);
        assertEq(desk.pool(), 0.05 ether);
        assertEq(desk.held(), jobsHold, "what the open jobs hold has not moved by a wei");
        assertEq(address(desk).balance - desk.pool() - desk.bonds(), jobsHold, "and it is really there");
        _books();

        // each job ends its own way and pays exactly what it should
        desk.refund(ids[0]);
        assertEq(who[0].balance, 1 ether, "a refund, whole");
        desk.refund(ids[1]);
        assertEq(who[1].balance, 0.7 ether, "a refund, less the early advance its customer allowed");
        uint256 before = agentB.balance;
        vm.prank(who[2]);
        desk.accept(ids[2]);
        assertEq(agentB.balance - before, 0.98 ether, "a settlement, whole");
        before = agentB.balance;
        desk.settle(ids[3]);
        assertEq(agentB.balance - before, 0.98 ether);
        desk.refund(ids[4]);
        assertEq(who[4].balance, 0.5 ether);

        assertEq(desk.held(), 0);
        assertEq(desk.pool(), 0.05 ether + 0.04 ether, "the pool is its own money and the two job fees, nothing else");
        _books();
    }
}
