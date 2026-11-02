// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BountyBase} from "./BountyBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorBounty} from "../../src/FactorBounty.sol";
import {Rejecter, GasEater, Reenterer, ForceSend} from "../mocks/Actors.sol";

/// Every attack in section 9 of docs/BOUNTIES.md, carried out against the bounty contract and the desk together.
/// A wallet that refuses ETH until it is armed, then takes it and calls back in with all the gas it has.
contract Flipper {
    bytes public armed;
    bool public reentered;
    bool public succeeded;

    function arm(bytes calldata data) external {
        armed = data;
    }

    receive() external payable {
        if (armed.length == 0) revert("no");
        reentered = true;
        (bool ok,) = msg.sender.call(armed);
        succeeded = ok;
    }
}

contract BountyAttacksTest is BountyBase {
    address internal attacker = makeAddr("attacker");
    address internal fake = makeAddr("the poster's fake wallet");

    function setUp() public override {
        super.setUp();
        vm.prank(attacker);
        desk.register();
        vm.prank(fake);
        desk.register();
    }

    /// 1. The free-work attack: the poster picks its own fake wallet. It cannot be told apart on the chain, so it works,
    ///    and this test records what it costs and what is left in the open: the 1% and the 2% are gone, the others have
    ///    their bonds, and every entrant is still there to be read beside the winner.
    function test_attack1_freeWork_itWorksAndCostsThreePercent() public {
        uint256 id = _post();
        _enter(id, agentA);
        _enter(id, fake);
        _toDeadline(id);
        uint256 start = poster.balance + fake.balance;
        uint256 pot = address(burnPot).balance;
        uint256 job = _pick(id, fake);
        b.returnBonds(id);
        _deliverProof(fake, job, b.entryOf(id, fake).hash);
        b.close(id);
        // the two wallets together have the prize back less the desk's 2%, and the fake's bond
        assertEq(poster.balance + fake.balance - start, 0.0049 ether + BOND, "98% of the prize comes back to the same hand");
        assertEq(address(burnPot).balance - pot, FEE, "the 1% is gone");
        assertEq(agentA.balance, BOND, "the honest entrant has only its bond");
        assertEq(b.entrants(id).length, 2, "every entrant stays on the chain beside the winner");
        // a minimum score keeps out a fresh fake wallet
        uint256 id2 = _post(poster, PRIZE, 1 days, 200);
        uint256 score = desk.score(fake);
        vm.deal(fake, 1 ether);
        vm.prank(fake);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.ScoreTooLow.selector, score, 200));
        b.enter{value: BOND}(id2, fake, keccak256("work"));
    }

    /// 2. Copying an entry by its hash: the hash has the agent's address in it, so the same hash under another agent
    ///    stands for nothing the copier can show. The contract does not need to refuse it; the win needs the hash the
    ///    copier committed, and a copied hash is a hash of somebody else's address.
    function test_attack2_copyingAHash_itCarriesTheOtherAgentsAddress() public {
        uint256 id = _post();
        bytes32 w = keccak256("the honest work");
        bytes32 h = b.entryHash(id, agentA, w);
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        b.enter{value: BOND}(id, agentA, h);
        // the copier sends the same hash: it stands, and can never be matched to a work under its own address
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        b.enter{value: BOND}(id, attacker, h);
        assertTrue(b.entryHash(id, attacker, w) != h, "the same work under its own address is another hash");
        assertEq(b.entryOf(id, attacker).hash, h);
    }

    /// 3. A poster who is also an entrant copies: nothing can be entered once the poster can read, because entries end at
    ///    the moment reading begins.
    function test_attack3_aSecondWalletCannotEnterOnceThePosterCanRead() public {
        uint256 id = _post();
        _enter(id, agentA);
        uint256 d = b.bounty(id).deadline;
        vm.warp(d);
        vm.deal(fake, 1 ether);
        vm.prank(fake);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.TooLate.selector, d));
        b.enter{value: BOND}(id, fake, keccak256("the copy"));
    }

    /// 4. Junk filling the 25 slots: it is possible, with bonds that come back, and this test says so plainly. A minimum
    ///    score is the answer.
    function test_attack4_junkFill_possibleAtNoScore_stoppedByAMinimumScore() public {
        uint256 id = _post();
        for (uint256 i = 0; i < 25; ++i) {
            address a = makeAddr(string.concat("junk ", vm.toString(i)));
            vm.prank(a);
            desk.register();
            _enter(id, a);
        }
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(FactorBounty.Full.selector);
        b.enter{value: BOND}(id, agentA, keccak256("honest"));
        // the same wallets cannot enter a bounty that asks for a score
        uint256 id2 = _post(poster, PRIZE, 1 days, 200);
        address j = makeAddr("junk 0");
        vm.deal(j, 1 ether);
        vm.prank(j);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.ScoreTooLow.selector, 0, 200));
        b.enter{value: BOND}(id2, j, keccak256("junk"));
    }

    /// 5. Entering after seeing the winner.
    function test_attack5_enteringAfterThePick() public {
        (uint256 id,) = _picked(agentA, _one(agentB));
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.WrongState.selector, FactorBounty.State.Picked));
        b.enter{value: BOND}(id, attacker, keccak256("late"));
    }

    /// 6. Double entry.
    function test_attack6_doubleEntry() public {
        uint256 id = _post();
        _enter(id, agentA);
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(FactorBounty.AlreadyIn.selector);
        b.enter{value: BOND}(id, agentA, keccak256("a second try"));
        assertEq(b.entrants(id).length, 1);
    }

    /// 7. The poster enters its own bounty, itself and through its line account.
    function test_attack7_thePosterCannotEnter() public {
        vm.prank(poster);
        desk.register();
        uint256 id = _post();
        vm.deal(poster, 1 ether);
        vm.prank(poster);
        vm.expectRevert(FactorBounty.OwnBounty.selector);
        b.enter{value: BOND}(id, poster, keccak256("mine"));
        _open(poster);
        address acct = line.accountOf(poster);
        vm.prank(poster);
        vm.expectRevert(FactorBounty.OwnBounty.selector);
        b.enter{value: BOND}(id, acct, keccak256("mine"));
    }

    /// 8. Re-entry from a poster, an entrant and a winner: every call back in fails, with the guard or for lack of gas,
    ///    and everybody else is paid.
    function test_attack8_reentry_fromAnEntrantInASplit() public {
        Reenterer r = new Reenterer();
        vm.prank(address(r));
        desk.register();
        uint256 id = _post();
        _enter(id, address(r));
        _enter(id, agentA);
        r.arm(abi.encodeCall(FactorBounty.close, (id)));
        _toSplit(id);
        uint256 before = agentA.balance;
        b.close(id);
        assertTrue(r.reentered(), "it did try");
        assertFalse(r.reentrySucceeded());
        assertEq(agentA.balance - before, PRIZE / 2 + BOND);
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Unpicked));
        _bbooks();
    }

    function test_attack8_reentry_collectInsideAPayout() public {
        Reenterer r = new Reenterer();
        vm.prank(address(r));
        desk.register();
        Rejecter other = new Rejecter();
        vm.prank(address(other));
        desk.register();
        uint256 id = _post();
        _enter(id, address(other));
        _enter(id, address(r));
        r.arm(abi.encodeCall(FactorBounty.collect, (address(other))));
        _toSplit(id);
        b.close(id);
        assertFalse(r.reentrySucceeded());
        assertEq(b.owed(address(other)), PRIZE / 2 + BOND, "what is owed is untouched");
        _bbooks();
    }

    function test_attack8_reentry_fromAPosterOnItsReturn() public {
        Reenterer r = new Reenterer();
        vm.deal(address(this), 1 ether);
        (bool ok, bytes memory out) = r.call{value: PRIZE + FEE}(
            address(b), abi.encodeCall(FactorBounty.post, (PRIZE, block.timestamp + 1 days, 0, TASK))
        );
        assertTrue(ok);
        uint256 id = abi.decode(out, (uint256));
        r.arm(abi.encodeCall(FactorBounty.close, (id)));
        _toDeadline(id);
        b.close(id);
        assertTrue(r.reentered());
        assertFalse(r.reentrySucceeded());
        assertEq(address(r).balance, PRIZE + FEE, "paid once");
        _bbooks();
    }

    /// The guard itself, apart from the gas limit: collect sends all the gas there is, so a receiver has plenty to call
    /// back in with, and the guard refuses it.
    function test_attack8_reentry_guardedAtFullGas() public {
        Flipper f = new Flipper();
        vm.prank(address(f));
        desk.register();
        Rejecter other = new Rejecter();
        vm.prank(address(other));
        desk.register();
        uint256 id = _post();
        _enter(id, address(f));
        _enter(id, address(other));
        _toSplit(id);
        b.close(id);
        uint256 owedF = b.owed(address(f));
        assertGt(owedF, 0);
        // the other wallet takes ETH now, so a collect for it in the middle of this one would go through, but for the guard
        other.setAccept(true);
        f.arm(abi.encodeCall(FactorBounty.collect, (address(other))));
        b.collect(address(f));
        assertTrue(f.reentered(), "it did try, with all the gas");
        assertFalse(f.succeeded(), "the guard refused it");
        assertEq(address(f).balance, owedF);
        assertEq(b.owed(address(other)), owedF, "what the other is owed is untouched");
        _bbooks();
    }

    /// 9. A barred agent, and a line account with a barred key or a defaulted line.
    function test_attack9_aBarredAgentCannotEnter() public {
        _barOnDesk(agentA);
        uint256 id = _post();
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(FactorBounty.Barred.selector);
        b.enter{value: BOND}(id, agentA, keccak256("work"));
    }

    function test_attack9_aLineAccountOfABarredKeyCannotEnter() public {
        _open(agentA);
        FactorLineAccount acct = _acct(agentA);
        _barOnDesk(agentA);
        uint256 id = _post();
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(FactorBounty.Barred.selector);
        b.enter{value: BOND}(id, address(acct), keccak256("work"));
        assertEq(b.scoreOf(address(acct)), 0);
    }

    function test_attack9_aLineThatDefaultedCannotEnter() public {
        _seed(1 ether);
        FactorLineAccount acct = _open(agentA);
        _earn(agentA, 1 ether);
        vm.prank(agentA);
        acct.withdraw(payable(agentA), 0.98 ether);
        _lineBond(agentA, 0.005 ether);
        _lineDraw(agentA, 0.025 ether, false);
        vm.warp(uint256(line.line(address(acct)).dueAt) + 30 days + 1);
        line.recover(address(acct));
        assertTrue(line.line(address(acct)).defaulted);
        uint256 id = _post();
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(FactorBounty.Barred.selector);
        b.enter{value: BOND}(id, address(acct), keccak256("work"));
        assertEq(b.scoreOf(address(acct)), 0);
    }

    function test_attack9_barredAfterEntering_itStaysAndCanBePaid() public {
        uint256 id = _post();
        _enter(id, agentA);
        _enter(id, agentB);
        _barOnDesk(agentA);
        vm.warp(b.bounty(id).deadline);
        uint256 job = _pick(id, agentA);
        assertEq(desk.job(job).agent, agentA, "the desk takes it");
    }

    /// 10. Entering for a line account from outside, and for another agent.
    function test_attack10_nobodyEntersForAnotherAgent() public {
        _open(agentA);
        address acct = line.accountOf(agentA);
        uint256 id = _post();
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        vm.expectRevert(FactorBounty.NotAgent.selector);
        b.enter{value: BOND}(id, acct, keccak256("for it"));
        vm.prank(attacker);
        vm.expectRevert(FactorBounty.NotAgent.selector);
        b.enter{value: BOND}(id, agentB, keccak256("for it"));
    }

    /// 11. An agent not registered on the desk.
    function test_attack11_notRegistered() public {
        uint256 id = _post();
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(FactorBounty.NotRegistered.selector);
        b.enter{value: BOND}(id, stranger, keccak256("work"));
    }

    /// 12. An entrant whose wallet refuses ETH, or eats all the gas, in a split of every kind. Everybody else is paid.
    function test_attack12_aWalletThatRefuses_inAnUnpickedSplit() public {
        Rejecter r = new Rejecter();
        vm.prank(address(r));
        desk.register();
        uint256 id = _post();
        _enter(id, address(r));
        _enter(id, agentA);
        _toSplit(id);
        b.close(id);
        assertEq(agentA.balance, PRIZE / 2 + BOND);
        assertEq(b.owed(address(r)), PRIZE / 2 + BOND);
        _bbooks();
    }

    function test_attack12_aWalletThatEatsGas_twentyFiveOfThem() public {
        uint256 id = _post();
        GasEater[] memory eaters = new GasEater[](24);
        for (uint256 i = 0; i < 24; ++i) {
            eaters[i] = new GasEater();
            vm.prank(address(eaters[i]));
            desk.register();
            _enter(id, address(eaters[i]));
        }
        _enter(id, agentA);
        _toSplit(id);
        uint256 gasBefore = gasleft();
        b.close{gas: 6_000_000}(id);
        uint256 used = gasBefore - gasleft();
        assertLt(used, 3_500_000, "bounded: 50,000 gas a wallet, and its entry in owed");
        assertEq(agentA.balance, PRIZE / 25 + BOND, "the honest entrant is paid");
        assertEq(b.owedTotal(), (PRIZE / 25 + BOND) * 24);
        _bbooks();
    }

    function test_attack12_aWinnerThatRefuses_theDeskKeepsItsOwnOwed() public {
        Rejecter r = new Rejecter();
        vm.prank(address(r));
        desk.register();
        uint256 id = _post();
        _enter(id, address(r));
        _enter(id, agentA);
        _toDeadline(id);
        uint256 job = _pick(id, address(r));
        bytes32 h = b.entryOf(id, address(r)).hash;
        vm.prank(address(r));
        desk.deliver(job, h);
        b.returnBonds(id);
        b.close(id);
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Won));
        assertEq(desk.owed(address(r)), 0.0049 ether, "the desk's own owed");
        assertEq(b.owed(address(r)), BOND);
        _bbooks();
    }

    function test_attack12_aBurnPotThatRefuses_isKeptAsOwed() public {
        // the burn pot's own receive takes ETH, so its address is made to refuse for this one call
        uint256 id = _post();
        _enter(id, agentA);
        _toDeadline(id);
        vm.mockCallRevert(address(burnPot), FEE, bytes(""), bytes("no"));
        _pick(id, agentA);
        vm.clearMockedCalls();
        assertEq(b.owed(address(burnPot)), FEE);
        _bbooks();
        b.collect(address(burnPot));
        assertEq(b.owed(address(burnPot)), 0);
    }

    /// 13. A prize below the desk's minimum after fees: the fee comes on top, and the job's price is the whole prize.
    function test_attack13_theDeskAlwaysTakesThePrize() public {
        uint256 id = _post(poster, 0.005 ether, 1 hours, 0);
        _enter(id, agentA);
        _toDeadline(id);
        uint256 job = _pick(id, agentA);
        assertEq(desk.job(job).price, 0.005 ether);
        assertGe(desk.job(job).price, desk.MIN_JOB());
    }

    /// 14. The winner never delivers, to hold everyone's money: the others' bonds at once, the rest after the grace, and
    ///     the winner pays for it with its bond.
    function test_attack14_theWinnerHoldsNothingHostage() public {
        (uint256 id, uint256 job) = _picked(attacker, _one(agentA));
        uint256 before = agentA.balance;
        b.returnBonds(id);
        assertEq(agentA.balance - before, BOND, "the bond at once");
        vm.warp(uint256(desk.job(job).dueAt) + 12 hours + 1);
        b.close(id);
        assertEq(agentA.balance - before, BOND + PRIZE + BOND, "the prize and the winner's bond");
        assertEq(attacker.balance, 0);
        _bbooks();
    }

    /// 15. The poster never picks: after 3 days anyone splits it.
    function test_attack15_thePosterCannotLockThePrizeForEver() public {
        uint256 id = _post();
        _enter(id, agentA);
        _toSplit(id);
        vm.prank(stranger);
        b.close(id);
        assertEq(agentA.balance, PRIZE + BOND);
    }

    /// 16. A hash of nothing still has its share if nobody is picked. Written down plainly; a poster who picks is safe.
    function test_attack16_aHashOfNothing_sharesOnlyIfNobodyIsPicked() public {
        uint256 id = _post();
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        b.enter{value: BOND}(id, attacker, keccak256("nothing behind it"));
        _enter(id, agentA);
        uint256 before = attacker.balance;
        _toDeadline(id);
        uint256 job = _pick(id, agentA);
        b.returnBonds(id);
        assertEq(attacker.balance - before, BOND, "only its bond when somebody else is picked");
        _deliverProof(agentA, job, b.entryOf(id, agentA).hash);
        b.close(id);
        assertEq(attacker.balance - before, BOND);
        // and when nobody is picked it has its share: the rule the poster agreed to
        uint256 id2 = _post();
        vm.prank(attacker);
        b.enter{value: BOND}(id2, attacker, keccak256("nothing behind it"));
        _enter(id2, agentB);
        before = attacker.balance;
        _toSplit(id2);
        b.close(id2);
        assertEq(attacker.balance - before, PRIZE / 2 + BOND);
    }

    /// 17. ETH forced in: it adds to nobody's claim, and plain ETH is refused from anybody but the desk.
    function test_attack17_forcedEthChangesNothing() public {
        uint256 id = _post();
        _enter(id, agentA);
        vm.deal(address(this), 1 ether);
        new ForceSend{value: 1 ether}(payable(address(b)));
        assertEq(address(b).balance, PRIZE + FEE + BOND + 1 ether);
        _toSplit(id);
        b.close(id);
        assertEq(agentA.balance, PRIZE + BOND, "exactly the claim");
        assertEq(address(b).balance, 1 ether, "the forced ETH is nobody's");
    }

    function test_attack17_plainEthIsRefused() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok, bytes memory out) = address(b).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(bytes4(out), FactorBounty.OnlyDesk.selector);
    }

    /// 18. A wrong proof does not get the job accepted, and the contract never rejects.
    function test_attack18_aWrongProofIsNotAccepted() public {
        (uint256 id, uint256 job) = _picked(attacker, _one(agentA));
        _deliverProof(attacker, job, b.entryOf(id, agentA).hash);
        vm.expectPartialRevert(FactorDesk.TooSoon.selector);
        b.close(id);
        assertEq(uint8(desk.job(job).state), uint8(FactorDesk.State.Delivered));
    }

    /// 19. A score bought through bounties costs more than one bought on the desk.
    function test_attack19_bountiesAreTheDearerWayToAScore() public {
        // the cheapest win: 1% + 2% of 0.005. The cheapest job on the desk: 2% of 0.001.
        uint256 bountyCost = b.feeFor(0.005 ether) + (0.005 ether * 200) / 10_000;
        uint256 deskCost = (0.001 ether * 200) / 10_000;
        assertEq(bountyCost, 0.00015 ether);
        assertEq(deskCost, 0.00002 ether);
        assertGt(bountyCost, deskCost);
    }

    /// Nobody but the desk can pay the contract back; the desk's own pay arrives within its 50,000 gas.
    function test_theDesksPushArrivesWithinItsGas() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        vm.prank(agentA);
        desk.decline(job);
        assertEq(desk.owed(address(b)), 0, "never in the desk's owed");
        b.close(id);
        _bbooks();
    }

    /// A winner that declines cannot be picked again, and nobody can pick for the poster in between.
    function test_aDeclineEndsThePick() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        vm.prank(agentA);
        desk.decline(job);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.WrongState.selector, FactorBounty.State.Picked));
        b.pick(id, agentB);
    }

    /// Delivering for the winner, from anybody else, is the desk's own refusal.
    function test_nobodyDeliversForTheWinner() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        bytes32 h = b.entryOf(id, agentA).hash;
        vm.prank(attacker);
        vm.expectRevert(FactorDesk.NotAgent.selector);
        desk.deliver(job, h);
    }

    /// Nobody can accept or reject for the contract on the desk.
    function test_nobodyAnswersForTheContract() public {
        (uint256 id, uint256 job) = _picked(agentA, _one(agentB));
        _deliverProof(agentA, job, b.entryOf(id, agentA).hash);
        vm.prank(poster);
        vm.expectRevert(FactorDesk.NotCustomer.selector);
        desk.reject(job);
        vm.prank(poster);
        vm.expectRevert(FactorDesk.NotCustomer.selector);
        desk.accept(job);
        b.close(id);
    }
}
