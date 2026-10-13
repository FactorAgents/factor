// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, ICurveX, IPonsToken} from "./ForkBase.sol";
import {FactorBurnPot} from "../../src/FactorBurnPot.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorSplitter} from "../../src/FactorSplitter.sol";

/// The whole of Factor against the real Pons, on a fork of Robinhood Chain: $FACTOR is launched through the real
/// launch factory and traded on the real bonding curve, the real fee escrow pays the splitter, the splitter's
/// tenth becomes the desk's pool, an agent is advanced out of that pool, and the fee on the advance is burned by
/// a real buy on the curve.
contract DeskForkTest is ForkBase {
    address admin = makeAddr("factor admin");
    address gateway = makeAddr("factor gateway");
    address buyer = makeAddr("factor buyer");
    address customer = makeAddr("factor customer");
    address agent = makeAddr("factor agent");
    address stranger = makeAddr("factor stranger");

    FactorBurnPot burnPot;
    FactorSplitter splitter;
    FactorDesk desk;
    IPonsToken token;
    ICurveX curve;
    uint256 t0;

    function setUp() public {
        _fork();
        Factor memory h = _deployFactor(address(this), admin, gateway, _pons());
        _verifyFactor(h, admin, gateway, _pons());
        (burnPot, splitter, desk) = (h.burnPot, h.splitter, h.desk);

        uint256 fee = _pons().launchFee();
        vm.deal(admin, fee);
        vm.prank(admin);
        address t = burnPot.launch{value: fee}(_params(keccak256("factor-desk-fork")), 0, new address[](0));
        token = IPonsToken(t);
        curve = ICurveX(_pons().getLaunchedToken(t).curve);
        t0 = block.timestamp;
        vm.deal(buyer, 1000 ether);
        vm.prank(agent);
        desk.register();
    }

    function _trade(uint256 eth) internal {
        vm.prank(buyer);
        curve.buy{value: eth}(eth, 0, buyer);
    }

    function _books() internal view {
        assertEq(address(desk).balance, desk.pool() + desk.held() + desk.bonds() + desk.owedTotal());
    }

    /// Before anybody trades there is no pool, and nobody can be advanced from it.
    function test_fork_withoutTradingThereIsNoPool() public {
        assertEq(desk.pool(), 0);
        vm.deal(agent, 1 ether);
        vm.prank(agent);
        desk.addBond{value: 1 ether}();
        vm.deal(customer, 1 ether);
        vm.prank(customer);
        uint256 id = desk.lock{value: 1 ether}(agent, block.timestamp + 1 days, false);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(FactorDesk.PoolShort.selector, 0));
        desk.draw(id, 0.1 ether, FactorDesk.Kind.Pool);
    }

    /// Trading fills the pool, the pool advances an agent, the job repays it, and the advance fee is burned.
    function test_fork_tradingFillsThePoolAndAnAdvanceBurnsTheToken() public {
        // 1. trading: 2 ETH of buys leave 3.7% in fees, and a tenth of that is the pool
        vm.warp(t0 + 10);
        _trade(2 ether);
        vm.prank(stranger);
        uint256 fees = splitter.sweep();
        assertEq(fees, 0.074 ether, "the 3% tax and Pons' share of the base fee, on 2 ETH");
        assertEq(desk.pool(), 0.0074 ether, "a tenth of it is the pool");
        assertEq(address(desk).balance, 0.0074 ether);
        assertEq(admin.balance, 0.0518 ether);
        uint256 burnShare = address(burnPot).balance;
        assertEq(burnShare, 0.0148 ether);

        // 2. a job: the customer locks 0.01 ETH, the agent posts a bond and draws half of it from the pool
        vm.deal(agent, 0.005 ether);
        vm.prank(agent);
        desk.addBond{value: 0.005 ether}();
        vm.deal(customer, 0.01 ether);
        vm.prank(customer);
        uint256 id = desk.lock{value: 0.01 ether}(agent, block.timestamp + 1 days, false);
        (, uint256 canDraw) = desk.canDrawOn(id);
        assertEq(canDraw, 0.005 ether, "half of the job, inside its bond and inside four fifths of the pool");
        vm.prank(agent);
        desk.draw(id, 0.005 ether, FactorDesk.Kind.Pool);
        assertEq(agent.balance, 0.00495 ether);
        assertEq(address(burnPot).balance, burnShare + 0.00005 ether, "the fee on the advance is in the burn pot");
        assertEq(desk.pool(), 0.0024 ether);
        assertEq(desk.out(), 0.005 ether);
        _books();

        // 3. the burn: anyone, half an hour after the launch. It buys on the real curve with the trading share
        //    and the advance fee together, and the supply falls by exactly what was bought.
        vm.warp(t0 + 30 minutes);
        uint256 supply = token.totalSupply();
        vm.prank(stranger);
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertEq(ethIn, burnShare + 0.00005 ether, "all of it, the advance fee included");
        assertGt(burned, 0);
        assertEq(supply - token.totalSupply(), burned, "bought back and destroyed");
        assertEq(token.balanceOf(address(burnPot)), 0);

        // 4. the job is delivered and accepted: the pool has its advance back and the job fee on top
        vm.prank(agent);
        desk.deliver(id, keccak256("the work"));
        vm.prank(customer);
        desk.accept(id);
        assertEq(agent.balance, 0.00495 ether + 0.0048 ether, "the rest of the job, less the 2% job fee");
        assertEq(desk.pool(), 0.0074 ether + 0.0002 ether, "the pool is whole and has grown by the job fee");
        assertEq(desk.out(), 0);
        assertEq(desk.limit(agent), 0.005 ether + 0.0002 ether);
        _books();

        // 5. the burn's own buy paid the trading tax like any buy, so the next sweep feeds the pool again
        vm.prank(stranger);
        uint256 more = splitter.sweep();
        assertApproxEqAbs(more, (ethIn * 37) / 1000, 2, "3.7% of what the burn spent");
        assertEq(desk.pool(), 0.0076 ether + (more * 1000) / 10_000);
        _books();
    }

    /// The pool the trading built carries a loss the way the rulebook says, with the real token and the real fees
    /// behind it: the bond first, then the pool, the customer whole.
    function test_fork_anUnpaidAdvanceOnTheRealPool() public {
        vm.warp(t0 + 10);
        _trade(2 ether);
        splitter.sweep();
        uint256 poolBefore = desk.pool();

        vm.deal(agent, 0.002 ether);
        vm.prank(agent);
        desk.addBond{value: 0.002 ether}();
        // a first job that settles gives it 0.002 more in fees
        vm.deal(customer, 0.11 ether);
        vm.prank(customer);
        uint256 first = desk.lock{value: 0.1 ether}(agent, block.timestamp + 1 days, false);
        vm.prank(agent);
        desk.deliver(first, keccak256("the work"));
        vm.prank(customer);
        desk.accept(first);
        assertEq(desk.limit(agent), 0.004 ether);

        vm.prank(customer);
        uint256 id = desk.lock{value: 0.01 ether}(agent, block.timestamp + 1 hours, false);
        vm.prank(agent);
        desk.draw(id, 0.004 ether, FactorDesk.Kind.Compute);
        assertEq(gateway.balance, 0.00396 ether, "the compute advance went to the gateway");
        vm.warp(block.timestamp + 13 hours + 1);
        vm.prank(stranger);
        desk.refund(id);

        assertEq(customer.balance, 0.01 ether, "the customer is whole");
        assertEq(desk.totalLost(), 0.002 ether, "the bond covered half, the pool the rest");
        assertEq(desk.pool(), poolBefore, "the pool lost exactly what this agent's own job had paid into it");
        assertTrue(desk.agent(agent).barred);
        _books();
    }

    /// The curve is small: a buy larger than what is left of it is filled up to graduation and the rest comes
    /// back, so the pool's share is a tenth of the fees on what was really traded.
    function test_fork_aBuyLargerThanTheCurveFeedsThePoolOnlyForWhatTraded() public {
        vm.warp(t0 + 10);
        uint256 before = buyer.balance;
        _trade(20 ether);
        uint256 spent = before - buyer.balance;
        assertLt(spent, 20 ether, "the curve gave back what it could not fill");
        uint256 fees = splitter.sweep();
        assertEq(desk.pool(), (fees * 1000) / 10_000);
        assertEq(desk.pool(), desk.totalPoolIn());
        _books();
    }
}
