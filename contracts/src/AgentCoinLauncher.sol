// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IPonsV2BondingCurve, IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "./interfaces/IPons.sol";
import {AgentCoinSplitter, IAgentDesk} from "./AgentCoinSplitter.sol";

interface IBurnPotReads {
    function admin() external view returns (address);
    function factory() external view returns (address);
}

/// @title AgentCoinLauncher
/// @notice Launches an agent's own coin on Pons: one coin per agent on Factor's desk, ever. Each coin's trading fees
///         go to a splitter made for it in the same transaction (AgentCoinSplitter), which pays the agent's compute
///         credit, its maker, the $FACTOR burn and Factor's owner in shares fixed in its code.
///
///         Who may launch an agent's coin:
///           - the agent itself, from its own registered wallet, naming the maker its share goes to; or
///           - the maker, carrying a permission the agent signed (EIP-712, checked with ERC-1271 for an agent that
///             is a contract, such as a Factor account). The permission names the maker, so only the maker can use
///             it: a copied signature is of no use to anyone else.
///
///         What is forced for every coin and read back from Pons right after the launch: fees to the coin's
///         splitter, the 3% tax, Pons' own buyback off, the ETH pair, and this contract as the deployer. The coin's
///         website link is the agent's page on Factor. The maker pays Pons' launch fee; anything sent above it buys
///         the coin in the same transaction, for the maker, before anybody else can trade it.
///
///         There is no owner and nothing can be set after deployment. Every address but the desk is read from the
///         chain in the constructor: the burn pot and the gateway from the desk, the owner and the Pons factory from
///         the burn pot, and the fee escrow from the factory.
contract AgentCoinLauncher is EIP712, ReentrancyGuard {
    /// @notice The tax on every trade of an agent coin, fixed at launch: 3%, as on $FACTOR.
    uint16 public constant CREATOR_TAX_BPS = 300;
    /// @notice What an agent signs to let its maker launch its coin.
    bytes32 public constant PERMISSION_TYPEHASH = keccak256(
        "Permission(address agent,address maker,string name,string symbol,string logo,string description,uint256 nonce,uint256 deadline)"
    );
    /// @notice The start of every coin's website link; the agent's address follows.
    string public constant PAGE = "https://factoragents.fun/agents/";

    IAgentDesk public immutable desk;
    address payable public immutable burnPot;
    address payable public immutable gateway;
    address payable public immutable owner;
    IPonsV2LaunchFactory public immutable factory;
    IPonsV2FeeEscrow public immutable escrow;

    mapping(address agent => address) public coinOf;
    mapping(address agent => address) public splitterOf;
    mapping(address coin => address) public agentOf;
    /// @notice An agent's permission number. Raising it (bumpNonce) cancels every permission it has signed.
    mapping(address agent => uint256) public nonces;
    address[] internal _coins;

    /// @dev Set only while launch() runs: the one time this contract takes ETH (a curve's refund of an opening buy).
    bool private transient _launching;

    event CoinLaunched(
        address indexed agent,
        address indexed coin,
        address indexed maker,
        address splitter,
        address curve,
        bool bySignature,
        uint256 openingBuyEth,
        uint256 openingBuyTokens
    );
    event NonceBumped(address indexed agent, uint256 nonce);

    error ZeroAddress();
    error NotAllowed();
    error Expired();
    error BadSignature();
    error NotRegistered();
    error Barred();
    error AlreadyLaunched(address coin);
    error LaunchFeeShort(uint256 fee);
    error NotPonsLaunch();
    error WrongFeeRecipient(address recipient);
    error NotEthPair();
    error WrongCreatorTax(uint16 bps);
    error BuybackEnabled();
    error NotDuringLaunch();
    error RefundFailed();

    constructor(IAgentDesk desk_) EIP712("Factor agent coins", "1") {
        if (address(desk_) == address(0)) revert ZeroAddress();
        desk = desk_;
        burnPot = payable(desk_.burnPot());
        gateway = payable(desk_.gateway());
        owner = payable(IBurnPotReads(burnPot).admin());
        factory = IPonsV2LaunchFactory(IBurnPotReads(burnPot).factory());
        escrow = IPonsV2FeeEscrow(factory.feeEscrow());
        if (
            burnPot == address(0) || gateway == address(0) || owner == address(0) || address(factory) == address(0)
                || address(escrow) == address(0)
        ) revert ZeroAddress();
    }

    /// @dev Only during a launch, when a curve hands back the part of an opening buy it could not fill.
    receive() external payable {
        if (!_launching) revert NotDuringLaunch();
    }

    /// @notice Launch `agent`'s coin. See the contract's notice for who may call it and what is forced.
    /// @param params name, symbol, logo, description, salt and the optional economics pin. The fee recipient, the
    ///        tax, buyback and the socials are overwritten here.
    /// @param deadline and `sig` only matter when the maker calls: the agent's permission, valid until `deadline`.
    /// @return coin the new coin
    function launch(
        address agent,
        address payable maker,
        IPonsV2LaunchFactory.TokenParams calldata params,
        uint256 launchConfigId,
        uint256 deadline,
        bytes calldata sig
    ) external payable nonReentrant returns (address coin) {
        if (agent == address(0) || maker == address(0)) revert ZeroAddress();
        bool bySignature = msg.sender != agent;
        if (bySignature) _checkPermission(agent, maker, params, deadline, sig);
        _checkAgent(agent);

        uint256 fee = factory.launchFee();
        if (msg.value < fee) revert LaunchFeeShort(fee);

        _launching = true;
        Launched memory l = _launchOnPons(agent, maker, params, launchConfigId, fee);
        coin = l.coin;
        coinOf[agent] = coin;
        splitterOf[agent] = l.splitter;
        agentOf[coin] = agent;
        _coins.push(coin);

        // The opening buy. A zero minimum is safe because no other trade can exist yet. What is said is what was
        // measured: the ETH that left this contract and the tokens that arrived with the maker.
        (uint256 spent, uint256 got) = _openingBuy(coin, l.curve, maker, msg.value - fee);
        _launching = false;

        emit CoinLaunched(agent, coin, maker, l.splitter, l.curve, bySignature, spent, got);
        _refund(maker);
    }

    /// @notice Cancel every permission the caller has signed as an agent.
    function bumpNonce() external {
        uint256 n = ++nonces[msg.sender];
        emit NonceBumped(msg.sender, n);
    }

    // ---------- internals ----------

    struct Launched {
        address coin;
        address curve;
        address splitter;
    }

    /// @dev On the desk, not barred, and without a coin yet.
    function _checkAgent(address agent) internal view {
        IAgentDesk.Agent memory a = desk.agent(agent);
        if (!a.registered) revert NotRegistered();
        if (a.barred) revert Barred();
        if (splitterOf[agent] != address(0)) revert AlreadyLaunched(coinOf[agent]);
    }

    /// @dev This contract holds no ETH between calls: whatever is left (what a curve could not fill) goes back.
    function _refund(address payable maker) internal {
        uint256 left = address(this).balance;
        if (left == 0) return;
        (bool ok,) = maker.call{value: left}("");
        if (!ok) revert RefundFailed();
    }

    /// @dev The maker calls with the agent's permission: it must be the maker named in it, in time, signed by the
    ///      agent (a wallet's signature, or a contract's own ERC-1271 answer), and at the agent's current number.
    function _checkPermission(
        address agent,
        address maker,
        IPonsV2LaunchFactory.TokenParams calldata params,
        uint256 deadline,
        bytes calldata sig
    ) internal {
        if (msg.sender != maker) revert NotAllowed();
        if (block.timestamp > deadline) revert Expired();
        uint256 nonce = nonces[agent]++;
        if (!SignatureChecker.isValidSignatureNow(agent, permissionDigest(agent, maker, params, nonce, deadline), sig))
        {
            revert BadSignature();
        }
    }

    /// @dev The splitter first (it is the fee recipient), then the launch with every fee setting forced, then the
    ///      launch read back from Pons, then the splitter told its coin.
    function _launchOnPons(
        address agent,
        address payable maker,
        IPonsV2LaunchFactory.TokenParams calldata params,
        uint256 launchConfigId,
        uint256 fee
    ) internal returns (Launched memory l) {
        AgentCoinSplitter s =
            new AgentCoinSplitter(agent, maker, address(desk), gateway, burnPot, owner, escrow, factory);
        l.splitter = address(s);

        IPonsV2LaunchFactory.TokenParams memory p = params;
        p.creatorFeeRecipient = l.splitter;
        p.creatorTaxBps = CREATOR_TAX_BPS;
        p.buybackEnabled = false;
        p.socials = IPonsV2LaunchFactory.Socials("", "", "", string.concat(PAGE, Strings.toHexString(agent)), "");

        // the maker, and the agent when it is another wallet, do not pay Pons' tax on the launch's first seconds
        address[] memory exempt = new address[](maker == agent ? 1 : 2);
        exempt[0] = maker;
        if (maker != agent) exempt[1] = agent;
        (l.coin, l.curve) = factory.launchToken{value: fee}(p, launchConfigId, address(0), exempt);

        IPonsV2LaunchFactory.LaunchedToken memory info = factory.getLaunchedToken(l.coin);
        if (!info.exists || info.token != l.coin || info.deployer != address(this) || info.curve != l.curve) {
            revert NotPonsLaunch();
        }
        if (info.creatorFeeRecipient != l.splitter) revert WrongFeeRecipient(info.creatorFeeRecipient);
        if (info.pairToken != address(0)) revert NotEthPair();
        if (info.creatorTaxBps != CREATOR_TAX_BPS) revert WrongCreatorTax(info.creatorTaxBps);
        if (info.buybackEnabled) revert BuybackEnabled();
        s.setCoin(l.coin);
    }

    function _openingBuy(address coin, address curve_, address maker, uint256 amount)
        internal
        returns (uint256 spent, uint256 got)
    {
        if (amount == 0) return (0, 0);
        uint256 ethBefore = address(this).balance;
        uint256 tokensBefore = IERC20(coin).balanceOf(maker);
        IPonsV2BondingCurve(curve_).buy{value: amount}(amount, 0, maker);
        spent = ethBefore - address(this).balance;
        got = IERC20(coin).balanceOf(maker) - tokensBefore;
    }

    // ---------- views ----------

    /// @notice The EIP-712 digest an agent signs to let `maker` launch its coin with these words.
    function permissionDigest(
        address agent,
        address maker,
        IPonsV2LaunchFactory.TokenParams calldata params,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PERMISSION_TYPEHASH,
                    agent,
                    maker,
                    keccak256(bytes(params.name)),
                    keccak256(bytes(params.symbol)),
                    keccak256(bytes(params.logo)),
                    keccak256(bytes(params.description)),
                    nonce,
                    deadline
                )
            )
        );
    }

    /// @notice How many coins have been launched here.
    function coinCount() external view returns (uint256) {
        return _coins.length;
    }

    /// @notice The `i`th coin launched here, oldest first.
    function coinAt(uint256 i) external view returns (address) {
        return _coins[i];
    }

    /// @notice What a launch needs to be sent with at least: Pons' launch fee.
    function launchFee() external view returns (uint256) {
        return factory.launchFee();
    }
}
