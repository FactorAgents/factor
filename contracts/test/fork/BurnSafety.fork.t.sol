// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ForkBase, ICurveX} from "./ForkBase.sol";
import {PoolSwapper} from "./PoolSwapper.sol";
import {FactorBurnPot} from "../../src/FactorBurnPot.sol";
import {FactorSplitter} from "../../src/FactorSplitter.sol";
import {IPonsV2LaunchFactory} from "../../src/interfaces/IPons.sol";
import {IPoolManager, PoolKey} from "../../src/interfaces/IPoolManager.sol";

interface ICurveFees {
    function quoteFeeBalance() external view returns (uint256);
    function creatorTaxBalance() external view returns (uint256);
    function protocolFeeShareBps() external view returns (uint16);
}

interface IHookFees {
    function pendingFees(bytes32 poolId, address currency) external view returns (uint256);
    function pendingCreatorTax(bytes32 poolId, address currency) external view returns (uint256);
}

/// buy -> burnPot.burn(0) -> sell, in one transaction, on the curve.
contract CurveSandwicher {
    receive() external payable {}

    function run(ICurveX curve, IERC20 token, FactorBurnPot pot, uint256 x)
        external
        returns (int256 pnl, uint256 potEth, uint256 depthAtBurn)
    {
        uint256 start = address(this).balance;
        uint256 got = curve.buy{value: x}(x, 0, address(this));
        (,, depthAtBurn) = pot.market();
        (potEth,) = pot.burn(0);
        token.approve(address(curve), got);
        curve.sell(got, 0, address(this));
        pnl = int256(address(this).balance) - int256(start);
    }
}

/// The same around the v4 pool, with an optional just-in-time liquidity position, in one transaction.
contract PoolSandwicher is PoolSwapper {
    struct Result {
        int256 pnl;
        uint256 potEth;
        uint256 depth;
        uint160 sqrtBefore;
        uint160 sqrtAfter;
    }

    /// x: the front-run buy (exact ETH in, stopping at `push` if it gets there); an optional position [lo, hi)
    /// of `jitL` liquidity put in just before the burn and pulled just after.
    struct Plan {
        uint256 x;
        uint160 push;
        int24 lo;
        int24 hi;
        int256 jitL;
    }

    constructor(IPoolManager pm_, PoolKey memory k) PoolSwapper(pm_, k) {}

    function run(FactorBurnPot pot, Plan memory p) external returns (Result memory r) {
        uint256 start = address(this).balance;
        buyTo(p.x, p.push);
        if (p.jitL > 0) liquidity(p.jitL, p.lo, p.hi);
        (,, r.depth) = pot.market();
        r.sqrtBefore = sqrtP();
        (r.potEth,) = pot.burn(0);
        r.sqrtAfter = sqrtP();
        if (p.jitL > 0) liquidity(-p.jitL, p.lo, p.hi);
        sell(token.balanceOf(address(this))); // everything it holds: it started with none
        r.pnl = int256(address(this).balance) - int256(start);
    }
}

/// burn() can be called by anyone, so anyone can wrap it: buy before it, let it push the price, sell after it.
/// These tests make that attack, on the real curve and the real pool, at many sizes, with and without just-in-time
/// liquidity, and assert that it loses money every time, also for an attacker who owns the admin wallet and so
/// gets 70% of the extra fees the attack itself pays.
contract BurnSafetyForkTest is ForkBase {
    uint160 constant MIN_SQRT = 4295128739;
    uint256 constant R_Q128 = 340299380613952818054172298683778356828; // sqrt(1.0001) in Q128
    uint256 constant RINV_Q128 = 340265354078544963557816517032075149313; // 1/sqrt(1.0001) in Q128

    address admin = makeAddr("factor admin");
    address gateway = makeAddr("factor gateway");
    address buyer = makeAddr("factor buyer");
    FactorBurnPot pot;
    FactorSplitter splitter;
    address token;
    ICurveX curve;
    uint256 t0;

    function setUp() public {
        _fork();
        Factor memory h = _deployFactor(address(this), admin, gateway, _pons());
        pot = h.burnPot;
        splitter = h.splitter;
        uint256 fee = _pons().launchFee();
        vm.deal(admin, fee);
        vm.prank(admin);
        token = pot.launch{value: fee}(_params(keccak256("factor-safety")), 0, new address[](0));
        curve = ICurveX(_pons().getLaunchedToken(token).curve);
        t0 = block.timestamp;
        vm.deal(buyer, 1000 ether);
    }

    // ---------- the curve ----------

    /// Creator income (ETH) sitting on the curve: 70% of the base fee and the whole tax.
    function _curveCreatorAccrued() internal view returns (uint256) {
        ICurveFees c = ICurveFees(address(curve));
        return (c.quoteFeeBalance() * (10_000 - c.protocolFeeShareBps())) / 10_000 + c.creatorTaxBalance();
    }

    function test_fork_sandwichingABurnOnTheCurveLosesMoney() public {
        uint256[4] memory pots = [uint256(1 ether), 8 ether, 20 ether, 50 ether];
        uint256[4] memory sizes = [uint256(0.01 ether), 0.1 ether, 0.5 ether, 2 ether];
        vm.warp(t0 + 20 hours);
        for (uint256 i = 0; i < 4; i++) {
            for (uint256 j = 0; j < 4; j++) {
                uint256 snap = vm.snapshotState();
                vm.deal(address(pot), pots[i]);
                CurveSandwicher a = new CurveSandwicher();
                vm.deal(address(a), sizes[j]);
                (int256 pnl, uint256 potEth, uint256 depth) = a.run(curve, IERC20(token), pot, sizes[j]);
                emit log_named_int(
                    string.concat(
                        "curve: pot ",
                        vm.toString(pots[i] / 1e18),
                        " ETH, attacker ",
                        vm.toString(sizes[j]),
                        " wei, pnl"
                    ),
                    pnl
                );
                assertGt(potEth, 0);
                assertLe(potEth, depth, "the burn spent at most 1% of the curve's depth, after the attacker's push");
                assertLt(pnl, 0, "the sandwich loses money");
                vm.revertToState(snap);
            }
        }
    }

    /// The same run by whoever holds the admin wallet, counting their 70% of the extra fees the attack pays.
    function test_fork_sandwichingABurnOnTheCurveLosesMoneyForTheAdminToo() public {
        uint256[2] memory pots = [uint256(8 ether), 50 ether];
        uint256[4] memory sizes = [uint256(0.01 ether), 0.1 ether, 0.5 ether, 2 ether];
        vm.warp(t0 + 20 hours);
        for (uint256 i = 0; i < 2; i++) {
            for (uint256 j = 0; j < 4; j++) {
                uint256 snap = vm.snapshotState();
                vm.deal(address(pot), pots[i]);
                uint256 c0 = _curveCreatorAccrued();
                pot.burn(0);
                uint256 baseline = _curveCreatorAccrued() - c0;
                vm.revertToState(snap);
                snap = vm.snapshotState();
                vm.deal(address(pot), pots[i]);
                CurveSandwicher a = new CurveSandwicher();
                vm.deal(address(a), sizes[j]);
                c0 = _curveCreatorAccrued();
                (int256 pnl,,) = a.run(curve, IERC20(token), pot, sizes[j]);
                uint256 withAttack = _curveCreatorAccrued() - c0;
                int256 adminFee = ((int256(withAttack) - int256(baseline)) * int256(uint256(splitter.ADMIN_BPS())))
                    / int256(uint256(splitter.BPS()));
                assertLt(pnl + adminFee, 0, "even with the admin's share of the fees the sandwich loses");
                vm.revertToState(snap);
            }
        }
    }

    // ---------- the pool, plain and with just-in-time liquidity ----------

    function _graduatedKey() internal returns (PoolKey memory key) {
        vm.warp(t0 + 10);
        _graduate(token, address(curve), buyer);
        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(token);
        key = PoolKey({
            currency0: address(0), currency1: token, fee: info.poolFee, tickSpacing: info.tickSpacing, hooks: HOOK
        });
    }

    function _slot0(PoolKey memory key) internal view returns (uint160 sqrtP, int24 tick, uint128 liq) {
        uint256 slot = uint256(keccak256(abi.encodePacked(keccak256(abi.encode(key)), uint256(6))));
        uint256 s0 = uint256(IPoolManager(POOL_MANAGER).extsload(bytes32(slot)));
        sqrtP = uint160(s0);
        tick = int24(uint24(s0 >> 160));
        liq = uint128(uint256(IPoolManager(POOL_MANAGER).extsload(bytes32(slot + 3))));
    }

    /// 2^96 * 1.0001^(t/2), by squaring; precise to far below 1e-9 relative.
    function _sqrtAtTick(int24 t) internal pure returns (uint160) {
        uint256 base = t >= 0 ? R_Q128 : RINV_Q128;
        uint256 n = uint256(int256(t >= 0 ? t : -t));
        uint256 result = 1 << 128;
        while (n > 0) {
            if (n & 1 == 1) result = Math.mulDiv(result, base, 1 << 128);
            n >>= 1;
            if (n > 0) base = Math.mulDiv(base, base, 1 << 128);
        }
        return uint160(result >> 32);
    }

    /// Creator income sitting in Pons' hook: the ETH part, and the token part (Pons turns it into ETH later).
    function _hookCreatorAccrued(PoolKey memory key) internal view returns (uint256 eth, uint256 tok) {
        bytes32 id = keccak256(abi.encode(key));
        uint256 creatorShare = 10_000 - ICurveFees(address(curve)).protocolFeeShareBps();
        IHookFees h = IHookFees(HOOK);
        eth = (h.pendingFees(id, address(0)) * creatorShare) / 10_000 + h.pendingCreatorTax(id, address(0));
        tok = (h.pendingFees(id, token) * creatorShare) / 10_000 + h.pendingCreatorTax(id, token);
    }

    function test_fork_sandwichingABurnInThePoolLosesMoney() public {
        PoolKey memory key = _graduatedKey();
        uint256[4] memory pots = [uint256(1 ether), 8 ether, 20 ether, 50 ether];
        uint256[4] memory sizes = [uint256(0.01 ether), 0.1 ether, 1 ether, 5 ether];
        vm.warp(t0 + 20 hours);
        for (uint256 i = 0; i < 4; i++) {
            for (uint256 j = 0; j < 4; j++) {
                uint256 snap = vm.snapshotState();
                vm.deal(address(pot), pots[i]);
                PoolSandwicher a = new PoolSandwicher(IPoolManager(POOL_MANAGER), key);
                vm.deal(address(a), sizes[j]);
                PoolSandwicher.Result memory r = a.run(pot, PoolSandwicher.Plan(sizes[j], MIN_SQRT + 1, 0, 0, 0));
                emit log_named_int(
                    string.concat(
                        "pool: pot ", vm.toString(pots[i] / 1e18), " ETH, attacker ", vm.toString(sizes[j]), " wei, pnl"
                    ),
                    r.pnl
                );
                assertGt(r.potEth, 0);
                assertLe(r.potEth, r.depth, "the burn spent at most 1% of the pool's in-range ETH depth");
                assertGe(r.sqrtAfter, (uint256(r.sqrtBefore) * 10_000) / 10_100, "the burn moved sqrtP at most 1%");
                assertLt(r.pnl, 0, "the sandwich loses money");
                vm.revertToState(snap);
            }
        }
    }

    /// The sharper attack: push the price down to just above a tick boundary, add a huge one-spacing position that
    /// is in range but ends right below the price (it inflates the in-range liquidity, and so the depth cap,
    /// without giving the burn any real depth), let the burn run, pull the liquidity, sell. `k` pushes k extra
    /// spacings. Returns the attacker's result and the admin's share of the extra creator fees it generated.
    function _jit(PoolKey memory key, uint256 potBal, int24 k)
        internal
        returns (PoolSandwicher.Result memory r, int256 adminFee)
    {
        vm.deal(address(pot), potBal);
        (int256 bE, int256 bT) = _baselineFees(key); // the same burn with no attack
        int256 aE;
        int256 aT;
        (aE, aT, r) = _attack(key, k);
        // token fees valued at the most favourable (lowest sqrtP = highest token) price seen in the attack
        adminFee = ((aE - bE + _toEth(aT - bT, r.sqrtAfter)) * int256(uint256(splitter.ADMIN_BPS())))
            / int256(uint256(splitter.BPS()));
    }

    function _jitSetup(PoolKey memory key, int24 k) internal view returns (PoolSandwicher.Plan memory p) {
        (uint160 s0, int24 tick, uint128 baseL) = _slot0(key);
        int24 sp = key.tickSpacing;
        p.lo = (tick >= 0 ? tick / sp : (tick - sp + 1) / sp) * sp - k * sp;
        p.hi = p.lo + sp;
        uint160 push = _sqrtAtTick(p.lo);
        p.push = push + push / 1e9;
        require(p.push < s0, "push above price");
        p.jitL = int256(uint256(baseL) * 200);
        p.x = 100 ether;
    }

    function _baselineFees(PoolKey memory key) internal returns (int256 dE, int256 dT) {
        uint256 snap = vm.snapshotState();
        (uint256 e, uint256 t) = _hookCreatorAccrued(key);
        dE = -int256(e);
        dT = -int256(t);
        pot.burn(0);
        (e, t) = _hookCreatorAccrued(key);
        dE += int256(e);
        dT += int256(t);
        vm.revertToState(snap);
    }

    function _attack(PoolKey memory key, int24 k)
        internal
        returns (int256 dE, int256 dT, PoolSandwicher.Result memory r)
    {
        PoolSandwicher.Plan memory p = _jitSetup(key, k);
        PoolSandwicher a = new PoolSandwicher(IPoolManager(POOL_MANAGER), key);
        vm.deal(address(a), 200 ether);
        (uint256 e, uint256 t) = _hookCreatorAccrued(key);
        dE = -int256(e);
        dT = -int256(t);
        r = a.run(pot, p);
        (e, t) = _hookCreatorAccrued(key);
        dE += int256(e);
        dT += int256(t);
    }

    function _toEth(int256 tok, uint160 sqrtP) internal pure returns (int256) {
        uint256 px = uint256(sqrtP) * uint256(sqrtP);
        return
            tok >= 0
                ? int256(Math.mulDiv(uint256(tok), 1 << 192, px))
                : -int256(Math.mulDiv(uint256(-tok), 1 << 192, px));
    }

    function test_fork_aJustInTimeLiquiditySandwichLosesMoney() public {
        PoolKey memory key = _graduatedKey();
        uint256[4] memory pots = [uint256(1 ether), 8 ether, 20 ether, 50 ether];
        int24[3] memory ks = [int24(1), 2, 4];
        vm.warp(t0 + 20 hours);
        for (uint256 i = 0; i < 4; i++) {
            for (uint256 j = 0; j < 3; j++) {
                uint256 snap = vm.snapshotState();
                (PoolSandwicher.Result memory r, int256 adminFee) = _jit(key, pots[i], ks[j]);
                emit log_named_int(
                    string.concat(
                        "JIT: pot ",
                        vm.toString(pots[i] / 1e18),
                        " ETH, k ",
                        vm.toString(uint256(int256(ks[j]))),
                        ", pnl"
                    ),
                    r.pnl
                );
                emit log_named_int("      as the admin, pnl + its share of the extra fees", r.pnl + adminFee);
                // the pot's own price limit: floor(sqrtBefore * 10000 / 10100), sqrtP down at most 1%
                assertGe(r.sqrtAfter, (uint256(r.sqrtBefore) * 10_000) / 10_100, "sqrtP moved at most 1% despite JIT");
                assertLt(r.pnl, 0, "a third party's JIT sandwich loses");
                assertLt(r.pnl + adminFee, 0, "and the admin's own loses too, counting its fee share");
                vm.revertToState(snap);
            }
        }
    }
}
