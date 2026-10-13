// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPonsV2BondingCurve, IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "./interfaces/IPons.sol";

interface IBurnPotWiring {
    function splitter() external view returns (address);
    function factory() external view returns (address);
    function token() external view returns (address);
}

interface IDeskWiring {
    function burnPot() external view returns (address);
}

/// @title FactorSplitter
/// @notice The address $FACTOR's trading fees are paid to on Pons. Everything that arrives here is divided three
///         ways and the proportions are constants:
///           70% to the admin wallet
///           20% to the burn pot, which buys $FACTOR and burns it
///           10% to the desk, where it becomes the pool that advances agents
///         There is no owner and nothing can be set after deployment: the three destinations and the three shares
///         are fixed in the bytecode. The token itself is not set here either; it is read from the burn pot, which
///         launches it.
/// @dev Pons never pushes fees. The tax first sits on the bonding curve, a sweep moves it into Pons' fee escrow, and
///      the escrow keeps a ledger. sweep() does both steps and splits, claim() does the escrow half alone, and ETH
///      sent straight to this contract is split by distribute(). All three can be called by anyone.
///
///      Rounding: the admin share and the pool share are rounded down and the burn share is whatever is left, so
///      the three always add up to exactly what came in, the admin never receives more than 70% and the dust is
///      burned. The burn share is 20% plus at most 2 wei of that dust.
///
///      A destination that refuses its ETH does not stop the others: its share is written down as pending and
///      stays here until retry() delivers it (or, for the admin share only, until the admin collects it).
///
///      Fees arrive as ETH. Pons' escrow can also hold a credit in a token; if it ever holds one in $FACTOR for
///      this contract, claimToken() takes it and sends it to the burn pot, which burns it. $FACTOR is never split.
contract FactorSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    uint16 public constant ADMIN_BPS = 7000;
    uint16 public constant BURN_BPS = 2000;
    uint16 public constant POOL_BPS = 1000;
    /// @dev The admin wallet is an ordinary wallet, but a wallet can carry code these days. A bounded push keeps
    ///      such code from eating all the gas and failing the split for everyone.
    uint256 internal constant ADMIN_PUSH_GAS = 50_000;

    address payable public immutable admin;
    address payable public immutable burnPot;
    /// @notice The desk. ETH sent to it goes into the pool and can only leave as an advance on a locked job.
    address payable public immutable desk;
    IPonsV2FeeEscrow public immutable escrow;

    /// @notice Shares that could not be delivered when they were split, by destination. They are not split again.
    uint256 public adminPending;
    uint256 public burnPending;
    uint256 public poolPending;

    uint256 public totalSplit;
    uint256 public totalToAdmin;
    uint256 public totalToBurn;
    uint256 public totalToPool;

    event Split(
        uint256 amount,
        uint256 toAdmin,
        uint256 toBurn,
        uint256 toPool,
        bool adminPushed,
        bool burnPushed,
        bool poolPushed
    );
    event PendingDelivered(address indexed to, uint256 amount);
    event TokensSentToBurn(uint256 amount);

    error ZeroAddress();
    error BadAdmin();
    error PotMismatch();
    error DeskMismatch();
    error EscrowMismatch();
    error NotAdmin();
    error NothingPending();
    error PushFailed();

    /// @dev The burn pot must already exist and be wired to this address (the deploy script predicts this address
    ///      from the deployer's nonce and gives it to the burn pot), and the desk must exist and send its advance
    ///      fees to that same burn pot. If either is missing or wired elsewhere this constructor fails, so fees
    ///      can never be aimed at a splitter that pays an empty address.
    constructor(address payable admin_, address payable burnPot_, address payable desk_, IPonsV2FeeEscrow escrow_) {
        if (admin_ == address(0) || burnPot_ == address(0) || desk_ == address(0)) revert ZeroAddress();
        if (address(escrow_) == address(0)) revert ZeroAddress();
        // the admin must be an address of its own: any of these would quietly turn the 70% into something else
        if (admin_ == burnPot_ || admin_ == desk_ || admin_ == address(this) || admin_ == address(escrow_)) {
            revert BadAdmin();
        }
        if (burnPot_.code.length == 0) revert PotMismatch();
        if (IBurnPotWiring(burnPot_).splitter() != address(this)) revert PotMismatch();
        if (desk_ == burnPot_ || desk_.code.length == 0) revert DeskMismatch();
        if (IDeskWiring(desk_).burnPot() != burnPot_) revert DeskMismatch();
        // this contract claims from the escrow the live factory credits, or it would wait on the wrong ledger
        if (IPonsV2LaunchFactory(IBurnPotWiring(burnPot_).factory()).feeEscrow() != address(escrow_)) {
            revert EscrowMismatch();
        }
        admin = admin_;
        burnPot = burnPot_;
        desk = desk_;
        escrow = escrow_;
    }

    receive() external payable {}

    /// @notice Everything in one transaction: release the fees still on the bonding curve into Pons' escrow, claim
    ///         what the escrow holds for this contract, and split it. Anyone may call it; the engine does, regularly.
    /// @dev Only the fee recipient (this contract) or Pons' own keeper may release a curve's fees, which is why the
    ///      release has to be a function here. Buyback is off for the token, so the release swaps nothing and its
    ///      zero minimum cannot be sandwiched. The release is best effort: it reverts when there is nothing on the
    ///      curve, and after graduation only Pons' keeper can release the pool's fees. The claim runs either way.
    function sweep() external nonReentrant returns (uint256 amount) {
        address c = curve();
        if (c != address(0)) {
            try IPonsV2BondingCurve(c).sweepFees(0) {} catch {}
        }
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        amount = _distribute();
    }

    /// @notice Claim what the escrow holds for this contract and split it.
    function claim() external nonReentrant returns (uint256 amount) {
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        amount = _distribute();
    }

    /// @notice Claim whatever $FACTOR Pons' escrow holds for this contract and send every $FACTOR here to the burn
    ///         pot, which burns all it holds with its next burn. Anyone may call it. The only place the tokens can
    ///         go is the burn pot. With nothing to claim and nothing here (or before the launch) it does nothing
    ///         and returns zero; it does not revert.
    /// @dev The escrow's claimToken() reverts when there is no credit, so it is only called when there is one.
    function claimToken() external nonReentrant returns (uint256 amount) {
        address t = IBurnPotWiring(burnPot).token();
        if (t == address(0)) return 0;
        if (escrow.balanceOfToken(address(this), t) > 0) escrow.claimToken(t);
        amount = IERC20(t).balanceOf(address(this));
        if (amount == 0) return 0;
        IERC20(t).safeTransfer(burnPot, amount);
        emit TokensSentToBurn(amount);
    }

    /// @notice Split whatever ETH is here and has not been split yet.
    function distribute() external nonReentrant returns (uint256 amount) {
        amount = _distribute();
    }

    /// @notice The token's bonding curve while this contract can still release its fees: zero before the launch
    ///         and from graduation on.
    function curve() public view returns (address) {
        address t = IBurnPotWiring(burnPot).token();
        if (t == address(0)) return address(0);
        try IPonsV2LaunchFactory(IBurnPotWiring(burnPot).factory()).getLaunchedToken(t) returns (
            IPonsV2LaunchFactory.LaunchedToken memory info
        ) {
            if (info.exists && info.phase == IPonsV2LaunchFactory.GraduationPhase.NotGraduated) return info.curve;
        } catch {}
        return address(0);
    }

    /// @notice ETH here that has arrived and not been split yet.
    function unsplit() public view returns (uint256) {
        return address(this).balance - adminPending - burnPending - poolPending;
    }

    /// @notice Deliver every share that was refused earlier, each to the destination it was split for. Anyone may
    ///         call it. A share that is refused again simply stays pending.
    function retry() external nonReentrant {
        uint256 a = adminPending;
        if (a > 0) {
            adminPending = 0;
            bool ok = _pushCapped(admin, a);
            if (ok) emit PendingDelivered(admin, a);
            else adminPending = a;
        }
        uint256 b = burnPending;
        if (b > 0) {
            burnPending = 0;
            (bool ok,) = burnPot.call{value: b}("");
            if (ok) emit PendingDelivered(burnPot, b);
            else burnPending = b;
        }
        uint256 p = poolPending;
        if (p > 0) {
            poolPending = 0;
            (bool ok,) = desk.call{value: p}("");
            if (ok) emit PendingDelivered(desk, p);
            else poolPending = p;
        }
    }

    /// @notice The admin collects an admin share that its own wallet refused, to an address it names. This moves
    ///         only ETH that was already split as the admin's 70%; the burn pot's and the pool's shares cannot
    ///         leave this way.
    function withdrawAdmin(address payable to) external nonReentrant {
        if (msg.sender != admin) revert NotAdmin();
        if (to == address(0)) revert ZeroAddress();
        uint256 a = adminPending;
        if (a == 0) revert NothingPending();
        adminPending = 0;
        (bool ok,) = to.call{value: a}("");
        if (!ok) revert PushFailed();
        emit PendingDelivered(to, a);
    }

    /// @dev A push with a fixed amount of gas that ignores whatever the receiver returns. Written out in assembly
    ///      for that last part: nothing the receiver hands back is copied, so code on the admin wallet can neither
    ///      take more gas than the cap nor make this contract pay to read a large reply.
    function _pushCapped(address to, uint256 value) internal returns (bool ok) {
        uint256 gasCap = ADMIN_PUSH_GAS;
        assembly ("memory-safe") {
            ok := call(gasCap, to, value, 0, 0, 0, 0)
        }
    }

    function _distribute() internal returns (uint256 amount) {
        amount = unsplit();
        if (amount == 0) return 0;
        uint256 toAdmin = (amount * ADMIN_BPS) / BPS;
        uint256 toPool = (amount * POOL_BPS) / BPS;
        // the remainder, so the three always add up to the whole and the rounding dust is burned, not kept
        uint256 toBurn = amount - toAdmin - toPool;

        totalSplit += amount;
        totalToAdmin += toAdmin;
        totalToBurn += toBurn;
        totalToPool += toPool;

        // A share whose push is refused is written down and stays here; the others are not held up by it.
        // ETH that arrives while these pushes run is not part of this split: it waits, unsplit, for the next call.
        bool okBurn = true;
        if (toBurn > 0) {
            (okBurn,) = burnPot.call{value: toBurn}("");
            if (!okBurn) burnPending += toBurn;
        }
        bool okPool = true;
        if (toPool > 0) {
            (okPool,) = desk.call{value: toPool}("");
            if (!okPool) poolPending += toPool;
        }
        bool okAdmin = true;
        if (toAdmin > 0) {
            okAdmin = _pushCapped(admin, toAdmin);
            if (!okAdmin) adminPending += toAdmin;
        }
        emit Split(amount, toAdmin, toBurn, toPool, okAdmin, okBurn, okPool);
    }
}
