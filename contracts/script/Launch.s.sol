// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";
import {Config} from "./Config.sol";

/// Launches $FACTOR on Pons through the burn pot, from the admin wallet, with the opening buy inside the same
/// transaction. The pot forces the fee settings (fees to the splitter, 3% tax, no buyback, paired with ETH) and
/// reads them back; the tokens the opening buy gets go to the admin wallet and stay there.
///
///   FACTOR_… (the admin and the two contracts) FACTOR_OPENING_BUY_WEI=… FACTOR_LAUNCH_JSON="$(cat launch.json)" \
///     forge script script/Launch.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --broadcast --interactive --sender <the admin wallet>
///
/// contracts/launch.sh runs exactly this with every value filled in. What is fixed for good once it runs: the
/// name, the ticker, the picture's link, the description and the links, all from contracts/launch.json.
///
/// Two things about Pons are pinned, so that a launch never goes through on terms nobody looked at:
///   - the launch fee must be the one written in launch.json (launchFeeWei), or the script stops
///   - the launch carries Pons' own hash of its launch terms (previewLaunchEconomics) as expectedEconomics, and
///     the factory refuses the launch if its terms are no longer those when the transaction is mined. launch.sh
///     hands the hash its dry run printed to the real run as FACTOR_EXPECTED_ECONOMICS, and the script stops if
///     the terms have changed in between.
contract Launch is Script, Config {
    using stdJson for string;

    /// Pons' launch configuration $FACTOR is launched under, and the one its terms are read for.
    uint256 internal constant LAUNCH_CONFIG = 0;

    function run() external returns (address token) {
        _requireChain();
        Factor memory h = _deployed();
        IPonsV2LaunchFactory factory = _factory();
        address admin = h.burnPot.admin();
        _verifyFactor(h, admin, h.desk.gateway(), factory);
        require(address(h.burnPot.token()) == address(0), "$FACTOR is already launched");

        uint256 openingBuy = vm.envUint("FACTOR_OPENING_BUY_WEI");
        string memory json = vm.envString("FACTOR_LAUNCH_JSON");
        IPonsV2LaunchFactory.TokenParams memory p;
        p.name = json.readString(".name");
        p.symbol = json.readString(".symbol");
        p.logo = json.readString(".logo");
        p.description = json.readString(".description");
        p.socials.website = json.readString(".website");
        p.socials.twitter = json.readString(".twitter");
        p.salt = keccak256(bytes(p.symbol));
        require(keccak256(bytes(p.symbol)) == keccak256("FACTOR"), "launch.json is not $FACTOR");
        require(bytes(p.name).length > 0 && bytes(p.logo).length > 0, "launch.json: name and logo are needed");
        // wallets besides the admin that should not pay Pons' launch-seconds tax; usually none
        address[] memory alsoExempt = vm.envOr("FACTOR_ALSO_EXEMPT", ",", new address[](0));

        uint256 fee = factory.launchFee();
        console.log("Launching %s ($%s) from %s", p.name, p.symbol, admin);
        console.log("Launch fee %s wei, opening buy %s wei", fee, openingBuy);
        require(
            fee == json.readUint(".launchFeeWei"),
            "Pons' launch fee is not the launchFeeWei written in launch.json: look at the new fee before launching"
        );
        // Pons' terms for this launch as they stand now. The factory checks the launch against them when it is
        // mined, so a change after this line makes the launch revert instead of going through on other terms.
        bytes32 economics = factory.previewLaunchEconomics(LAUNCH_CONFIG, address(0));
        bytes32 seenByDryRun = vm.envOr("FACTOR_EXPECTED_ECONOMICS", bytes32(0));
        require(
            seenByDryRun == bytes32(0) || seenByDryRun == economics,
            "Pons' launch terms have changed since the dry run: run the dry run again and look before launching"
        );
        p.expectedEconomics = economics;
        console.log("FACTOR_EXPECTED_ECONOMICS=%s", vm.toString(economics));

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(sender == admin, "only the admin can launch: run it from the admin wallet (--sender)");
        token = h.burnPot.launch{value: fee + openingBuy}(p, LAUNCH_CONFIG, alsoExempt);
        vm.stopBroadcast();

        _verifyLaunch(h, factory, token, openingBuy);
        console.log("");
        console.log("FACTOR_TOKEN=%s", token);
        console.log("Opening buy: %s tokens in the admin wallet", h.burnPot.openingBuyTokens());
    }

    /// Reads the launch back from the chain. No broadcast, no key.
    function check() external view {
        _requireChain();
        Factor memory h = _deployed();
        IPonsV2LaunchFactory factory = _factory();
        address token = address(h.burnPot.token());
        require(token != address(0), "$FACTOR is not launched yet");
        _verifyLaunch(h, factory, token, h.burnPot.openingBuyEth());
        console.log("OK: $FACTOR %s", token);
        console.log("    opening buy  %s tokens for %s wei", h.burnPot.openingBuyTokens(), h.burnPot.openingBuyEth());
    }

    function _verifyLaunch(Factor memory h, IPonsV2LaunchFactory factory, address token, uint256 openingBuy)
        internal
        view
    {
        IPonsV2LaunchFactory.LaunchedToken memory info = factory.getLaunchedToken(token);
        require(info.exists && info.token == token, "Pons does not know the token");
        require(info.deployer == address(h.burnPot), "the burn pot is not the launch's deployer");
        require(info.creatorFeeRecipient == address(h.splitter), "fees do not go to the splitter");
        require(info.creatorTaxBps == 300, "the tax is not 3%");
        require(info.pairToken == address(0), "not paired with ETH");
        require(!info.buybackEnabled, "Pons' own buyback is on");
        require(address(h.burnPot.token()) == token, "the burn pot burns another token");
        require(
            h.splitter.curve() == info.curve || info.phase != IPonsV2LaunchFactory.GraduationPhase.NotGraduated,
            "the splitter cannot find the curve"
        );
        require(IERC20(token).balanceOf(address(h.burnPot)) == 0, "the burn pot holds tokens");
        if (openingBuy > 0) require(h.burnPot.openingBuyTokens() > 0, "the opening buy bought nothing");
    }
}
