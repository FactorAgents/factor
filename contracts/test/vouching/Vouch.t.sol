// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VouchBase} from "./VouchBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorGuarantee} from "../../src/FactorGuarantee.sol";
import {FactorVouch} from "../../src/FactorVouch.sol";
import {Rejecter} from "../mocks/Actors.sol";

/// Every rule of docs/VOUCHING.md, one by one, with its examples to the wei.
contract VouchTest is VouchBase {
    // ---------- the newer agent's income, taken out so only its fees back its line ----------

    /// The newer agent is paid for a job at its line account (its fee counts toward its limit) and takes the payout
    /// out, so a default leaves exactly the fees' part unpaid.
    function _earnFree(uint256 price) internal {
        _earn(newKey, price);
        uint256 have = address(newAcct).balance;
        vm.prank(newKey);
        newAcct.withdraw(payable(newKey), have);
    }

    // ---------- the contract itself ----------

    function test_readsItsWiringAndHasNoOwner() public view {
        assertEq(address(vc.guarantee()), address(g));
        assertEq(address(vc.line()), address(line));
        assertEq(address(vc.desk()), address(desk));
        assertEq(vc.burnPot(), desk.burnPot());
        assertEq(vc.lineDue(), 30 days);
        assertEq(vc.lineDefaultAfter(), 30 days);
        assertEq(vc.grace(), 12 hours);
        assertEq(vc.review(), 24 hours);
        assertEq(vc.MIN_SCORE(), 300);
        assertEq(vc.MAX_SHARE_BPS(), 2500);
        assertEq(vc.FEE_BPS(), 200);
        assertEq(vc.VOUCHER_BPS(), 5000);
        assertEq(vc.MIN_VOUCH(), 0.0001 ether);
        assertEq(vc.LINE_TERM(), 30 days);
        assertEq(vc.OFFER_WINDOW(), 7 days);
        assertEq(vc.vouchCount(), 0);
    }

    function test_aGuaranteeContractIsNeeded() public {
        vm.expectRevert(FactorVouch.ZeroAddress.selector);
        new FactorVouch(FactorGuarantee(payable(address(0))));
    }

    function test_theGuaranteeContractMustReadALineContract() public {
        FactorGuarantee plain = new FactorGuarantee(desk, FactorLine(payable(address(0))));
        vm.expectRevert(FactorVouch.NoLineContract.selector);
        new FactorVouch(plain);
    }

    function test_takesNoPlainEth() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(vc).call{value: 1 ether}("");
        assertFalse(ok, "plain ETH is refused: every wei here is a bond, a fee or a payout");
    }

    // ---------- the bond ----------

    function test_anyoneBondsARegisteredAgent() public {
        vm.expectEmit(address(vc));
        emit FactorVouch.BondAdded(voucher, address(this), 0.1 ether, 0.1 ether);
        _vbond(voucher, 0.1 ether);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vc.addBond{value: 0.05 ether}(voucher);
        assertEq(vc.voucherOf(voucher).bond, 0.15 ether);
        assertEq(vc.bonds(), 0.15 ether);
        assertEq(vc.freeOf(voucher), 0.15 ether);
        _vbooks();
    }

    function test_aBondNeedsARegisteredAgentAndSomeEth() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert(FactorVouch.NotRegistered.selector);
        vc.addBond{value: 0.1 ether}(stranger);
        vm.expectRevert(FactorVouch.ZeroAmount.selector);
        vc.addBond{value: 0}(voucher);
    }

    function test_aKeyBondsAsItsLineAccount() public {
        _vbond(newKey, 0.1 ether);
        assertEq(vc.voucherOf(address(newAcct)).bond, 0.1 ether, "the key's bond is its line account's");
        assertEq(vc.voucherOf(newKey).bond, 0.1 ether, "read by either address");
        assertEq(vc.agentOf(newKey), address(newAcct));
        assertEq(vc.agentOf(address(newAcct)), address(newAcct));
        assertEq(vc.agentOf(voucher), voucher);
    }

    function test_onlyTheVoucherTakesItsBondAndItGoesToTheVoucher() public {
        _vbond(voucher, 0.1 ether);
        vm.prank(stranger);
        vm.expectRevert(FactorVouch.NotVoucher.selector);
        vc.takeBond(voucher, 0.01 ether);
        uint256 before = voucher.balance;
        vm.expectEmit(address(vc));
        emit FactorVouch.BondTaken(voucher, 0.04 ether, 0.06 ether);
        vm.prank(voucher);
        vc.takeBond(voucher, 0.04 ether);
        assertEq(voucher.balance - before, 0.04 ether);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.ZeroAmount.selector);
        vc.takeBond(voucher, 0);
        _vbooks();
    }

    function test_aLineKeyTakesItsAccountsBondToTheAccount() public {
        _vbond(newKey, 0.1 ether);
        vm.prank(newKey);
        vc.takeBond(newKey, 0.1 ether);
        assertEq(address(newAcct).balance, 0.1 ether, "to the line account, where the line is paid first");
        assertEq(newKey.balance, 0);
    }

    function test_onlyTheFreePartComesOut() public {
        _vbond(voucher, 0.04 ether);
        _offerLine(voucher, address(newAcct), 0.01 ether);
        assertEq(vc.freeOf(voucher), 0.03 ether);
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.OverFree.selector, 0.03 ether));
        vc.takeBond(voucher, 0.031 ether);
        vm.prank(voucher);
        vc.takeBond(voucher, 0.03 ether);
        assertEq(vc.voucherOf(voucher).bond, 0.01 ether, "what the vouch holds back stays");
        _vbooks();
    }

    // ---------- offering a vouch on a line ----------

    function test_offerALine() public {
        _vbond(voucher, 0.04 ether);
        vm.expectEmit(address(vc));
        emit FactorVouch.Offered(
            1, voucher, address(newAcct), FactorVouch.Kind.Line, uint256(uint160(address(newAcct))), 0.01 ether,
            0.0002 ether, block.timestamp + 7 days
        );
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        assertEq(id, 1);
        FactorVouch.Vouch memory v = vc.vouch(id);
        assertEq(v.voucher, voucher);
        assertEq(v.agent, address(newAcct));
        assertEq(uint8(v.kind), uint8(FactorVouch.Kind.Line));
        assertEq(uint8(v.state), uint8(FactorVouch.State.Offered));
        assertEq(v.subject, uint256(uint160(address(newAcct))));
        assertEq(v.amount, 0.01 ether);
        assertEq(v.fee, 0.0002 ether, "2% of the amount");
        assertEq(v.offeredAt, block.timestamp);
        assertEq(v.startedAt, 0);
        assertEq(v.debtAtOffer, 0);
        assertEq(vc.voucherOf(voucher).held, 0.01 ether);
        assertEq(vc.held(), 0.01 ether);
        assertEq(vc.heldOn(voucher, address(newAcct)), 0.01 ether);
        assertEq(vc.openOf(voucher, FactorVouch.Kind.Line, uint256(uint160(address(newAcct)))), id);
        assertEq(vc.feesHeld(), 0, "no fee until it is accepted");
        _vbooks();
    }

    function test_aWeakScoreCannotVouch() public {
        _score200(agentA);
        _vbond(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.ScoreTooLow.selector, 200, 300));
        vc.offerLine(agentA, address(newAcct), 0.01 ether);
        assertEq(vc.canVouch(agentA, address(newAcct)), 0);
    }

    function test_theScoreIsTheGuaranteeContractsReading() public {
        _vbond(agentA, 1 ether);
        _mockScore(agentA, 299);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.ScoreTooLow.selector, 299, 300));
        vc.offerLine(agentA, address(newAcct), 0.01 ether);
        _mockScore(agentA, 300);
        assertEq(vc.scoreOf(agentA), 300);
        vm.prank(agentA);
        vc.offerLine(agentA, address(newAcct), 0.01 ether);
    }

    function test_aLineAccountVouchesWithTheBetterOfItsTwoScores() public {
        // a strong agent opens its own line: its account starts at 0, its key keeps its record
        FactorLineAccount acct = _open(voucher);
        assertEq(desk.score(address(acct)), 0);
        assertEq(vc.scoreOf(voucher), g.scoreOf(address(acct)));
        assertGe(vc.scoreOf(address(acct)), 300, "the better of the account's and the key's");
        _vbond(voucher, 0.04 ether);
        vm.prank(voucher);
        uint256 id = vc.offerLine(voucher, address(newAcct), 0.01 ether);
        assertEq(vc.vouch(id).voucher, address(acct), "the voucher is its line account");
    }

    function test_theSmallestVouch() public {
        _vbond(voucher, 1 ether);
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.TooSmall.selector, 0.0001 ether));
        vc.offerLine(voucher, address(newAcct), 0.0001 ether - 1);
        uint256 id = _offerLine(voucher, address(newAcct), 0.0001 ether);
        assertEq(vc.vouch(id).fee, 0.000002 ether);
    }

    function test_onlyTheVoucherOffers() public {
        _vbond(voucher, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(FactorVouch.NotVoucher.selector);
        vc.offerLine(voucher, address(newAcct), 0.01 ether);
        vm.prank(newKey);
        vm.expectRevert(FactorVouch.NotVoucher.selector);
        vc.offerLine(voucher, address(newAcct), 0.01 ether);
    }

    function test_aQuarterOfTheBondOnOneAgent() public {
        _vbond(voucher, 0.04 ether);
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.OverShare.selector, 0.01 ether));
        vc.offerLine(voucher, address(newAcct), 0.01 ether + 1);
        _offerLine(voucher, address(newAcct), 0.01 ether);
        assertEq(vc.canVouch(voucher, address(newAcct)), 0, "a quarter is held for it already");
        assertEq(vc.canVouch(voucher, agentA), 0.01 ether, "another agent has its own quarter");
    }

    function test_theQuarterCountsEveryVouchOnTheSameAgent() public {
        _ready(address(newAcct), 0.1 ether, 0.01 ether);
        _vbond(voucher, 0.04 ether);
        _offerLine(voucher, address(newAcct), 0.006 ether);
        (uint256 cover,) = _hire(buyer, address(newAcct), 0.04 ether, 0.01 ether, false);
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.OverShare.selector, 0.004 ether));
        vc.offerCover(voucher, cover, 0.005 ether);
        _offerCover(voucher, cover, 0.004 ether);
        assertEq(vc.heldOn(voucher, address(newAcct)), 0.01 ether);
    }

    function test_aVoucherCannotPromiseMoreThanItsFreeBond() public {
        _vbond(voucher, 0.04 ether);
        address[4] memory others = [agentA, agentB, makeAddr("agent c"), makeAddr("agent d")];
        for (uint256 i = 0; i < 4; ++i) {
            bool registered = desk.agent(others[i]).registered;
            if (!registered) {
                vm.prank(others[i]);
                desk.register();
            }
            vm.prank(others[i]);
            line.open();
            _offerLine(voucher, line.accountOf(others[i]), 0.01 ether);
        }
        assertEq(vc.freeOf(voucher), 0);
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.OverFree.selector, 0));
        vc.offerLine(voucher, address(newAcct), 0.0001 ether);
        // more bond: the share grows, but only the free part can be promised
        _vbond(voucher, 0.002 ether);
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.OverFree.selector, 0.002 ether));
        vc.offerLine(voucher, address(newAcct), 0.003 ether);
        assertEq(vc.canVouch(voucher, address(newAcct)), 0.002 ether);
    }

    function test_oneVouchPerLineAtATime() public {
        _vbond(voucher, 1 ether);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.AlreadyVouched.selector, id));
        vc.offerLine(voucher, address(newAcct), 0.01 ether);
        vm.prank(voucher);
        vc.withdraw(id);
        _offerLine(voucher, address(newAcct), 0.01 ether);
    }

    function test_onlyARealLineAccount() public {
        _vbond(voucher, 1 ether);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.NoLine.selector);
        vc.offerLine(voucher, agentA, 0.01 ether);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.NoLine.selector);
        vc.offerLine(voucher, newKey, 0.01 ether); // the key, not its account
    }

    function test_noVouchForALateLine() public {
        _vbond(voucher, 1 ether);
        _newDraws(0.01 ether, 0.005 ether);
        vm.warp(block.timestamp + 30 days + 1);
        uint256 dueAt = line.line(address(newAcct)).dueAt;
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.LineLate.selector, dueAt));
        vc.offerLine(voucher, address(newAcct), 0.01 ether);
    }

    function test_noVouchForADefaultedLine() public {
        _vbond(voucher, 1 ether);
        _earnFree(0.05 ether);
        _newDraws(0, 0.001 ether);
        _default();
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.LineDefaulted.selector);
        vc.offerLine(voucher, address(newAcct), 0.01 ether);
    }

    function test_aLineAlreadyOwingCanBeVouched() public {
        _vbond(voucher, 1 ether);
        _newDraws(0.01 ether, 0.005 ether);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        assertEq(vc.vouch(id).debtAtOffer, 0.005 ether);
        _accept(address(newAcct), id);
    }

    // ---------- offering a vouch on a cover ----------

    function test_offerACover() public {
        (uint256 cover,) = _covered(agentA, 0.04 ether, 0.01 ether);
        _vbond(voucher, 0.04 ether);
        uint256 id = _offerCover(voucher, cover, 0.01 ether);
        FactorVouch.Vouch memory v = vc.vouch(id);
        assertEq(uint8(v.kind), uint8(FactorVouch.Kind.Cover));
        assertEq(v.subject, cover);
        assertEq(v.agent, agentA);
        assertEq(v.fee, 0.0002 ether);
        assertEq(vc.openOf(voucher, FactorVouch.Kind.Cover, cover), id);
    }

    function test_aCoverMustBeTiedToItsJob() public {
        _ready(agentA, 1 ether, 0.01 ether);
        _vbond(voucher, 1 ether);
        uint256 reserved = _reserve(buyer, agentA, 0.04 ether, block.timestamp + 1 days, false, 0.01 ether);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.NotCovered.selector);
        vc.offerCover(voucher, reserved, 0.01 ether);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.NotCovered.selector);
        vc.offerCover(voucher, 99, 0.01 ether);
    }

    function test_aCoveredJobMustBeLockedAndNotDue() public {
        _ready(agentA, 1 ether, 1 ether);
        _vbond(voucher, 1 ether);
        _fund(1 ether);
        _bond(agentA, 0.01 ether);
        (uint256 c1, uint256 j1) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        _draw(agentA, j1, 0.001 ether, FactorDesk.Kind.Pool);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.JobNotOpen.selector);
        vc.offerCover(voucher, c1, 0.01 ether);

        (uint256 c2, uint256 j2) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        _deliver(agentA, j2);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.JobNotOpen.selector);
        vc.offerCover(voucher, c2, 0.01 ether);

        (uint256 c3,) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        vm.warp(block.timestamp + 1 days);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.JobNotOpen.selector);
        vc.offerCover(voucher, c3, 0.01 ether);
    }

    function test_noCoSigningACoverYouBought() public {
        _ready(agentA, 1 ether, 1 ether);
        _vbond(voucher, 1 ether);
        (uint256 cover,) = _hire(voucher, agentA, 0.04 ether, 0.01 ether, false);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.Related.selector);
        vc.offerCover(voucher, cover, 0.01 ether);
    }

    // ---------- accepting ----------

    function test_theAgentAcceptsWithTheFee() public {
        _vbond(voucher, 0.04 ether);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        vm.deal(newKey, 1 ether);
        vm.expectEmit(address(vc));
        emit FactorVouch.Accepted(id, address(newAcct), newKey, 0.0002 ether, block.timestamp + 30 days);
        vm.prank(newKey);
        vc.accept{value: 0.0002 ether}(id);
        FactorVouch.Vouch memory v = vc.vouch(id);
        assertEq(uint8(v.state), uint8(FactorVouch.State.Active));
        assertEq(v.startedAt, block.timestamp);
        assertEq(v.endsAt, block.timestamp + 30 days);
        assertEq(v.payer, newKey);
        assertEq(vc.feesHeld(), 0.0002 ether);
        FactorVouch.Voucher memory b = vc.voucherOf(voucher);
        assertEq(b.vouches, 1);
        assertEq(b.vouchedTotal, 0.01 ether);
        assertEq(vc.totalVouched(), 0.01 ether);
        _vbooks();
    }

    function test_onlyTheAgentAcceptsAndOnlyWithTheRightFee() public {
        _vbond(voucher, 0.04 ether);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(FactorVouch.NotAgent.selector);
        vc.accept{value: 0.0002 ether}(id);
        vm.deal(voucher, 1 ether);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.NotAgent.selector);
        vc.accept{value: 0.0002 ether}(id);
        vm.deal(newKey, 1 ether);
        vm.prank(newKey);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongFee.selector, 0.0002 ether));
        vc.accept{value: 0.0001 ether}(id);
        vm.prank(newKey);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongFee.selector, 0.0002 ether));
        vc.accept{value: 0.0003 ether}(id);
    }

    function test_anOfferWaitsSevenDays() public {
        _vbond(voucher, 0.04 ether);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        vm.warp(block.timestamp + 7 days + 1);
        vm.deal(newKey, 1 ether);
        vm.prank(newKey);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.Expired.selector, block.timestamp - 1));
        vc.accept{value: 0.0002 ether}(id);
    }

    function test_noAcceptingOnceTheLineOwesMore() public {
        _vbond(voucher, 0.04 ether);
        _newDraws(0.02 ether, 0.005 ether);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        _lineDraw(newKey, 0.005 ether, false);
        vm.deal(newKey, 1 ether);
        vm.prank(newKey);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.DebtGrew.selector, 0.01 ether));
        vc.accept{value: 0.0002 ether}(id);
        // paying back to where it was is enough
        vm.prank(newKey);
        line.repay{value: 0.005 ether}(address(newAcct));
        vm.prank(newKey);
        vc.accept{value: 0.0002 ether}(id);
    }

    function test_noAcceptingALateLine() public {
        _vbond(voucher, 0.04 ether);
        _newDraws(0.02 ether, 0.005 ether);
        uint256 dueAt = line.line(address(newAcct)).dueAt;
        vm.warp(dueAt - 3 days);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        vm.warp(dueAt + 1);
        assertLe(block.timestamp, uint256(vc.vouch(id).offeredAt) + 7 days, "the offer is still open");
        vm.deal(newKey, 1 ether);
        vm.prank(newKey);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.LineLate.selector, dueAt));
        vc.accept{value: 0.0002 ether}(id);
    }

    function test_noAcceptingACoverWhoseJobWasDrawnOn() public {
        _ready(agentA, 1 ether, 1 ether);
        _vbond(voucher, 1 ether);
        (uint256 cover, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
        uint256 id = _offerCover(voucher, cover, 0.01 ether);
        _fund(1 ether);
        _bond(agentA, 0.01 ether);
        _draw(agentA, job, 0.001 ether, FactorDesk.Kind.Pool);
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(FactorVouch.JobNotOpen.selector);
        vc.accept{value: 0.0002 ether}(id);
    }

    function test_acceptOnlyAnOffer() public {
        uint256 id = _lineVouch(0.01 ether);
        vm.deal(newKey, 1 ether);
        vm.prank(newKey);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongState.selector, FactorVouch.State.Active));
        vc.accept{value: 0.0002 ether}(id);
        vm.prank(newKey);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongState.selector, FactorVouch.State.None));
        vc.accept{value: 0.0002 ether}(42);
    }

    // ---------- withdrawing an offer ----------

    function test_theVoucherWithdrawsAnOfferAtAnyTime() public {
        _vbond(voucher, 0.04 ether);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        vm.expectEmit(address(vc));
        emit FactorVouch.Withdrawn(id, voucher);
        vm.prank(voucher);
        vc.withdraw(id);
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Withdrawn));
        assertEq(vc.freeOf(voucher), 0.04 ether);
        assertEq(vc.heldOn(voucher, address(newAcct)), 0);
        assertEq(vc.held(), 0);
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongState.selector, FactorVouch.State.Withdrawn));
        vc.withdraw(id);
        _vbooks();
    }

    function test_anyoneWithdrawsAnOfferAfterSevenDays() public {
        _vbond(voucher, 0.04 ether);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        vm.warp(block.timestamp + 7 days);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.TooSoon.selector, block.timestamp + 1));
        vc.withdraw(id);
        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        vc.withdraw(id);
        assertEq(vc.freeOf(voucher), 0.04 ether);
    }

    function test_noWithdrawingAnAcceptedVouch() public {
        uint256 id = _lineVouch(0.01 ether);
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongState.selector, FactorVouch.State.Active));
        vc.withdraw(id);
    }

    // ---------- a line vouch kept ----------

    /// The example: a vouch of 0.01 kept. The voucher earns 0.0001 into its bond, 0.0001 is burned.
    function test_aLineVouchKept() public {
        uint256 id = _lineVouch(0.01 ether);
        vm.expectRevert(FactorVouch.NotYet.selector);
        vc.settle(id);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(FactorVouch.NotYet.selector);
        vc.settle(id);
        vm.warp(block.timestamp + 1);
        uint256 pot = address(burnPot).balance;
        vm.expectEmit(address(vc));
        emit FactorVouch.Settled(id, voucher, address(newAcct), FactorVouch.State.Kept, 0.0001 ether, 0.0001 ether, 0, address(0), 0);
        vm.prank(stranger);
        vc.settle(id);
        assertEq(address(burnPot).balance - pot, 0.0001 ether);
        FactorVouch.Voucher memory b = vc.voucherOf(voucher);
        assertEq(b.bond, 0.0401 ether, "the voucher's half of the fee is in its bond");
        assertEq(b.held, 0);
        assertEq(b.kept, 1);
        assertEq(b.earned, 0.0001 ether);
        assertEq(vc.feesHeld(), 0);
        assertEq(vc.totalEarned(), 0.0001 ether);
        assertEq(vc.totalBurned(), 0.0001 ether);
        assertEq(vc.openOf(voucher, FactorVouch.Kind.Line, uint256(uint160(address(newAcct)))), 0);
        _vbooks();
    }

    function test_aLineVouchKeptWhenItsDrawsWereRepaid() public {
        uint256 id = _lineVouch(0.01 ether);
        _newDraws(0.02 ether, 0.01 ether);
        vm.warp(block.timestamp + 20 days);
        vm.deal(newKey, 1 ether);
        vm.prank(newKey);
        line.repay{value: 0.01 ether}(address(newAcct));
        vm.warp(block.timestamp + 10 days + 1);
        vc.settle(id);
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Kept));
    }

    function test_aLineVouchWaitsForTheDebtOpenAtItsEnd() public {
        uint256 id = _lineVouch(0.01 ether);
        vm.warp(block.timestamp + 20 days);
        _newDraws(0.02 ether, 0.01 ether);
        vm.warp(block.timestamp + 10 days + 1);
        vm.expectRevert(FactorVouch.NotYet.selector);
        vc.settle(id);
        vm.warp(block.timestamp + 25 days); // late now, not yet recoverable
        vm.expectRevert(FactorVouch.NotYet.selector);
        vc.settle(id);
        vm.deal(newKey, 1 ether);
        vm.prank(newKey);
        line.repay{value: 0.01 ether}(address(newAcct));
        vc.settle(id);
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Kept), "repaid late is repaid");
    }

    function test_aDebtThatBeganAfterTheVouchEndedIsNotTheVouchers() public {
        uint256 id = _lineVouch(0.01 ether);
        _earnFree(0.5 ether);
        vm.warp(block.timestamp + 30 days + 1);
        _lineDraw(newKey, 0.005 ether, false); // after the vouch's end, before anyone settled it
        _default();
        uint256 lostBefore = line.lost();
        vc.settle(id);
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Kept), "the new debt is not the voucher's");
        assertEq(line.lost(), lostBefore, "and nothing was paid for it");
        assertEq(vc.voucherOf(voucher).bond, 0.0401 ether);
    }

    // ---------- a line vouch failed ----------

    /// The example: the line defaulted with 0.006 still owed. The line pool is repaid 0.006, 0.0002 from the fee and
    /// 0.0058 from the voucher's bond; 0.0042 is free in the bond again; nothing is burned.
    function test_aLineVouchFailed() public {
        uint256 id = _lineVouch(0.01 ether);
        _earnFree(0.3 ether); // fees paid 0.006: the line's limit with no bond
        _lineDraw(newKey, 0.006 ether, false);
        vm.warp(block.timestamp + 60 days);
        vm.expectRevert(FactorVouch.NotYet.selector);
        vc.settle(id);
        _default();
        assertEq(line.debtOf(address(newAcct)), 0.006 ether);
        uint256 lost = line.lost();
        uint256 pool = line.pool();
        uint256 pot = address(burnPot).balance;
        vm.expectEmit(address(vc));
        emit FactorVouch.Settled(id, voucher, address(newAcct), FactorVouch.State.Failed, 0, 0, 0.006 ether, address(line), 0);
        vc.settle(id);
        assertEq(line.debtOf(address(newAcct)), 0, "the line is repaid");
        assertEq(lost - line.lost(), 0.006 ether, "the pool lost nothing in the end");
        assertEq(line.pool() - pool, 0.006 ether);
        assertEq(line.totalRecovered(), 0.006 ether);
        assertEq(address(burnPot).balance, pot, "nothing burned");
        FactorVouch.Voucher memory b = vc.voucherOf(voucher);
        assertEq(b.bond, 0.04 ether - 0.0058 ether);
        assertEq(b.held, 0);
        assertEq(b.failed, 1);
        assertEq(b.lostTotal, 0.0058 ether);
        assertEq(b.earned, 0);
        FactorVouch.Vouch memory v = vc.vouch(id);
        assertEq(uint8(v.state), uint8(FactorVouch.State.Failed));
        assertEq(v.paid, 0.006 ether);
        assertEq(v.paidTo, address(line));
        assertEq(vc.totalPaid(), 0.006 ether);
        assertEq(vc.freeOf(voucher), 0.0342 ether);
        _vbooks();
        _lineBooks();
    }

    /// The example: 0.05 still owed. The pool is repaid 0.0102, the fee and the whole amount; the line still owes the
    /// rest, which the line contract goes on recovering.
    function test_aLineVouchPaysAtMostTheFeeAndTheAmount() public {
        uint256 id = _lineVouch(0.01 ether);
        _earnFree(2.5 ether);
        _lineDraw(newKey, 0.05 ether, false);
        _default();
        vc.settle(id);
        assertEq(vc.vouch(id).paid, 0.0102 ether);
        assertEq(line.debtOf(address(newAcct)), 0.0398 ether);
        assertEq(vc.voucherOf(voucher).bond, 0.03 ether);
        assertEq(vc.voucherOf(voucher).lostTotal, 0.01 ether);
        _vbooks();
        _lineBooks();
    }

    /// The example: 0.0001 still owed. The fee pays it; the rest of the fee is burned; the whole 0.01 is free again.
    function test_aSmallLossIsPaidFromTheFee() public {
        uint256 id = _lineVouch(0.01 ether);
        _earnFree(0.005 ether);
        _lineDraw(newKey, 0.0001 ether, false);
        _default();
        uint256 pot = address(burnPot).balance;
        vc.settle(id);
        assertEq(vc.vouch(id).paid, 0.0001 ether);
        assertEq(address(burnPot).balance - pot, 0.0001 ether);
        assertEq(vc.voucherOf(voucher).bond, 0.04 ether);
        assertEq(vc.voucherOf(voucher).lostTotal, 0);
        assertEq(vc.freeOf(voucher), 0.04 ether);
        _vbooks();
    }

    function test_settleRecoversALineDueToBeRecovered() public {
        uint256 id = _lineVouch(0.01 ether);
        _earnFree(0.3 ether);
        _lineDraw(newKey, 0.006 ether, false);
        vm.warp(uint256(line.line(address(newAcct)).dueAt) + 30 days + 1);
        assertFalse(line.line(address(newAcct)).defaulted);
        vc.settle(id); // one call: recover, then the vouch pays
        assertTrue(line.line(address(newAcct)).defaulted);
        assertEq(vc.vouch(id).paid, 0.006 ether);
        assertEq(line.debtOf(address(newAcct)), 0);
    }

    function test_theAgentsOwnBondPaysBeforeTheVoucher() public {
        uint256 id = _lineVouch(0.01 ether);
        _earnFree(0.3 ether);
        _lineBond(newKey, 0.004 ether); // limit 0.01
        _lineDraw(newKey, 0.01 ether, false);
        vm.warp(uint256(line.line(address(newAcct)).dueAt) + 30 days + 1);
        vc.settle(id);
        assertEq(vc.vouch(id).paid, 0.006 ether, "the desk bond paid 0.004 first, the vouch the 0.006 left");
        assertEq(vc.voucherOf(voucher).lostTotal, 0.0058 ether);
    }

    function test_aLineRecoveredInFullBeforeTheEndIsKept() public {
        uint256 id = _lineVouch(0.01 ether);
        _lineBond(newKey, 0.01 ether);
        _lineDraw(newKey, 0.005 ether, false);
        vm.warp(uint256(line.line(address(newAcct)).dueAt) + 30 days + 1);
        line.recover(address(newAcct)); // the bond pays it all: repaid late, not a default
        assertFalse(line.line(address(newAcct)).defaulted);
        vc.settle(id);
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Kept));
    }

    // ---------- release ----------

    function test_theAgentReleasesALineVouchEarly() public {
        uint256 id = _lineVouch(0.01 ether);
        _newDraws(0.02 ether, 0.005 ether);
        vm.prank(newKey);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.StillOwes.selector, 0.005 ether));
        vc.release(id);
        vm.deal(newKey, 1 ether);
        vm.prank(newKey);
        line.repay{value: 0.005 ether}(address(newAcct));
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.NotAgent.selector);
        vc.release(id);
        vm.prank(newKey);
        vc.release(id);
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Kept));
        assertEq(vc.voucherOf(voucher).earned, 0.0001 ether);
    }

    function test_aCoverVouchCannotBeReleased() public {
        (uint256 cover,) = _covered(agentA, 0.04 ether, 0.01 ether);
        _vbond(voucher, 0.04 ether);
        uint256 id = _offerCover(voucher, cover, 0.01 ether);
        _accept(agentA, id);
        vm.prank(agentA);
        vm.expectRevert(FactorVouch.WrongKind.selector);
        vc.release(id);
    }

    // ---------- a cover vouch ----------

    function _coverVouch() internal returns (uint256 id, uint256 cover, uint256 job) {
        (cover, job) = _covered(agentA, 0.04 ether, 0.01 ether);
        _vbond(voucher, 0.04 ether);
        id = _offerCover(voucher, cover, 0.01 ether);
        _accept(agentA, id);
    }

    function test_aCoverVouchKeptWhenTheJobIsDelivered() public {
        (uint256 id, uint256 cover, uint256 job) = _coverVouch();
        assertEq(vc.vouch(id).endsAt, 0, "a cover vouch ends with its job");
        vm.expectRevert(FactorVouch.NotYet.selector);
        vc.settle(id);
        _deliver(agentA, job);
        vm.expectRevert(FactorVouch.NotYet.selector);
        vc.settle(id);
        vm.prank(buyer);
        desk.accept(job);
        uint256 pot = address(burnPot).balance;
        vc.settle(id); // closes the cover too
        assertEq(uint8(g.cover(cover).state), uint8(FactorGuarantee.State.Released));
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Kept));
        assertEq(vc.voucherOf(voucher).earned, 0.0001 ether);
        assertEq(address(burnPot).balance - pot, 0.0001 ether + 0.00005 ether, "the vouch's half and the cover's half");
        _vbooks();
        _gbooks();
    }

    function test_aCoverVouchKeptWhenTheCustomerNeverAnswers() public {
        (uint256 id,, uint256 job) = _coverVouch();
        _deliver(agentA, job);
        vm.warp(block.timestamp + 24 hours - 1);
        vm.expectRevert(FactorVouch.NotYet.selector);
        vc.settle(id);
        vm.warp(block.timestamp + 1);
        vc.settle(id);
        assertEq(uint8(desk.job(job).state), uint8(FactorDesk.State.Settled), "settled on the desk in the same call");
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Kept));
    }

    function test_aCoverVouchKeptWhenTheJobSettlesAtHalf() public {
        (uint256 id,, uint256 job) = _coverVouch();
        _deliver(agentA, job);
        vm.prank(buyer);
        desk.reject(job);
        vc.settle(id);
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Kept), "something was delivered");
    }

    /// The example: a covered job never delivered. The customer is paid 0.01, 0.0002 from the fee and 0.0098 from the
    /// voucher's bond, on top of the desk's refund and the agent's own cover.
    function test_aCoverVouchFailedPaysTheCustomer() public {
        (uint256 id, uint256 cover, uint256 job) = _coverVouch();
        vm.warp(block.timestamp + 1 days + 12 hours);
        vm.expectRevert(FactorVouch.NotYet.selector);
        vc.settle(id);
        vm.warp(block.timestamp + 1);
        uint256 before = buyer.balance;
        vm.expectEmit(address(vc));
        emit FactorVouch.Settled(id, voucher, agentA, FactorVouch.State.Failed, 0, 0, 0.01 ether, buyer, 0);
        vc.settle(id);
        assertEq(uint8(desk.job(job).state), uint8(FactorDesk.State.Refunded));
        assertEq(uint8(g.cover(cover).state), uint8(FactorGuarantee.State.Paid));
        assertEq(buyer.balance - before, 0.04 ether + 0.01 ether + 0.01 ether, "the refund, the cover and the vouch");
        FactorVouch.Voucher memory b = vc.voucherOf(voucher);
        assertEq(b.bond, 0.04 ether - 0.0098 ether);
        assertEq(b.lostTotal, 0.0098 ether);
        assertEq(b.failed, 1);
        assertEq(vc.vouch(id).paidTo, buyer);
        _vbooks();
        _gbooks();
    }

    function test_aCoverVouchReturnedWhenTheJobIsDeclined() public {
        (uint256 id,, uint256 job) = _coverVouch();
        vm.prank(agentA);
        desk.decline(job);
        uint256 before = agentA.balance;
        vm.expectEmit(address(vc));
        emit FactorVouch.Settled(id, voucher, agentA, FactorVouch.State.Returned, 0, 0, 0, address(0), 0.0002 ether);
        vc.settle(id);
        assertEq(agentA.balance - before, 0.0002 ether, "the fee back to whoever paid it");
        assertEq(vc.voucherOf(voucher).returned, 1);
        assertEq(vc.freeOf(voucher), 0.04 ether);
        _vbooks();
    }

    function test_aCoverClosedByAnyoneElseFirstStillSettles() public {
        (uint256 id,, uint256 job) = _coverVouch();
        vm.warp(block.timestamp + 2 days);
        g.close(job);
        vc.settle(id);
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Failed));
    }

    function test_aVouchSettlesOnce() public {
        (uint256 id,, uint256 job) = _coverVouch();
        _deliver(agentA, job);
        vm.prank(buyer);
        desk.accept(job);
        vc.settle(id);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongState.selector, FactorVouch.State.Kept));
        vc.settle(id);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongState.selector, FactorVouch.State.None));
        vc.settle(77);
    }

    function test_anOfferIsNotSettled() public {
        _vbond(voucher, 0.04 ether);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongState.selector, FactorVouch.State.Offered));
        vc.settle(id);
    }

    // ---------- refused payouts ----------

    function test_aRefusedPayoutWaitsAsOwed() public {
        _ready(agentA, 1 ether, 1 ether);
        Rejecter cust = new Rejecter();
        (uint256 cover, uint256 job) = _hire(address(cust), agentA, 0.04 ether, 0.01 ether, false);
        _vbond(voucher, 0.04 ether);
        uint256 id = _offerCover(voucher, cover, 0.01 ether);
        _accept(agentA, id);
        vm.warp(block.timestamp + 2 days);
        vc.settle(id);
        assertEq(desk.owed(address(cust)), 0.04 ether, "the desk's refund waits on the desk");
        assertEq(g.owed(address(cust)), 0.01 ether, "the cover waits in the guarantee contract");
        assertEq(vc.owed(address(cust)), 0.01 ether, "the vouch waits here");
        assertEq(vc.owedTotal(), 0.01 ether);
        _vbooks();
        vm.expectRevert(FactorVouch.PushFailed.selector);
        vc.collect(address(cust));
        cust.setAccept(true);
        vc.collect(address(cust));
        assertEq(address(cust).balance, 0.01 ether, "collected");
        assertEq(vc.owedTotal(), 0);
        vm.expectRevert(FactorVouch.NothingOwed.selector);
        vc.collect(address(cust));
    }

    function test_collectToSendsYourOwnElsewhere() public {
        _ready(agentA, 1 ether, 1 ether);
        Rejecter cust = new Rejecter();
        (uint256 cover,) = _hire(address(cust), agentA, 0.04 ether, 0.01 ether, false);
        _vbond(voucher, 0.04 ether);
        uint256 id = _offerCover(voucher, cover, 0.01 ether);
        _accept(agentA, id);
        vm.warp(block.timestamp + 2 days);
        vc.settle(id);
        vm.prank(address(cust));
        vm.expectRevert(FactorVouch.ZeroAddress.selector);
        vc.collectTo(payable(address(0)));
        vm.prank(address(cust));
        vc.collectTo(payable(stranger));
        assertEq(stranger.balance, 0.01 ether);
        _vbooks();
    }

    // ---------- views ----------

    function test_canVouchSaysTheMost() public {
        assertEq(vc.canVouch(voucher, address(newAcct)), 0, "no bond");
        _vbond(voucher, 0.08 ether);
        assertEq(vc.canVouch(voucher, address(newAcct)), 0.02 ether);
        assertEq(vc.canVouch(voucher, newKey), 0.02 ether, "by its key too");
        assertEq(vc.canVouch(voucher, voucher), 0, "never itself");
        assertEq(vc.canVouch(agentA, address(newAcct)), 0, "not a strong score");
        assertTrue(vc.related(newKey, address(newAcct)));
        assertFalse(vc.related(voucher, address(newAcct)));
        assertEq(vc.feeFor(0.01 ether), 0.0002 ether);
    }

    // ---------- fuzzed ----------

    /// Any amount kept: the fee is 2%, the voucher's half rounded down, the burn the rest, every wei counted.
    function testFuzz_keptSplitsTheFeeToTheWei(uint256 amount) public {
        amount = bound(amount, 0.0001 ether, 2 ether);
        _vbond(voucher, amount * 4);
        uint256 id = _offerLine(voucher, address(newAcct), amount);
        _accept(address(newAcct), id);
        (uint256 fee, uint256 toVoucher, uint256 burned) = _vfee(amount);
        assertEq(vc.vouch(id).fee, fee);
        vm.warp(block.timestamp + 30 days + 1);
        uint256 pot = address(burnPot).balance;
        vc.settle(id);
        assertEq(vc.voucherOf(voucher).bond, amount * 4 + toVoucher);
        assertEq(address(burnPot).balance - pot, burned);
        assertEq(toVoucher + burned, fee);
        _vbooks();
    }

    /// Any loss and amount: paid up to the fee and the amount together, the fee first, the rest of the fee burned, the
    /// rest of the amount free again.
    function testFuzz_failedPaysTheLossToTheWei(uint256 amount, uint256 owe) public {
        amount = bound(amount, 0.0001 ether, 0.5 ether);
        owe = bound(owe, 0.0001 ether, 1 ether);
        _vbond(voucher, amount * 4);
        uint256 id = _offerLine(voucher, address(newAcct), amount);
        _accept(address(newAcct), id);
        _earnFree(owe * 50);
        _lineDraw(newKey, owe, false);
        _default();
        uint256 left = line.debtOf(address(newAcct));
        uint256 pot = address(burnPot).balance;
        vc.settle(id);
        (uint256 fee,,) = _vfee(amount);
        uint256 pay = left < fee + amount ? left : fee + amount;
        uint256 fromFee = pay < fee ? pay : fee;
        assertEq(vc.vouch(id).paid, pay);
        assertEq(line.debtOf(address(newAcct)), left - pay);
        assertEq(vc.voucherOf(voucher).bond, amount * 4 - (pay - fromFee));
        assertEq(address(burnPot).balance - pot, fee - fromFee);
        _vbooks();
        _lineBooks();
    }
}
