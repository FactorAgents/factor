// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";
import {Config} from "./Config.sol";

/// Deploys the three contracts of Factor, in the order the launch runbook needs: every address the token's fees
/// will ever go to exists, and is checked, before there is a token. A fourth follows them and is wired to none of
/// them: FactorAccounts, which makes accounts for people without a wallet.
///
///   1. FactorBurnPot   given the splitter's address ahead of time (worked out from the deployer's nonce)
///   2. FactorDesk      jobs, advances, the pool and bonds; its advance fees go to the burn pot
///   3. FactorSplitter  last: it refuses to exist unless the burn pot and the desk are there and wired to it
///
/// Nothing is set afterwards, because nothing can be. The token does not exist yet: script/Launch.s.sol makes it.
///
///   FACTOR_ADMIN=0x… FACTOR_GATEWAY=0x… forge script script/Deploy.s.sol \
///     --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --interactive --sender <the admin wallet>
///
/// contracts/deploy.sh runs exactly this with every value filled in. Without --broadcast it is a dry run.
contract Deploy is Script, Config {
    function run() external returns (Factor memory h) {
        _requireChain();
        address admin = _admin();
        address gateway = _gateway();
        IPonsV2LaunchFactory factory = _factory();
        // a wallet with code on it could refuse the 70% pushed to it; the share would wait in the splitter
        require(admin.code.length == 0, "FACTOR_ADMIN has code on it: use a plain wallet");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        h = _deployFactor(deployer, admin, gateway, factory);
        vm.stopBroadcast();

        _verifyFactor(h, admin, gateway, factory);
        require(address(h.burnPot.token()) == address(0), "a fresh burn pot has no token");

        console.log("Deployed from %s. Admin %s.", deployer, admin);
        console.log("");
        console.log("FACTOR_BURN_POT=%s", address(h.burnPot));
        console.log("FACTOR_DESK=%s", address(h.desk));
        console.log("FACTOR_SPLITTER=%s", address(h.splitter));
        console.log("FACTOR_ACCOUNTS=%s", address(h.accounts));
    }

    /// Reads a deployment back from the chain and checks every wire. No broadcast, no key.
    ///   FACTOR_ADMIN=… FACTOR_BURN_POT=… FACTOR_DESK=… FACTOR_SPLITTER=… FACTOR_ACCOUNTS=… \
    ///     forge script script/Deploy.s.sol --sig "check()" --rpc-url https://rpc.mainnet.chain.robinhood.com
    function check() external view {
        _requireChain();
        Factor memory h = _deployed();
        _verifyFactor(h, _admin(), h.desk.gateway(), _factory());
        console.log("OK: the three contracts are wired to each other, to the admin and to Pons.");
        console.log("    accounts   %s (accounts for people without a wallet)", address(h.accounts));
        console.log("    desk       %s (jobs, advances, the pool and bonds)", address(h.desk));
        console.log("    gateway    %s (compute advances are paid here)", h.desk.gateway());
        console.log("    burn pot   %s", address(h.burnPot));
        console.log("    splitter   %s (the address the token's fees will be paid to)", address(h.splitter));
        console.log("    admin      %s", h.splitter.admin());
        console.log("    token      %s", address(h.burnPot.token()));
    }
}
