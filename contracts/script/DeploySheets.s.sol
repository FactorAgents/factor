// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FactorSheets} from "../src/FactorSheets.sol";
import {Config} from "./Config.sol";

/// Deploys the seal contract for live balance sheets: one transaction, no constructor arguments, no owner, nothing to
/// set afterwards. The engine's keeper writes each hour's root of every agent's balance sheet to it.
///
///   forge script script/DeploySheets.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --interactive \
///     --sender <the deploying wallet>
///
/// contracts/deploy-sheets.sh runs exactly this. Without --broadcast it is a dry run: it prints where the contract would
/// be and sends nothing.
contract DeploySheets is Script, Config {
    function run() external returns (FactorSheets s) {
        _requireChain();
        vm.startBroadcast();
        s = new FactorSheets();
        vm.stopBroadcast();
        _verify(s);
        console.log("FACTOR_SHEETS=%s", address(s));
    }

    /// Reads a deployed seal contract back from the chain and checks it. No broadcast, no key.
    function check() external view {
        _requireChain();
        FactorSheets s = FactorSheets(vm.envAddress("FACTOR_SHEETS"));
        require(address(s).code.length > 0, "no contract at FACTOR_SHEETS");
        _verify(s);
        console.log("OK: the seal contract answers and has sealed nothing for the zero address.");
        console.log("    sheets        %s", address(s));
    }

    function _verify(FactorSheets s) internal view {
        require(address(s).code.length > 0 && address(s).code.length <= 24_576, "sheets: size");
        require(s.lastHour(address(0)) == 0 && s.rootOf(address(0), 0) == bytes32(0), "sheets: fresh");
        bytes32[] memory none = new bytes32[](0);
        require(!s.proves(address(0), 0, bytes32(uint256(1)), none), "sheets: proves nothing unsealed");
    }
}
