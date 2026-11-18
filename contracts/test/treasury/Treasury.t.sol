// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {VouchBase} from "../vouching/VouchBase.sol";
import {Rejecter} from "../mocks/Actors.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorClaims} from "../../src/FactorClaims.sol";
import {FactorVouch} from "../../src/FactorVouch.sol";
import {FactorTreasury} from "../../src/FactorTreasury.sol";

/// A key that sells a claim and, when it is paid for it, tries to come back into the treasury: to run it again and to
/// take another agent's money out. Whatever it manages is recorded.
contract ReenteringSeller {
    FactorTreasury internal t;
    FactorClaims internal cl;
    address internal victim;
    bool public tried;
    bool public ranAgain;
    bool public withdrew;

    constructor(FactorTreasury t_, FactorClaims cl_, address victim_) {
        t = t_;
        cl = cl_;
        victim = victim_;
    }

    function open() external returns (address) {
        return cl.open();
    }

    function list(uint256 job, uint256 price) external returns (uint256) {
        return cl.list(job, price);
    }

    receive() external payable {
        tried = true;
        uint256[] memory none = new uint256[](0);
        try t.run(victim, none) {
            ranAgain = true;
        } catch {}
        try t.withdraw(payable(address(this)), 1) {
            withdrew = true;
        } catch {}
    }
}

/// An agent that is a contract and, when its withdrawal arrives, tries to withdraw again and to run itself.
contract ReenteringAgent {
    FactorTreasury internal t;
    bool public again;

    constructor(FactorTreasury t_) {
        t = t_;
    }

    function withdraw(uint256 amount) external {
        t.withdraw(payable(address(this)), amount);
    }

    receive() external payable {
        try t.withdraw(payable(address(this)), 1) {
            again = true;
        } catch {}
    }
}

/// The rules of docs/TREASURY.md, and the attacks on them. The treasury stands beside the desk, the line contract, the
/// guarantee contract, the vouching contract and the claims contract of the other tests, which know nothing of it.
contract TreasuryTest is VouchBase {
    FactorClaims internal cl;
    FactorTreasury internal t;

    /// an agent with a credit line: its key owns the treasury
    address internal key = makeAddr("an agent's key, with a line and a treasury");
    FactorLineAccount internal acct;
    /// a seller of locked pay
    address internal seller = makeAddr("a seller of locked pay");
    address internal sellerAcct;

    uint256 internal constant PRICE = 0.01 ether; // a job's price
    uint256 internal constant FACE = 0.0098 ether; // less the desk's 2% job fee
    uint256 internal constant ASK = 0.0094 ether; // about 4% under the face

    function setUp() public override {
        super.setUp();
        cl = new FactorClaims(desk);
        t = new FactorTreasury(vc, cl);
        vm.prank(key);
        desk.register();
        acct = _open(key);
        vm.prank(seller);
        sellerAcct = cl.open();
    }

    // ---------- moves ----------

    function _put(address agent, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        t.deposit{value: amount}(agent);
    }

    function _rules(address agent, FactorTreasury.Rules memory r) internal {
        vm.prank(agent);
        t.setRules(r);
    }

    function _none() internal pure returns (uint256[] memory) {
        return new uint256[](0);
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    /// The agent's line owes `amount`: a bond at its line account, then a draw.
    function _owes(uint256 amount) internal {
        _lineBond(key, amount * 2);
        _lineDraw(key, amount, false);
        assertEq(line.debtOf(address(acct)), amount);
    }

    /// The seller lists the claim on a fresh job of its pay account.
    function _listed(uint256 ask) internal returns (uint256 id, uint256 job) {
        job = _lock(sellerAcct, PRICE, false);
        vm.prank(seller);
        id = cl.list(job, ask);
    }

    function _claimRules() internal pure returns (FactorTreasury.Rules memory r) {
        r.claims = true;
        r.claimsDaily = 1 ether;
        r.claimMaxPrice = 0.01 ether;
    }

    function _tbooks() internal view {
        assertEq(address(t).balance, t.held(), "the treasury holds exactly what its books say");
    }

    // ---------- wiring ----------

    function test_wiredFromTheVouchingAndClaimsContracts() public view {
        assertEq(address(t.vouch()), address(vc));
        assertEq(address(t.claims()), address(cl));
        assertEq(address(t.guarantee()), address(g));
        assertEq(address(t.line()), address(line));
        assertEq(address(t.desk()), address(desk));
        assertEq(t.gateway(), gateway);
        assertEq(t.MIN_STEP(), 0.0001 ether);
        assertEq(t.MAX_CLAIMS(), 10);
    }

    function test_aClaimsContractOfAnotherDeskIsRefused() public {
        FactorDesk other_ = new FactorDesk(address(burnPot), gateway);
        FactorClaims wrong = new FactorClaims(other_);
        vm.expectRevert(FactorTreasury.WrongDesk.selector);
        new FactorTreasury(vc, wrong);
        vm.expectRevert(FactorTreasury.ZeroAddress.selector);
        new FactorTreasury(FactorVouch(payable(address(0))), cl);
    }

    // ---------- money in ----------

    function test_anyoneDepositsForAnAgentAndGetsNoClaimOnIt() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        t.deposit{value: 0.3 ether}(key);
        assertEq(t.balanceOf(key), 0.3 ether);
        assertEq(t.balanceOf(stranger), 0);
        assertEq(t.totalsOf(key).deposited, 0.3 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FactorTreasury.OverBalance.selector, 0));
        t.withdraw(payable(stranger), 0.3 ether);
        _tbooks();
    }

    function test_depositRefusesNothingAndNobody() public {
        vm.expectRevert(FactorTreasury.ZeroAmount.selector);
        t.deposit(key);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(FactorTreasury.ZeroAddress.selector);
        t.deposit{value: 1}(address(0));
    }

    function test_plainEthIsTheSendersOwnDeposit() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(t).call{value: 0.2 ether}("");
        assertTrue(ok);
        assertEq(t.balanceOf(stranger), 0.2 ether);
        _tbooks();
    }

    /// The key withdraws from its line account straight into its treasury: the ETH is the key's, not the account's.
    function test_ethFromALineAccountGoesToItsKeysTreasury() public {
        _earn(key, 0.1 ether);
        uint256 has = address(acct).balance;
        assertGt(has, 0);
        vm.prank(key);
        acct.withdraw(payable(address(t)), has);
        assertEq(t.balanceOf(key), has);
        assertEq(t.balanceOf(address(acct)), 0);
        _tbooks();
    }

    /// And from its pay account, through the claims contract's withdraw.
    function test_ethFromAPayAccountGoesToItsKeysTreasury() public {
        uint256 job = _lock(sellerAcct, PRICE, false);
        vm.prank(seller);
        cl.deliver(job, keccak256("the work"));
        _accept(job);
        vm.prank(seller);
        cl.withdraw(payable(address(t)), FACE);
        assertEq(t.balanceOf(seller), FACE);
        _tbooks();
    }

    // ---------- money out: always ----------

    function test_onlyTheAgentWithdrawsAndOnlyItsOwn() public {
        _put(key, 1 ether);
        _put(agentA, 0.5 ether);
        vm.prank(agentA);
        vm.expectRevert(abi.encodeWithSelector(FactorTreasury.OverBalance.selector, 0.5 ether));
        t.withdraw(payable(agentA), 0.6 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FactorTreasury.OverBalance.selector, 0));
        t.withdraw(payable(stranger), 1);
        // a line account is not its key: only the key owns the treasury
        vm.prank(address(acct));
        vm.expectRevert(abi.encodeWithSelector(FactorTreasury.OverBalance.selector, 0));
        t.withdraw(payable(address(acct)), 1);
        vm.prank(key);
        t.withdraw(payable(other), 1 ether);
        assertEq(other.balance, 1 ether);
        assertEq(t.balanceOf(key), 0);
        assertEq(t.balanceOf(agentA), 0.5 ether, "another agent's money is untouched");
        _tbooks();
    }

    function test_withdrawRefusesNothingAndNobody() public {
        _put(key, 1 ether);
        vm.startPrank(key);
        vm.expectRevert(FactorTreasury.ZeroAmount.selector);
        t.withdraw(payable(key), 0);
        vm.expectRevert(FactorTreasury.ZeroAddress.selector);
        t.withdraw(payable(address(0)), 1);
        vm.stopPrank();
    }

    /// Every use on, a floor above the balance, the line owing and late: the whole balance still comes out.
    function test_withdrawAlwaysWorks_whateverTheRulesAndTheLine() public {
        _owes(0.01 ether);
        _put(key, 1 ether);
        FactorTreasury.Rules memory r = _claimRules();
        r.floor = 5 ether;
        r.repay = true;
        r.compute = true;
        r.guarantee = true;
        r.vouch = true;
        _rules(key, r);
        vm.warp(block.timestamp + 45 days);
        assertTrue(line.isLate(address(acct)));
        uint256 before = key.balance;
        vm.prank(key);
        t.withdraw(payable(key), 1 ether);
        assertEq(key.balance - before, 1 ether);
        assertEq(t.balanceOf(key), 0);
        _tbooks();
    }

    function test_withdrawAfterARunTakesAllThatIsLeft() public {
        _put(key, 1 ether);
        FactorTreasury.Rules memory r;
        r.compute = true;
        r.computeDaily = 0.1 ether;
        _rules(key, r);
        t.run(key, _none());
        uint256 before = key.balance;
        vm.prank(key);
        t.withdraw(payable(key), 0.9 ether);
        assertEq(key.balance - before, 0.9 ether);
        assertEq(address(t).balance, 0);
    }

    /// A wallet that refuses ETH blocks nobody: the agent names another address.
    function test_aRefusingAddressIsTheAgentsToChange() public {
        _put(key, 1 ether);
        Rejecter no = new Rejecter();
        vm.prank(key);
        vm.expectRevert(FactorTreasury.PushFailed.selector);
        t.withdraw(payable(address(no)), 1 ether);
        vm.prank(key);
        t.withdraw(payable(other), 1 ether);
        assertEq(other.balance, 1 ether);
    }

    function test_attack_reenteringWithdrawTakesNothingMore() public {
        ReenteringAgent a = new ReenteringAgent(t);
        _put(address(a), 1 ether);
        a.withdraw(0.4 ether);
        assertFalse(a.again(), "the second withdrawal inside the first is refused");
        assertEq(address(a).balance, 0.4 ether);
        assertEq(t.balanceOf(address(a)), 0.6 ether);
        _tbooks();
    }

    // ---------- rules ----------

    function test_rulesAreTheAgentsOwn() public {
        FactorTreasury.Rules memory r;
        r.floor = 0.5 ether;
        r.compute = true;
        r.computeDaily = 0.01 ether;
        _rules(key, r);
        assertEq(t.rulesOf(key).floor, 0.5 ether);
        assertTrue(t.rulesOf(key).compute);
        assertEq(t.rulesOf(stranger).floor, 0, "nobody else's rules moved");
        assertFalse(t.rulesOf(address(acct)).compute);
    }

    function test_rulesOutOfRangeAreRefused() public {
        FactorTreasury.Rules memory r;
        r.claimMinDiscountBps = 10_001;
        vm.prank(key);
        vm.expectRevert(FactorTreasury.BadRules.selector);
        t.setRules(r);
        r.claimMinDiscountBps = 0;
        r.claimMinScore = 1001;
        vm.prank(key);
        vm.expectRevert(FactorTreasury.BadRules.selector);
        t.setRules(r);
    }

    function test_noRules_nothingIsEverSpent() public {
        _owes(0.01 ether);
        _put(key, 1 ether);
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(key, _none());
        assertEq(t.balanceOf(key), 1 ether);
    }

    // ---------- 1 the line ----------

    function test_run_repaysTheLineUpToWhatItOwes() public {
        _owes(0.01 ether);
        _put(key, 1 ether);
        FactorTreasury.Rules memory r;
        r.repay = true;
        r.repayDaily = 1 ether;
        _rules(key, r);
        vm.expectEmit(true, true, false, true);
        emit FactorTreasury.LineRepaid(key, address(acct), 0.01 ether, 0);
        vm.prank(stranger);
        uint256 spent = t.run(key, _none());
        assertEq(spent, 0.01 ether);
        assertEq(line.debtOf(address(acct)), 0);
        assertEq(line.line(address(acct)).onTime, 1, "the line counts it as repaid on time");
        assertEq(t.balanceOf(key), 0.99 ether);
        assertEq(t.totalsOf(key).repaid, 0.01 ether);
        assertEq(t.totalsOf(key).runs, 1);
        _tbooks();
        _lineBooks();
    }

    function test_run_theDailyAmountHoldsAndTheNextDayGoesOn() public {
        _owes(0.01 ether);
        _put(key, 1 ether);
        FactorTreasury.Rules memory r;
        r.repay = true;
        r.repayDaily = 0.004 ether;
        _rules(key, r);
        t.run(key, _none());
        assertEq(line.debtOf(address(acct)), 0.006 ether);
        assertEq(t.spentToday(key, FactorTreasury.Step.Repay), 0.004 ether);
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(key, _none());
        vm.warp(block.timestamp + 1 days);
        assertEq(t.spentToday(key, FactorTreasury.Step.Repay), 0);
        t.run(key, _none());
        assertEq(line.debtOf(address(acct)), 0.002 ether);
    }

    /// While repaying is on and the line still owes, nothing else is done, however much is there.
    function test_order_theLineFirst_nothingElseWhileItOwes() public {
        _owes(0.01 ether);
        _put(key, 1 ether);
        FactorTreasury.Rules memory r;
        r.repay = true;
        r.repayDaily = 0.004 ether;
        r.compute = true;
        r.computeDaily = 0.1 ether;
        r.guarantee = true;
        r.guaranteeUpTo = 0.1 ether;
        r.vouch = true;
        r.vouchUpTo = 0.1 ether;
        _rules(key, r);
        (uint256 repay, uint256 compute,, uint256 toG, uint256 toV, bool blocked) = t.preview(key, _none());
        assertEq(repay, 0.004 ether);
        assertEq(compute + toG + toV, 0);
        assertTrue(blocked);
        uint256 spent = t.run(key, _none());
        assertEq(spent, 0.004 ether, "only the repayment");
        assertEq(gateway.balance, 0);
        assertEq(g.bondOf(address(acct)).bond, 0);
    }

    /// The line repaid in full and the rest in the same run, in the order of the rules.
    function test_order_allFiveInOneRun() public {
        _owes(0.01 ether);
        (uint256 id, uint256 job) = _listed(ASK);
        _put(key, 1 ether);
        FactorTreasury.Rules memory r = _claimRules();
        r.floor = 0.5 ether;
        r.repay = true;
        r.repayDaily = 1 ether;
        r.compute = true;
        r.computeDaily = 0.02 ether;
        r.guarantee = true;
        r.guaranteeUpTo = 0.03 ether;
        r.vouch = true;
        r.vouchUpTo = 0.04 ether;
        _rules(key, r);
        uint256 gatewayBefore = gateway.balance;

        (uint256 repay, uint256 compute, uint256[] memory prices, uint256 toG, uint256 toV, bool blocked) =
            t.preview(key, _one(id));
        assertEq(repay, 0.01 ether);
        assertEq(compute, 0.02 ether);
        assertEq(prices[0], ASK);
        assertEq(toG, 0.03 ether);
        assertEq(toV, 0.04 ether);
        assertFalse(blocked);

        vm.recordLogs();
        uint256 spent = t.run(key, _one(id));
        assertEq(spent, repay + compute + ASK + toG + toV, "the run did what the preview said");
        _inOrder();

        assertEq(line.debtOf(address(acct)), 0);
        assertEq(gateway.balance - gatewayBefore, 0.02 ether);
        assertEq(cl.claim(id).holder, key, "the claim is the agent's own");
        assertEq(g.bondOf(address(acct)).bond, 0.03 ether, "the bond of its desk address, the line account");
        assertEq(vc.voucherOf(key).bond, 0.04 ether);
        assertEq(t.balanceOf(key), 1 ether - spent);
        FactorTreasury.Totals memory tt = t.totalsOf(key);
        assertEq(tt.repaid, 0.01 ether);
        assertEq(tt.compute, 0.02 ether);
        assertEq(tt.claims, ASK);
        assertEq(tt.claimsBought, 1);
        assertEq(tt.guarantee, 0.03 ether);
        assertEq(tt.vouch, 0.04 ether);
        _tbooks();
        _gbooks();
        _vbooks();

        // the job is delivered and accepted: its pay goes to the agent, the holder
        uint256 before = key.balance;
        vm.prank(seller);
        cl.deliver(job, keccak256("the work"));
        _accept(job);
        cl.settle(id);
        assertEq(key.balance - before, FACE, "the job paid the agent the face");
    }

    /// The treasury's own events of the last run came in the order of the rules.
    function _inOrder() internal {
        bytes32[5] memory want = [
            FactorTreasury.LineRepaid.selector,
            FactorTreasury.ComputePrepaid.selector,
            FactorTreasury.ClaimBought.selector,
            FactorTreasury.GuaranteeBacked.selector,
            FactorTreasury.VouchBacked.selector
        ];
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(t) || n == 5) continue;
            if (logs[i].topics[0] == want[n]) ++n;
        }
        assertEq(n, 5, "each step's receipt, in order");
    }

    function test_run_withRepayOff_theOtherUsesGoOnThoughTheLineOwes() public {
        _owes(0.01 ether);
        _put(key, 1 ether);
        FactorTreasury.Rules memory r;
        r.compute = true;
        r.computeDaily = 0.01 ether;
        _rules(key, r);
        t.run(key, _none());
        assertEq(gateway.balance, 0.01 ether);
        assertEq(line.debtOf(address(acct)), 0.01 ether, "the agent chose not to repay from here");
    }

    // ---------- the floor ----------

    function test_floor_aRunNeverGoesBelowIt() public {
        _owes(0.01 ether);
        _put(key, 0.104 ether);
        FactorTreasury.Rules memory r;
        r.floor = 0.1 ether;
        r.repay = true;
        r.repayDaily = 1 ether;
        _rules(key, r);
        assertEq(t.spendable(key), 0.004 ether);
        t.run(key, _none());
        assertEq(t.balanceOf(key), 0.1 ether);
        assertEq(line.debtOf(address(acct)), 0.006 ether);
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(key, _none());
    }

    function test_floor_atOrUnderIt_nothing() public {
        _put(key, 0.1 ether);
        FactorTreasury.Rules memory r;
        r.floor = 0.1 ether;
        r.compute = true;
        r.computeDaily = 1 ether;
        _rules(key, r);
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(key, _none());
        r.floor = 5 ether;
        _rules(key, r);
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(key, _none());
    }

    // ---------- 2 compute ----------

    function test_compute_goesToTheGatewayUpToTheDailyAmount() public {
        _put(agentA, 1 ether);
        FactorTreasury.Rules memory r;
        r.compute = true;
        r.computeDaily = 0.003 ether;
        _rules(agentA, r);
        vm.expectEmit(true, true, false, true);
        emit FactorTreasury.ComputePrepaid(agentA, gateway, 0.003 ether);
        t.run(agentA, _none());
        assertEq(gateway.balance, 0.003 ether);
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(agentA, _none());
        vm.warp(block.timestamp + 1 days);
        t.run(agentA, _none());
        assertEq(gateway.balance, 0.006 ether);
        assertEq(t.totalsOf(agentA).compute, 0.006 ether);
    }

    function test_compute_nothingSmallerThanTheLeastStep() public {
        _put(agentA, 0.00009 ether);
        FactorTreasury.Rules memory r;
        r.compute = true;
        r.computeDaily = 1 ether;
        _rules(agentA, r);
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(agentA, _none());
    }

    /// A gateway that refuses ETH: the step is skipped, the ETH stays, and the steps after it still run.
    function test_compute_aRefusingGatewayIsSkipped() public {
        vm.etch(gateway, address(new Rejecter()).code);
        _put(agentA, 1 ether);
        FactorTreasury.Rules memory r;
        r.compute = true;
        r.computeDaily = 0.01 ether;
        r.guarantee = true;
        r.guaranteeUpTo = 0.02 ether;
        _rules(agentA, r);
        vm.expectEmit(true, false, false, true);
        emit FactorTreasury.Skipped(agentA, FactorTreasury.Step.Compute, 0);
        uint256 spent = t.run(agentA, _none());
        assertEq(spent, 0.02 ether);
        assertEq(t.spentToday(agentA, FactorTreasury.Step.Compute), 0);
        assertEq(g.bondOf(agentA).bond, 0.02 ether);
        _tbooks();
    }

    // ---------- 3 locked pay ----------

    function test_claims_aClaimInsideTheRulesIsBoughtAndHandedToTheAgent() public {
        (uint256 id, uint256 job) = _listed(ASK);
        _put(agentA, 1 ether);
        _rules(agentA, _claimRules());
        uint256 before = seller.balance;
        vm.expectEmit(true, true, true, true);
        emit FactorTreasury.ClaimBought(agentA, id, job, ASK, FACE);
        t.run(agentA, _one(id));
        assertEq(seller.balance - before, ASK, "the price went straight to the seller");
        FactorClaims.Claim memory c = cl.claim(id);
        assertEq(uint8(c.state), uint8(FactorClaims.State.Sold));
        assertEq(c.holder, agentA);
        assertEq(c.buyer, address(t));
        assertEq(t.balanceOf(agentA), 1 ether - ASK);
        _tbooks();
    }

    function _refused(uint256 id) internal {
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(agentA, _one(id));
        assertEq(uint8(cl.claim(id).state), uint8(FactorClaims.State.Listed));
    }

    function test_claims_overTheMostForOneClaimIsLeft() public {
        (uint256 id,) = _listed(ASK);
        _put(agentA, 1 ether);
        FactorTreasury.Rules memory r = _claimRules();
        r.claimMaxPrice = ASK - 1;
        _rules(agentA, r);
        _refused(id);
    }

    function test_claims_notFarEnoughUnderItsFaceIsLeft() public {
        (uint256 id,) = _listed(ASK); // 4.08% under
        _put(agentA, 1 ether);
        FactorTreasury.Rules memory r = _claimRules();
        r.claimMinDiscountBps = 500;
        _rules(agentA, r);
        _refused(id);
        r.claimMinDiscountBps = 400;
        _rules(agentA, r);
        t.run(agentA, _one(id));
        assertEq(cl.claim(id).holder, agentA);
    }

    function test_claims_aSellerUnderTheLeastScoreIsLeft() public {
        (uint256 id,) = _listed(ASK);
        _put(agentA, 1 ether);
        FactorTreasury.Rules memory r = _claimRules();
        r.claimMinScore = 200;
        _rules(agentA, r);
        assertLt(desk.score(sellerAcct), 200);
        _refused(id);
        _mockScore(sellerAcct, 200);
        t.run(agentA, _one(id));
        assertEq(cl.claim(id).holder, agentA);
    }

    function test_claims_deliveredOnly() public {
        (uint256 id, uint256 job) = _listed(ASK);
        _put(agentA, 1 ether);
        FactorTreasury.Rules memory r = _claimRules();
        r.claimDeliveredOnly = true;
        _rules(agentA, r);
        _refused(id);
        vm.prank(seller);
        cl.deliver(job, keccak256("the work"));
        t.run(agentA, _one(id));
        assertEq(cl.claim(id).holder, agentA);
    }

    function test_claims_theDailyAmountHolds() public {
        (uint256 a,) = _listed(ASK);
        (uint256 b,) = _listed(ASK);
        _put(agentA, 1 ether);
        FactorTreasury.Rules memory r = _claimRules();
        r.claimsDaily = ASK + 1;
        _rules(agentA, r);
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        (,, uint256[] memory prices,,,) = t.preview(agentA, ids);
        assertEq(prices[0], ASK);
        assertEq(prices[1], 0);
        t.run(agentA, ids);
        assertEq(cl.claim(a).holder, agentA);
        assertEq(uint8(cl.claim(b).state), uint8(FactorClaims.State.Listed), "the second is over the day's amount");
        vm.warp(block.timestamp + 6 hours);
        _refused(b);
    }

    function test_claims_neverBelowTheFloor() public {
        (uint256 id,) = _listed(ASK);
        _put(agentA, 0.1 ether);
        FactorTreasury.Rules memory r = _claimRules();
        r.floor = 0.1 ether - ASK + 1;
        _rules(agentA, r);
        _refused(id);
    }

    /// The treasury never buys its agent's own claim: that would only move its ETH to the agent's key.
    function test_claims_neverItsOwn() public {
        (uint256 id,) = _listed(ASK);
        _put(seller, 1 ether);
        _rules(seller, _claimRules());
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(seller, _one(id));
    }

    function test_claims_aClaimNotOnSaleOrNamedTwiceIsLeft() public {
        (uint256 id,) = _listed(ASK);
        _put(agentA, 1 ether);
        _rules(agentA, _claimRules());
        uint256[] memory ids = new uint256[](3);
        ids[0] = id;
        ids[1] = id;
        ids[2] = 999;
        (,, uint256[] memory prices,,,) = t.preview(agentA, ids);
        assertEq(prices[0], ASK);
        assertEq(prices[1] + prices[2], 0);
        uint256 spent = t.run(agentA, ids);
        assertEq(spent, ASK, "bought once");
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(agentA, _one(id));
    }

    function test_claims_noMoreThanTenNamed() public {
        _put(agentA, 1 ether);
        _rules(agentA, _claimRules());
        vm.expectRevert(FactorTreasury.TooMany.selector);
        t.run(agentA, new uint256[](11));
    }

    function test_claims_withTheUseOffNothingIsBought() public {
        (uint256 id,) = _listed(ASK);
        _put(agentA, 1 ether);
        FactorTreasury.Rules memory r = _claimRules();
        r.claims = false;
        _rules(agentA, r);
        _refused(id);
    }

    /// The seller's key refuses the price: the buy fails, the claim is skipped and the ETH stays.
    function test_claims_aRefusedBuyIsSkipped() public {
        Rejecter no = new Rejecter();
        vm.prank(address(no));
        address a = cl.open();
        uint256 job = _lock(a, PRICE, false);
        vm.prank(address(no));
        uint256 id = cl.list(job, ASK);
        _put(agentA, 1 ether);
        FactorTreasury.Rules memory r = _claimRules();
        r.compute = true;
        r.computeDaily = 0.001 ether;
        _rules(agentA, r);
        vm.expectEmit(true, false, false, true);
        emit FactorTreasury.Skipped(agentA, FactorTreasury.Step.Claims, id);
        uint256 spent = t.run(agentA, _one(id));
        assertEq(spent, 0.001 ether, "only the compute step spent");
        assertEq(t.spentToday(agentA, FactorTreasury.Step.Claims), 0);
        _tbooks();
    }

    /// A seller that comes back in while it is paid can neither run the treasury again nor take anything out.
    function test_attack_aSellerCannotReenterWhileItIsPaid() public {
        ReenteringSeller bad = new ReenteringSeller(t, cl, agentA);
        address a = bad.open();
        uint256 job = _lock(a, PRICE, false);
        uint256 id = bad.list(job, ASK);
        _put(agentA, 1 ether);
        _put(address(bad), 0.5 ether);
        FactorTreasury.Rules memory r = _claimRules();
        r.compute = true;
        r.computeDaily = 0.001 ether;
        _rules(agentA, r);
        t.run(agentA, _one(id));
        assertTrue(bad.tried());
        assertFalse(bad.ranAgain(), "no second run inside the first");
        assertFalse(bad.withdrew(), "no withdrawal inside a run");
        assertEq(address(bad).balance, ASK, "it was paid the price and nothing more");
        assertEq(t.balanceOf(agentA), 1 ether - ASK - 0.001 ether);
        assertEq(t.balanceOf(address(bad)), 0.5 ether);
        _tbooks();
    }

    // ---------- 4 and 5: the bonds ----------

    function test_guarantee_toppedUpToTheLevelAndNoFurther() public {
        _gbond(agentA, 0.004 ether);
        _put(agentA, 1 ether);
        FactorTreasury.Rules memory r;
        r.guarantee = true;
        r.guaranteeUpTo = 0.01 ether;
        _rules(agentA, r);
        vm.expectEmit(true, true, false, true);
        emit FactorTreasury.GuaranteeBacked(agentA, agentA, 0.006 ether, 0.01 ether);
        t.run(agentA, _none());
        assertEq(g.bondOf(agentA).bond, 0.01 ether);
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(agentA, _none());
        _gbooks();
    }

    function test_vouch_toppedUpToTheLevel_andTheAgentVouchesWithIt() public {
        _put(voucher, 1 ether);
        FactorTreasury.Rules memory r;
        r.vouch = true;
        r.vouchUpTo = 0.04 ether;
        _rules(voucher, r);
        vm.expectEmit(true, true, false, true);
        emit FactorTreasury.VouchBacked(voucher, voucher, 0.04 ether, 0.04 ether);
        t.run(voucher, _none());
        assertEq(vc.freeOf(voucher), 0.04 ether);
        // the bond the treasury put up stands behind a newer agent's line
        uint256 id = _offerLine(voucher, address(newAcct), 0.01 ether);
        _accept(address(newAcct), id);
        assertEq(uint8(vc.vouch(id).state), uint8(FactorVouch.State.Active));
        _vbooks();
    }

    function test_bonds_aGapSmallerThanTheLeastStepIsLeft() public {
        _gbond(agentA, 0.00995 ether);
        _put(agentA, 1 ether);
        FactorTreasury.Rules memory r;
        r.guarantee = true;
        r.guaranteeUpTo = 0.01 ether;
        _rules(agentA, r);
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(agentA, _none());
    }

    function test_bonds_anAddressNotOnTheDeskIsLeft() public {
        _put(stranger, 1 ether);
        FactorTreasury.Rules memory r;
        r.guarantee = true;
        r.guaranteeUpTo = 0.01 ether;
        r.vouch = true;
        r.vouchUpTo = 0.01 ether;
        _rules(stranger, r);
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(stranger, _none());
        assertEq(t.balanceOf(stranger), 1 ether);
    }

    function test_bonds_theFloorHolds() public {
        _put(agentA, 0.105 ether);
        FactorTreasury.Rules memory r;
        r.floor = 0.1 ether;
        r.guarantee = true;
        r.guaranteeUpTo = 1 ether;
        r.vouch = true;
        r.vouchUpTo = 1 ether;
        _rules(agentA, r);
        t.run(agentA, _none());
        assertEq(g.bondOf(agentA).bond, 0.005 ether, "the guarantee bond comes before the vouching bond");
        assertEq(vc.voucherOf(agentA).bond, 0);
        assertEq(t.balanceOf(agentA), 0.1 ether);
    }

    // ---------- several agents ----------

    function test_oneAgentsRunNeverTouchesAnothers() public {
        _put(agentA, 1 ether);
        _put(agentB, 1 ether);
        FactorTreasury.Rules memory r;
        r.compute = true;
        r.computeDaily = 0.5 ether;
        _rules(agentA, r);
        t.run(agentA, _none());
        assertEq(t.balanceOf(agentA), 0.5 ether);
        assertEq(t.balanceOf(agentB), 1 ether);
        vm.expectRevert(FactorTreasury.NothingToDo.selector);
        t.run(agentB, _none());
        _tbooks();
    }

    // ---------- fuzz ----------

    /// Whatever is put in, whatever the floor and the amounts: a run spends no more than what is above the floor and
    /// no more than the rules name, the line never gets more than it is owed, and the books hold.
    function testFuzz_aRunStaysInsideTheFloorAndTheAmounts(
        uint96 put,
        uint96 floor,
        uint96 repayDaily,
        uint96 computeDaily,
        uint96 upTo,
        uint96 debt
    ) public {
        put = uint96(bound(put, 1, 100 ether));
        debt = uint96(bound(debt, 0.0001 ether, 1 ether));
        _owes(debt);
        _put(key, put);
        FactorTreasury.Rules memory r;
        r.floor = floor;
        r.repay = true;
        r.repayDaily = repayDaily;
        r.compute = true;
        r.computeDaily = computeDaily;
        r.guarantee = true;
        r.guaranteeUpTo = upTo;
        r.vouch = true;
        r.vouchUpTo = upTo;
        _rules(key, r);
        _runAsPreviewed(put > floor ? put - floor : 0);
        assertGe(t.balanceOf(key), put < floor ? put : floor);
        FactorTreasury.Totals memory tt = t.totalsOf(key);
        assertLe(tt.repaid, debt);
        assertLe(tt.repaid, repayDaily);
        assertLe(tt.compute, computeDaily);
        assertLe(tt.guarantee, upTo);
        assertLe(tt.vouch, upTo);
        assertEq(line.debtOf(address(acct)), debt - tt.repaid);
        if (line.debtOf(address(acct)) != 0) assertEq(tt.compute + tt.guarantee + tt.vouch, 0, "the line first");
        assertEq(t.balanceOf(key), put - tt.repaid - tt.compute - tt.guarantee - tt.vouch);
        _tbooks();
        _allComesOut();
    }

    function _runAsPreviewed(uint256 room) internal {
        (uint256 pr, uint256 pc,, uint256 pg, uint256 pv,) = t.preview(key, _none());
        uint256 planned = pr + pc + pg + pv;
        try t.run(key, _none()) returns (uint256 spent) {
            assertEq(spent, planned, "the preview is what the run did");
            assertLe(spent, room, "never below the floor");
        } catch {
            assertEq(planned, 0, "it refused only because there was nothing to do");
        }
    }

    /// All that is left comes out.
    function _allComesOut() internal {
        uint256 left = t.balanceOf(key);
        if (left != 0) {
            vm.prank(key);
            t.withdraw(payable(other), left);
            assertEq(other.balance, left);
        }
        assertEq(address(t).balance, 0);
    }

    function testFuzz_withdrawNeverMoreThanItsOwn(uint96 mine, uint96 theirs, uint96 want) public {
        mine = uint96(bound(mine, 1, 100 ether));
        theirs = uint96(bound(theirs, 1, 100 ether));
        want = uint96(bound(want, 1, 300 ether));
        _put(key, mine);
        _put(agentA, theirs);
        vm.prank(key);
        if (want > mine) {
            vm.expectRevert(abi.encodeWithSelector(FactorTreasury.OverBalance.selector, uint256(mine)));
            t.withdraw(payable(other), want);
        } else {
            t.withdraw(payable(other), want);
            assertEq(other.balance, want);
        }
        assertEq(t.balanceOf(agentA), theirs);
        _tbooks();
    }

    /// A claim at any price the claims contract allows is bought only inside the agent's rules.
    function testFuzz_aClaimIsBoughtOnlyInsideTheRules(uint96 ask, uint96 maxPrice, uint16 minDiscount, uint96 daily)
        public
    {
        ask = uint96(bound(ask, (FACE * 9000) / 10_000, FACE));
        minDiscount = uint16(bound(minDiscount, 0, 1500));
        (uint256 id,) = _listed(ask);
        _put(agentA, 1 ether);
        FactorTreasury.Rules memory r = _claimRules();
        r.claimMaxPrice = maxPrice;
        r.claimMinDiscountBps = minDiscount;
        r.claimsDaily = daily;
        _rules(agentA, r);
        bool inside = ask <= maxPrice && ask <= daily && (FACE - ask) * 10_000 >= FACE * uint256(minDiscount);
        if (inside) {
            t.run(agentA, _one(id));
            assertEq(cl.claim(id).holder, agentA);
            assertEq(t.balanceOf(agentA), 1 ether - ask);
        } else {
            vm.expectRevert(FactorTreasury.NothingToDo.selector);
            t.run(agentA, _one(id));
            assertEq(t.balanceOf(agentA), 1 ether);
        }
        _tbooks();
    }
}
