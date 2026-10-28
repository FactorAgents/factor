// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AgentCoinLauncher} from "../src/AgentCoinLauncher.sol";
import {IAgentDesk} from "../src/AgentCoinSplitter.sol";
import {FactorBurnPot} from "../src/FactorBurnPot.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";
import {Config} from "./Config.sol";

interface IEthUsd {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Deploys the coin launcher: one contract with no owner, given the desk and nothing else. It reads the burn pot and
/// the gateway from the desk, the owner and Pons from the burn pot, and Pons' fee escrow from Pons, and each splitter
/// it makes later carries those same addresses. Nothing is set afterwards, because nothing can be.
///
///   FACTOR_ADMIN=… FACTOR_GATEWAY=… FACTOR_BURN_POT=… FACTOR_DESK=… FACTOR_SPLITTER=… FACTOR_ACCOUNTS=… \
///     forge script script/DeployCoins.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --broadcast --interactive --sender <the deploying wallet>
///
/// contracts/deploy-coins.sh runs exactly this with every value filled in. Without --broadcast it is a dry run.
/// costs() says what the deploy and one coin's launch cost, from a simulation against the chain as it is now.
contract DeployCoins is Script, Config {
    address internal constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    function run() external returns (AgentCoinLauncher launcher) {
        _requireChain();
        Factor memory h = _deployed();
        address admin = _admin();
        _verifyFactor(h, admin, _gateway(), _factory());

        vm.startBroadcast();
        launcher = new AgentCoinLauncher(IAgentDesk(address(h.desk)));
        vm.stopBroadcast();

        _verifyCoins(launcher, h, admin);
        require(launcher.coinCount() == 0, "a fresh launcher has no coin");
        console.log("FACTOR_COIN_LAUNCHER=%s", address(launcher));
    }

    /// Reads a deployed launcher back from the chain and checks every wire. No broadcast, no key.
    function check() external view {
        _requireChain();
        Factor memory h = _deployed();
        AgentCoinLauncher launcher = AgentCoinLauncher(payable(vm.envAddress("FACTOR_COIN_LAUNCHER")));
        require(address(launcher).code.length > 0, "no contract at FACTOR_COIN_LAUNCHER");
        _verifyCoins(launcher, h, _admin());
        console.log("OK: the coin launcher is wired to the desk, the burn pot, the gateway, the owner and Pons.");
        console.log("    launcher   %s", address(launcher));
        console.log("    desk       %s", address(launcher.desk()));
        console.log("    burn pot   %s", launcher.burnPot());
        console.log("    gateway    %s (each coin's compute share is paid here)", launcher.gateway());
        console.log("    owner      %s", launcher.owner());
        console.log("    pons       %s", address(launcher.factory()));
        console.log("    coins      %s", launcher.coinCount());
    }

    /// What the deploy and one coin's launch cost, simulated against the chain as it is now and sent nowhere: a
    /// launcher is made in the simulation, a throwaway agent registers on the real desk, and its maker launches its
    /// coin on the real Pons. Gas at the chain's base fee plus a 25% margin, in ETH and in dollars at Chainlink's
    /// price.
    function costs() external {
        _requireChain();
        Factor memory h = _deployed();
        uint256 gasPrice = (block.basefee * 125) / 100;
        if (gasPrice == 0) gasPrice = 0.02 gwei;
        (, int256 answer,,,) = IEthUsd(ETH_USD_FEED).latestRoundData();
        uint256 usd8 = uint256(answer);

        uint256 g = gasleft();
        AgentCoinLauncher launcher = new AgentCoinLauncher(IAgentDesk(address(h.desk)));
        // the creation itself, plus the transaction's base cost and its calldata (the contract's creation code)
        uint256 deployGas = g - gasleft() + 21_000 + type(AgentCoinLauncher).creationCode.length * 16;

        (uint256 launchGas, uint256 fee) = _launchGas(launcher, h.desk);

        console.log("gas price used: %s wei (the base fee plus 25%%)", gasPrice);
        console.log("ETH price: %s (8 decimals)", usd8);
        _say("the deploy (paid once, by the deploying wallet)", deployGas, gasPrice, 0, usd8);
        _say("one coin's launch, gas (paid by its maker)", launchGas, gasPrice, 0, usd8);
        _say("one coin's launch, gas and Pons' launch fee", launchGas, gasPrice, fee, usd8);
        console.log("COIN_DEPLOY_GAS=%s", deployGas);
        console.log("COIN_LAUNCH_GAS=%s", launchGas);
        console.log("COIN_LAUNCH_FEE_WEI=%s", fee);
    }

    /// A throwaway agent registers on the real desk and its maker launches its coin with its permission.
    function _launchGas(AgentCoinLauncher launcher, FactorDesk desk) internal returns (uint256 gas, uint256 fee) {
        (address agent, uint256 key) = makeAddrAndKey("a throwaway agent for the cost of a launch");
        vm.prank(agent);
        desk.register();
        address maker = makeAddr("a throwaway maker");
        IPonsV2LaunchFactory.TokenParams memory p;
        p.name = "Cost Check";
        p.symbol = "COST";
        p.logo = "https://factoragents.fun/api/v1/coins/logo/cost-check";
        p.description = "Cost Check, an agent on Factor. Its coin's trading fees pay for its compute.";
        p.salt = keccak256("cost-check");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, launcher.permissionDigest(agent, maker, p, 0, deadline));
        fee = launcher.launchFee();
        vm.deal(maker, fee);
        vm.prank(maker);
        uint256 g = gasleft();
        launcher.launch{value: fee}(agent, payable(maker), p, 0, deadline, abi.encodePacked(r, s, v));
        // the launch itself, plus the transaction's base cost and its calldata (about 1,500 bytes)
        gas = g - gasleft() + 21_000 + 1_500 * 16;
    }

    function _say(string memory what, uint256 gas, uint256 gasPrice, uint256 extra, uint256 usd8) internal pure {
        uint256 wei_ = gas * gasPrice + extra;
        uint256 cents = (wei_ * usd8) / 1e24;
        console.log(what);
        console.log("    %s gas, %s wei", gas, wei_);
        console.log("    about $%s.%s", cents / 100, _two(cents % 100));
    }

    function _two(uint256 n) internal pure returns (string memory) {
        return n < 10 ? string.concat("0", vm.toString(n)) : vm.toString(n);
    }

    /// Everything about the launcher that can be read back, read back against the deployed Factor.
    function _verifyCoins(AgentCoinLauncher launcher, Factor memory h, address admin) internal view {
        FactorDesk desk = h.desk;
        FactorBurnPot pot = h.burnPot;
        require(address(launcher.desk()) == address(desk), "launcher: wrong desk");
        require(launcher.burnPot() == address(pot) && desk.burnPot() == address(pot), "launcher: wrong burn pot");
        require(launcher.gateway() == desk.gateway() && launcher.gateway() == _gateway(), "launcher: wrong gateway");
        require(launcher.owner() == pot.admin() && launcher.owner() == admin, "launcher: the owner is not the admin");
        require(address(launcher.factory()) == address(pot.factory()), "launcher: not the burn pot's Pons");
        require(address(launcher.factory()) == address(_factory()), "launcher: not the live Pons factory");
        require(address(launcher.escrow()) == launcher.factory().feeEscrow(), "launcher: not Pons' fee escrow");
        require(address(launcher.escrow()) == address(h.splitter.escrow()), "launcher: not $FACTOR's escrow");
        require(launcher.CREATOR_TAX_BPS() == 300, "launcher: the tax is not 3%");
        require(
            launcher.PERMISSION_TYPEHASH()
                == keccak256(
                    "Permission(address agent,address maker,string name,string symbol,string logo,string description,uint256 nonce,uint256 deadline)"
                ),
            "launcher: not the permission the site and the kit sign"
        );
        require(address(launcher).code.length > 0 && address(launcher).code.length <= 24_576, "launcher: size");
    }
}
