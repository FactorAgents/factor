// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {FactorClaims, FactorPayAccount} from "../src/FactorClaims.sol";
import {Config} from "./Config.sol";

/// Deploys the claims contract (selling locked pay): one transaction, given the desk and nothing else. There is no
/// owner, and nothing is set afterwards, because nothing can be. Nothing needs seeding: every price is paid by a buyer
/// to a seller and every payout comes from the desk.
///
///   FACTOR_ADMIN=… FACTOR_GATEWAY=… FACTOR_BURN_POT=… FACTOR_DESK=… FACTOR_SPLITTER=… FACTOR_ACCOUNTS=… \
///   forge script script/DeployClaims.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --broadcast --interactive --sender <the deploying wallet>
///
/// contracts/deploy-claims.sh runs exactly this with every value filled in. Without --broadcast it is a dry run.
contract DeployClaims is Script, Config {
    function run() external returns (FactorClaims c) {
        _requireChain();
        Factor memory h = _deployed();
        vm.startBroadcast();
        c = new FactorClaims(h.desk);
        vm.stopBroadcast();
        _verify(c, h.desk);
        require(c.claimCount() == 0 && c.owedTotal() == 0, "a fresh claims contract has no claim and holds nothing");
        console.log("FACTOR_CLAIMS=%s", address(c));
    }

    /// Reads a deployed claims contract back from the chain and checks every wire. No broadcast, no key.
    function check() external view {
        _requireChain();
        Factor memory h = _deployed();
        FactorClaims c = FactorClaims(payable(vm.envAddress("FACTOR_CLAIMS")));
        require(address(c).code.length > 0, "no contract at FACTOR_CLAIMS");
        _verify(c, h.desk);
        console.log("OK: the claims contract is wired to the desk.");
        console.log("    claims        %s", address(c));
        console.log("    desk          %s", address(c.desk()));
        console.log("    account code  %s", c.accountCode());
        console.log("    claims made   %s", c.claimCount());
        console.log("    owed          %s wei", c.owedTotal());
    }

    function _verify(FactorClaims c, FactorDesk desk) internal view {
        require(address(c.desk()) == address(desk), "claims: wrong desk");
        FactorPayAccount code = FactorPayAccount(payable(c.accountCode()));
        require(code.claims() == address(c) && address(code.desk()) == address(desk), "claims: the account code");
        require(
            c.jobFeeBps() == desk.JOB_FEE_BPS() && c.rejectedBps() == desk.REJECTED_BPS() && c.grace() == desk.GRACE()
                && c.review() == desk.REVIEW(),
            "claims: the desk's numbers"
        );
        require(
            c.MAX_DISCOUNT_BPS() == 1000 && c.MIN_FACE() == 0.0005 ether && c.MAX_OPEN() == 10, "claims: the numbers"
        );
        require(address(c).code.length > 0 && address(c).code.length <= 24_576, "claims: size");
    }
}
