// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VerifierBase} from "./VerifierBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine} from "../../src/FactorLine.sol";
import {FactorVerifiers} from "../../src/FactorVerifiers.sol";

/// Every rule of docs/VERIFIERS.md, one by one, with the examples to the wei.
contract VerifierTest is VerifierBase {
    // ---------- deployment ----------

    function test_readsTheDesk() public view {
        assertEq(address(vf.desk()), address(desk));
        assertEq(address(vf.line()), address(line));
        assertEq(vf.review(), desk.REVIEW());
        assertLe(vf.REVEAL_END() + vf.CUSTOMER_TIME(), desk.REVIEW());
        assertEq(vf.caseCount(), 0);
    }

    function test_refusesNoDeskOrALineOfAnotherDesk() public {
        vm.expectRevert(FactorVerifiers.ZeroAddress.selector);
        new FactorVerifiers(FactorDesk(payable(address(0))), line);
        vm.expectRevert(FactorVerifiers.ZeroAddress.selector);
        new FactorVerifiers(desk, FactorLine(payable(address(0))));
        FactorDesk other_ = new FactorDesk(address(0xB0), address(0xB1));
        vm.expectRevert(FactorVerifiers.DeskRules.selector);
        new FactorVerifiers(other_, line);
    }

    function test_plainEthIsRefused() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(vf).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ---------- verifiers ----------

    function test_join() public view {
        FactorVerifiers.Verifier memory v = vf.verifier(claude);
        assertEq(v.maker, ANTHROPIC);
        assertEq(v.free, BOND);
        assertGt(v.since, 0);
        assertLt(v.since, vf.verifier(gemini).since, "an earlier join is an older standing");
        assertEq(vf.bonds(), 5 * BOND);
        _vbooks();
    }

    function test_joinRefusals() public {
        address x = makeAddr("x");
        vm.deal(x, 1 ether);
        uint256 min = vf.MIN_BOND();
        vm.startPrank(x);
        vm.expectRevert(FactorVerifiers.BadMaker.selector);
        vf.join{value: BOND}(0);
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.TooSmall.selector, min));
        vf.join{value: min - 1}(1);
        vf.join{value: min}(7);
        vm.expectRevert(FactorVerifiers.AlreadyJoined.selector);
        vf.join{value: BOND}(7);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(FactorVerifiers.NotVerifier.selector);
        vf.addBond{value: 0}();
    }

    function test_addBondAndWithdraw() public {
        vm.deal(claude, 1 ether);
        vm.prank(claude);
        vf.addBond{value: 0.02 ether}();
        assertEq(_free(claude), BOND + 0.02 ether);
        uint256 before = claude.balance;
        vm.prank(claude);
        vf.withdraw(0.03 ether);
        assertEq(claude.balance - before, 0.03 ether);
        assertEq(_free(claude), BOND - 0.01 ether);
        vm.prank(claude);
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.OverFree.selector, BOND - 0.01 ether));
        vf.withdraw(BOND);
        vm.prank(claude);
        vm.expectRevert(FactorVerifiers.ZeroAmount.selector);
        vf.withdraw(0);
        _vbooks();
    }

    function test_standingIsLostUnderTheMinimumAndStartsAgain() public {
        uint40 was = vf.verifier(claude).since;
        uint256 amount = BOND - vf.MIN_BOND() + 1;
        vm.prank(claude);
        vf.withdraw(amount);
        assertEq(vf.verifier(claude).since, 0, "under the minimum: no standing");
        vm.warp(block.timestamp + 3 days);
        vm.deal(claude, 1 ether);
        vm.prank(claude);
        vf.addBond{value: 1}();
        uint40 now_ = vf.verifier(claude).since;
        assertEq(now_, block.timestamp, "a new standing, from now");
        assertGt(now_, was);
    }

    function test_setMakerStartsTheStandingAgain() public {
        vm.prank(claude);
        vf.setMaker(9);
        assertEq(vf.verifier(claude).maker, 9);
        assertEq(vf.verifier(claude).since, block.timestamp);
        vm.prank(claude);
        vm.expectRevert(FactorVerifiers.BadMaker.selector);
        vf.setMaker(0);
        vm.prank(stranger);
        vm.expectRevert(FactorVerifiers.NotVerifier.selector);
        vf.setMaker(1);
    }

    function test_setMakerRefusedWithAnOpenSeat() public {
        _checked(true);
        vm.prank(claude);
        vm.expectRevert(FactorVerifiers.HasOpenSeats.selector);
        vf.setMaker(2);
    }

    // ---------- hiring ----------

    function test_hireLocksOnTheDesk() public {
        uint256 id = _hire();
        FactorVerifiers.Case memory c = vf.getCase(id);
        assertEq(c.customer, hirer);
        assertEq(c.agent, agentA);
        assertEq(c.price, PRICE);
        assertEq(c.fee, FEE);
        assertEq(c.stake, 0.002 ether, "20% of the price");
        assertEq(c.disputeBond, 0.001 ether, "10% of the price");
        assertEq(c.terms, TERMS);
        assertEq(uint8(c.state), uint8(FactorVerifiers.State.Working));
        FactorDesk.Job memory j = desk.job(c.job);
        assertEq(j.customer, address(vf), "the contract is the desk's customer");
        assertEq(j.agent, agentA);
        assertEq(j.price, PRICE);
        assertEq(vf.caseOfJob(c.job), id);
        assertEq(vf.fees(), FEE);
        assertEq(vf.atDesk(), PRICE);
        _vbooks();
    }

    function test_smallJobsStakeAndDisputeTheMinimum() public {
        uint256 id = _hire(hirer, agentA, 0.001 ether, 0.0001 ether);
        assertEq(vf.getCase(id).stake, 0.001 ether);
        assertEq(vf.getCase(id).disputeBond, 0.0005 ether);
        assertEq(vf.stakeOf(1 ether), 0.2 ether);
        assertEq(vf.disputeBondOf(1 ether), 0.1 ether);
    }

    function test_hireRefusals() public {
        vm.deal(hirer, 1 ether);
        vm.startPrank(hirer);
        vm.expectRevert(FactorVerifiers.NoTerms.selector);
        vf.hire{value: PRICE + FEE}(agentA, block.timestamp + 1 days, false, FEE, bytes32(0));
        vm.expectRevert(FactorVerifiers.BadFee.selector);
        vf.hire{value: PRICE + 1}(agentA, block.timestamp + 1 days, false, 1, TERMS);
        vm.expectRevert(FactorVerifiers.BadFee.selector);
        vf.hire{value: 0.003 ether}(agentA, block.timestamp + 1 days, false, 0.002 ether, TERMS);
        vm.expectRevert(FactorVerifiers.BadFee.selector);
        vf.hire{value: FEE}(agentA, block.timestamp + 1 days, false, FEE, TERMS);
        vm.expectRevert(FactorDesk.NotRegistered.selector);
        vf.hire{value: PRICE + FEE}(stranger, block.timestamp + 1 days, false, FEE, TERMS);
        vm.expectRevert(FactorDesk.BadDueTime.selector);
        vf.hire{value: PRICE + FEE}(agentA, block.timestamp + 31 days, false, FEE, TERMS);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.TooSmall.selector, 0.001 ether));
        vf.hire{value: 0.0009 ether + 0.0001 ether}(agentA, block.timestamp + 1 days, false, 0.0001 ether, TERMS);
        vm.stopPrank();
    }

    // ---------- the first check ----------

    function test_checkLocksTheStake() public {
        uint256 id = _checked(true);
        FactorVerifiers.Case memory c = vf.getCase(id);
        assertEq(uint8(c.state), uint8(FactorVerifiers.State.Checked));
        assertEq(c.checker, claude);
        assertTrue(c.firstAccept);
        assertEq(c.reason, WHY);
        assertEq(_locked(claude), 0.002 ether);
        assertEq(_free(claude), BOND - 0.002 ether);
        assertEq(vf.verifier(claude).checks, 1);
        assertEq(vf.verifier(claude).open, 1);
        _vbooks();
        _verifierBooks();
    }

    function test_checkRefusals() public {
        uint256 id = _hire();
        vm.prank(claude);
        vm.expectRevert(FactorVerifiers.NotDelivered.selector);
        vf.check(id, true, WHY);
        _deliverCase(id);
        vm.prank(stranger);
        vm.expectRevert(FactorVerifiers.NotVerifier.selector);
        vf.check(id, true, WHY);
        _check(id, claude, true);
        vm.prank(gemini);
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.WrongState.selector, FactorVerifiers.State.Checked));
        vf.check(id, false, WHY);
    }

    function test_checkTooLate() public {
        uint256 id = _hire();
        _deliverCase(id);
        vm.warp(_delivered(id) + vf.CHECK_TIME());
        vm.prank(claude);
        vm.expectRevert(FactorVerifiers.TooLate.selector);
        vf.check(id, true, WHY);
    }

    function test_checkNeedsTheStakeFree() public {
        uint256 id = _hire(hirer, agentA, 0.3 ether, FEE);
        _deliverCase(id);
        vm.prank(claude);
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.BondShort.selector, 0.06 ether));
        vf.check(id, true, WHY);
    }

    // ---------- a first verdict, undisputed ----------

    function test_acceptStands_theAgentIsPaidInFull() public {
        uint256 id = _checked(true);
        vm.warp(block.timestamp + vf.DISPUTE_TIME() - 1);
        vm.expectRevert();
        vf.step(id);
        vm.warp(block.timestamp + 1);
        uint256 a = agentA.balance;
        vf.step(id);
        assertEq(agentA.balance - a, 0.0098 ether, "the price less the desk's 2%");
        FactorVerifiers.Case memory c = vf.getCase(id);
        assertEq(uint8(c.state), uint8(FactorVerifiers.State.Accepted));
        assertEq(uint8(c.how), uint8(FactorVerifiers.How.FirstCheck));
        assertEq(_free(claude), BOND + FEE, "the stake back, and the fee");
        assertEq(_locked(claude), 0);
        assertEq(vf.verifier(claude).right, 1);
        assertEq(vf.verifier(claude).earned, FEE);
        assertEq(desk.agent(agentA).settled, 1);
        assertEq(vf.atDesk(), 0);
        assertEq(vf.fees(), 0);
        _vbooks();
        _verifierBooks();
    }

    function test_rejectStands_theJobSettlesAtHalf() public {
        uint256 id = _checked(false);
        vm.warp(block.timestamp + vf.DISPUTE_TIME());
        uint256 h = hirer.balance;
        uint256 a = agentA.balance;
        vf.step(id);
        assertEq(hirer.balance - h, 0.005 ether, "half back to the customer");
        assertEq(agentA.balance - a, 0.0049 ether, "half to the agent, less 2% of it");
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Rejected));
        assertEq(uint8(vf.getCase(id).how), uint8(FactorVerifiers.How.FirstCheck));
        assertEq(_free(claude), BOND + FEE);
        assertEq(desk.agent(agentA).settledAtHalf, 1);
        _vbooks();
    }

    function test_theCustomerAcceptsAnAcceptAtOnce() public {
        uint256 id = _checked(true);
        vm.prank(hirer);
        vf.accept(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Accepted));
        assertEq(uint8(vf.getCase(id).how), uint8(FactorVerifiers.How.FirstCheck));
        assertEq(_free(claude), BOND + FEE);
        _vbooks();
    }

    function test_theCustomerMayAcceptOverAReject() public {
        uint256 id = _checked(false);
        vm.prank(hirer);
        vf.accept(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Accepted));
        assertEq(uint8(vf.getCase(id).how), uint8(FactorVerifiers.How.Customer));
        assertEq(_free(claude), BOND + FEE, "the checker did the work: it is paid");
        _vbooks();
    }

    function test_theAgentConcedesAReject() public {
        uint256 id = _checked(false);
        uint256 h = hirer.balance;
        vm.prank(agentA);
        vf.concede(id);
        assertEq(hirer.balance - h, 0.005 ether);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Rejected));
        _vbooks();
    }

    function test_concedeRefusals() public {
        uint256 id = _checked(true);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.WrongState.selector, FactorVerifiers.State.Checked));
        vf.concede(id);
        vm.prank(hirer);
        vm.expectRevert(FactorVerifiers.NotAgent.selector);
        vf.concede(id);
    }

    function test_theCustomerCannotRejectBeforeTheAgentMayDispute() public {
        uint256 id = _checked(false);
        vm.prank(hirer);
        vm.expectRevert();
        vf.reject(id);
        vm.warp(block.timestamp + vf.DISPUTE_TIME());
        vm.prank(hirer);
        vf.reject(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Rejected));
        assertEq(uint8(vf.getCase(id).how), uint8(FactorVerifiers.How.FirstCheck));
    }

    function test_theCustomerCannotRejectAnAccept() public {
        uint256 id = _checked(true);
        vm.warp(block.timestamp + vf.DISPUTE_TIME());
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.WrongState.selector, FactorVerifiers.State.Checked));
        vf.reject(id);
    }

    // ---------- nobody checks ----------

    function test_theCustomerAcceptsBeforeAnyCheck_theFeeComesBack() public {
        uint256 id = _hire();
        _deliverCase(id);
        uint256 h = hirer.balance;
        vm.prank(hirer);
        vf.accept(id);
        assertEq(hirer.balance - h, FEE);
        assertEq(uint8(vf.getCase(id).how), uint8(FactorVerifiers.How.Customer));
        _vbooks();
    }

    function test_acceptBeforeDeliveryIsRefusedByTheDesk() public {
        uint256 id = _hire();
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.WrongState.selector, FactorDesk.State.Locked));
        vf.accept(id);
    }

    function test_noCheck_theCustomerDecidesByTheDesksRule() public {
        uint256 id = _hire();
        _deliverCase(id);
        uint256 at = _delivered(id) + vf.CHECK_TIME();
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.TooSoon.selector, at));
        vf.reject(id);
        vm.warp(_delivered(id) + vf.CHECK_TIME());
        uint256 h = hirer.balance;
        vf.step(id);
        assertEq(hirer.balance - h, FEE, "the fee comes back");
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.CustomerDecides));
        vm.prank(hirer);
        vf.reject(id);
        assertEq(hirer.balance - h, FEE + 0.005 ether);
        assertEq(uint8(vf.getCase(id).how), uint8(FactorVerifiers.How.Customer));
        _vbooks();
    }

    function test_noCheck_theCustomerRejectsInOneCall() public {
        uint256 id = _hire();
        _deliverCase(id);
        vm.warp(_delivered(id) + vf.CHECK_TIME());
        uint256 h = hirer.balance;
        vm.prank(hirer);
        vf.reject(id);
        assertEq(hirer.balance - h, FEE + 0.005 ether);
        _vbooks();
    }

    function test_noCheck_silence_settlesOnTheDesksClock() public {
        uint256 id = _hire();
        _deliverCase(id);
        vm.warp(_delivered(id) + vf.CHECK_TIME());
        vf.step(id);
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.TooSoon.selector, _delivered(id) + 24 hours));
        vf.step(id);
        vm.warp(_delivered(id) + 24 hours);
        uint256 a = agentA.balance;
        vf.step(id);
        assertEq(agentA.balance - a, 0.0098 ether);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Accepted));
        assertEq(uint8(vf.getCase(id).how), uint8(FactorVerifiers.How.Clock));
        _vbooks();
    }

    function test_noCheck_aLateRejectIsRefusedByTheDesk() public {
        uint256 id = _hire();
        _deliverCase(id);
        vm.warp(_delivered(id) + 24 hours);
        vm.prank(hirer);
        vm.expectRevert(FactorDesk.TooLate.selector);
        vf.reject(id);
    }

    // ---------- not delivered ----------

    function test_notDelivered_paymentAndFeeComeBack() public {
        uint256 id = _hire();
        vm.expectRevert();
        vf.step(id);
        vm.warp(desk.job(_jobOf(id)).dueAt + desk.GRACE() + 1);
        uint256 h = hirer.balance;
        vf.step(id);
        assertEq(hirer.balance - h, PRICE + FEE);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Returned));
        assertEq(uint8(vf.getCase(id).how), uint8(FactorVerifiers.How.NotDelivered));
        _vbooks();
    }

    function test_notDelivered_afterAnEarlyDraw_theEarlyHalfIsTheCustomers() public {
        vm.deal(hirer, 1 ether);
        vm.prank(hirer);
        uint256 id = vf.hire{value: PRICE + FEE}(agentA, block.timestamp + 1 days, true, FEE, TERMS);
        uint256 job = _jobOf(id);
        vm.prank(agentA);
        desk.draw(job, 0.004 ether, FactorDesk.Kind.Early);
        vm.warp(desk.job(job).dueAt + desk.GRACE() + 1);
        uint256 h = hirer.balance;
        vf.step(id);
        assertEq(hirer.balance - h, PRICE - 0.004 ether + FEE, "the price less the early draw it allowed, and the fee");
        _vbooks();
    }

    function test_declined_paymentAndFeeComeBack() public {
        uint256 id = _hire();
        uint256 job = _jobOf(id);
        vm.prank(agentA);
        desk.decline(job);
        _vbooks(PRICE);
        uint256 h = hirer.balance;
        vf.step(id);
        assertEq(hirer.balance - h, PRICE + FEE);
        _vbooks();
    }

    function test_refundedOnTheDeskDirectly_isTakenUpByTheStep() public {
        uint256 id = _hire();
        vm.warp(desk.job(_jobOf(id)).dueAt + desk.GRACE() + 1);
        desk.refund(_jobOf(id));
        _vbooks(PRICE);
        uint256 h = hirer.balance;
        vf.step(id);
        assertEq(hirer.balance - h, PRICE + FEE);
        _vbooks();
    }

    // ---------- a dispute ----------

    function test_disputeRefusals() public {
        uint256 id = _checked(true);
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(FactorVerifiers.NotYourSide.selector);
        vf.dispute{value: 0.001 ether}(id);
        vm.deal(hirer, 1 ether);
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.WrongValue.selector, 0.001 ether));
        vf.dispute{value: 0.0009 ether}(id);
        vm.warp(block.timestamp + vf.DISPUTE_TIME());
        vm.prank(hirer);
        vm.expectRevert(FactorVerifiers.TooLate.selector);
        vf.dispute{value: 0.001 ether}(id);
    }

    function test_theAgentDisputesAReject() public {
        uint256 id = _checked(false);
        _dispute(id);
        FactorVerifiers.Case memory c = vf.getCase(id);
        assertEq(c.disputer, agentA);
        assertEq(uint8(c.state), uint8(FactorVerifiers.State.Disputed));
        assertEq(vf.disputes(), 0.001 ether);
        _vbooks();
    }

    function test_noAcceptWhileThePanelSits() public {
        uint256 id = _checked(false);
        _dispute(id);
        vm.prank(hirer);
        vm.expectRevert();
        vf.accept(id);
    }

    // ---------- the panel ----------

    /// The example in docs/VERIFIERS.md, section 5: Claude says accept, the customer disputes, Gemini and GPT say accept
    /// and Grok says reject. The pot is the fee 0.0003, the dispute bond 0.001 and half of Grok's stake 0.001: 0.0023,
    /// in three shares of 0.000766666666666666, with the 2 wei that do not divide to Claude.
    function test_panelUpholds_twoToOne() public {
        uint256 id = _checked(true);
        _dispute(id);
        _sit(id, gemini, true);
        _sit(id, gpt, true);
        _sit(id, grok, false);
        _toReveals(id);
        _reveal(id, gemini, true);
        _reveal(id, gpt, true);
        _reveal(id, grok, false);
        uint256 a = agentA.balance;
        uint256 h = hirer.balance;
        vf.step(id);
        assertEq(agentA.balance - a, 0.0098 ether, "the agent is paid in full");
        assertEq(hirer.balance, h, "the customer's bond is gone");
        assertEq(uint8(vf.getCase(id).how), uint8(FactorVerifiers.How.Panel));
        assertEq(_free(claude), BOND + 766666666666668);
        assertEq(_free(gemini), BOND + 766666666666666);
        assertEq(_free(gpt), BOND + 766666666666666);
        assertEq(_free(grok), BOND - 0.001 ether, "half its stake lost");
        assertEq(vf.verifier(grok).wrong, 1);
        assertEq(vf.verifier(gemini).right, 1);
        assertEq(vf.verifier(gemini).panels, 1);
        assertEq(vf.totalSlashed(), 0.001 ether);
        assertEq(vf.staked(), 0);
        _vbooks();
        _verifierBooks();
    }

    /// Claude says accept, the customer disputes, and the whole panel says reject. Claude loses half its stake; the
    /// pot (the fee and that half: 0.0013) is shared by the three; the customer has its dispute bond and its half back.
    function test_panelOverturns_threeToNothing() public {
        uint256 id = _checked(true);
        _dispute(id);
        _sit(id, gemini, false);
        _sit(id, gpt, false);
        _sit(id, grok, false);
        _toReveals(id);
        _reveal(id, gemini, false);
        _reveal(id, gpt, false);
        _reveal(id, grok, false);
        uint256 a = agentA.balance;
        uint256 h = hirer.balance;
        vf.step(id);
        assertEq(hirer.balance - h, 0.001 ether + 0.005 ether, "the dispute bond, and half");
        assertEq(agentA.balance - a, 0.0049 ether);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Rejected));
        assertEq(_free(claude), BOND - 0.001 ether);
        assertEq(vf.verifier(claude).wrong, 1);
        assertEq(_free(gemini), BOND + 433333333333334);
        assertEq(_free(gpt), BOND + 433333333333333);
        assertEq(_free(grok), BOND + 433333333333333);
        _vbooks();
        _verifierBooks();
    }

    function test_aTieKeepsTheFirstVerdict_andASilentSeatLosesItAll() public {
        uint256 id = _checked(false);
        _dispute(id);
        _sit(id, gemini, true);
        _sit(id, gpt, false);
        _sit(id, grok, true);
        _toReveals(id);
        _reveal(id, gemini, true);
        _reveal(id, gpt, false);
        _pastReveals(id);
        vf.step(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Rejected), "one to one: the first verdict stands");
        // pot: fee 0.0003 + bond 0.001 + Gemini's half 0.001 + Grok's whole 0.002 = 0.0043, to Claude and GPT
        assertEq(_free(claude), BOND + 0.00215 ether);
        assertEq(_free(gpt), BOND + 0.00215 ether);
        assertEq(_free(gemini), BOND - 0.001 ether);
        assertEq(_free(grok), BOND - 0.002 ether);
        assertEq(vf.verifier(grok).hidden, 1);
        _vbooks();
        _verifierBooks();
    }

    function test_noPanelRevealed_theCustomerDecides() public {
        uint256 id = _checked(true);
        _dispute(id);
        _sit(id, gemini, true);
        _pastReveals(id);
        vf.step(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.CustomerDecides));
        // Claude: its stake back, the fee, the dispute bond and Gemini's silent stake
        assertEq(_free(claude), BOND + FEE + 0.001 ether + 0.002 ether);
        assertEq(_free(gemini), BOND - 0.002 ether);
        uint256 h = hirer.balance;
        vm.prank(hirer);
        vf.reject(id);
        assertEq(hirer.balance - h, 0.005 ether);
        assertEq(uint8(vf.getCase(id).how), uint8(FactorVerifiers.How.Customer));
        _vbooks();
        _verifierBooks();
    }

    function test_noSeatAtAll_isNoPanel() public {
        uint256 id = _checked(true);
        _dispute(id);
        vm.warp(_delivered(id) + vf.SEAT_END());
        vf.step(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.CustomerDecides));
        assertEq(_free(claude), BOND + FEE + 0.001 ether);
        _vbooks();
    }

    function test_thePanelDecidesAsSoonAsEverySeatRevealed() public {
        uint256 id = _checked(true);
        _dispute(id);
        _sit(id, gemini, true);
        _sit(id, gpt, true);
        // nobody has revealed: the panel's time runs to its end, unless every seat reveals first
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.TooSoon.selector, _delivered(id) + vf.REVEAL_END()));
        vf.step(id);
        _toReveals(id);
        _reveal(id, gemini, true);
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.TooSoon.selector, _delivered(id) + vf.REVEAL_END()));
        vf.step(id);
        _reveal(id, gpt, true);
        vf.step(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Accepted));
    }

    function test_revealRefusals() public {
        uint256 id = _checked(true);
        _dispute(id);
        _sit(id, gemini, true);
        uint256 at = _delivered(id) + vf.SEAT_END();
        vm.prank(gemini);
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.TooSoon.selector, at));
        vf.reveal(id, true, WHY, _salt(gemini));
        _toReveals(id);
        vm.prank(gemini);
        vm.expectRevert(FactorVerifiers.BadReveal.selector);
        vf.reveal(id, false, WHY, _salt(gemini));
        vm.prank(gpt);
        vm.expectRevert(FactorVerifiers.NotSeated.selector);
        vf.reveal(id, true, WHY, _salt(gpt));
        _reveal(id, gemini, true);
        vm.prank(gemini);
        vm.expectRevert(FactorVerifiers.AlreadyRevealed.selector);
        vf.reveal(id, true, WHY, _salt(gemini));
        _pastReveals(id);
        vm.prank(gemini);
        vm.expectRevert(FactorVerifiers.TooLate.selector);
        vf.reveal(id, true, WHY, _salt(gemini));
    }

    function test_sitRefusals() public {
        uint256 id = _checked(true);
        vm.prank(gemini);
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.WrongState.selector, FactorVerifiers.State.Checked));
        vf.sit(id, keccak256("x"));
        _dispute(id);
        vm.prank(gemini);
        vm.expectRevert(FactorVerifiers.NoCommit.selector);
        vf.sit(id, bytes32(0));
        vm.prank(claude);
        vm.expectRevert(FactorVerifiers.Related.selector);
        vf.sit(id, keccak256("x"));
        _sit(id, gemini, true);
        vm.prank(gemini);
        vm.expectRevert(FactorVerifiers.AlreadySeated.selector);
        vf.sit(id, keccak256("x"));
        vm.warp(_delivered(id) + vf.SEAT_END());
        vm.prank(gpt);
        vm.expectRevert(FactorVerifiers.TooLate.selector);
        vf.sit(id, keccak256("x"));
    }

    function test_oneSeatPerMaker_anOlderStandingTakesIt() public {
        uint256 id = _checked(true);
        // Claude checked first, so the panel's Anthropic seat is open to Claude's newer twin only
        _dispute(id);
        address claude3 = makeAddr("a third verifier on Claude, newest");
        _join(claude3, ANTHROPIC);
        _sit(id, claude3, true);
        _sit(id, claude2, true); // older than claude3: takes its seat
        assertEq(vf.seats(id)[0].verifier, claude2);
        assertEq(_locked(claude3), 0, "the stake of the verifier moved out is free again");
        vm.prank(claude3);
        vm.expectRevert(FactorVerifiers.MakerTaken.selector);
        vf.sit(id, keccak256("x"));
        _vbooks();
    }

    function test_aFullPanel_anOlderStandingTakesTheNewestSeat() public {
        uint256 id = _checked(true);
        _dispute(id);
        address n1 = makeAddr("new on maker 7");
        address n2 = makeAddr("new on maker 8");
        address n3 = makeAddr("new on maker 9");
        _join(n1, 7);
        vm.warp(block.timestamp + 1);
        _join(n2, 8);
        vm.warp(block.timestamp + 1);
        _join(n3, 9);
        _sit(id, n1, true);
        _sit(id, n2, true);
        _sit(id, n3, true);
        address n4 = makeAddr("newest on maker 10");
        vm.warp(block.timestamp + 1);
        _join(n4, 10);
        vm.prank(n4);
        vm.expectRevert(FactorVerifiers.PanelFull.selector);
        vf.sit(id, keccak256("x"));
        _sit(id, gemini, false); // older than all three: takes the newest seat, n3's
        FactorVerifiers.Seat[3] memory s = vf.seats(id);
        assertEq(s[2].verifier, gemini);
        assertEq(_locked(n3), 0);
        _sit(id, gpt, false); // and then n2's
        assertEq(vf.seats(id)[1].verifier, gpt);
        _vbooks();
    }

    function test_strike() public {
        uint256 id = _checked(true);
        _dispute(id);
        _sit(id, gemini, true);
        _sit(id, gpt, true);
        vm.prank(agentA);
        vf.strike(id, gemini);
        assertTrue(vf.struck(id, gemini));
        assertEq(vf.seats(id)[0].verifier, address(0));
        assertEq(_locked(gemini), 0);
        assertEq(vf.verifier(gemini).struck, 1);
        vm.prank(agentA);
        vm.expectRevert(FactorVerifiers.StrikeUsed.selector);
        vf.strike(id, gpt);
        vm.prank(gemini);
        vm.expectRevert(FactorVerifiers.StruckOff.selector);
        vf.sit(id, keccak256("x"));
        vm.prank(stranger);
        vm.expectRevert(FactorVerifiers.NotYourSide.selector);
        vf.strike(id, gpt);
        vm.prank(hirer);
        vm.expectRevert(FactorVerifiers.NotSeated.selector);
        vf.strike(id, grok);
        _sit(id, grok, true); // the seat is open again
        vm.prank(hirer);
        vf.strike(id, gpt);
        vm.prank(hirer);
        vm.expectRevert(FactorVerifiers.StrikeUsed.selector);
        vf.strike(id, grok);
        _vbooks();
    }

    function test_strikeTooLate() public {
        uint256 id = _checked(true);
        _dispute(id);
        _sit(id, gemini, true);
        vm.warp(_delivered(id) + vf.SEAT_END());
        vm.prank(hirer);
        vm.expectRevert(FactorVerifiers.TooLate.selector);
        vf.strike(id, gemini);
    }

    function test_anEqualStandingDoesNotMoveASeat() public {
        uint256 id = _checked(true);
        _dispute(id);
        address t1 = makeAddr("twin on maker 7");
        address t2 = makeAddr("twin on maker 8");
        address t3 = makeAddr("twin on maker 9");
        address t4 = makeAddr("twin on maker 10, joined in the same second");
        _join(t1, 7);
        _join(t2, 8);
        _join(t3, 9);
        _join(t4, 10);
        _sit(id, t1, true);
        _sit(id, t2, true);
        _sit(id, t3, true);
        bytes32 commit = vf.commitOf(id, t4, true, WHY, _salt(t4));
        vm.prank(t4);
        vm.expectRevert(FactorVerifiers.PanelFull.selector);
        vf.sit(id, commit);
        address t5 = makeAddr("a second maker 7, joined in the same second");
        _join(t5, 7);
        commit = vf.commitOf(id, t5, true, WHY, _salt(t5));
        vm.prank(t5);
        vm.expectRevert(FactorVerifiers.MakerTaken.selector);
        vf.sit(id, commit);
    }

    // ---------- the desk's clock ----------

    function test_aRejectCarriedOutAfterTheDesks24Hours_settlesAsAccepted() public {
        uint256 id = _checked(false);
        vm.warp(_delivered(id) + 24 hours);
        uint256 a = agentA.balance;
        vf.step(id);
        assertEq(agentA.balance - a, 0.0098 ether);
        assertEq(uint8(vf.getCase(id).how), uint8(FactorVerifiers.How.Clock));
        assertEq(_free(claude), BOND + FEE, "the checker is paid all the same");
        _vbooks();
    }

    function test_settledOnTheDeskDirectly_isTakenUpByTheStep() public {
        uint256 id = _checked(false);
        _dispute(id);
        _sit(id, gemini, false);
        vm.warp(_delivered(id) + 24 hours);
        desk.settle(_jobOf(id));
        vf.step(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Accepted));
        assertEq(uint8(vf.getCase(id).how), uint8(FactorVerifiers.How.Clock));
        _vbooks();
        _verifierBooks();
    }

    function test_deadlines() public {
        uint256 id = _hire();
        (uint256 c0,,,,) = vf.deadlines(id);
        assertEq(c0, 0);
        _deliverCase(id);
        uint256 d = _delivered(id);
        _check(id, claude, true);
        (uint256 c, uint256 di, uint256 s, uint256 r, uint256 rv) = vf.deadlines(id);
        assertEq(c, d + 4 hours);
        assertEq(di, block.timestamp + 2 hours);
        assertEq(s, d + 14 hours);
        assertEq(r, d + 18 hours);
        assertEq(rv, d + 24 hours);
    }

    // ---------- money that is refused ----------

    function test_aCustomerThatRefusesEth_isOwed() public {
        RefusingCustomer rc = new RefusingCustomer();
        uint256 id = _hire(address(rc), agentA, PRICE, FEE);
        _deliverCase(id);
        _check(id, claude, false);
        vm.warp(block.timestamp + vf.DISPUTE_TIME());
        vf.step(id);
        assertEq(vf.owed(address(rc)), 0.005 ether);
        _vbooks();
        address to = makeAddr("where it goes");
        vm.prank(address(rc));
        vf.collectTo(payable(to));
        assertEq(to.balance, 0.005 ether);
        vm.expectRevert(FactorVerifiers.NothingOwed.selector);
        vf.collect(address(rc));
        _vbooks();
    }

    function test_theConstructorRefusesADeskWithAShortReview() public {
        ShortDesk d = new ShortDesk();
        ShortLine l = new ShortLine(address(d));
        vm.expectRevert(FactorVerifiers.DeskRules.selector);
        new FactorVerifiers(FactorDesk(payable(address(d))), FactorLine(payable(address(l))));
    }

    // ---------- fuzzed ----------

    /// Any price and fee, accepted or rejected by an undisputed first verdict: every wei is where it should be.
    function testFuzz_anyFirstVerdict(uint96 rawPrice, uint96 rawFee, bool accept) public {
        uint256 price = bound(uint256(rawPrice), 0.001 ether, 0.2 ether);
        uint256 fee = bound(uint256(rawFee), vf.MIN_FEE(), price);
        uint256 id = _hire(hirer, agentA, price, fee);
        _deliverCase(id);
        _check(id, claude, accept);
        vm.warp(block.timestamp + vf.DISPUTE_TIME());
        uint256 h = hirer.balance;
        vf.step(id);
        assertEq(hirer.balance - h, accept ? 0 : price / 2);
        assertEq(_free(claude), BOND + fee);
        _vbooks();
        _verifierBooks();
    }

    /// Any price and fee, and any panel of three votes: the pot is shared out to the wei and the books hold.
    function testFuzz_anyPanel(uint96 rawPrice, uint96 rawFee, bool first, bool a, bool b, bool c, bool hideC) public {
        uint256 price = bound(uint256(rawPrice), 0.001 ether, 0.2 ether);
        uint256 fee = bound(uint256(rawFee), vf.MIN_FEE(), price);
        uint256 id = _hire(hirer, agentA, price, fee);
        _deliverCase(id);
        _check(id, claude, first);
        _dispute(id);
        _sit(id, gemini, a);
        _sit(id, gpt, b);
        _sit(id, grok, c);
        _toReveals(id);
        _reveal(id, gemini, a);
        _reveal(id, gpt, b);
        if (!hideC) _reveal(id, grok, c);
        uint256 before = _free(claude) + _free(gemini) + _free(gpt) + _free(grok) + _locked(claude) + _locked(gemini)
            + _locked(gpt) + _locked(grok);
        _pastReveals(id);
        vf.step(id);
        uint256 afterAll = _free(claude) + _free(gemini) + _free(gpt) + _free(grok);
        // what the verifiers hold now is what they held, plus the fee, plus the dispute bond unless the dispute won
        bool rejected = vf.getCase(id).state == FactorVerifiers.State.Rejected;
        bool won = rejected == first;
        assertEq(afterAll, before + fee + (won ? 0 : vf.disputeBondOf(price)), "the pot is shared to the wei");
        assertEq(vf.staked(), 0);
        _vbooks();
        _verifierBooks();
    }
}

/// A customer whose wallet refuses ETH.
contract RefusingCustomer {
    receive() external payable {
        revert("no");
    }
}

/// A desk whose time to answer a delivery is too short for a panel.
contract ShortDesk {
    function REVIEW() external pure returns (uint256) {
        return 23 hours;
    }
}

/// A line contract wired to that desk.
contract ShortLine {
    address public desk;

    constructor(address d) {
        desk = d;
    }
}
