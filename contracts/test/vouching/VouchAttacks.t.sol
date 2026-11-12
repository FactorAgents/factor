// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VouchBase} from "./VouchBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorGuarantee} from "../../src/FactorGuarantee.sol";
import {FactorVouch} from "../../src/FactorVouch.sol";
import {Reenterer, ForceSend} from "../mocks/Actors.sol";

/// The attacks of docs/VOUCHING.md, section 9, each carried out.
contract VouchAttackTest is VouchBase {
    function _earnFree(uint256 price) internal {
        _earn(newKey, price);
        uint256 have = address(newAcct).balance;
        vm.prank(newKey);
        newAcct.withdraw(payable(newKey), have);
    }

    /// 1. A strong agent vouches for itself: its own line account, from either address, and its own cover. Refused.
    function test_attack1_noVouchingForYourself() public {
        FactorLineAccount own = _open(voucher);
        _vbond(voucher, 1 ether);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.Related.selector);
        vc.offerLine(voucher, address(own), 0.01 ether);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.Related.selector);
        vc.offerLine(address(own), address(own), 0.01 ether);

        // a strong agent with a cover of its own on a job: it cannot co-sign it
        _gbond(address(own), 1 ether);
        vm.prank(voucher);
        g.setOffer(address(own), 1 ether);
        (uint256 cover,) = _hire(buyer, address(own), 0.04 ether, 0.01 ether, false);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.Related.selector);
        vc.offerCover(voucher, cover, 0.01 ether);
        assertEq(vc.canVouch(voucher, address(own)), 0);
        assertEq(vc.canVouch(address(own), voucher), 0);
    }

    /// 2. Vouch for a second wallet of one's own the chain cannot link, and let it default. The voucher's own bond pays
    ///    the pool: the two wallets together end poorer, and the line pool loses nothing.
    function test_attack2_aHiddenSecondWalletOnlyCostsItsOwner() public {
        _earnFree(0.3 ether);
        _vbond(voucher, 0.04 ether);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        vm.deal(newKey, newKey.balance + 0.0002 ether);
        uint256 lostBefore = line.lost();
        uint256 together = newKey.balance + vc.voucherOf(voucher).bond;
        vm.prank(newKey);
        vc.accept{value: 0.0002 ether}(id);
        _lineDraw(newKey, 0.006 ether, false); // the second wallet takes the cash
        _default();
        vc.settle(id);
        uint256 after_ = newKey.balance + vc.voucherOf(voucher).bond;
        assertEq(together - after_, 0.00012 ether, "the pair ends poorer by the draw's fee");
        assertEq(line.lost(), lostBefore, "the line pool lost nothing in the end");
        _vbooks();
        _lineBooks();
    }

    /// 3. Co-sign a cover one's own customer wallet bought, to pay oneself. Refused when the chain shows it (the
    ///    voucher's key is the customer); otherwise the bond only pays its own owner.
    function test_attack3_noCoSigningYourOwnPurchase() public {
        FactorLineAccount own = _open(voucher);
        _vbond(voucher, 1 ether);
        _ready(agentA, 1 ether, 1 ether);
        (uint256 cover,) = _hire(voucher, agentA, 0.04 ether, 0.01 ether, false); // the key buys
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.Related.selector);
        vc.offerCover(address(own), cover, 0.01 ether);

        // an unlinked customer wallet of the voucher's own: the vouch pays it out of the voucher's own bond
        address mine = makeAddr("the voucher's unlinked wallet");
        (uint256 cover2, uint256 job2) = _hire(mine, agentA, 0.04 ether, 0.01 ether, false);
        uint256 id = _offerCover(voucher, cover2, 0.01 ether);
        _accept(agentA, id);
        uint256 bondBefore = vc.voucherOf(voucher).bond;
        vm.warp(block.timestamp + 2 days);
        vc.settle(id);
        assertEq(uint8(desk.job(job2).state), uint8(FactorDesk.State.Refunded));
        assertEq(bondBefore - vc.voucherOf(voucher).bond, 0.0098 ether, "out of its own bond");
        _vbooks();
    }

    /// 4. Settle twice, of every kind. Refused after the first.
    function test_attack4_noDoubleSettle() public {
        uint256 id = _lineVouch(0.01 ether);
        _earnFree(0.3 ether);
        _lineDraw(newKey, 0.006 ether, false);
        _default();
        vc.settle(id);
        uint256 bond = vc.voucherOf(voucher).bond;
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongState.selector, FactorVouch.State.Failed));
        vc.settle(id);
        vm.prank(newKey);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongState.selector, FactorVouch.State.Failed));
        vc.release(id);
        assertEq(vc.voucherOf(voucher).bond, bond, "paid once");
    }

    /// 5. Settle against a fake line or a fake cover: a real line account of another line contract, a cover of another
    ///    guarantee contract. The vouching contract reads only its own two.
    function test_attack5_noFakeLineOrCover() public {
        _vbond(voucher, 1 ether);
        FactorLine fakeLine = new FactorLine(desk);
        vm.prank(agentB);
        address fakeAcct = fakeLine.open();
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.NoLine.selector);
        vc.offerLine(voucher, fakeAcct, 0.01 ether);

        FactorGuarantee fakeG = new FactorGuarantee(desk, line);
        _score200(agentA);
        vm.deal(address(this), 1 ether);
        fakeG.addBond{value: 1 ether}(agentA);
        vm.prank(agentA);
        fakeG.setOffer(agentA, 1 ether);
        uint256 dueAt = block.timestamp + 1 days;
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        uint256 fakeCover = fakeG.reserve{value: 0.0001 ether}(agentA, 0.04 ether, dueAt, false, 0.01 ether);
        uint256 job = _lockAt(buyer, agentA, 0.04 ether, dueAt, false);
        fakeG.bind(fakeCover, job);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.NotCovered.selector);
        vc.offerCover(voucher, fakeCover, 0.01 ether);
    }

    /// 6. Re-entry: a customer that calls back in when the vouch pays it, and an agent that calls back in when its fee
    ///    comes back. Neither gets in; the books hold.
    function test_attack6_reentryIsShutOut() public {
        _ready(agentA, 1 ether, 1 ether);
        _vbond(voucher, 0.08 ether);
        Reenterer cust = new Reenterer();
        (uint256 cover, uint256 job) = _hire(address(cust), agentA, 0.04 ether, 0.01 ether, false);
        uint256 id = _offerCover(voucher, cover, 0.01 ether);
        _accept(agentA, id);
        cust.arm(abi.encodeCall(FactorVouch.settle, (id)));
        vm.warp(block.timestamp + 2 days);
        vc.settle(id);
        assertTrue(cust.reentered());
        assertFalse(cust.reentrySucceeded());
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Failed));
        assertEq(vc.voucherOf(voucher).lostTotal, 0.0098 ether, "paid once");
        assertEq(uint8(desk.job(job).state), uint8(FactorDesk.State.Refunded));

        Reenterer ag = new Reenterer();
        vm.prank(address(ag));
        desk.register();
        _score200(address(ag));
        _gbond(address(ag), 1 ether);
        vm.prank(address(ag));
        g.setOffer(address(ag), 1 ether);
        (uint256 cover2, uint256 job2) = _hire(buyer, address(ag), 0.04 ether, 0.01 ether, false);
        uint256 id2 = _offerCover(voucher, cover2, 0.01 ether);
        vm.deal(address(ag), 1 ether);
        vm.prank(address(ag));
        vc.accept{value: 0.0002 ether}(id2);
        vm.prank(address(ag));
        desk.decline(job2);
        ag.arm(abi.encodeCall(FactorVouch.settle, (id2)));
        vc.settle(id2);
        assertTrue(ag.reentered());
        assertFalse(ag.reentrySucceeded());
        assertEq(uint8(vc.vouch(id2).state), uint8(FactorVouch.State.Returned));
        _vbooks();
    }

    /// 7. The voucher pulls its bond before the default. Only the free part comes out; the vouch is paid whole.
    function test_attack7_theBondCannotLeaveFromUnderAVouch() public {
        uint256 id = _lineVouch(0.01 ether);
        _earnFree(0.3 ether);
        _lineDraw(newKey, 0.006 ether, false);
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.OverFree.selector, 0.03 ether));
        vc.takeBond(voucher, 0.04 ether);
        vm.prank(voucher);
        vc.takeBond(voucher, 0.03 ether);
        _default();
        vc.settle(id);
        assertEq(vc.vouch(id).paid, 0.006 ether, "the vouch was backed all along");
        assertEq(vc.voucherOf(voucher).bond, 0.0042 ether);
    }

    /// 8. The voucher tries to leave a standing vouch early. It cannot: no withdrawal and no release.
    function test_attack8_noEarlyExitForAVoucher() public {
        uint256 id = _lineVouch(0.01 ether);
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongState.selector, FactorVouch.State.Active));
        vc.withdraw(id);
        vm.prank(voucher);
        vm.expectRevert(FactorVouch.NotAgent.selector);
        vc.release(id);
        vm.expectRevert(FactorVouch.NotYet.selector);
        vc.settle(id);
    }

    /// 9. The agent draws heavily between the offer and its acceptance. The acceptance is refused.
    function test_attack9_noDrawingBeforeAccepting() public {
        _vbond(voucher, 0.04 ether);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        _newDraws(0.05 ether, 0.04 ether);
        vm.deal(newKey, 1 ether);
        vm.prank(newKey);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.DebtGrew.selector, 0.04 ether));
        vc.accept{value: 0.0002 ether}(id);
    }

    /// 10. The agent draws on the covered job, then buys the vouch. Refused.
    function test_attack10_noVouchForAJobAlreadyGoingWrong() public {
        _ready(agentA, 1 ether, 1 ether);
        _vbond(voucher, 1 ether);
        (uint256 cover, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, true);
        uint256 id = _offerCover(voucher, cover, 0.01 ether);
        _draw(agentA, job, 0.02 ether, FactorDesk.Kind.Early); // half the price, then it plans to vanish
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vm.expectRevert(FactorVouch.JobNotOpen.selector);
        vc.accept{value: 0.0002 ether}(id);
    }

    /// 11. Make the voucher pay for a debt drawn after its vouch ended, before anyone settled it. It does not.
    function test_attack11_aLaterDebtIsNotTheVouchers() public {
        uint256 id = _lineVouch(0.01 ether);
        _earnFree(0.3 ether);
        vm.warp(block.timestamp + 30 days + 1);
        _lineDraw(newKey, 0.006 ether, false);
        _default();
        vc.settle(id);
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Kept));
        assertEq(vc.voucherOf(voucher).lostTotal, 0);
    }

    /// 12. Keep a vouch standing forever by never repaying and never defaulting. The line's own clock ends it.
    function test_attack12_aVouchAlwaysEnds() public {
        uint256 id = _lineVouch(0.01 ether);
        _earnFree(0.3 ether);
        _lineDraw(newKey, 0.006 ether, false);
        vm.warp(block.timestamp + 60 days);
        vm.expectRevert(FactorVouch.NotYet.selector);
        vc.settle(id);
        vm.warp(block.timestamp + 1);
        vc.settle(id);
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Failed));
    }

    /// 13. Griefing an agent with dust offers. Dust is refused; offers cost the agent nothing and anyone clears them
    ///     after seven days; nothing about the agent's line changes.
    function test_attack13_dustAndManyOffers() public {
        _vbond(voucher, 0.04 ether);
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.TooSmall.selector, 0.0001 ether));
        vc.offerLine(voucher, address(newAcct), 1);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        _newDraws(0.01 ether, 0.005 ether); // the agent's line works as ever
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(stranger);
        vc.withdraw(id);
        assertEq(vc.freeOf(voucher), 0.04 ether);
        uint256 again = _offerLine(voucher, address(newAcct), 0.01 ether);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongState.selector, FactorVouch.State.Offered));
        vc.settle(again);
    }

    /// 14. Holding a voucher's bond hostage. Only the voucher offers from its bond, and it takes an offer back at once.
    function test_attack14_noHostage() public {
        _vbond(voucher, 0.04 ether);
        vm.prank(newKey);
        vm.expectRevert(FactorVouch.NotVoucher.selector);
        vc.offerLine(voucher, address(newAcct), 0.01 ether);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        vm.prank(voucher);
        vc.withdraw(id);
        vm.prank(voucher);
        vc.takeBond(voucher, 0.04 ether);
        assertEq(vc.bonds(), 0);
    }

    /// 15. Accepting with the wrong fee, or with none. Refused.
    function test_attack15_theFeeIsExact() public {
        _vbond(voucher, 0.04 ether);
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        vm.prank(newKey);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.WrongFee.selector, 0.0002 ether));
        vc.accept(id);
    }

    /// 16. A bought score: an agent hires itself to 300 and vouches. It paid the desk's fees for the score, and its
    ///     vouch can only cost it its own bond.
    function test_attack16_aBoughtScoreRisksOnlyTheBuyersBond() public {
        address buyerSelf = makeAddr("the attacker's customer wallet");
        uint256 spent;
        for (uint256 i = 0; i < 21; ++i) {
            uint256 jobId = _settleFor(buyerSelf, agentA, i == 20 ? 0.05 ether : 0.001 ether);
            spent += desk.job(jobId).price / 50;
        }
        vm.warp(block.timestamp + 50 days);
        assertGe(vc.scoreOf(agentA), 300);
        assertEq(spent, 0.0014 ether, "the desk's fees it paid for the score");
        _vbond(agentA, 0.04 ether);
        vm.prank(agentA);
        uint256 id = vc.offerLine(agentA, address(newAcct), 0.01 ether);
        _accept(address(newAcct), id);
        _earnFree(0.3 ether);
        _lineDraw(newKey, 0.006 ether, false);
        _default();
        vc.settle(id);
        assertEq(vc.voucherOf(agentA).lostTotal, 0.0058 ether, "from its own bond");
    }

    /// 17. Put a voucher's whole bond on one agent. At most a quarter.
    function test_attack17_aQuarterAtMost() public {
        _vbond(voucher, 1 ether);
        vm.prank(voucher);
        vm.expectRevert(abi.encodeWithSelector(FactorVouch.OverShare.selector, 0.25 ether));
        vc.offerLine(voucher, address(newAcct), 1 ether);
        _offerLine(voucher, address(newAcct), 0.25 ether);
        assertEq(vc.canVouch(voucher, newKey), 0);
    }

    /// 18. A settle with too little gas, to push the burn's part into owed. Refused whole, or done whole.
    function test_attack18_tooLittleGasMovesNothing() public {
        uint256 id = _lineVouch(0.01 ether);
        vm.warp(block.timestamp + 30 days + 1);
        bool done;
        for (uint256 gas_ = 60_000; gas_ <= 400_000; gas_ += 5_000) {
            (bool ok,) = address(vc).call{gas: gas_}(abi.encodeCall(FactorVouch.settle, (id)));
            if (ok) {
                done = true;
                break;
            }
            assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Active), "nothing moved");
        }
        assertTrue(done);
        assertEq(vc.owed(address(burnPot)), 0, "the burn's part went to the burn pot, not into owed");
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Kept));

        // a customer whose wallet needs most of a push's gas to take ETH: never pushed with less than its 50,000
        _ready(agentA, 1 ether, 1 ether);
        ThirstyWallet cust = new ThirstyWallet();
        (uint256 cover,) = _hire(address(cust), agentA, 0.04 ether, 0.01 ether, false);
        uint256 id2 = _offerCover(voucher, cover, 0.01 ether);
        _accept(agentA, id2);
        vm.warp(block.timestamp + 2 days);
        g.close(g.cover(cover).job); // the desk refunds it and the guarantee pays its cover first
        uint256 before = cust.got();
        done = false;
        for (uint256 gas_ = 60_000; gas_ <= 600_000; gas_ += 250) {
            (bool ok,) = address(vc).call{gas: gas_}(abi.encodeCall(FactorVouch.settle, (id2)));
            if (ok) {
                done = true;
                break;
            }
            assertEq(uint8(vc.vouch(id2).state), uint8(FactorVouch.State.Active), "nothing moved");
        }
        assertTrue(done);
        assertEq(vc.owed(address(cust)), 0, "pushed with its full gas: paid, not kept as owed");
        assertEq(cust.got() - before, 0.01 ether);
    }

    /// 19. Forcing ETH in changes nothing anybody can take, and every flow still balances.
    function test_attack19_forcedEthChangesNothing() public {
        vm.deal(address(this), address(this).balance + 0.5 ether);
        new ForceSend{value: 0.5 ether}(payable(address(vc)));
        uint256 id = _lineVouch(0.01 ether);
        vm.warp(block.timestamp + 30 days + 1);
        vc.settle(id);
        uint256 free = vc.freeOf(voucher);
        vm.prank(voucher);
        vc.takeBond(voucher, free);
        assertEq(vc.bonds(), 0);
        assertEq(vc.feesHeld(), 0);
        assertEq(address(vc).balance, 0.5 ether, "only what was forced in is left, and nobody can take it");
    }

    /// 20. The books never mix: many vouches of both kinds ending every way, the books after each, then every bond out.
    function test_attack20_theBooksHold() public {
        _ready(agentA, 1 ether, 1 ether);
        _vbond(voucher, 1 ether);
        uint256 lineId = _offerLine(voucher, address(newAcct), 0.05 ether);
        _accept(address(newAcct), lineId);
        uint256[3] memory ids;
        uint256[3] memory jobs;
        for (uint256 i = 0; i < 3; ++i) {
            (uint256 cover, uint256 job) = _hire(buyer, agentA, 0.04 ether, 0.01 ether, false);
            ids[i] = _offerCover(voucher, cover, 0.01 ether);
            _accept(agentA, ids[i]);
            jobs[i] = job;
            _vbooks();
        }
        _deliver(agentA, jobs[0]);
        vm.prank(buyer);
        desk.accept(jobs[0]);
        vc.settle(ids[0]);
        _vbooks();
        vm.prank(agentA);
        desk.decline(jobs[1]);
        vc.settle(ids[1]);
        _vbooks();
        vm.warp(block.timestamp + 2 days);
        vc.settle(ids[2]);
        _vbooks();
        _earnFree(0.3 ether);
        _lineDraw(newKey, 0.006 ether, false);
        _default();
        vc.settle(lineId);
        _vbooks();
        uint256 free = vc.freeOf(voucher);
        vm.prank(voucher);
        vc.takeBond(voucher, free);
        assertEq(address(vc).balance, vc.owedTotal(), "nothing left but what wallets are owed");
        assertEq(vc.held(), 0);
        assertEq(vc.feesHeld(), 0);
    }
}

/// A wallet that takes ETH only when it is given most of the 50,000 gas a push carries (a contract wallet that does some
/// work when paid). Given less, it refuses cheaply, which is what a step sent with too little gas would cause.
contract ThirstyWallet {
    uint256 public got;

    receive() external payable {
        require(gasleft() > 49_000, "too little gas to take it");
        got += msg.value;
    }
}
