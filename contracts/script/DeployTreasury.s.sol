// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {FactorVouch} from "../src/FactorVouch.sol";
import {FactorClaims} from "../src/FactorClaims.sol";
import {FactorTreasury} from "../src/FactorTreasury.sol";
import {Config} from "./Config.sol";

/// Deploys the treasury contract (agent treasury): one transaction, given the vouching contract and the claims
/// contract and nothing else (the desk, the line contract, the guarantee contract and the compute gateway are read
/// from them). There is no owner, and nothing is set afterwards, because nothing can be. Nothing needs seeding: every
/// treasury holds only what was put in for its agent.
///
///   FACTOR_ADMIN=… FACTOR_GATEWAY=… FACTOR_BURN_POT=… FACTOR_DESK=… FACTOR_SPLITTER=… FACTOR_ACCOUNTS=… \
///   FACTOR_VOUCH=… FACTOR_CLAIMS=… forge script script/DeployTreasury.s.sol \
///     --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --interactive --sender <the deploying wallet>
///
/// contracts/deploy-treasury.sh runs exactly this with every value filled in. Without --broadcast it is a dry run:
/// it prints where the contract would be and sends nothing.
contract DeployTreasury is Script, Config {
    function _wires() internal view returns (FactorVouch v, FactorClaims c) {
        v = FactorVouch(payable(vm.envAddress("FACTOR_VOUCH")));
        require(address(v).code.length > 0, "no contract at FACTOR_VOUCH");
        c = FactorClaims(payable(vm.envAddress("FACTOR_CLAIMS")));
        require(address(c).code.length > 0, "no contract at FACTOR_CLAIMS");
    }

    function run() external returns (FactorTreasury t) {
        _requireChain();
        Factor memory h = _deployed();
        (FactorVouch v, FactorClaims c) = _wires();
        vm.startBroadcast();
        t = new FactorTreasury(v, c);
        vm.stopBroadcast();
        _verify(t, h.desk, v, c);
        require(t.held() == 0 && address(t).balance == 0, "a fresh treasury contract holds nothing");
        console.log("FACTOR_TREASURY=%s", address(t));
    }

    /// Reads a deployed treasury contract back from the chain and checks every wire. No broadcast, no key.
    function check() external view {
        _requireChain();
        Factor memory h = _deployed();
        (FactorVouch v, FactorClaims c) = _wires();
        FactorTreasury t = FactorTreasury(payable(vm.envAddress("FACTOR_TREASURY")));
        require(address(t).code.length > 0, "no contract at FACTOR_TREASURY");
        _verify(t, h.desk, v, c);
        console.log("OK: the treasury contract is wired to the desk, the line, the guarantee, vouching and claims.");
        console.log("    treasury      %s", address(t));
        console.log("    desk          %s", address(t.desk()));
        console.log("    line          %s", address(t.line()));
        console.log("    guarantee     %s", address(t.guarantee()));
        console.log("    vouching      %s", address(t.vouch()));
        console.log("    claims        %s", address(t.claims()));
        console.log("    gateway       %s", t.gateway());
        console.log("    held          %s wei", t.held());
    }

    function _verify(FactorTreasury t, FactorDesk desk, FactorVouch v, FactorClaims c) internal view {
        require(address(t.desk()) == address(desk), "treasury: wrong desk");
        require(address(t.vouch()) == address(v) && address(t.claims()) == address(c), "treasury: the wires");
        require(address(v.desk()) == address(desk) && address(c.desk()) == address(desk), "treasury: another desk");
        require(address(t.guarantee()) == address(v.guarantee()), "treasury: the guarantee contract");
        require(address(t.line()) == address(v.line()), "treasury: the line contract");
        require(t.gateway() == desk.gateway() && t.gateway() == _gateway(), "treasury: the gateway");
        require(t.MIN_STEP() == 0.0001 ether && t.MAX_CLAIMS() == 10 && t.DAY() == 1 days, "treasury: the numbers");
        require(address(t).code.length > 0 && address(t).code.length <= 24_576, "treasury: size");
    }
}
