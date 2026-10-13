// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FactorDeployer} from "../script/FactorDeployer.sol";
import {FactorAccounts} from "../src/FactorAccount.sol";
import {FactorBurnPot} from "../src/FactorBurnPot.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {FactorSplitter} from "../src/FactorSplitter.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";
import {PoolKey} from "../src/interfaces/IPoolManager.sol";
import {MockCurve, MockEscrow, MockFactory, MockFactorToken, MockPoolManager} from "./mocks/MockPons.sol";

/// The three contracts deployed exactly as the deploy script deploys them, against the stand-in for Pons, with the
/// handful of moves most tests start from.
abstract contract FactorTest is Test, FactorDeployer {
    // A Tuesday noon UTC in October 2026.
    uint256 internal constant START = 1_791_288_000;

    address internal admin = makeAddr("admin");
    address internal gateway = makeAddr("gateway");
    address internal stranger = makeAddr("stranger");
    address internal trader = makeAddr("trader");

    MockPoolManager internal pm;
    MockFactory internal factory;
    MockEscrow internal escrow;

    FactorBurnPot internal burnPot;
    FactorDesk internal desk;
    FactorSplitter internal splitter;
    FactorAccounts internal accounts;

    MockFactorToken internal token;
    MockCurve internal curve;

    function setUp() public virtual {
        vm.warp(START);
        pm = new MockPoolManager();
        factory = new MockFactory(address(pm));
        escrow = MockEscrow(factory.feeEscrow());
        Factor memory h = _deployFactor(address(this), admin, gateway, IPonsV2LaunchFactory(address(factory)));
        _verifyFactor(h, admin, gateway, IPonsV2LaunchFactory(address(factory)));
        burnPot = h.burnPot;
        desk = h.desk;
        splitter = h.splitter;
        accounts = h.accounts;
    }

    function _params() internal pure returns (IPonsV2LaunchFactory.TokenParams memory p) {
        p.name = "Factor";
        p.symbol = "FACTOR";
        p.logo = "https://factor.fun/factor.png";
        p.description = "Advances for AI agents.";
        p.salt = keccak256("factor");
    }

    /// The launch as the admin sends it: the fee plus an opening buy.
    function _launch(uint256 openingBuy) internal {
        uint256 fee = factory.launchFee();
        vm.deal(admin, admin.balance + fee + openingBuy);
        vm.prank(admin);
        address t = burnPot.launch{value: fee + openingBuy}(_params(), 0, new address[](0));
        token = MockFactorToken(t);
        curve = MockCurve(IPonsV2LaunchFactory(address(factory)).getLaunchedToken(t).curve);
    }

    /// Somebody buys on the curve, past the launch seconds; the trade leaves fees on the curve.
    function _trade(uint256 eth) internal returns (uint256 got) {
        if (block.timestamp < curve.launchedAt() + 5) vm.warp(curve.launchedAt() + 5);
        vm.deal(trader, trader.balance + eth);
        vm.prank(trader);
        got = curve.buy{value: eth}(eth, 0, trader);
    }

    /// Graduate the token in the stand-in: the curve stops, a v4 pool exists with this price and depth.
    function _graduate(uint160 sqrtP, uint128 liquidity) internal {
        factory.setPhase(address(token), IPonsV2LaunchFactory.GraduationPhase.PoolCreated);
        PoolKey memory key = PoolKey({
            currency0: address(0), currency1: address(token), fee: 0, tickSpacing: 200, hooks: factory.memeHook()
        });
        pm.setPool(keccak256(abi.encode(key)), sqrtP, liquidity);
        // the pool's tokens: taken from the curve's stock, which is where the real ones come from too
        vm.prank(address(curve));
        token.transfer(address(pm), 100_000_000e18);
    }
}
