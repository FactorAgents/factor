// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {FactorAccount, FactorAccounts} from "../src/FactorAccount.sol";
import {FactorBurnPot} from "../src/FactorBurnPot.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {FactorSplitter} from "../src/FactorSplitter.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";

/// The three contracts, in the one order they can be deployed in, and the checks that say they are wired as meant,
/// followed by the maker of accounts for people without a wallet, which stands by itself.
/// The deploy script and the tests both go through here, so what the tests exercise is what the owner deploys.
abstract contract FactorDeployer is CommonBase {
    struct Factor {
        FactorBurnPot burnPot;
        FactorDesk desk;
        FactorSplitter splitter;
        FactorAccounts accounts;
    }

    /// Deploys from `deployer`, which must be the account the next four creations come from: the broadcaster in
    /// a script, the test contract in a test.
    ///
    /// The burn pot has to know the splitter (it aims the token's fees at it) and the splitter has to know the
    /// burn pot and the desk, so the splitter's address is worked out beforehand from the deployer's nonce and the
    /// splitter goes last: it refuses to deploy unless the burn pot exists and points at it, and the desk exists
    /// and sends its advance fees to that burn pot. A fee address that pays an empty address can therefore never
    /// come out of this.
    ///
    /// `gateway` is the address compute advances are paid to. It is fixed in the desk for good.
    function _deployFactor(address deployer, address admin, address gateway, IPonsV2LaunchFactory factory)
        internal
        returns (Factor memory h)
    {
        uint256 nonce = vm.getNonce(deployer);
        address splitterAt = vm.computeCreateAddress(deployer, nonce + 2);
        h.burnPot = new FactorBurnPot(admin, factory, splitterAt);
        h.desk = new FactorDesk(address(h.burnPot), gateway);
        h.splitter = new FactorSplitter(
            payable(admin), payable(address(h.burnPot)), payable(address(h.desk)), IPonsV2FeeEscrow(factory.feeEscrow())
        );
        require(address(h.splitter) == splitterAt, "the splitter did not land at the address the burn pot was given");
        // last, and wired to nothing: an account is a customer or an agent on the desk like any other address
        h.accounts = new FactorAccounts();
    }

    /// Everything about a deployment that can be read back, read back. Reverts with the first thing that is wrong.
    function _verifyFactor(Factor memory h, address admin, address gateway, IPonsV2LaunchFactory factory)
        internal
        view
    {
        require(address(h.burnPot).code.length > 0, "no burn pot");
        require(address(h.desk).code.length > 0, "no desk");
        require(address(h.splitter).code.length > 0, "no splitter");

        require(h.desk.burnPot() == address(h.burnPot), "desk: advance fees would not go to this burn pot");
        require(h.desk.gateway() == gateway, "desk: wrong compute gateway");
        require(gateway != admin && gateway != address(h.burnPot) && gateway != address(h.desk), "desk: bad gateway");
        require(
            h.desk.ADVANCE_MAX_BPS() == 5000 && h.desk.ADVANCE_FEE_BPS() == 100 && h.desk.JOB_FEE_BPS() == 200
                && h.desk.POOL_OUT_MAX_BPS() == 8000 && h.desk.REJECTED_BPS() == 5000,
            "desk: not the rulebook's numbers"
        );

        require(h.burnPot.admin() == admin, "burn pot: wrong admin");
        require(h.burnPot.splitter() == address(h.splitter), "burn pot: fees would not go to this splitter");
        require(address(h.burnPot.factory()) == address(factory), "burn pot: wrong Pons factory");
        require(address(h.burnPot.poolManager()) == factory.poolManager(), "burn pot: wrong pool manager");
        require(h.burnPot.hook() == factory.memeHook(), "burn pot: wrong hook");

        require(h.splitter.admin() == admin, "splitter: wrong admin");
        require(h.splitter.burnPot() == address(h.burnPot), "splitter: wrong burn pot");
        require(address(h.splitter.escrow()) == factory.feeEscrow(), "splitter: escrow is not the factory's");
        require(h.splitter.desk() == address(h.desk), "splitter: wrong desk");
        require(
            h.splitter.ADMIN_BPS() == 7000 && h.splitter.BURN_BPS() == 2000 && h.splitter.POOL_BPS() == 1000,
            "splitter: not 70 / 20 / 10"
        );
        require(
            uint256(h.splitter.ADMIN_BPS()) + h.splitter.BURN_BPS() + h.splitter.POOL_BPS() == h.splitter.BPS(),
            "splitter: shares do not add up"
        );

        require(address(h.accounts).code.length > 0, "no maker of accounts");
        address implementation = h.accounts.implementation();
        require(implementation.code.length > 0, "accounts: nothing to copy");
        require(FactorAccount(payable(implementation)).factory() == address(h.accounts), "accounts: wrong factory");
        require(FactorAccount(payable(implementation)).keyCount() == 0, "accounts: the original has a key");
    }
}
