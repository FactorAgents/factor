// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./ForkBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorVerifiers} from "../../src/FactorVerifiers.sol";

/// Verifiers against the contracts that are DEPLOYED on Robinhood Chain, at their real addresses, on a fork of the
/// chain (nothing here is sent anywhere): a verifier contract is deployed beside the live desk and the live line
/// contract, which know nothing of it. A verified job is locked on the live desk with the contract as its customer; a
/// first verdict of accept pays the agent through the live desk and its job fee reaches the live pool; a verdict of
/// reject settles at half and the customer's half comes back from the live desk within its 50,000 gas; a panel
/// overturns a verdict; a job not delivered comes back with its fee; and a live line account's key cannot check its
/// own account's job.
contract VerifiersForkTest is ForkBase {
    FactorDesk constant DESK = FactorDesk(payable(0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F));
    FactorLine constant LINE = FactorLine(payable(0xc9405ca62eD1e9a4a058F404e5c1C893F7ae67c4));

    uint256 constant PRICE = 0.002 ether;
    uint256 constant FEE = 0.0002 ether;
    bytes32 constant TERMS = keccak256("a job checked by a verifier on the live desk");

    FactorVerifiers vf;
    address customer;
    address agent;
    address[4] v;

    function setUp() public {
        _fork();
        vf = new FactorVerifiers(DESK, LINE);
        customer = makeAddr("a customer on the live desk");
        agent = makeAddr("an agent on the live desk");
        vm.deal(customer, 1 ether);
        vm.deal(agent, 1 ether);
        vm.prank(agent);
        DESK.register();
        for (uint256 i = 0; i < 4; ++i) {
            v[i] = makeAddr(string.concat("a verifier on the live desk ", vm.toString(i)));
            vm.deal(v[i], 1 ether);
            vm.prank(v[i]);
            vf.join{value: 0.02 ether}(uint8(i + 1));
            vm.warp(block.timestamp + 1);
        }
    }

    function _hire() internal returns (uint256 id) {
        vm.prank(customer);
        id = vf.hire{value: PRICE + FEE}(agent, block.timestamp + 1 days, false, FEE, TERMS);
    }

    function _deliver(uint256 id) internal {
        uint256 job = vf.getCase(id).job;
        vm.prank(agent);
        DESK.deliver(job, keccak256(abi.encode("work", job)));
    }

    function _books() internal view {
        assertEq(
            address(vf).balance,
            vf.bonds() + vf.staked() + vf.fees() + vf.disputes() + vf.owedTotal(),
            "the contract holds its books"
        );
        assertGe(
            address(DESK).balance,
            DESK.pool() + DESK.held() + DESK.bonds() + DESK.owedTotal(),
            "the live desk holds its books"
        );
    }

    function test_fork_readsTheLiveDeskAndLine() public view {
        assertEq(address(vf.desk()), address(DESK));
        assertEq(address(vf.line()), address(LINE));
        assertEq(vf.review(), DESK.REVIEW());
        assertLe(vf.REVEAL_END() + vf.CUSTOMER_TIME(), DESK.REVIEW());
    }

    function test_fork_anAcceptPaysTheAgentThroughTheLiveDesk() public {
        uint256 pool = DESK.pool();
        uint256 id = _hire();
        assertEq(DESK.job(vf.getCase(id).job).customer, address(vf));
        _deliver(id);
        vm.prank(v[0]);
        vf.check(id, true, keccak256("fine"));
        vm.warp(block.timestamp + vf.DISPUTE_TIME());
        uint256 a = agent.balance;
        vf.step(id);
        assertEq(agent.balance - a, PRICE - (PRICE * 200) / 10_000);
        assertEq(DESK.pool() - pool, (PRICE * 200) / 10_000, "the job fee reached the live pool");
        assertEq(vf.verifier(v[0]).free, 0.02 ether + FEE);
        _books();
    }

    function test_fork_aRejectSettlesAtHalfOnTheLiveDesk() public {
        uint256 id = _hire();
        _deliver(id);
        vm.prank(v[1]);
        vf.check(id, false, keccak256("the dates are missing"));
        uint256 c = customer.balance;
        vm.prank(agent);
        vf.concede(id);
        assertEq(customer.balance - c, PRICE / 2, "the half came back from the live desk and on to the customer");
        assertEq(DESK.agent(agent).settledAtHalf, 1);
        _books();
    }

    function test_fork_aPanelOverturnsAVerdict() public {
        uint256 id = _hire();
        _deliver(id);
        vm.prank(v[0]);
        vf.check(id, false, keccak256("no"));
        uint256 bond = vf.getCase(id).disputeBond;
        vm.prank(agent);
        vf.dispute{value: bond}(id);
        for (uint256 i = 1; i < 4; ++i) {
            bytes32 commit = vf.commitOf(id, v[i], true, keccak256("yes"), bytes32(i));
            vm.prank(v[i]);
            vf.sit(id, commit);
        }
        uint256 d = DESK.job(vf.getCase(id).job).deliveredAt;
        vm.warp(d + vf.SEAT_END());
        for (uint256 i = 1; i < 4; ++i) {
            vm.prank(v[i]);
            vf.reveal(id, true, keccak256("yes"), bytes32(i));
        }
        uint256 a = agent.balance;
        vf.step(id);
        assertEq(agent.balance - a, bond + PRICE - (PRICE * 200) / 10_000, "paid in full, with its dispute bond back");
        assertEq(uint8(vf.getCase(id).how), uint8(FactorVerifiers.How.Panel));
        assertEq(vf.verifier(v[0]).wrong, 1);
        _books();
    }

    function test_fork_notDeliveredComesBackWithTheFee() public {
        uint256 id = _hire();
        vm.warp(DESK.job(vf.getCase(id).job).dueAt + DESK.GRACE() + 1);
        uint256 c = customer.balance;
        vf.step(id);
        assertEq(customer.balance - c, PRICE + FEE);
        _books();
    }

    function test_fork_aLiveLineAccountsKeyCannotCheckIt() public {
        address key = makeAddr("a key on the live line contract");
        vm.prank(key);
        DESK.register();
        vm.prank(key);
        address acct = LINE.open();
        vm.deal(key, 1 ether);
        vm.prank(key);
        vf.join{value: 0.02 ether}(9);
        vm.prank(customer);
        uint256 id = vf.hire{value: PRICE + FEE}(acct, block.timestamp + 1 days, false, FEE, TERMS);
        uint256 job = vf.getCase(id).job;
        vm.prank(key);
        FactorLineAccount(payable(acct)).deliver(job, keccak256("work"));
        vm.prank(key);
        vm.expectRevert(FactorVerifiers.Related.selector);
        vf.check(id, true, keccak256("mine"));
        vm.prank(v[2]);
        vf.check(id, true, keccak256("fine"));
        _books();
    }
}
