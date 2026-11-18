// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorGuarantee} from "../../src/FactorGuarantee.sol";
import {FactorVouch} from "../../src/FactorVouch.sol";
import {FactorClaims} from "../../src/FactorClaims.sol";
import {FactorTreasury} from "../../src/FactorTreasury.sol";

/// The treasury against the contracts that are DEPLOYED on Robinhood Chain, at their real addresses, on a fork of the
/// chain (nothing here is sent anywhere): a treasury contract is deployed beside the live desk, line, guarantee, vouching
/// and claims contracts, which know nothing of it. The demo wallet's treasury repays its live credit line; a treasury
/// prepays compute to the live gateway; report-lead's treasury buys a claim listed on the live claims contract and is
/// paid when the job settles on the live desk; it tops up report-lead's live guarantee bond and vouching bond; and
/// everything left comes out.
contract TreasuryForkTest is ForkBase {
    FactorDesk constant DESK = FactorDesk(payable(0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F));
    FactorLine constant LINE = FactorLine(payable(0xc9405ca62eD1e9a4a058F404e5c1C893F7ae67c4));
    FactorGuarantee constant G = FactorGuarantee(payable(0x577A00Ad9B0a719C4465A3a887F969B0E377daEF));
    FactorVouch constant VOUCH = FactorVouch(payable(0x23ee52Fd61D3FbcBD1746BD2931554152AaFC248));
    FactorClaims constant CLAIMS = FactorClaims(payable(0xd2a678430BaDBB738789DA8e88Fd1c5F476A52Ba));
    address constant GATEWAY = 0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0;
    /// report-lead, a test agent of Factor's own on the live desk
    address constant LEAD = 0x74325C9644973d9C7A293BDFc970a573A38419e1;
    /// Factor's demo wallet and its live line account
    address constant DEMO = 0x50A9Bf50C3337d5db03efdF89DEB0F5A0B908f17;
    address constant DEMO_LINE = 0x4Af5cbd7BaAD4AE2F09d45fd9b55bD49214b2c5F;

    FactorTreasury t;
    address seller = makeAddr("a seller of locked pay, on the fork");
    address customer = makeAddr("a customer, on the fork");

    function setUp() public {
        _fork();
        t = new FactorTreasury(VOUCH, CLAIMS);
        vm.deal(LEAD, 1 ether);
        vm.deal(DEMO, 1 ether);
    }

    function _none() internal pure returns (uint256[] memory) {
        return new uint256[](0);
    }

    function _books() internal view {
        assertEq(address(t).balance, t.held(), "the treasury holds exactly its books");
        assertEq(address(LINE).balance, LINE.pool() + LINE.owedTotal(), "the live line contract holds its books");
        assertEq(address(G).balance, G.bonds() + G.feesHeld() + G.owedTotal(), "the live guarantee contract too");
        assertEq(address(VOUCH).balance, VOUCH.bonds() + VOUCH.feesHeld() + VOUCH.owedTotal(), "and the vouching one");
    }

    function test_wiredToTheLiveContracts() public view {
        assertEq(address(t.vouch()), address(VOUCH));
        assertEq(address(t.claims()), address(CLAIMS));
        assertEq(address(t.guarantee()), address(G));
        assertEq(address(t.line()), address(LINE));
        assertEq(address(t.desk()), address(DESK));
        assertEq(t.gateway(), GATEWAY, "the live desk's compute gateway");
        assertEq(GATEWAY.code.length, 0, "the gateway is a wallet: a prepayment cannot be refused");
        assertLe(address(t).code.length, 24_576);
    }

    /// The demo wallet draws on its live line; its treasury repays the live line, which counts it as repaid on time.
    function test_aTreasuryRepaysALiveLine() public {
        vm.prank(DEMO);
        FactorLineAccount(payable(DEMO_LINE)).addBond{value: 0.001 ether}(0);
        uint256 owedBefore = LINE.debtOf(DEMO_LINE);
        vm.prank(DEMO);
        LINE.draw(0.0001 ether, false);
        uint256 debt = LINE.debtOf(DEMO_LINE);
        assertEq(debt, owedBefore + 0.0001 ether);

        vm.prank(DEMO);
        t.deposit{value: 0.01 ether}(DEMO);
        FactorTreasury.Rules memory r;
        r.floor = 0.005 ether;
        r.repay = true;
        r.repayDaily = 1 ether;
        vm.prank(DEMO);
        t.setRules(r);
        uint32 onTime = LINE.line(DEMO_LINE).onTime;
        uint256 pool = LINE.pool();
        uint256 spent = t.run(DEMO, _none());
        assertEq(spent, debt);
        assertEq(LINE.debtOf(DEMO_LINE), 0);
        assertEq(LINE.pool() - pool, debt, "the live pool has its ETH back");
        assertEq(LINE.line(DEMO_LINE).onTime, onTime + 1);
        assertEq(t.balanceOf(DEMO), 0.01 ether - debt);
        _books();
    }

    function test_computeReachesTheLiveGateway() public {
        vm.prank(LEAD);
        t.deposit{value: 0.01 ether}(LEAD);
        FactorTreasury.Rules memory r;
        r.compute = true;
        r.computeDaily = 0.002 ether;
        vm.prank(LEAD);
        t.setRules(r);
        uint256 before = GATEWAY.balance;
        t.run(LEAD, _none());
        assertEq(GATEWAY.balance - before, 0.002 ether);
        _books();
    }

    /// A seller lists a claim on the live claims contract for a job locked on the live desk; report-lead's treasury buys
    /// it inside its rules, the price goes to the seller, and when the job settles the live desk's payout reaches
    /// report-lead.
    function test_aTreasuryBuysALiveClaimAndItsAgentIsPaid() public {
        vm.prank(seller);
        address account = CLAIMS.open();
        vm.deal(customer, 1 ether);
        vm.prank(customer);
        uint256 job = DESK.lock{value: 0.01 ether}(account, block.timestamp + 1 days, false);
        vm.prank(seller);
        uint256 id = CLAIMS.list(job, 0.0094 ether);

        vm.prank(LEAD);
        t.deposit{value: 0.05 ether}(LEAD);
        FactorTreasury.Rules memory r;
        r.claims = true;
        r.claimsDaily = 0.02 ether;
        r.claimMaxPrice = 0.01 ether;
        r.claimMinDiscountBps = 300;
        vm.prank(LEAD);
        t.setRules(r);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        t.run(LEAD, ids);
        assertEq(seller.balance, 0.0094 ether);
        assertEq(CLAIMS.claim(id).holder, LEAD);

        vm.prank(seller);
        CLAIMS.deliver(job, keccak256("the work"));
        vm.prank(customer);
        DESK.accept(job);
        uint256 before = LEAD.balance;
        CLAIMS.settle(id);
        assertEq(LEAD.balance - before, 0.0098 ether, "the live desk's payout went to the agent");
        _books();
    }

    function test_theBondsOnTheLiveGuaranteeAndVouchingContracts() public {
        uint256 gBond = G.bondOf(LEAD).bond;
        uint256 vBond = VOUCH.voucherOf(LEAD).bond;
        vm.prank(LEAD);
        t.deposit{value: 0.05 ether}(LEAD);
        FactorTreasury.Rules memory r;
        r.guarantee = true;
        r.guaranteeUpTo = gBond + 0.002 ether;
        r.vouch = true;
        r.vouchUpTo = vBond + 0.003 ether;
        vm.prank(LEAD);
        t.setRules(r);
        t.run(LEAD, _none());
        assertEq(G.bondOf(LEAD).bond, gBond + 0.002 ether);
        assertEq(VOUCH.voucherOf(LEAD).bond, vBond + 0.003 ether);
        assertGe(VOUCH.freeOf(LEAD), 0.003 ether, "free to stand behind a newer agent");
        _books();
    }

    function test_everythingLeftComesOut() public {
        vm.prank(LEAD);
        t.deposit{value: 0.05 ether}(LEAD);
        FactorTreasury.Rules memory r;
        r.floor = 1 ether;
        r.compute = true;
        r.computeDaily = 1 ether;
        vm.prank(LEAD);
        t.setRules(r);
        uint256 before = LEAD.balance;
        vm.prank(LEAD);
        t.withdraw(payable(LEAD), 0.05 ether);
        assertEq(LEAD.balance - before, 0.05 ether);
        assertEq(address(t).balance, 0);
    }
}
