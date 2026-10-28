// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {AgentCoinSplitter} from "../../src/AgentCoinSplitter.sol";
import {IPonsV2FeeEscrow} from "../../src/interfaces/IPons.sol";
import {ForceSend, Rejecter} from "../mocks/Actors.sol";
import {MockCurve} from "../mocks/MockPons.sol";

/// Does to one agent coin's splitter whatever anybody could: trades of the coin, sweeps, claims, ETH sent and forced
/// in, Pons' keeper crediting the escrow late, the maker, the owner and the gateway refusing and accepting their ETH,
/// retries and collections, and the agent being barred. It keeps a ghost count of every wei that went in.
contract CoinHandler is CommonBase, StdUtils {
    AgentCoinSplitter internal immutable s;
    MockCurve internal immutable curve;
    IPonsV2FeeEscrow internal immutable escrow;
    Rejecter internal immutable makerW;
    Rejecter internal immutable ownerW;
    Rejecter internal immutable gatewayW;
    address internal immutable burnPot;
    address internal constant TRADER = address(0x7EAD);
    address internal constant COLLECTOR = address(0xC011);
    address internal immutable barAgent; // the test bars the agent through this, once

    uint256 public ghostIn; // every wei that reached the splitter
    uint256 public potIn; // every wei the burn pot received from it
    uint256 public calls;
    bool public barred;

    constructor(AgentCoinSplitter s_, MockCurve curve_, IPonsV2FeeEscrow escrow_, address barAgent_) {
        s = s_;
        curve = curve_;
        escrow = escrow_;
        makerW = Rejecter(payable(s_.maker()));
        ownerW = Rejecter(payable(s_.owner()));
        gatewayW = Rejecter(payable(s_.gateway()));
        burnPot = s_.burnPot();
        barAgent = barAgent_;
    }

    /// ETH that left the splitter, wherever it went: the three wallets, the burn pot and the collector.
    function out() public view returns (uint256) {
        return address(makerW).balance + address(ownerW).balance + address(gatewayW).balance + potIn + COLLECTOR.balance;
    }

    function _in(function() external returns (uint256) f) internal {
        uint256 before = address(s).balance;
        uint256 outBefore = out();
        uint256 potBefore = burnPot.balance;
        f();
        potIn += burnPot.balance - potBefore;
        // what came in = what is here now, less what was here, plus what left
        ghostIn += address(s).balance + (out() - outBefore) - before;
    }

    function trade(uint96 eth) external {
        calls++;
        eth = uint96(bound(eth, 0.0001 ether, 3 ether));
        vm.deal(TRADER, eth);
        vm.prank(TRADER);
        curve.buy{value: eth}(eth, 0, TRADER);
    }

    function sweep() external {
        calls++;
        _in(s.sweep);
    }

    function claim() external {
        calls++;
        _in(s.claim);
    }

    function distribute() external {
        calls++;
        _in(s.distribute);
    }

    function lateFees(uint64 eth) external {
        calls++;
        eth = uint64(bound(eth, 1, 1 ether));
        vm.deal(address(this), eth);
        escrow.credit{value: eth}(address(s));
    }

    function gift(uint64 eth) external {
        calls++;
        eth = uint64(bound(eth, 1, 1 ether));
        vm.deal(address(this), eth);
        (bool ok,) = address(s).call{value: eth}("");
        require(ok);
        ghostIn += eth;
    }

    function force(uint64 eth) external {
        calls++;
        eth = uint64(bound(eth, 1, 1 ether));
        vm.deal(address(this), eth);
        new ForceSend{value: eth}(payable(address(s)));
        ghostIn += eth;
    }

    function toggle(uint8 who, bool accept) external {
        calls++;
        Rejecter r = who % 3 == 0 ? makerW : who % 3 == 1 ? ownerW : gatewayW;
        r.setAccept(accept);
    }

    function retry() external {
        calls++;
        uint256 potBefore = burnPot.balance;
        s.retry();
        potIn += burnPot.balance - potBefore;
    }

    function collectMaker() external {
        calls++;
        if (s.makerPending() == 0) return;
        vm.prank(address(makerW));
        s.withdrawMaker(payable(COLLECTOR));
    }

    function collectOwner() external {
        calls++;
        if (s.ownerPending() == 0) return;
        vm.prank(address(ownerW));
        s.withdrawOwner(payable(COLLECTOR));
    }

    /// The agent is barred on the desk (the test does it, through a desk job the agent fails to repay).
    function bar() external {
        calls++;
        if (barred) return;
        barred = true;
        (bool ok,) = barAgent.call("");
        require(ok, "barring failed");
    }

    receive() external payable {}
}
