// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, IPonsToken} from "./ForkBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorBurnPot} from "../../src/FactorBurnPot.sol";
import {FactorAccount, FactorAccounts} from "../../src/FactorAccount.sol";

/// Pay with Factor needs no new contract. These tests show it against the contracts that are DEPLOYED on Robinhood
/// Chain, at their real addresses, on a fork of the chain (nothing here is sent anywhere):
///
///   - any wallet registers as an agent, with no list and nobody's leave, and any buyer locks a job for it;
///   - a deal runs as the rulebook says: an early advance the buyer allowed, a delivery, an acceptance, every wei
///     where it should be, and a rejection that sends half back;
///   - the burn pot takes plain ETH from anybody and its next burn spends it on $FACTOR, so a deal can add to the
///     burn with a plain transfer next to the lock;
///   - a Factor account does the transfer and the lock in one order: both happen, or neither.
contract PayWithFactorForkTest is ForkBase {
    // the deployed contracts (contracts/broadcast/factor.env, deploy block 88409629)
    FactorDesk constant DESK = FactorDesk(payable(0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F));
    FactorBurnPot constant POT = FactorBurnPot(payable(0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79));
    FactorAccounts constant ACCOUNTS = FactorAccounts(0x3417A303DcB62A84965a641f894ff5803502F8FA);

    address agent;
    address buyer;

    function setUp() public {
        _fork();
        agent = makeAddr("an agent from outside");
        buyer = makeAddr("a buyer from another site");
        vm.deal(agent, 1 ether);
        vm.deal(buyer, 10 ether);
    }

    function _books() internal view {
        assertGe(address(DESK).balance, DESK.pool() + DESK.held() + DESK.bonds() + DESK.owedTotal(), "the desk holds its books");
    }

    function _lock(uint256 price, bool early) internal returns (uint256 id) {
        vm.prank(buyer);
        id = DESK.lock{value: price}(agent, block.timestamp + 24 hours, early);
    }

    function test_fork_anyWalletRegistersAndAnyBuyerLocksForIt() public {
        assertTrue(address(DESK).code.length > 0 && address(POT).code.length > 0, "the deployed contracts are there");
        // a wallet the desk has never seen is not an agent, and a lock for it is refused
        vm.prank(buyer);
        vm.expectRevert(FactorDesk.NotRegistered.selector);
        DESK.lock{value: 0.01 ether}(agent, block.timestamp + 24 hours, false);
        // one call of its own, and nothing else
        vm.prank(agent);
        DESK.register();
        assertTrue(DESK.agent(agent).registered);
        uint256 id = _lock(0.01 ether, false);
        FactorDesk.Job memory j = DESK.job(id);
        assertEq(j.customer, buyer);
        assertEq(j.agent, agent);
        assertEq(j.price, 0.01 ether);
        assertEq(uint8(j.state), uint8(FactorDesk.State.Locked));
        _books();
    }

    function test_fork_aDealWithAnEarlyAdvanceDeliveredAndAccepted() public {
        vm.prank(agent);
        DESK.register();
        uint256 price = 0.04 ether;
        uint256 id = _lock(price, true);
        uint256 potBefore = address(POT).balance;
        uint256 agentBefore = agent.balance;
        // the agent starts with half, out of the buyer's own payment, less the 1% fee that goes to the burn pot
        vm.prank(agent);
        DESK.draw(id, price / 2, FactorDesk.Kind.Early);
        assertEq(agent.balance - agentBefore, price / 2 - price / 200);
        assertEq(address(POT).balance - potBefore, price / 200, "the advance fee is in the burn pot");
        vm.prank(agent);
        DESK.deliver(id, keccak256("the work"));
        vm.prank(buyer);
        DESK.accept(id);
        // the rest, less the 2% job fee
        assertEq(agent.balance - agentBefore, price / 2 - price / 200 + price / 2 - (price * 200) / 10_000);
        FactorDesk.Agent memory a = DESK.agent(agent);
        assertEq(a.settled, 1);
        assertEq(a.onTime, 1);
        assertEq(a.volume, price);
        assertEq(uint8(DESK.job(id).state), uint8(FactorDesk.State.Settled));
        _books();
    }

    function test_fork_aRejectedDealSendsHalfBack() public {
        vm.prank(agent);
        DESK.register();
        uint256 price = 0.02 ether;
        uint256 id = _lock(price, false);
        vm.prank(agent);
        DESK.deliver(id, keccak256("work the buyer did not want"));
        uint256 buyerBefore = buyer.balance;
        uint256 agentBefore = agent.balance;
        vm.prank(buyer);
        DESK.reject(id);
        assertEq(buyer.balance - buyerBefore, price / 2, "half back");
        assertEq(agent.balance - agentBefore, price / 2 - ((price / 2) * 200) / 10_000, "the agent keeps its half less the fee on it");
        assertEq(DESK.agent(agent).settledAtHalf, 1);
        (, uint32 rejected) = DESK.customers(buyer);
        assertEq(rejected, 1);
        _books();
    }

    function test_fork_theBurnPotTakesPlainEthAndItsNextBurnSpendsIt() public {
        IPonsToken token = IPonsToken(address(POT.token()));
        assertTrue(address(token) != address(0), "$FACTOR is launched from the pot");
        uint256 before = address(POT).balance;
        vm.prank(buyer);
        (bool ok,) = address(POT).call{value: 0.01 ether}("");
        assertTrue(ok, "a plain transfer to the burn pot goes through");
        assertEq(address(POT).balance, before + 0.01 ether);
        // the next burn: at most every 30 minutes, and a small one waits up to a day
        vm.warp(block.timestamp + 1 days + 1);
        (bool open,,) = POT.market();
        if (!open) return; // between graduation and the pool, nowhere to buy: the ETH waits for the next burn
        uint256 supply = token.totalSupply();
        uint256 spentBefore = POT.totalEthBurned();
        (uint256 ethIn, uint256 burned) = POT.burn(0);
        assertGt(ethIn, 0);
        assertGt(burned, 0);
        assertEq(POT.totalEthBurned(), spentBefore + ethIn);
        assertEq(supply - token.totalSupply(), burned, "the supply fell by what was burned");
    }

    function test_fork_anAccountLocksAndAddsToTheBurnInOneOrder() public {
        vm.prank(agent);
        DESK.register();
        address key = makeAddr("the buyer's own wallet key");
        FactorAccount.Key memory first = FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(uint256(uint160(key))), bytes32(0));
        address payable account = payable(ACCOUNTS.create(first, ""));
        vm.deal(account, 1 ether);
        uint256 price = 0.01 ether;
        uint256 dealBurn = price / 100;
        FactorAccount.Call[] memory calls = new FactorAccount.Call[](2);
        calls[0] = FactorAccount.Call(address(DESK), price, abi.encodeCall(FactorDesk.lock, (agent, block.timestamp + 24 hours, false)));
        calls[1] = FactorAccount.Call(address(POT), dealBurn, "");
        uint256 potBefore = address(POT).balance;
        uint256 jobsBefore = DESK.jobCount();
        vm.prank(key);
        FactorAccount(account).run(calls);
        assertEq(DESK.jobCount(), jobsBefore + 1);
        assertEq(DESK.job(jobsBefore + 1).customer, account, "the account is the customer");
        assertEq(address(POT).balance, potBefore + dealBurn);
        // and when one of the two cannot happen, neither does: a lock under the smallest job takes the transfer with it
        calls[0].value = 0.0001 ether;
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.TooSmall.selector, 0.001 ether));
        FactorAccount(account).run(calls);
        assertEq(address(POT).balance, potBefore + dealBurn);
        _books();
    }
}
