// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorBurnPot} from "../../src/FactorBurnPot.sol";
import {FactorAccount, FactorAccounts} from "../../src/FactorAccount.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorGuarantee} from "../../src/FactorGuarantee.sol";

/// Guarantees against the contracts that are DEPLOYED on Robinhood Chain, at their real addresses, on a fork of the
/// chain (nothing here is sent anywhere): a guarantee contract is deployed beside the live desk and the live line
/// contract, which know nothing of it. An agent earns a score of 200 with real jobs on the live desk, bonds and sells
/// cover; a covered job is delivered and its cover released, another is never delivered and close() refunds it on the
/// live desk and pays the cover; a line account on the live line contract sells cover run by its key; and a passkey
/// account hires with cover in one order. Half of every fee reaches the live burn pot.
contract GuaranteesForkTest is ForkBase {
    FactorDesk constant DESK = FactorDesk(payable(0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F));
    FactorBurnPot constant POT = FactorBurnPot(payable(0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79));
    FactorAccounts constant ACCOUNTS = FactorAccounts(0x3417A303DcB62A84965a641f894ff5803502F8FA);
    FactorLine constant LINE = FactorLine(payable(0xc9405ca62eD1e9a4a058F404e5c1C893F7ae67c4));

    FactorGuarantee g;
    address agent;
    address buyer;
    address scorer;

    function setUp() public {
        _fork();
        g = new FactorGuarantee(DESK, LINE);
        agent = makeAddr("an agent on the live desk");
        buyer = makeAddr("a customer of the live desk");
        scorer = makeAddr("a customer whose small jobs build a score");
        vm.deal(agent, 1 ether);
        vm.deal(buyer, 10 ether);
        vm.deal(scorer, 1 ether);
        vm.prank(agent);
        DESK.register();
    }

    function _score200(address who, address deliverer, bool viaAccount) internal {
        for (uint256 i = 0; i < 20; ++i) {
            vm.prank(scorer);
            uint256 id = DESK.lock{value: 0.001 ether}(who, block.timestamp + 1 days, false);
            vm.prank(deliverer);
            if (viaAccount) FactorLineAccount(payable(who)).deliver(id, keccak256("the work"));
            else DESK.deliver(id, keccak256("the work"));
            vm.prank(scorer);
            DESK.accept(id);
        }
    }

    function _ready() internal {
        _score200(agent, agent, false);
        assertGe(DESK.score(agent), 200, "a score of 200 on the live desk");
        vm.prank(agent);
        g.addBond{value: 0.05 ether}(agent);
        vm.prank(agent);
        g.setOffer(agent, 0.02 ether);
    }

    function _hire(uint256 price, uint256 amount, uint256 dueIn) internal returns (uint256 id, uint256 job) {
        uint256 dueAt = block.timestamp + dueIn;
        uint256 fee = g.feeFor(amount);
        vm.prank(buyer);
        id = g.reserve{value: fee}(agent, price, dueAt, false, amount);
        vm.prank(buyer);
        job = DESK.lock{value: price}(agent, dueAt, false);
        g.bind(id, job);
    }

    function _books() internal view {
        assertEq(address(g).balance, g.bonds() + g.feesHeld() + g.owedTotal());
        assertGe(
            address(DESK).balance,
            DESK.pool() + DESK.held() + DESK.bonds() + DESK.owedTotal(),
            "the live desk holds its books"
        );
    }

    function test_fork_readsTheLiveDeskAndLine() public view {
        assertEq(address(g.desk()), address(DESK));
        assertEq(address(g.line()), address(LINE));
        assertEq(g.burnPot(), address(POT));
        assertEq(g.minJob(), DESK.MIN_JOB());
        assertEq(g.grace(), DESK.GRACE());
        assertEq(g.review(), DESK.REVIEW());
    }

    function test_fork_aCoveredJobDeliveredReleasesItsCover() public {
        _ready();
        uint256 potBefore = address(POT).balance;
        (uint256 id, uint256 job) = _hire(0.04 ether, 0.01 ether, 1 days);
        vm.prank(agent);
        DESK.deliver(job, keccak256("the work"));
        vm.prank(buyer);
        DESK.accept(job);
        g.close(job);
        assertEq(uint8(g.cover(id).state), uint8(FactorGuarantee.State.Released));
        assertEq(address(POT).balance - potBefore, 0.00005 ether, "half the fee reached the live burn pot");
        assertEq(g.freeOf(agent), 0.05 ether);
        _books();
    }

    function test_fork_aCoveredJobNotDeliveredIsRefundedAndPaid() public {
        _ready();
        (uint256 id, uint256 job) = _hire(0.04 ether, 0.01 ether, 1 hours);
        uint256 before = buyer.balance;
        vm.warp(block.timestamp + 1 hours + 12 hours + 1);
        g.close(job);
        assertEq(uint8(DESK.job(job).state), uint8(FactorDesk.State.Refunded), "refunded on the live desk");
        assertEq(uint8(g.cover(id).state), uint8(FactorGuarantee.State.Paid));
        assertEq(buyer.balance - before, 0.04 ether + 0.01 ether, "the refund and the cover");
        assertEq(g.bondOf(agent).bond, 0.04 ether);
        _books();
    }

    function test_fork_aLineAccountOnTheLiveLineSellsCover() public {
        address key = makeAddr("an agent with a credit line");
        vm.deal(key, 1 ether);
        vm.prank(key);
        DESK.register();
        vm.prank(key);
        address acct = LINE.open();
        _score200(acct, key, true);
        assertEq(g.keyOf(acct), key);
        assertGe(g.scoreOf(acct), 200);
        vm.prank(key);
        g.addBond{value: 0.02 ether}(acct);
        vm.prank(key);
        g.setOffer(acct, 0.01 ether);
        uint256 dueAt = block.timestamp + 1 days;
        vm.prank(buyer);
        uint256 id = g.reserve{value: 0.0001 ether}(acct, 0.04 ether, dueAt, false, 0.01 ether);
        vm.prank(buyer);
        uint256 job = DESK.lock{value: 0.04 ether}(acct, dueAt, false);
        g.bind(id, job);
        vm.prank(key);
        FactorLineAccount(payable(acct)).deliver(job, keccak256("the work"));
        vm.prank(buyer);
        DESK.accept(job);
        uint256 before = acct.balance;
        g.close(job);
        assertEq(acct.balance - before, 0.00005 ether, "the agent's half reached its line account");
        vm.prank(key);
        g.takeBond(acct, 0.02 ether);
        assertEq(acct.balance - before, 0.02005 ether, "bond taken out reached the line account too");
        _books();
    }

    function test_fork_aPasskeyAccountHiresWithCoverInOneOrder() public {
        _ready();
        address walletKey = makeAddr("a Factor account's wallet key");
        FactorAccount.Key memory first =
            FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(uint256(uint160(walletKey))), bytes32(0));
        address payable fa = payable(ACCOUNTS.create(first, ""));
        vm.deal(fa, 0.1 ether);
        uint256 dueAt = block.timestamp + 1 days;
        FactorAccount.Call[] memory calls = new FactorAccount.Call[](3);
        calls[0] = FactorAccount.Call(
            address(g), 0.0001 ether, abi.encodeCall(FactorGuarantee.reserve, (agent, 0.04 ether, dueAt, false, 0.01 ether))
        );
        calls[1] = FactorAccount.Call(address(DESK), 0.04 ether, abi.encodeCall(FactorDesk.lock, (agent, dueAt, false)));
        calls[2] = FactorAccount.Call(address(g), 0, abi.encodeCall(FactorGuarantee.bindLatest, ()));
        vm.prank(walletKey);
        FactorAccount(fa).run(calls);
        uint256 job = DESK.jobCount();
        assertEq(DESK.job(job).customer, fa);
        assertEq(g.coverOf(job), 1);
        _books();
    }
}
