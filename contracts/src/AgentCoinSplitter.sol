// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPonsV2BondingCurve, IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "./interfaces/IPons.sol";

/// @dev The part of the desk an agent coin reads: whether an agent is on the desk and whether it is barred, and the
///      two addresses the desk itself was deployed with. The struct is FactorDesk.Agent, field for field.
interface IAgentDesk {
    struct Agent {
        bool registered;
        bool barred;
        uint40 firstSettledAt;
        uint32 settled;
        uint32 settledAtHalf;
        uint32 notDelivered;
        uint32 unanswered;
        uint32 customers;
        uint32 onTime;
        uint32 late;
        uint32 advancesRepaid;
        uint32 advancesNotRepaid;
        uint32 earlyKept;
        uint256 bond;
        uint256 feesPaid;
        uint256 advancedNow;
        uint256 volume;
    }

    function agent(address who) external view returns (Agent memory);
    function burnPot() external view returns (address);
    function gateway() external view returns (address);
}

/// @dev What every token the Pons launch factory makes offers: the caller destroys its own tokens and totalSupply()
///      falls by the same amount. Checked against the live chain in the fork tests.
interface ICoinBurnable {
    function burn(uint256 value) external;
}

/// @title AgentCoinSplitter
/// @notice The address one agent coin's trading fees are paid to on Pons. The coin launcher makes one for every coin,
///         in the coin's own launch transaction. Everything that arrives here is divided four ways and the shares are
///         constants:
///           the agent's compute   paid to Factor's compute gateway with the agent's address in the event, where it
///                                 becomes that agent's compute credit; to the burn pot instead while the agent is
///                                 barred on the desk
///           the agent's maker     the wallet the launch named
///           the burn              $FACTOR's own burn pot, which buys $FACTOR and burns it
///           Factor's owner        the admin wallet of $FACTOR's burn pot
///         There is no owner and nothing can be set after deployment, except the coin, once, by the launcher.
/// @dev Pons never pushes fees. The tax first sits on the bonding curve, a sweep moves it into Pons' fee escrow, and
///      the escrow keeps a ledger. sweep() does both steps and splits, claim() does the escrow half alone, and ETH
///      sent straight to this contract is split by distribute(). All three can be called by anyone.
///
///      Rounding: the compute, maker and owner shares are rounded down and the burn share is whatever is left, so the
///      four always add up to exactly what came in and the dust is burned.
///
///      A destination that refuses its ETH does not stop the others: its share is written down as pending and stays
///      here until retry() delivers it. The maker and the owner can also collect their own pending share to an
///      address they name. Pending compute only ever goes to the gateway (or, once the agent is barred, to the burn).
///
///      Fees arrive as ETH. Pons' escrow can also hold a credit in a token; if it ever holds one in the coin itself
///      for this contract, claimToken() takes it and burns it with the coin's own burn().
contract AgentCoinSplitter is ReentrancyGuard {
    uint16 public constant BPS = 10_000;
    uint16 public constant COMPUTE_BPS = 4000;
    uint16 public constant MAKER_BPS = 2000;
    uint16 public constant BURN_BPS = 2000;
    uint16 public constant OWNER_BPS = 2000;
    /// @dev The maker, the owner and the gateway are wallets, and a wallet can carry code these days. A bounded push
    ///      keeps such code from eating all the gas and failing the split for everyone.
    uint256 internal constant PUSH_GAS = 50_000;

    /// @notice The coin launcher that made this splitter. The only address that can set the coin, once.
    address public immutable launcher;
    /// @notice The agent whose coin this is: the address its compute share is credited to.
    address public immutable agent;
    address payable public immutable maker;
    address public immutable desk;
    /// @notice Factor's compute gateway, read from the desk: where the agent's compute share is paid.
    address payable public immutable gateway;
    /// @notice $FACTOR's burn pot, read from the desk.
    address payable public immutable burnPot;
    /// @notice Factor's owner: the burn pot's admin.
    address payable public immutable owner;
    IPonsV2FeeEscrow public immutable escrow;
    IPonsV2LaunchFactory public immutable factory;

    /// @notice The coin. Set once, by the launcher, in the launch transaction.
    address public coin;

    /// @notice Shares that could not be delivered when they were split, by destination. They are not split again.
    uint256 public computePending;
    uint256 public makerPending;
    uint256 public burnPending;
    uint256 public ownerPending;

    uint256 public totalSplit;
    /// @notice The compute share as it was split, whether it reached the gateway, waits, or went to the burn.
    uint256 public totalToCompute;
    uint256 public totalToMaker;
    uint256 public totalToBurn;
    uint256 public totalToOwner;
    /// @notice What actually reached the gateway as the agent's compute credit.
    uint256 public totalComputePaid;
    /// @notice Compute shares sent to the burn because the agent was barred on the desk.
    uint256 public totalComputeBurned;
    /// @notice Coins that reached this splitter and were burned by claimToken().
    uint256 public totalCoinBurned;

    event CoinSet(address indexed coin);
    event Split(
        uint256 amount,
        uint256 toCompute,
        uint256 toMaker,
        uint256 toBurn,
        uint256 toOwner,
        bool computePushed,
        bool makerPushed,
        bool burnPushed,
        bool ownerPushed
    );
    /// @notice The agent's compute share reached the gateway. Emitted only when the ETH arrived there.
    event ComputePaid(address indexed agent, uint256 amount);
    /// @notice The agent was barred on the desk, so its compute share went to the burn pot.
    event ComputeBurned(address indexed agent, uint256 amount);
    event PendingDelivered(address indexed to, uint256 amount);
    event CoinBurned(uint256 amount);

    error ZeroAddress();
    error NotLauncher();
    error CoinAlreadySet();
    error NotMaker();
    error NotOwner();
    error NothingPending();
    error PushFailed();
    error SupplyDidNotFall();

    /// @dev Made by the launcher only, which reads every address but the agent and the maker from the chain.
    constructor(
        address agent_,
        address payable maker_,
        address desk_,
        address payable gateway_,
        address payable burnPot_,
        address payable owner_,
        IPonsV2FeeEscrow escrow_,
        IPonsV2LaunchFactory factory_
    ) {
        if (
            agent_ == address(0) || maker_ == address(0) || desk_ == address(0) || gateway_ == address(0)
                || burnPot_ == address(0) || owner_ == address(0) || address(escrow_) == address(0)
                || address(factory_) == address(0)
        ) revert ZeroAddress();
        launcher = msg.sender;
        agent = agent_;
        maker = maker_;
        desk = desk_;
        gateway = gateway_;
        burnPot = burnPot_;
        owner = owner_;
        escrow = escrow_;
        factory = factory_;
    }

    receive() external payable {}

    /// @notice The launcher only, once: the coin whose fees come here.
    function setCoin(address coin_) external {
        if (msg.sender != launcher) revert NotLauncher();
        if (coin != address(0)) revert CoinAlreadySet();
        if (coin_ == address(0)) revert ZeroAddress();
        coin = coin_;
        emit CoinSet(coin_);
    }

    /// @notice Everything in one transaction: release the fees still on the bonding curve into Pons' escrow, claim
    ///         what the escrow holds for this contract, and split it. Anyone may call it; Factor's engine does once a
    ///         coin has gathered enough to be worth the gas.
    /// @dev Only the fee recipient (this contract) or Pons' own keeper may release a curve's fees. Buyback is off for
    ///      every agent coin, so the release swaps nothing and its zero minimum cannot be sandwiched. The release is
    ///      best effort: it reverts when there is nothing on the curve, and after graduation only Pons' keeper can
    ///      release the pool's fees. The claim runs either way.
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

    /// @notice Split whatever ETH is here and has not been split yet.
    function distribute() external nonReentrant returns (uint256 amount) {
        amount = _distribute();
    }

    /// @notice Claim whatever of the coin Pons' escrow holds for this contract, and burn every coin here with the
    ///         coin's own burn(): its total supply falls by exactly that much, or this reverts. Anyone may call it.
    ///         With nothing to claim and nothing here (or before the coin is set) it does nothing and returns zero.
    /// @dev The escrow's claimToken() reverts when there is no credit, so it is only called when there is one.
    function claimToken() external nonReentrant returns (uint256 amount) {
        address t = coin;
        if (t == address(0)) return 0;
        if (escrow.balanceOfToken(address(this), t) > 0) escrow.claimToken(t);
        amount = IERC20(t).balanceOf(address(this));
        if (amount == 0) return 0;
        uint256 supplyBefore = IERC20(t).totalSupply();
        ICoinBurnable(t).burn(amount);
        if (supplyBefore - IERC20(t).totalSupply() != amount) revert SupplyDidNotFall();
        totalCoinBurned += amount;
        emit CoinBurned(amount);
    }

    /// @notice Deliver every share that was refused earlier, each to where it was split for. Anyone may call it. A
    ///         share that is refused again stays pending. Pending compute goes to the burn instead if the agent has
    ///         been barred on the desk since.
    function retry() external nonReentrant {
        uint256 c = computePending;
        if (c > 0) {
            computePending = 0;
            if (_barred()) {
                (bool ok,) = burnPot.call{value: c}("");
                if (ok) {
                    totalComputeBurned += c;
                    emit ComputeBurned(agent, c);
                } else {
                    computePending = c;
                }
            } else if (_pushCapped(gateway, c)) {
                totalComputePaid += c;
                emit ComputePaid(agent, c);
            } else {
                computePending = c;
            }
        }
        uint256 m = makerPending;
        if (m > 0) {
            makerPending = 0;
            if (_pushCapped(maker, m)) emit PendingDelivered(maker, m);
            else makerPending = m;
        }
        uint256 b = burnPending;
        if (b > 0) {
            burnPending = 0;
            (bool ok,) = burnPot.call{value: b}("");
            if (ok) emit PendingDelivered(burnPot, b);
            else burnPending = b;
        }
        uint256 o = ownerPending;
        if (o > 0) {
            ownerPending = 0;
            if (_pushCapped(owner, o)) emit PendingDelivered(owner, o);
            else ownerPending = o;
        }
    }

    /// @notice The maker collects a maker share that its own wallet refused, to an address it names. Only ETH that
    ///         was already split as the maker's share can leave this way.
    function withdrawMaker(address payable to) external nonReentrant {
        if (msg.sender != maker) revert NotMaker();
        uint256 m = makerPending;
        makerPending = 0;
        _collect(to, m);
    }

    /// @notice The owner collects an owner share that its own wallet refused, to an address it names.
    function withdrawOwner(address payable to) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        uint256 o = ownerPending;
        ownerPending = 0;
        _collect(to, o);
    }

    // ---------- views ----------

    /// @notice The coin's bonding curve while this contract can still release its fees: zero before the coin is set
    ///         and from graduation on.
    function curve() public view returns (address) {
        address t = coin;
        if (t == address(0)) return address(0);
        try factory.getLaunchedToken(t) returns (IPonsV2LaunchFactory.LaunchedToken memory info) {
            if (info.exists && info.phase == IPonsV2LaunchFactory.GraduationPhase.NotGraduated) return info.curve;
        } catch {}
        return address(0);
    }

    /// @notice ETH here that has arrived and not been split yet.
    function unsplit() public view returns (uint256) {
        return address(this).balance - computePending - makerPending - burnPending - ownerPending;
    }

    /// @notice Every pending share together.
    function pending() external view returns (uint256) {
        return computePending + makerPending + burnPending + ownerPending;
    }

    // ---------- internals ----------

    function _barred() internal view returns (bool) {
        return IAgentDesk(desk).agent(agent).barred;
    }

    function _collect(address payable to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert NothingPending();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PushFailed();
        emit PendingDelivered(to, amount);
    }

    /// @dev A push with a fixed amount of gas that ignores whatever the receiver returns. Written out in assembly for
    ///      that last part: nothing the receiver hands back is copied, so code on a wallet can neither take more gas
    ///      than the cap nor make this contract pay to read a large reply.
    function _pushCapped(address to, uint256 value) internal returns (bool ok) {
        uint256 gasCap = PUSH_GAS;
        assembly ("memory-safe") {
            ok := call(gasCap, to, value, 0, 0, 0, 0)
        }
    }

    function _distribute() internal returns (uint256 amount) {
        amount = unsplit();
        if (amount == 0) return 0;
        uint256 toCompute = (amount * COMPUTE_BPS) / BPS;
        uint256 toMaker = (amount * MAKER_BPS) / BPS;
        uint256 toOwner = (amount * OWNER_BPS) / BPS;
        // the remainder, so the four always add up to the whole and the rounding dust is burned, not kept
        uint256 toBurn = amount - toCompute - toMaker - toOwner;

        totalSplit += amount;
        totalToCompute += toCompute;
        totalToMaker += toMaker;
        totalToBurn += toBurn;
        totalToOwner += toOwner;

        // A barred agent's compute share joins the burn share in the same push, and is counted as burned compute.
        uint256 computeToBurn = 0;
        if (toCompute > 0 && _barred()) {
            computeToBurn = toCompute;
            toCompute = 0;
        }

        // A share whose push is refused is written down and stays here; the others are not held up by it.
        // ETH that arrives while these pushes run is not part of this split: it waits, unsplit, for the next call.
        bool okBurn = true;
        if (toBurn + computeToBurn > 0) {
            (okBurn,) = burnPot.call{value: toBurn + computeToBurn}("");
            if (!okBurn) {
                burnPending += toBurn;
                computePending += computeToBurn;
            } else if (computeToBurn > 0) {
                totalComputeBurned += computeToBurn;
                emit ComputeBurned(agent, computeToBurn);
            }
        }
        bool okCompute = true;
        if (toCompute > 0) {
            okCompute = _pushCapped(gateway, toCompute);
            if (okCompute) {
                totalComputePaid += toCompute;
                emit ComputePaid(agent, toCompute);
            } else {
                computePending += toCompute;
            }
        }
        bool okMaker = true;
        if (toMaker > 0) {
            okMaker = _pushCapped(maker, toMaker);
            if (!okMaker) makerPending += toMaker;
        }
        bool okOwner = true;
        if (toOwner > 0) {
            okOwner = _pushCapped(owner, toOwner);
            if (!okOwner) ownerPending += toOwner;
        }
        emit Split(amount, toCompute + computeToBurn, toMaker, toBurn, toOwner, okCompute, okMaker, okBurn, okOwner);
    }
}
