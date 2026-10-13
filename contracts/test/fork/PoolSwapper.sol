// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager, IUnlockCallback, PoolKey, SwapParams} from "../../src/interfaces/IPoolManager.sol";

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPMLiquidity {
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
}

/// An ordinary trader on the token's real Uniswap v4 pool: buys with ETH, sells for ETH, and (for the attack tests)
/// adds and removes a liquidity position. ETH is currency0, the token currency1.
contract PoolSwapper is IUnlockCallback {
    uint160 internal constant MIN_SQRT = 4295128739;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342;
    IPoolManager internal immutable pm;
    IERC20 internal immutable token;
    PoolKey internal key;
    bytes32 internal immutable poolId;

    constructor(IPoolManager pm_, PoolKey memory k) {
        pm = pm_;
        key = k;
        token = IERC20(k.currency1);
        poolId = keccak256(abi.encode(k));
    }

    receive() external payable {}

    function sqrtP() public view returns (uint160) {
        uint256 slot = uint256(keccak256(abi.encodePacked(poolId, uint256(6))));
        return uint160(uint256(pm.extsload(bytes32(slot))));
    }

    /// ETH -> token, exact ETH in. Returns the tokens gained.
    function buy(uint256 eth) public returns (uint256 got) {
        return buyTo(eth, MIN_SQRT + 1);
    }

    /// The same, stopping if the price reaches `limit`.
    function buyTo(uint256 eth, uint160 limit) public returns (uint256 got) {
        uint256 before = token.balanceOf(address(this));
        pm.unlock(abi.encode(uint8(0), int256(eth), limit, int24(0), int24(0)));
        got = token.balanceOf(address(this)) - before;
    }

    /// token -> ETH, exact tokens in.
    function sell(uint256 tokens) public {
        pm.unlock(abi.encode(uint8(1), int256(tokens), uint160(0), int24(0), int24(0)));
    }

    /// Add (positive) or remove (negative) liquidity in [lo, hi).
    function liquidity(int256 delta, int24 lo, int24 hi) public {
        pm.unlock(abi.encode(uint8(2), delta, uint160(0), lo, hi));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "not the pool manager");
        (uint8 action, int256 amt, uint160 limit, int24 lo, int24 hi) =
            abi.decode(data, (uint8, int256, uint160, int24, int24));
        int256 d;
        if (action == 0) d = pm.swap(key, SwapParams(true, -amt, limit), "");
        else if (action == 1) d = pm.swap(key, SwapParams(false, -amt, MAX_SQRT - 1), "");
        else (d,) = IPMLiquidity(address(pm)).modifyLiquidity(key, ModifyLiquidityParams(lo, hi, amt, 0), "");
        int128 a0 = int128(d >> 128);
        int128 a1 = int128(d);
        if (a0 < 0) pm.settle{value: uint256(uint128(-a0))}();
        else if (a0 > 0) pm.take(address(0), address(this), uint256(uint128(a0)));
        if (a1 < 0) {
            pm.sync(address(token));
            token.transfer(address(pm), uint256(uint128(-a1)));
            pm.settle();
        } else if (a1 > 0) {
            pm.take(address(token), address(this), uint256(uint128(a1)));
        }
        return "";
    }
}
