// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CoinBase} from "../coins/CoinBase.sol";
import {CoinHandler} from "./CoinHandler.sol";
import {AgentCoinSplitter} from "../../src/AgentCoinSplitter.sol";
import {IPonsV2FeeEscrow} from "../../src/interfaces/IPons.sol";
import {Rejecter} from "../mocks/Actors.sol";
import {MockCurve} from "../mocks/MockPons.sol";

/// The rules of an agent coin's splitter that must hold whatever anybody does, in whatever order: the four shares
/// always add up to what came in, every wei that came in is either here or delivered, the compute share is either
/// paid to the gateway, burned for a barred agent or waiting, and nothing stays stuck once every wallet takes its ETH.
contract AgentCoinsInvariantTest is CoinBase {
    CoinHandler internal handler;
    AgentCoinSplitter internal s;

    function setUp() public override {
        super.setUp();
        // the maker, the owner and the gateway can each be told to refuse their ETH
        Rejecter m = new Rejecter();
        m.setAccept(true);
        vm.etch(admin, address(new Rejecter()).code);
        Rejecter(payable(admin)).setAccept(true);
        vm.etch(gateway, address(new Rejecter()).code);
        Rejecter(payable(gateway)).setAccept(true);
        MockCurve c;
        (, s, c) = _launchByAgent(address(m), 0);
        vm.warp(block.timestamp + 1 minutes);
        handler = new CoinHandler(s, c, IPonsV2FeeEscrow(address(escrow)), address(this));
        targetContract(address(handler));
    }

    /// Called by the handler, once: the agent fails to repay an advance and is barred on the desk.
    fallback() external {
        _bar(agentW);
    }

    function invariant_theFourSharesAddUp() public view {
        assertEq(s.totalSplit(), s.totalToCompute() + s.totalToMaker() + s.totalToBurn() + s.totalToOwner());
    }

    function invariant_theComputeShareIsPaidBurnedOrWaiting() public view {
        assertEq(s.totalToCompute(), s.totalComputePaid() + s.totalComputeBurned() + s.computePending());
        if (!handler.barred()) assertEq(s.totalComputeBurned(), 0);
    }

    function invariant_everyWeiIsHereOrDelivered() public view {
        assertEq(handler.ghostIn(), handler.out() + address(s).balance);
        // and what is here is pending or not split yet: never less
        assertEq(address(s).balance, s.unsplit() + s.pending());
    }

    /// Nothing stays stuck: once every wallet takes its ETH, a retry and a split leave the splitter empty.
    function invariant_nothingStaysStuck() public {
        uint256 snap = vm.snapshotState();
        Rejecter(payable(s.maker())).setAccept(true);
        Rejecter(payable(admin)).setAccept(true);
        Rejecter(payable(gateway)).setAccept(true);
        s.retry();
        s.distribute();
        assertEq(address(s).balance, 0, "nothing left behind");
        assertEq(s.pending(), 0);
        vm.revertToState(snap);
    }

    function test_aScriptedYearKeepsEveryRule() public {
        for (uint256 week = 0; week < 52; ++week) {
            handler.trade(uint96(0.05 ether + week * 0.01 ether));
            handler.trade(uint96(0.2 ether));
            if (week % 5 == 1) handler.toggle(uint8(week), false);
            if (week % 5 == 3) handler.toggle(uint8(week - 2), true);
            handler.sweep();
            if (week % 4 == 0) handler.lateFees(uint64(0.01 ether));
            if (week % 6 == 2) handler.gift(uint64(0.003 ether));
            if (week % 9 == 4) handler.force(uint64(0.002 ether));
            if (week == 30) handler.bar();
            handler.claim();
            handler.retry();
            if (week % 7 == 6) {
                handler.collectMaker();
                handler.collectOwner();
            }
            vm.warp(block.timestamp + 7 days);
            invariant_theFourSharesAddUp();
            invariant_theComputeShareIsPaidBurnedOrWaiting();
            invariant_everyWeiIsHereOrDelivered();
            invariant_nothingStaysStuck();
        }
        assertGt(s.totalComputeBurned(), 0, "the agent was barred and its compute share burned since");
        assertGt(s.totalComputePaid(), 0);
    }
}
