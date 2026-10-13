// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IPonsV2LaunchFactory} from "../../src/interfaces/IPons.sol";
import {FactorDeployer} from "../../script/FactorDeployer.sol";

interface IFactoryX {
    function createGraduatedPool(address token) external returns (uint256);
    function transferCreatorFeeRecipient(address token, address newRecipient) external;
    function setCreatorFeeRecipient(address token, address newRecipient) external;
    function setBuybackEnabled(address token, bool enabled) external;
}

interface ICurveX {
    function buy(uint256, uint256, address) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
    function sweepFees(uint256) external;
    function currentSnipeTaxBps(address) external view returns (uint256);
    function snipeTaxExempt(address) external view returns (bool);
    function deployer() external view returns (address);
    function readyToGraduate() external view returns (bool);
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
}

interface IPonsToken {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function logo() external view returns (string memory);
    function deployer() external view returns (address);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function burn(uint256) external;
    function burnFrom(address, uint256) external;
}

/// Shared setup for the tests that run against the real Pons on a fork of Robinhood Chain, and the live addresses
/// they use (read from the live launch factory).
abstract contract ForkBase is Test, FactorDeployer {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    // Pons' keeper, the only caller besides a token's fee recipient that may release a curve's fees. Pons rotates
    // it and exposes no getter. If the tests that impersonate it start failing with NotFeeSweepOperator, find the
    // current one with `cast call <curve> 'sweepFees(uint256)' 0 --from <address>`.
    address constant FEE_SWEEP_OPERATOR = 0xa1018c1D9655292A2dE0F7dEa9a0F848EaA8cA83;
    // It is a contract. This is the wallet that drives it, and the two calls it releases a graduated pool's fees
    // with, all three read from its transactions on the live chain on 2026-10-09 (Pons publishes no ABI for it).
    address constant KEEPER = 0x49BbF2b70955Fb3a106e084D4BFDa92d334573d2;
    bytes4 constant SWEEP_POOL = 0x431d17b7; // sweepPool(bytes32 poolId)
    bytes4 constant SWEEP_POOL_MIN = 0x21724275; // (bytes32 poolId, uint256 minimum ETH out, uint256)
    address constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    // A token somebody else launched on Pons on 2026-10-09, an hour before these tests were written (taken from
    // the launch factory's own log of launches, block 83991287). It is here only as a real, recent Pons token
    // that nobody connected with this project made.
    address constant LIVE_TOKEN = 0xBe3b7A952C803C3926eD0222E3e6561b221c0094;

    string constant DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
    /// Improbable enough that it can only mean "the variable is absent".
    string constant UNSET = "__RPC_URL_UNSET__";

    /// RPC_URL absent: use the public node. RPC_URL set to "": there is deliberately no node (CI without the
    /// secret), so skip rather than fail. RPC_URL set to something: use it.
    ///
    /// Every test in a run forks the same block, a recent one on a round number, so the node is asked for each
    /// piece of state once and not once per test. It has to be recent: the public node throws state away after
    /// a few thousand blocks (measured: 5,000 back answers, 20,000 does not), which is under ten minutes.
    /// FORK_BLOCK pins a block by hand.
    function _fork() internal {
        string memory url = vm.envOr("RPC_URL", string(UNSET));
        if (keccak256(bytes(url)) == keccak256(bytes(UNSET))) url = DEFAULT_RPC;
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        uint256 pinned = vm.envOr("FORK_BLOCK", uint256(0));
        if (pinned == 0) {
            bytes memory raw = vm.rpc(url, "eth_blockNumber", "[]");
            uint256 head;
            for (uint256 i = 0; i < raw.length; ++i) {
                head = (head << 8) | uint8(raw[i]);
            }
            pinned = ((head - 20) / 500) * 500;
        }
        vm.createSelectFork(url, pinned);
    }

    function _pons() internal pure returns (IPonsV2LaunchFactory) {
        return IPonsV2LaunchFactory(FACTORY);
    }

    function _params(bytes32 salt) internal pure returns (IPonsV2LaunchFactory.TokenParams memory p) {
        p.name = "Factor";
        p.symbol = "FACTOR";
        p.logo = "https://factoragents.fun/factor.png";
        p.description = "Advances for AI agents on Robinhood Chain.";
        p.socials.twitter = "https://x.com/FactorAgents";
        p.socials.website = "https://factoragents.fun";
        p.salt = salt;
    }

    /// A launch straight on the factory, the way anybody can make one.
    function _launchDirect(address from, address recipient, uint16 tax, bool buyback, bytes32 salt)
        internal
        returns (address t, address c)
    {
        IPonsV2LaunchFactory.TokenParams memory p = _params(salt);
        p.creatorFeeRecipient = recipient;
        p.creatorTaxBps = tax;
        p.buybackEnabled = buyback;
        uint256 fee = _pons().launchFee();
        vm.deal(from, from.balance + fee);
        vm.prank(from);
        (t, c) = _pons().launchToken{value: fee}(p, 0, address(0), new address[](0));
    }

    /// Pons' keeper releases a graduated pool's fees, as it does about once an hour on the live chain: the hook
    /// swaps the fees it took in the token into ETH and credits the escrow.
    ///
    /// The keeper's wallet calls Pons' operator contract. The one-argument call works out its own minimum for that
    /// swap from a quote and refuses a pool as young as a test's; the three-argument call takes the minimum from
    /// the keeper, and the operator accepts it only inside a window (not below its floor, not above what the swap
    /// really returns). The live keeper computes it off chain. Here it is found by trying upwards until one is
    /// accepted, which is the same call the live keeper sends.
    function _keeperSweepsPool(bytes32 poolId) internal returns (bool ok) {
        vm.prank(KEEPER);
        (ok,) = FEE_SWEEP_OPERATOR.call(abi.encodeWithSelector(SWEEP_POOL, poolId));
        for (uint256 minOut = 1e9; !ok && minOut < 10 ether; minOut = (minOut * 5) / 4) {
            vm.prank(KEEPER);
            (ok,) = FEE_SWEEP_OPERATOR.call(abi.encodeWithSelector(SWEEP_POOL_MIN, poolId, minOut, uint256(0)));
        }
    }

    /// Buy the curve out (crosses graduation, which releases its fees) and create the v4 pool.
    function _graduate(address token, address curve, address buyer) internal {
        vm.deal(buyer, buyer.balance + 10 ether);
        vm.prank(buyer);
        ICurveX(curve).buy{value: 10 ether}(10 ether, 0, buyer);
        IFactoryX(FACTORY).createGraduatedPool(token);
    }
}
