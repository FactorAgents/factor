// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VerifierBase} from "./VerifierBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorVerifiers} from "../../src/FactorVerifiers.sol";
import {GasEater, ForceSend} from "../mocks/Actors.sol";

/// A wallet that calls back into the verifier contract with whatever it was armed with, every time it is paid, and
/// remembers whether the call went through.
contract VReenterer {
    FactorVerifiers internal vf;
    bytes public armed;
    bool public reentered;
    bool public succeeded;

    constructor(FactorVerifiers vf_) {
        vf = vf_;
    }

    function arm(bytes calldata data) external {
        armed = data;
    }

    function join(uint8 maker) external payable {
        vf.join{value: msg.value}(maker);
    }

    function withdraw(uint256 amount) external {
        vf.withdraw(amount);
    }

    function hire(address agent, uint256 fee, bytes32 terms) external payable returns (uint256) {
        return vf.hire{value: msg.value}(agent, block.timestamp + 1 days, false, fee, terms);
    }

    function accept(uint256 id) external {
        vf.accept(id);
    }

    receive() external payable {
        if (armed.length == 0) return;
        reentered = true;
        (bool ok,) = address(vf).call(armed);
        if (ok) succeeded = true;
    }
}

/// Every attack in section 9 of docs/VERIFIERS.md, carried out against the verifier contract and the desk together.
contract VerifierAttacksTest is VerifierBase {
    /// 1. A verifier checks its own job: the customer or the agent signs up as a verifier. Refused for the first check
    ///    and for a panel seat.
    function test_attack1_aSideCannotCheckItsOwnJob() public {
        _join(hirer, 9);
        vm.deal(agentA, 1 ether);
        vm.prank(agentA);
        vf.join{value: BOND}(8);
        uint256 id = _hire();
        _deliverCase(id);
        vm.prank(hirer);
        vm.expectRevert(FactorVerifiers.Related.selector);
        vf.check(id, false, WHY);
        vm.prank(agentA);
        vm.expectRevert(FactorVerifiers.Related.selector);
        vf.check(id, true, WHY);
        _check(id, claude, false);
        _dispute(id);
        vm.prank(agentA);
        vm.expectRevert(FactorVerifiers.Related.selector);
        vf.sit(id, keccak256("x"));
        vm.prank(hirer);
        vm.expectRevert(FactorVerifiers.Related.selector);
        vf.sit(id, keccak256("x"));
        assertTrue(vf.related(id, hirer) && vf.related(id, agentA));
        assertFalse(vf.related(id, gemini));
    }

    /// 2. The agent's runner checks it: the agent is a line account and its key is a verifier; or the verifier's own
    ///    line account is the agent; or the customer's. All refused on the chain.
    function test_attack2_aLineAccountsKeyCannotCheckItsAccount() public {
        address key = makeAddr("a key that runs a line account agent");
        vm.prank(key);
        desk.register();
        FactorLineAccount acct = _open(key); // registered on the desk as it opens
        _join(key, 9);
        uint256 id = _hire(hirer, address(acct), PRICE, FEE);
        _deliverCase(id);
        assertTrue(vf.related(id, key));
        vm.prank(key);
        vm.expectRevert(FactorVerifiers.Related.selector);
        vf.check(id, true, WHY);

        // the customer is a line account and the verifier is its key
        address ckey = makeAddr("a key whose line account hires");
        vm.prank(ckey);
        desk.register();
        FactorLineAccount cacct = _open(ckey);
        _join(ckey, 10);
        uint256 id2 = _hire(address(cacct), agentA, PRICE, FEE);
        assertTrue(vf.related(id2, ckey));
    }

    /// 3. A tie the chain cannot see (the same owner behind a verifier and the agent, as Factor's records show it):
    ///    the other side strikes it. It has its stake back, cannot sit on the case again, and its seat is open.
    function test_attack3_aHiddenTieIsStruck() public {
        uint256 id = _checked(true);
        _dispute(id);
        _sit(id, gemini, true); // run by the agent's owner, as the case page shows
        vm.prank(hirer);
        vf.strike(id, gemini);
        vm.prank(gemini);
        vm.expectRevert(FactorVerifiers.StruckOff.selector);
        vf.sit(id, keccak256("again"));
        _sit(id, gpt, false);
        assertEq(vf.seats(id)[0].verifier, gpt);
        assertEq(_locked(gemini), 0);
        _vbooks();
    }

    /// 4. Collusion by speed: a side disputes and fills the panel in the same moment with fresh verifiers of its own.
    ///    Being first wins nothing: verifiers of an older standing take those seats until seating closes.
    function test_attack4_freshVerifiersFillingThePanelAreMovedOut() public {
        uint256 id = _checked(true);
        address s1 = makeAddr("sybil one");
        address s2 = makeAddr("sybil two");
        address s3 = makeAddr("sybil three");
        _join(s1, 2);
        _join(s2, 3);
        _join(s3, 4);
        _dispute(id);
        _sit(id, s1, false);
        _sit(id, s2, false);
        _sit(id, s3, false);
        // hours later the established verifiers volunteer
        vm.warp(block.timestamp + 3 hours);
        _sit(id, gemini, true);
        _sit(id, gpt, true);
        _sit(id, grok, true);
        FactorVerifiers.Seat[3] memory s = vf.seats(id);
        for (uint256 i = 0; i < 3; ++i) {
            assertTrue(
                s[i].verifier == gemini || s[i].verifier == gpt || s[i].verifier == grok, "only the older ones sit"
            );
        }
        assertEq(_locked(s1) + _locked(s2) + _locked(s3), 0, "the moved-out stakes are free");
        _toReveals(id);
        _reveal(id, gemini, true);
        _reveal(id, gpt, true);
        _reveal(id, grok, true);
        vf.step(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Accepted));
        _vbooks();
    }

    /// 5. Collusion by copying: a panelist waits to see the others' votes. Votes are sealed until seating closes, and a
    ///    reveal that is not what was sealed is refused, so a vote cannot be changed after seeing the others.
    function test_attack5_votesAreSealed() public {
        uint256 id = _checked(true);
        _dispute(id);
        _sit(id, gemini, false);
        _sit(id, gpt, true);
        vm.prank(gpt);
        vm.expectRevert();
        vf.reveal(id, true, WHY, _salt(gpt)); // too soon: nobody can reveal while seats are still open
        _toReveals(id);
        _reveal(id, gemini, false);
        // gpt sealed accept; seeing gemini's reject, it tries to switch
        vm.prank(gpt);
        vm.expectRevert(FactorVerifiers.BadReveal.selector);
        vf.reveal(id, false, WHY, _salt(gpt));
        // and the commit names the case and the verifier, so one cannot be reused for another case or seat
        assertTrue(vf.commitOf(id, gpt, true, WHY, _salt(gpt)) != vf.commitOf(id + 1, gpt, true, WHY, _salt(gpt)));
        assertTrue(vf.commitOf(id, gpt, true, WHY, _salt(gpt)) != vf.commitOf(id, grok, true, WHY, _salt(gpt)));
    }

    /// 6. Withdrawing bond during an open case, to escape a loss. Only bond that is not staked comes out; the stake
    ///    stays until the case ends, and the loss is taken from it.
    function test_attack6_aStakeCannotBeWithdrawnDuringACase() public {
        uint256 id = _checked(true);
        uint256 free = _free(claude);
        vm.prank(claude);
        vf.withdraw(free);
        assertEq(_free(claude), 0);
        assertEq(_locked(claude), 0.002 ether);
        vm.prank(claude);
        vm.expectRevert(abi.encodeWithSelector(FactorVerifiers.OverFree.selector, 0));
        vf.withdraw(1);
        _dispute(id);
        _sit(id, gemini, false);
        _sit(id, gpt, false);
        _toReveals(id);
        _reveal(id, gemini, false);
        _reveal(id, gpt, false);
        vf.step(id);
        assertEq(_free(claude), 0.001 ether, "it lost half of what stayed staked");
        assertEq(vf.verifier(claude).since, 0, "and its standing, being under the minimum");
        _vbooks();
    }

    /// 7. Griefing with disputes: a customer disputes every verdict of accept. Each dispute costs its bond, which goes to
    ///    the verifiers who judged right when the panel agrees with the first verdict.
    function test_attack7_aDisputeIsNotFree() public {
        uint256 h0 = hirer.balance;
        uint256 id = _checked(true);
        _dispute(id);
        _sit(id, gemini, true);
        _sit(id, gpt, true);
        _toReveals(id);
        _reveal(id, gemini, true);
        _reveal(id, gpt, true);
        vf.step(id);
        assertEq(hirer.balance, h0, "the dispute bond is gone");
        assertEq(_free(claude) + _free(gemini) + _free(gpt), 3 * BOND + FEE + 0.001 ether);
        _vbooks();
    }

    /// 8. Stalling, every way: nobody checks, the panelists never reveal, the customer never answers. Each has an end,
    ///    and the last one is the desk's own 24 hours, after which anyone settles the job as accepted.
    function test_attack8_stallingAlwaysEnds() public {
        // a silent panel
        uint256 id = _checked(false);
        _dispute(id);
        _sit(id, gemini, true);
        _sit(id, gpt, true);
        _pastReveals(id);
        vf.step(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.CustomerDecides));
        assertEq(vf.verifier(gemini).hidden, 1);
        // and a silent customer after it
        vm.warp(_delivered(id) + 24 hours);
        vf.step(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Accepted));
        _vbooks();
        _verifierBooks();
    }

    /// 8b. An agent that never delivers holds nothing: the job and the fee come back after the due time and grace.
    function test_attack8b_anAgentThatNeverDelivers() public {
        uint256 id = _hire();
        vm.warp(desk.job(_jobOf(id)).dueAt + desk.GRACE() + 1);
        uint256 h = hirer.balance;
        vm.prank(stranger);
        vf.step(id);
        assertEq(hirer.balance - h, PRICE + FEE);
        _vbooks();
    }

    /// 9. Re-entry: a customer whose wallet calls back in when it is paid, a verifier whose wallet calls back in when it
    ///    withdraws. Every way back in is shut while a call runs.
    function test_attack9_reentry() public {
        VReenterer r = new VReenterer(vf);
        vm.deal(address(r), 1 ether);
        uint256 id = r.hire{value: PRICE + FEE}(agentA, FEE, TERMS);
        _deliverCase(id);
        r.arm(abi.encodeCall(FactorVerifiers.collect, (address(r))));
        r.accept(id); // the fee comes back to it, and it tries to come back in
        assertTrue(r.reentered());
        assertFalse(r.succeeded());

        VReenterer w = new VReenterer(vf);
        vm.deal(address(w), 1 ether);
        w.join{value: BOND}(12);
        w.arm(abi.encodeCall(FactorVerifiers.withdraw, (0.01 ether)));
        w.withdraw(0.01 ether);
        assertTrue(w.reentered());
        assertFalse(w.succeeded(), "a second withdrawal from inside the first is refused");
        assertEq(vf.verifier(address(w)).free, BOND - 0.01 ether);
        _vbooks();
    }

    /// 10. Rounding: a pot that does not divide by the verifiers who judged right. Every wei goes to someone, the first
    ///     of them takes what does not divide, and the books hold to the wei. Fuzzed over prices and fees.
    function testFuzz_attack10_roundingLeavesNothingBehind(uint64 rawPrice, uint64 rawFee) public {
        uint256 price = bound(uint256(rawPrice), 0.001 ether, 0.2 ether);
        uint256 fee = bound(uint256(rawFee), vf.MIN_FEE(), price);
        uint256 id = _hire(hirer, agentA, price, fee);
        _deliverCase(id);
        _check(id, claude, true);
        _dispute(id);
        _sit(id, gemini, true);
        _sit(id, gpt, true);
        _sit(id, grok, false);
        _toReveals(id);
        _reveal(id, gemini, true);
        _reveal(id, gpt, true);
        _reveal(id, grok, false);
        vf.step(id);
        uint256 stake = vf.stakeOf(price);
        uint256 pot = fee + vf.disputeBondOf(price) + stake / 2;
        uint256 share = pot / 3;
        assertEq(_free(claude), BOND + share + (pot - share * 3));
        assertEq(_free(gemini), BOND + share);
        assertEq(_free(grok), BOND - stake / 2);
        _vbooks();
        _verifierBooks();
    }

    /// 11. Forcing ETH in, or sending it plainly. Plain ETH from anybody but the desk is refused; forced ETH adds to
    ///     nobody's claim.
    function test_attack11_forcedEthIsNobodys() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(vf).call{value: 0.1 ether}("");
        assertFalse(ok);
        new ForceSend{value: 0.1 ether}(payable(address(vf)));
        uint256 id = _checked(true);
        vm.warp(block.timestamp + vf.DISPUTE_TIME());
        vf.step(id);
        assertEq(address(vf).balance, vf.bonds() + vf.staked() + vf.fees() + vf.disputes() + vf.owedTotal() + 0.1 ether);
    }

    /// 12. A step with too little gas, to push a payout into owed: refused whole before anything moves.
    function test_attack12_tooLittleGas() public {
        uint256 id = _hire();
        _deliverCase(id);
        vm.warp(_delivered(id) + vf.CHECK_TIME());
        (bool ok,) = address(vf).call{gas: 120_000}(abi.encodeCall(FactorVerifiers.step, (id)));
        assertFalse(ok);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Working));
        assertEq(vf.owedTotal(), 0);
    }

    /// 13. A customer whose wallet eats all the gas it is given: its payout is kept for it alone, nothing waits.
    function test_attack13_aCustomerThatEatsGas() public {
        GasEater eater = new GasEater();
        uint256 id = _hire(address(eater), agentA, PRICE, FEE);
        _deliverCase(id);
        _check(id, claude, false);
        vm.warp(block.timestamp + vf.DISPUTE_TIME());
        vf.step(id);
        assertEq(vf.owed(address(eater)), 0.005 ether);
        assertEq(_free(claude), BOND + FEE, "the verifier is paid all the same");
        _vbooks();
    }

    /// 14. Putting on a maker for one panel: a verifier switches its declared maker to fill a free seat. Not with a seat
    ///     open, and a switch starts its standing again, so it would only sit where nobody older wants the seat.
    function test_attack14_aMakerCannotBeWornForOnePanel() public {
        uint256 id = _checked(true);
        _dispute(id);
        _sit(id, gemini, true);
        vm.prank(gemini);
        vm.expectRevert(FactorVerifiers.HasOpenSeats.selector);
        vf.setMaker(3);
        // claude2 (Anthropic) puts on Google after Gemini sat: its standing is now the newest, so it cannot take Gemini's
        vm.prank(claude2);
        vf.setMaker(GOOGLE);
        vm.prank(claude2);
        vm.expectRevert(FactorVerifiers.MakerTaken.selector);
        vf.sit(id, keccak256("x"));
    }

    /// 15. A friend of the agent rushes the first check with a verdict of accept. The customer disputes, the panel
    ///     overturns it, and the friend loses half of its stake to the verifiers who judged right.
    function test_attack15_aRushedFriendlyCheckIsOverturned() public {
        address friend = makeAddr("the agent's friend");
        _join(friend, 11);
        uint256 id = _hire();
        _deliverCase(id);
        _check(id, friend, true);
        _dispute(id);
        _sit(id, gemini, false);
        _sit(id, gpt, false);
        _sit(id, grok, false);
        _toReveals(id);
        _reveal(id, gemini, false);
        _reveal(id, gpt, false);
        _reveal(id, grok, false);
        uint256 h = hirer.balance;
        vf.step(id);
        assertEq(hirer.balance - h, 0.005 ether + 0.001 ether, "half back, and the dispute bond");
        assertEq(vf.verifier(friend).free, BOND - 0.001 ether);
        assertEq(vf.verifier(friend).wrong, 1);
        _vbooks();
    }

    /// 16. Answering for the contract on the desk, or striking for a side that is not yours.
    function test_attack16_nobodyAnswersForTheContract() public {
        uint256 id = _checked(true);
        uint256 job = _jobOf(id);
        vm.prank(hirer);
        vm.expectRevert(FactorDesk.NotCustomer.selector);
        desk.reject(job);
        vm.prank(stranger);
        vm.expectRevert(FactorVerifiers.NotCustomer.selector);
        vf.accept(id);
        vm.prank(stranger);
        vm.expectRevert(FactorVerifiers.NotCustomer.selector);
        vf.reject(id);
        _dispute(id);
        vm.prank(gemini);
        vm.expectRevert(FactorVerifiers.NotYourSide.selector);
        vf.strike(id, gemini);
    }

    /// 17. Keeping a standing with dust: a verifier takes out all but a wei to keep its place in line for later. A bond
    ///     under the minimum has no standing; topping it up starts a new one.
    function test_attack17_aStandingNeedsTheBond() public {
        uint256 amount = BOND - 1;
        vm.prank(claude);
        vf.withdraw(amount);
        assertEq(vf.verifier(claude).since, 0);
        uint256 id = _hire();
        _deliverCase(id);
        vm.prank(claude);
        vm.expectRevert(FactorVerifiers.NoStanding.selector);
        vf.check(id, true, WHY);
    }

    /// 18. The customer disputes, then strikes the one panelist who would uphold the verdict, hoping for no panel. One
    ///     strike only; the seat refills, and a tie keeps the first verdict.
    function test_attack18_oneStrikeCannotEmptyAPanel() public {
        uint256 id = _checked(true);
        _dispute(id);
        _sit(id, gemini, true);
        vm.prank(hirer);
        vf.strike(id, gemini);
        _sit(id, gpt, true);
        vm.prank(hirer);
        vm.expectRevert(FactorVerifiers.StrikeUsed.selector);
        vf.strike(id, gpt);
        _toReveals(id);
        _reveal(id, gpt, true);
        vf.step(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Accepted));
        _vbooks();
    }

    /// 19. A panelist who never reveals, to make a tie or no panel: it loses all of its stake, and one silent seat
    ///     cannot turn a verdict.
    function test_attack19_silenceCostsTheWholeStake() public {
        uint256 id = _checked(true);
        _dispute(id);
        _sit(id, gemini, true);
        _sit(id, gpt, false);
        _sit(id, grok, false);
        _toReveals(id);
        _reveal(id, gemini, true);
        _reveal(id, gpt, false);
        _pastReveals(id);
        vf.step(id);
        assertEq(uint8(_stateOf(id)), uint8(FactorVerifiers.State.Accepted), "one to one: the first verdict");
        assertEq(_free(grok), BOND - 0.002 ether);
        _vbooks();
    }
}
