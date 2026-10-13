// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {FactorAccounts} from "../src/FactorAccount.sol";
import {FactorBurnPot} from "../src/FactorBurnPot.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {FactorSplitter} from "../src/FactorSplitter.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";
import {FactorDeployer} from "./FactorDeployer.sol";

/// Every address the scripts use, read from the environment. Nothing here is secret: these are public addresses.
/// A key is never read from the environment or from a file; forge asks for it at its own prompt.
///
///   FACTOR_ADMIN       the admin wallet (receives the 70% and launches the token)
///   FACTOR_GATEWAY     the address compute advances are paid to (the engine's wallet), fixed in the desk for good
///   FACTOR_BURN_POT, FACTOR_DESK, FACTOR_SPLITTER, FACTOR_ACCOUNTS
///                     the three contracts, once deployed (contracts/deploy.sh writes them to broadcast/factor.env)
///   PONS_FACTORY      only to point a rehearsal somewhere else; unset, it is the live Pons factory
abstract contract Config is CommonBase, FactorDeployer {
    uint256 internal constant ROBINHOOD_CHAIN = 4663;
    address internal constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    function _requireChain() internal view {
        require(block.chainid == ROBINHOOD_CHAIN, "wrong chain: Robinhood Chain is 4663 (check --rpc-url)");
    }

    function _factory() internal view returns (IPonsV2LaunchFactory f) {
        f = IPonsV2LaunchFactory(vm.envOr("PONS_FACTORY", PONS_FACTORY));
        require(address(f).code.length > 0, "no contract at the Pons factory address on this chain");
    }

    function _admin() internal view returns (address a) {
        a = vm.envAddress("FACTOR_ADMIN");
        require(a != address(0), "FACTOR_ADMIN is the zero address");
    }

    function _gateway() internal view returns (address g) {
        g = vm.envAddress("FACTOR_GATEWAY");
        require(g != address(0), "FACTOR_GATEWAY is the zero address");
    }

    /// The three deployed contracts, each of which must exist.
    function _deployed() internal view returns (Factor memory h) {
        h.burnPot = FactorBurnPot(payable(_contract("FACTOR_BURN_POT")));
        h.desk = FactorDesk(payable(_contract("FACTOR_DESK")));
        h.splitter = FactorSplitter(payable(_contract("FACTOR_SPLITTER")));
        h.accounts = FactorAccounts(_contract("FACTOR_ACCOUNTS"));
    }

    function _contract(string memory name) private view returns (address a) {
        a = vm.envAddress(name);
        require(a.code.length > 0, string.concat("no contract at ", name));
    }
}
