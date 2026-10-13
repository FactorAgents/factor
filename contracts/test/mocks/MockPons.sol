// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPonsV2LaunchFactory} from "../../src/interfaces/IPons.sol";
import {IUnlockCallback, PoolKey, SwapParams} from "../../src/interfaces/IPoolManager.sol";

// A stand-in for Pons, small enough to read in one sitting, for the tests that do not fork the chain. It behaves
// like the real thing in the ways the Factor contracts depend on (checked against the real thing in test/fork) and
// it can be told to misbehave in the ways they must survive.

/// A token like the ones the Pons factory makes: fixed supply, burn and burnFrom lower it, no permit.
/// `fakeBurn` turns burn and burnFrom into transfers to the dead address, so the supply does not fall: the
/// contracts must notice.
contract MockFactorToken is ERC20 {
    bool public fakeBurn;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    constructor(string memory name_, string memory symbol_, address to) ERC20(name_, symbol_) {
        _mint(to, 1_000_000_000e18);
    }

    function setFakeBurn(bool on) external {
        fakeBurn = on;
    }

    function burn(uint256 value) external {
        if (fakeBurn) _transfer(msg.sender, DEAD, value);
        else _burn(msg.sender, value);
    }

    function burnFrom(address account, uint256 value) external {
        _spendAllowance(account, msg.sender, value);
        if (fakeBurn) _transfer(account, DEAD, value);
        else _burn(account, value);
    }
}

/// Pons' fee escrow: a ledger of ETH owed to fee recipients, paid out on claim(), and a second ledger of tokens
/// owed to them, paid out on claimToken(), which like the real one reverts when nothing is owed.
contract MockEscrow {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public balanceOfToken;

    function creditToken(address recipient, address token, uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        balanceOfToken[recipient][token] += amount;
    }

    function claimToken(address token) external returns (uint256 amount) {
        amount = balanceOfToken[msg.sender][token];
        require(amount > 0, "NothingToClaim");
        balanceOfToken[msg.sender][token] = 0;
        IERC20(token).transfer(msg.sender, amount);
    }

    function credit(address recipient) external payable {
        balanceOf[recipient] += msg.value;
    }

    function claim() external returns (uint256 amount) {
        amount = balanceOf[msg.sender];
        balanceOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "claim refused");
    }
}

/// A bonding curve: constant product over a virtual ETH reserve, 1% base fee and 3% tax held until released,
/// a 99% tax on the launch seconds for anyone not exempt.
contract MockCurve {
    MockFactorToken public immutable token;
    MockEscrow public immutable escrow;
    address public immutable feeRecipient;
    address public immutable operator;
    uint256 public immutable launchedAt;

    uint256 public quoteReserve = 1.2 ether; // virtual to begin with
    uint256 public tokenReserve = 800_000_000e18;
    uint256 public pendingFees;
    bool public readyToGraduate;
    uint256 public maxFill; // 0 = no limit; otherwise the most ETH one buy fills, the rest is refunded
    mapping(address => bool) public snipeTaxExempt;

    constructor(
        MockFactorToken token_,
        MockEscrow escrow_,
        address feeRecipient_,
        address operator_,
        address[] memory exempt_
    ) {
        token = token_;
        escrow = escrow_;
        feeRecipient = feeRecipient_;
        operator = operator_;
        launchedAt = block.timestamp;
        snipeTaxExempt[msg.sender] = true;
        snipeTaxExempt[feeRecipient_] = true;
        for (uint256 i = 0; i < exempt_.length; ++i) {
            snipeTaxExempt[exempt_[i]] = true;
        }
    }

    function exempt(address who) external {
        snipeTaxExempt[who] = true;
    }

    function setReadyToGraduate(bool on) external {
        readyToGraduate = on;
    }

    function setMaxFill(uint256 m) external {
        maxFill = m;
    }

    function getReserves() external view returns (uint256, uint256) {
        return (quoteReserve, tokenReserve);
    }

    function currentSnipeTaxBps(address who) public view returns (uint256) {
        if (snipeTaxExempt[who] || block.timestamp >= launchedAt + 5) return 0;
        return 9900;
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 out) {
        require(msg.value == quoteIn, "value");
        require(!readyToGraduate, "graduating");
        uint256 fill = maxFill != 0 && quoteIn > maxFill ? maxFill : quoteIn;
        uint256 fee = (fill * 400) / 10_000;
        uint256 net = fill - fee;
        out = (tokenReserve * net) / (quoteReserve + net);
        quoteReserve += net;
        tokenReserve -= out;
        pendingFees += fee;
        // the launch seconds' tax, for a buyer that is not exempt
        out -= (out * currentSnipeTaxBps(msg.sender)) / 10_000;
        require(out >= minTokensOut, "slippage");
        token.transfer(recipient, out);
        if (quoteIn > fill) {
            (bool ok,) = msg.sender.call{value: quoteIn - fill}("");
            require(ok, "refund refused");
        }
    }

    /// The fee recipient or Pons' keeper only. The recipient gets the whole tax and 70% of the base fee.
    function sweepFees(uint256) external {
        require(msg.sender == feeRecipient || msg.sender == operator, "NotFeeSweepOperator");
        require(pendingFees > 0, "nothing to sweep");
        uint256 fees = pendingFees;
        pendingFees = 0;
        uint256 toCreator = (fees * 37) / 40;
        escrow.credit{value: toCreator}(feeRecipient);
        (bool ok,) = operator.call{value: fees - toCreator}("");
        require(ok, "protocol refused");
    }
}

/// The launch factory. `lie` makes getLaunchedToken() misreport one field, to prove the burn pot reads the launch
/// back rather than trusting that it got what it asked for.
contract MockFactory {
    enum Lie {
        None,
        Missing,
        Deployer,
        Recipient,
        Pair,
        Tax,
        Buyback
    }

    uint256 public launchFee = 0.0005 ether;
    address public immutable poolManager;
    address public immutable memeHook = address(0x4004);
    address public immutable feeEscrow;
    address public immutable operator = address(0x0bE2);
    Lie public lie;
    uint256 public curveMaxFill;

    mapping(address => IPonsV2LaunchFactory.LaunchedToken) internal _launched;

    constructor(address poolManager_) {
        poolManager = poolManager_;
        feeEscrow = address(new MockEscrow());
    }

    function setLie(Lie lie_) external {
        lie = lie_;
    }

    function setLaunchFee(uint256 fee) external {
        launchFee = fee;
    }

    /// The most ETH one buy fills on curves made from here on (0 = no limit); the rest of a buy is refunded.
    function setCurveMaxFill(uint256 m) external {
        curveMaxFill = m;
    }

    function setPhase(address token, IPonsV2LaunchFactory.GraduationPhase phase) external {
        _launched[token].phase = phase;
    }

    function launchToken(
        IPonsV2LaunchFactory.TokenParams calldata params,
        uint256,
        address pairToken,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve) {
        require(msg.value == launchFee, "launch fee");
        // the curve's address is needed to mint to, and the curve needs the token: predict the curve
        uint256 nonce = _nonce;
        _nonce += 2;
        address curveAt = _create(nonce + 1);
        MockFactorToken t = new MockFactorToken(params.name, params.symbol, curveAt);
        MockCurve c = new MockCurve(t, MockEscrow(feeEscrow), params.creatorFeeRecipient, operator, snipeTaxExemptions);
        require(address(c) == curveAt, "curve address");
        c.exempt(msg.sender);
        if (curveMaxFill != 0) c.setMaxFill(curveMaxFill);
        token = address(t);
        curve = address(c);
        IPonsV2LaunchFactory.LaunchedToken storage info = _launched[token];
        info.token = token;
        info.curve = curve;
        info.deployer = msg.sender;
        info.creatorFeeRecipient = params.creatorFeeRecipient;
        info.pairToken = pairToken;
        info.tickSpacing = 200;
        info.creatorTaxBps = params.creatorTaxBps;
        info.buybackEnabled = params.buybackEnabled;
        info.exists = true;
    }

    uint256 internal _nonce = 2; // the constructor made the escrow at nonce 1

    function _create(uint256 nonce) internal view returns (address) {
        require(nonce < 0x80, "mock: too many launches");
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), address(this), bytes1(uint8(nonce)))))
            )
        );
    }

    function getLaunchedToken(address token) external view returns (IPonsV2LaunchFactory.LaunchedToken memory info) {
        info = _launched[token];
        if (lie == Lie.Missing) info.exists = false;
        if (lie == Lie.Deployer) info.deployer = address(0xBAD);
        if (lie == Lie.Recipient) info.creatorFeeRecipient = address(0xBAD);
        if (lie == Lie.Pair) info.pairToken = address(0xBAD);
        if (lie == Lie.Tax) info.creatorTaxBps = 301;
        if (lie == Lie.Buyback) info.buybackEnabled = true;
    }
}

/// Uniswap v4's PoolManager, as far as one ETH -> token swap goes: unlock, swap, settle, take, and the two storage
/// slots the burn pot reads. Tokens are paid from this contract's own balance at a fixed rate.
contract MockPoolManager {
    enum Fault {
        None,
        Overcharge, // asks for more ETH than the swap was for
        WrongSign // reports a swap that paid no tokens
    }

    mapping(bytes32 => bytes32) public slots;
    uint256 public rate = 20_000_000e18; // tokens per 1 ETH
    uint256 public fillBps = 10_000; // how much of the asked ETH a swap takes (a price limit stopping it early)
    Fault public fault;
    uint256 public settled;

    function setPool(bytes32 poolId, uint160 sqrtP, uint128 liquidity) external {
        uint256 slot = uint256(keccak256(abi.encodePacked(poolId, uint256(6))));
        slots[bytes32(slot)] = bytes32(uint256(sqrtP));
        slots[bytes32(slot + 3)] = bytes32(uint256(liquidity));
    }

    function setRate(uint256 rate_) external {
        rate = rate_;
    }

    function setFillBps(uint256 bps) external {
        fillBps = bps;
    }

    function setFault(Fault f) external {
        fault = f;
    }

    function extsload(bytes32 slot) external view returns (bytes32) {
        return slots[slot];
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        return IUnlockCallback(msg.sender).unlockCallback(data);
    }

    function swap(PoolKey memory, SwapParams memory params, bytes calldata) external view returns (int256 delta) {
        require(params.zeroForOne && params.amountSpecified < 0, "mock: ETH in only");
        uint256 ethIn = (uint256(-params.amountSpecified) * fillBps) / 10_000;
        uint256 out = (ethIn * rate) / 1e18;
        if (fault == Fault.Overcharge) ethIn = uint256(-params.amountSpecified) + 1;
        if (fault == Fault.WrongSign) out = 0;
        int128 amount0 = -int128(uint128(ethIn));
        int128 amount1 = int128(uint128(out));
        delta = int256((uint256(uint128(amount0)) << 128) | uint256(uint128(amount1)));
    }

    function sync(address) external {}

    function settle() external payable returns (uint256) {
        settled += msg.value;
        return msg.value;
    }

    function take(address currency, address to, uint256 amount) external {
        IERC20(currency).transfer(to, amount);
    }
}
