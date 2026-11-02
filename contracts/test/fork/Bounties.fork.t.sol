// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorBurnPot} from "../../src/FactorBurnPot.sol";
import {FactorAccount, FactorAccounts} from "../../src/FactorAccount.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorBounty} from "../../src/FactorBounty.sol";

/// Bounties against the contracts that are DEPLOYED on Robinhood Chain, at their real addresses, on a fork of the chain
/// (nothing here is sent anywhere): a bounty contract is deployed beside the live desk and the live line contract, which
/// know nothing of it. A win is paid through the live desk with the contract as its customer and the 1% reaches the live
/// burn pot; a bounty with no pick is split; a winner who never delivers is refunded by the live desk, and the contract
/// takes that ETH within the desk's 50,000 gas; a line account on the live line contract enters through its key; and a
/// passkey-style account posts and enters by its orders.
contract BountiesForkTest is ForkBase {
    FactorDesk constant DESK = FactorDesk(payable(0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F));
    FactorBurnPot constant POT = FactorBurnPot(payable(0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79));
    FactorAccounts constant ACCOUNTS = FactorAccounts(0x3417A303DcB62A84965a641f894ff5803502F8FA);
    FactorLine constant LINE = FactorLine(payable(0xc9405ca62eD1e9a4a058F404e5c1C893F7ae67c4));

    uint256 constant PRIZE = 0.005 ether;
    uint256 constant FEE = 0.00005 ether;
    uint256 constant BOND = 0.00005 ether;

    FactorBounty b;
    address poster;
    address a1;
    address a2;
    address a3;

    function setUp() public {
        _fork();
        b = new FactorBounty(DESK, LINE);
        poster = makeAddr("a poster on the live desk");
        a1 = makeAddr("an agent on the live desk");
        a2 = makeAddr("a second agent on the live desk");
        a3 = makeAddr("a third agent on the live desk");
        vm.deal(poster, 1 ether);
        address[3] memory all = [a1, a2, a3];
        for (uint256 i = 0; i < 3; ++i) {
            vm.deal(all[i], 1 ether);
            vm.prank(all[i]);
            DESK.register();
        }
    }

    function _post() internal returns (uint256 id) {
        vm.prank(poster);
        id = b.post{value: PRIZE + FEE}(PRIZE, block.timestamp + 1 hours, 0, keccak256("a task"));
    }

    function _enter(uint256 id, address a) internal returns (bytes32 h) {
        h = b.entryHash(id, a, keccak256(abi.encode("work", a)));
        vm.prank(a);
        b.enter{value: BOND}(id, a, h);
    }

    function _books(uint256 back) internal view {
        assertEq(address(b).balance, b.held() + b.bonds() + b.owedTotal() + back, "the contract holds its books");
        assertGe(
            address(DESK).balance,
            DESK.pool() + DESK.held() + DESK.bonds() + DESK.owedTotal(),
            "the live desk holds its books"
        );
    }

    function test_fork_readsTheLiveDeskAndLine() public view {
        assertEq(address(b.desk()), address(DESK));
        assertEq(address(b.line()), address(LINE));
        assertEq(b.burnPot(), address(POT));
        assertGe(b.MIN_PRIZE(), DESK.MIN_JOB());
        assertGe(b.DELIVER_TIME(), DESK.MIN_DUE());
        assertLe(b.DELIVER_TIME(), DESK.MAX_DUE());
    }

    function test_fork_aWinIsPaidThroughTheLiveDesk() public {
        uint256 id = _post();
        bytes32 h = _enter(id, a1);
        _enter(id, a2);
        vm.warp(block.timestamp + 1 hours);
        uint256 pot = address(POT).balance;
        uint256 pool = DESK.pool();
        vm.prank(poster);
        uint256 job = b.pick(id, a1);
        assertEq(address(POT).balance - pot, FEE, "the 1% reached the live burn pot");
        assertEq(DESK.job(job).customer, address(b));
        assertEq(DESK.job(job).price, PRIZE);
        uint256 a2Before = a2.balance;
        b.returnBonds(id);
        assertEq(a2.balance - a2Before, BOND);
        vm.prank(a1);
        DESK.deliver(job, h);
        uint256 before = a1.balance;
        b.close(id);
        assertEq(uint8(DESK.job(job).state), uint8(FactorDesk.State.Settled), "accepted on the live desk");
        assertEq(a1.balance - before, 0.0049 ether + BOND, "98% of the prize and the bond");
        assertEq(DESK.pool() - pool, 0.0001 ether, "the job fee to the live pool");
        FactorDesk.Agent memory a = DESK.agent(a1);
        assertEq(a.settled, 1);
        assertEq(a.feesPaid, 0.0001 ether);
        assertEq(a.volume, PRIZE);
        assertEq(DESK.score(a1), 10);
        assertEq(address(b).balance, 0);
        _books(0);
    }

    function test_fork_noPickIsSplit() public {
        uint256 id = _post();
        _enter(id, a1);
        _enter(id, a2);
        _enter(id, a3);
        vm.warp(uint256(b.bounty(id).deadline) + 3 days);
        uint256 before = a2.balance;
        uint256 pot = address(POT).balance;
        b.close(id);
        uint256 share = PRIZE / 3;
        assertEq(a2.balance - before, share + BOND);
        assertEq(address(POT).balance - pot, FEE + PRIZE - share * 3, "the 1% and the dust");
        assertEq(address(b).balance, 0);
        _books(0);
    }

    function test_fork_aWinnerWhoNeverDeliversIsRefundedByTheLiveDesk() public {
        uint256 id = _post();
        _enter(id, a1);
        _enter(id, a2);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(poster);
        uint256 job = b.pick(id, a1);
        vm.warp(uint256(DESK.job(job).dueAt) + DESK.GRACE() + 1);
        uint256 before = a2.balance;
        b.close(id);
        assertEq(uint8(DESK.job(job).state), uint8(FactorDesk.State.Refunded));
        assertEq(DESK.owed(address(b)), 0, "the live desk's push reached the contract within its gas");
        assertEq(a2.balance - before, PRIZE + BOND + BOND, "the prize, the winner's bond, its own bond");
        assertEq(DESK.agent(a1).unanswered, 1, "no mark but unanswered");
        assertEq(address(b).balance, 0);
        _books(0);
    }

    function test_fork_aDeclineComesBackWithinTheDesksGas() public {
        uint256 id = _post();
        _enter(id, a1);
        _enter(id, a2);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(poster);
        uint256 job = b.pick(id, a1);
        vm.prank(a1);
        DESK.decline(job);
        assertEq(DESK.owed(address(b)), 0);
        _books(PRIZE);
        b.close(id);
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Undelivered));
        _books(0);
    }

    function test_fork_aLineAccountOnTheLiveLineEntersThroughItsKey() public {
        address key = makeAddr("an agent with a credit line");
        vm.deal(key, 1 ether);
        vm.prank(key);
        DESK.register();
        vm.prank(key);
        address acct = LINE.open();
        assertEq(b.keyOf(acct), key);
        uint256 id = _post();
        bytes32 h = b.entryHash(id, acct, keccak256("work"));
        vm.prank(a1);
        vm.expectRevert(FactorBounty.NotAgent.selector);
        b.enter(id, acct, h);
        vm.prank(key);
        b.enter{value: BOND}(id, acct, h);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(poster);
        uint256 job = b.pick(id, acct);
        vm.prank(key);
        FactorLineAccount(payable(acct)).deliver(job, h);
        b.close(id);
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Won));
        assertEq(acct.balance, 0.0049 ether + BOND, "to the line account");
        assertEq(DESK.agent(acct).settled, 1);
        _books(0);
    }

    /// A passkey account's orders: it posts, an account agent enters, it picks, all through the account's own execute.
    /// Wallet keys stand in for passkeys, which the account treats alike.
    function test_fork_accountsPostEnterAndWinByOrder() public {
        (address posterKey, uint256 posterPk) = makeAddrAndKey("an account's key, for a poster");
        (address agentKey, uint256 agentPk) = makeAddrAndKey("an account's key, for an agent");
        FactorAccount.Key memory pk = FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(uint256(uint160(posterKey))), 0);
        FactorAccount.Key memory ak = FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(uint256(uint160(agentKey))), 0);
        FactorAccount pa = FactorAccount(payable(ACCOUNTS.create(pk, "")));
        FactorAccount aa = FactorAccount(payable(ACCOUNTS.create(ak, "")));
        vm.deal(address(pa), 0.1 ether);
        vm.deal(address(aa), 0.1 ether);

        FactorAccount.Call[] memory c = new FactorAccount.Call[](1);
        c[0] = FactorAccount.Call(address(DESK), 0, abi.encodeCall(FactorDesk.register, ()));
        _order(aa, c, agentPk);
        c[0] = FactorAccount.Call(
            address(b),
            PRIZE + FEE,
            abi.encodeCall(FactorBounty.post, (PRIZE, block.timestamp + 1 hours, 0, keccak256("a task")))
        );
        _order(pa, c, posterPk);
        uint256 id = b.bountyCount();
        bytes32 h = b.entryHash(id, address(aa), keccak256("work"));
        c[0] = FactorAccount.Call(address(b), BOND, abi.encodeCall(FactorBounty.enter, (id, address(aa), h)));
        _order(aa, c, agentPk);
        vm.warp(block.timestamp + 1 hours);
        c[0] = FactorAccount.Call(address(b), 0, abi.encodeCall(FactorBounty.pick, (id, address(aa))));
        _order(pa, c, posterPk);
        uint256 job = b.bounty(id).job;
        c[0] = FactorAccount.Call(address(DESK), 0, abi.encodeCall(FactorDesk.deliver, (job, h)));
        _order(aa, c, agentPk);
        uint256 before = address(aa).balance;
        b.close(id);
        assertEq(address(aa).balance - before, 0.0049 ether + BOND);
        assertEq(uint8(b.bounty(id).state), uint8(FactorBounty.State.Won));
        _books(0);
    }

    function _order(FactorAccount who, FactorAccount.Call[] memory calls, uint256 pk) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 d = who.digest(calls, who.nonce(), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, d);
        who.execute(calls, deadline, abi.encodePacked(r, s, v));
    }

    function test_fork_theScoreIsTheLiveDesks() public {
        uint256 id;
        vm.prank(poster);
        id = b.post{value: PRIZE + FEE}(PRIZE, block.timestamp + 1 hours, 10, keccak256("a task"));
        vm.prank(a1);
        vm.expectRevert(abi.encodeWithSelector(FactorBounty.ScoreTooLow.selector, 0, 10));
        b.enter{value: BOND}(id, a1, keccak256("work"));
        // a small job on the live desk: 10 points
        vm.prank(poster);
        uint256 job = DESK.lock{value: 0.001 ether}(a1, block.timestamp + 1 days, false);
        vm.prank(a1);
        DESK.deliver(job, keccak256("work"));
        vm.prank(poster);
        DESK.accept(job);
        assertEq(b.scoreOf(a1), 10);
        vm.prank(a1);
        b.enter{value: BOND}(id, a1, keccak256("work"));
        assertEq(b.entrants(id).length, 1);
    }
}
