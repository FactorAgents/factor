// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorBurnPot} from "../../src/FactorBurnPot.sol";
import {FactorAccount, FactorAccounts} from "../../src/FactorAccount.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorMilestones} from "../../src/FactorMilestones.sol";

/// Milestones against the contracts that are DEPLOYED on Robinhood Chain, at their real addresses, on a fork of the
/// chain (nothing here is sent anywhere): a milestone contract is deployed beside the live desk, which knows nothing of
/// it. Every stage is paid through the live desk with the contract as its customer and its job fee reaches the live
/// pool; an advance on a stage pays its 1% to the live burn pot; a stage that is missed, declined or rejected comes back
/// from the live desk within its 50,000 gas, with every stage not yet started; a line account on the live line contract
/// takes stages through its key; and a passkey-style account hires in stages by its orders.
contract MilestonesForkTest is ForkBase {
    FactorDesk constant DESK = FactorDesk(payable(0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F));
    FactorBurnPot constant POT = FactorBurnPot(payable(0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79));
    FactorAccounts constant ACCOUNTS = FactorAccounts(0x3417A303DcB62A84965a641f894ff5803502F8FA);
    FactorLine constant LINE = FactorLine(payable(0xc9405ca62eD1e9a4a058F404e5c1C893F7ae67c4));

    uint256 constant STAGE = 0.001 ether;
    bytes32 constant TERMS = keccak256("two stages on the live desk");

    FactorMilestones m;
    address customer;
    address a1;

    function setUp() public {
        _fork();
        m = new FactorMilestones(DESK);
        customer = makeAddr("a customer on the live desk");
        a1 = makeAddr("an agent on the live desk");
        vm.deal(customer, 1 ether);
        vm.deal(a1, 1 ether);
        vm.prank(a1);
        DESK.register();
    }

    function _two() internal pure returns (uint256[] memory l) {
        l = new uint256[](2);
        l[0] = STAGE;
        l[1] = STAGE;
    }

    function _days() internal pure returns (uint256[] memory l) {
        l = new uint256[](2);
        l[0] = 1 days;
        l[1] = 1 days;
    }

    function _post(bool early) internal returns (uint256 id) {
        vm.prank(customer);
        id = m.post{value: 2 * STAGE}(a1, _two(), _days(), early, TERMS);
    }

    function _deliver(uint256 id) internal returns (uint256 job) {
        job = m.currentJob(id);
        vm.prank(DESK.job(job).agent);
        DESK.deliver(job, keccak256(abi.encode("work", job)));
    }

    function _books(uint256 back) internal view {
        assertEq(address(m).balance, m.held() + m.owedTotal() + back, "the contract holds its books");
        assertGe(
            address(DESK).balance,
            DESK.pool() + DESK.held() + DESK.bonds() + DESK.owedTotal(),
            "the live desk holds its books"
        );
    }

    function test_fork_readsTheLiveDesk() public view {
        assertEq(address(m.desk()), address(DESK));
        assertGe(m.MIN_STAGE(), DESK.MIN_JOB());
        assertGe(m.MIN_TIME(), DESK.MIN_DUE());
        assertLe(m.MAX_TIME(), DESK.MAX_DUE());
    }

    function test_fork_bothStagesPaidThroughTheLiveDesk() public {
        uint256 pool = DESK.pool();
        uint256 count = DESK.jobCount();
        uint256 id = _post(false);
        uint256 job1 = m.currentJob(id);
        assertEq(job1, count + 1, "the next number on the live desk");
        assertEq(DESK.job(job1).customer, address(m));
        _deliver(id);
        uint256 before = a1.balance;
        vm.prank(customer);
        m.accept(id);
        assertEq(a1.balance - before, 0.00098 ether);
        uint256 job2 = m.currentJob(id);
        assertEq(job2, job1 + 1);
        assertEq(DESK.job(job2).dueAt, block.timestamp + 1 days);
        _deliver(id);
        vm.prank(customer);
        m.accept(id);
        assertEq(a1.balance - before, 0.00196 ether, "98% of each stage");
        assertEq(DESK.pool() - pool, 0.00004 ether, "2% of each stage to the live pool");
        assertEq(uint8(m.plan(id).state), uint8(FactorMilestones.State.Done));
        FactorDesk.Agent memory a = DESK.agent(a1);
        assertEq(a.settled, 2, "both stages on the live desk's record");
        assertEq(a.volume, 2 * STAGE);
        assertEq(DESK.score(a1), 20);
        assertEq(address(m).balance, 0);
        _books(0);
    }

    function test_fork_anAdvanceOnAStagePaysTheLiveBurnPot() public {
        uint256 id = _post(true);
        uint256 job = m.currentJob(id);
        uint256 pot = address(POT).balance;
        vm.prank(a1);
        DESK.draw(job, 0.0005 ether, FactorDesk.Kind.Early);
        assertEq(address(POT).balance - pot, 0.000005 ether, "1% of the advance");
        _deliver(id);
        vm.prank(customer);
        m.accept(id);
        assertEq(m.plan(id).current, 1);
        _books(0);
    }

    function test_fork_aMissComesBackFromTheLiveDesk() public {
        uint256 id = _post(false);
        uint256 job = m.currentJob(id);
        vm.warp(uint256(DESK.job(job).dueAt) + DESK.GRACE() + 1);
        uint256 before = customer.balance;
        m.step(id);
        assertEq(uint8(DESK.job(job).state), uint8(FactorDesk.State.Refunded));
        assertEq(DESK.owed(address(m)), 0, "the live desk's push reached the contract within its gas");
        assertEq(customer.balance - before, 2 * STAGE);
        assertEq(uint8(m.plan(id).state), uint8(FactorMilestones.State.Missed));
        _books(0);
    }

    function test_fork_aDeclineAndARejectComeBack() public {
        uint256 id = _post(false);
        uint256 job = m.currentJob(id);
        vm.prank(a1);
        DESK.decline(job);
        _books(STAGE);
        uint256 before = customer.balance;
        m.step(id);
        assertEq(customer.balance - before, 2 * STAGE);
        id = _post(false);
        _deliver(id);
        before = customer.balance;
        vm.prank(customer);
        m.reject(id);
        assertEq(customer.balance - before, STAGE / 2 + STAGE, "half of the stage and the second stage");
        assertEq(uint8(m.plan(id).state), uint8(FactorMilestones.State.Rejected));
        _books(0);
    }

    function test_fork_aLineAccountOnTheLiveLineTakesStages() public {
        address key = makeAddr("an agent with a credit line");
        vm.deal(key, 1 ether);
        vm.prank(key);
        DESK.register();
        vm.prank(key);
        address acct = LINE.open();
        vm.prank(customer);
        uint256 id = m.post{value: 2 * STAGE}(acct, _two(), _days(), false, TERMS);
        for (uint256 i = 0; i < 2; ++i) {
            uint256 job = m.currentJob(id);
            vm.prank(key);
            FactorLineAccount(payable(acct)).deliver(job, keccak256("work"));
            vm.prank(customer);
            m.accept(id);
        }
        assertEq(acct.balance, 0.00196 ether, "to the line account");
        assertEq(DESK.agent(acct).settled, 2);
        _books(0);
    }

    /// A passkey account's orders: it hires in stages and accepts, all through the account's own execute. A wallet key
    /// stands in for a passkey, which the account treats alike.
    function test_fork_anAccountHiresInStagesByOrder() public {
        (address k, uint256 pk) = makeAddrAndKey("an account's key, for a customer");
        FactorAccount.Key memory key = FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(uint256(uint160(k))), 0);
        FactorAccount acct = FactorAccount(payable(ACCOUNTS.create(key, "")));
        vm.deal(address(acct), 0.1 ether);
        FactorAccount.Call[] memory c = new FactorAccount.Call[](1);
        c[0] = FactorAccount.Call(
            address(m), 2 * STAGE, abi.encodeCall(FactorMilestones.post, (a1, _two(), _days(), false, TERMS))
        );
        _order(acct, c, pk);
        uint256 id = m.planCount();
        assertEq(m.plan(id).customer, address(acct));
        _deliver(id);
        c[0] = FactorAccount.Call(address(m), 0, abi.encodeCall(FactorMilestones.accept, (id)));
        _order(acct, c, pk);
        assertEq(m.plan(id).current, 1);
        // the second stage missed: it comes back to the account within the contract's 50,000 gas
        vm.warp(uint256(DESK.job(m.currentJob(id)).dueAt) + DESK.GRACE() + 1);
        uint256 before = address(acct).balance;
        m.step(id);
        assertEq(address(acct).balance - before, STAGE);
        assertEq(m.owed(address(acct)), 0);
        _books(0);
    }

    function _order(FactorAccount who, FactorAccount.Call[] memory calls, uint256 pk) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 d = who.digest(calls, who.nonce(), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        who.execute(calls, deadline, abi.encodePacked(r, s, v));
    }
}
