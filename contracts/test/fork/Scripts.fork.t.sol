// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, ICurveX, IPonsToken} from "./ForkBase.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {Launch} from "../../script/Launch.s.sol";
import {DeployCoins} from "../../script/DeployCoins.s.sol";
import {AgentCoinLauncher} from "../../src/AgentCoinLauncher.sol";
import {IAgentDesk as IAgentDeskRef} from "../../src/AgentCoinSplitter.sol";
import {FactorDeployer} from "../../script/FactorDeployer.sol";
import {IPonsV2LaunchFactory} from "../../src/interfaces/IPons.sol";

/// The two scripts the owner will run, run here exactly as forge runs them, against the real Pons on a fork:
/// script/Deploy.s.sol, its check, script/Launch.s.sol with the opening buy, and its check; then the coin launcher's
/// script/DeployCoins.s.sol, its check and its costs.
contract ScriptsForkTest is ForkBase {
    string constant LAUNCH_JSON_START = '{"name":"Factor","symbol":"FACTOR","logo":"https://factoragents.fun/factor.png",'
        '"description":"Advances for AI agents on Robinhood Chain.","website":"https://factoragents.fun","twitter":"https://x.com/FactorAgents",'
        '"launchFeeWei":"';

    /// launch.json as the owner will have it, with this launch fee written in it.
    function _launchJson(uint256 feeWei) internal pure returns (string memory) {
        return string.concat(LAUNCH_JSON_START, vm.toString(feeWei), '"}');
    }

    /// The real factory's refusal of a launch whose pinned terms are not its terms (selector 0xf4844814).
    error LaunchEconomicsMismatch(bytes32 expected, bytes32 actual);

    address admin; // the account forge broadcasts from in a test

    function setUp() public {
        _fork();
        vm.startBroadcast();
        (, admin,) = vm.readCallers();
        vm.stopBroadcast();
        // forge's default sender is a well-known address; on the live chain it may carry code. Here it stands in
        // for the owner's own plain wallet.
        vm.etch(admin, "");
        vm.setEnv("FACTOR_ADMIN", vm.toString(admin));
        vm.setEnv("FACTOR_GATEWAY", vm.toString(makeAddr("factor gateway")));
    }

    function _setAddresses(FactorDeployer.Factor memory h) internal {
        vm.setEnv("FACTOR_BURN_POT", vm.toString(address(h.burnPot)));
        vm.setEnv("FACTOR_DESK", vm.toString(address(h.desk)));
        vm.setEnv("FACTOR_SPLITTER", vm.toString(address(h.splitter)));
        vm.setEnv("FACTOR_ACCOUNTS", vm.toString(address(h.accounts)));
    }

    /// One test, in order, because the scripts read their addresses from the environment and the environment is
    /// shared by every test running at the same moment: the steps below change it and put it back.
    function test_fork_theScriptsAsTheOwnerWillRunThem() public {
        Deploy d = new Deploy();
        _deployRefusesAWalletWithCode(d);
        FactorDeployer.Factor memory h = _deployAndCheck(d);
        _checkCatchesWrongWiring(d, h);
        _launchRefusesAnotherTicker();
        _launchAndCheck(h);
        _deployCoinsAndCheck(h);
    }

    function _deployCoinsAndCheck(FactorDeployer.Factor memory h) internal {
        DeployCoins c = new DeployCoins();
        AgentCoinLauncher launcher = c.run();
        assertEq(address(launcher.desk()), address(h.desk));
        assertEq(launcher.burnPot(), address(h.burnPot));
        assertEq(launcher.gateway(), makeAddr("factor gateway"));
        assertEq(launcher.owner(), admin);
        assertEq(address(launcher.escrow()), ESCROW);
        vm.setEnv("FACTOR_COIN_LAUNCHER", vm.toString(address(launcher)));
        c.check();
        // a launcher pointed at another deployment's desk is caught by the check
        uint256 snap = vm.snapshotState();
        FactorDeployer.Factor memory other = new Deploy().run();
        AgentCoinLauncher stray = new AgentCoinLauncher(IAgentDeskRef(address(other.desk)));
        vm.setEnv("FACTOR_COIN_LAUNCHER", vm.toString(address(stray)));
        vm.expectRevert(bytes("launcher: wrong desk"));
        c.check();
        vm.revertToState(snap);
        vm.setEnv("FACTOR_COIN_LAUNCHER", vm.toString(address(launcher)));
        c.costs();
    }

    function _deployRefusesAWalletWithCode(Deploy d) internal {
        uint256 snap = vm.snapshotState();
        vm.etch(admin, hex"00");
        vm.expectRevert(bytes("FACTOR_ADMIN has code on it: use a plain wallet"));
        d.run();
        vm.revertToState(snap);
    }

    function _deployAndCheck(Deploy d) internal returns (FactorDeployer.Factor memory h) {
        h = d.run();
        assertEq(h.burnPot.admin(), admin);
        assertEq(h.burnPot.splitter(), address(h.splitter));
        assertEq(h.splitter.admin(), admin);
        assertEq(h.splitter.burnPot(), address(h.burnPot));
        assertEq(address(h.splitter.escrow()), ESCROW);
        assertEq(h.splitter.ADMIN_BPS(), 7000);
        assertEq(h.splitter.BURN_BPS(), 2000);
        assertEq(h.splitter.POOL_BPS(), 1000);
        assertEq(h.splitter.desk(), address(h.desk));
        assertEq(h.desk.burnPot(), address(h.burnPot));
        assertEq(h.desk.gateway(), makeAddr("factor gateway"));
        assertEq(address(h.burnPot.token()), address(0), "nothing is launched by the deploy");
        _setAddresses(h);
        d.check();
    }

    function _checkCatchesWrongWiring(Deploy d, FactorDeployer.Factor memory h) internal {
        // the right contracts but the wrong admin: the check says so
        vm.setEnv("FACTOR_ADMIN", vm.toString(makeAddr("another wallet")));
        vm.expectRevert(bytes("burn pot: wrong admin"));
        d.check();
        vm.setEnv("FACTOR_ADMIN", vm.toString(admin));
        // a second deployment's splitter beside the first deployment's burn pot
        uint256 snap = vm.snapshotState();
        FactorDeployer.Factor memory other = d.run();
        vm.setEnv("FACTOR_SPLITTER", vm.toString(address(other.splitter)));
        vm.expectRevert(bytes("burn pot: fees would not go to this splitter"));
        d.check();
        vm.revertToState(snap);
        _setAddresses(h);
        d.check();
    }

    function _launchRefusesAnotherTicker() internal {
        Launch l = new Launch();
        vm.setEnv("FACTOR_OPENING_BUY_WEI", "0");
        vm.setEnv(
            "FACTOR_LAUNCH_JSON",
            '{"name":"Factor","symbol":"HIEST","logo":"x","description":"x","website":"x","twitter":"x","launchFeeWei":"1"}'
        );
        vm.expectRevert(bytes("launch.json is not $FACTOR"));
        l.run();
    }

    function _launchAndCheck(FactorDeployer.Factor memory h) internal {
        Launch l = new Launch();
        vm.expectRevert(bytes("$FACTOR is not launched yet"));
        l.check();

        uint256 fee = _pons().launchFee();
        assertEq(fee, 0.0005 ether, "the fee written in contracts/launch.json is still Pons' fee");
        assertEq(vm.parseJsonUint(vm.readFile("launch.json"), ".launchFeeWei"), fee);
        vm.deal(admin, fee + 0.05 ether + 1 ether);
        vm.setEnv("FACTOR_OPENING_BUY_WEI", "50000000000000000");

        // a launch fee that is not the one written in launch.json stops the script before anything is sent
        vm.setEnv("FACTOR_LAUNCH_JSON", _launchJson(fee + 1));
        vm.expectRevert(
            bytes(
                "Pons' launch fee is not the launchFeeWei written in launch.json: look at the new fee before launching"
            )
        );
        l.run();
        vm.setEnv("FACTOR_LAUNCH_JSON", _launchJson(fee));

        // Pons' terms are not what the dry run saw: the script stops
        bytes32 economics = _pons().previewLaunchEconomics(0, address(0));
        assertTrue(economics != bytes32(0));
        vm.setEnv("FACTOR_EXPECTED_ECONOMICS", vm.toString(keccak256("the terms an earlier dry run saw")));
        vm.expectRevert(
            bytes("Pons' launch terms have changed since the dry run: run the dry run again and look before launching")
        );
        l.run();
        vm.setEnv("FACTOR_EXPECTED_ECONOMICS", vm.toString(economics));

        // Pons changes its terms after the script has read them and before the launch is mined: the launch
        // carries the terms the script read, and the real factory refuses it. (The script is shown other terms
        // than the factory really has, which is the same disagreement from the other side.)
        uint256 snap = vm.snapshotState();
        vm.setEnv("FACTOR_EXPECTED_ECONOMICS", vm.toString(bytes32(0)));
        vm.mockCall(
            FACTORY,
            abi.encodeCall(IPonsV2LaunchFactory.previewLaunchEconomics, (0, address(0))),
            abi.encode(keccak256("terms Pons no longer has"))
        );
        vm.expectRevert(
            abi.encodeWithSelector(LaunchEconomicsMismatch.selector, keccak256("terms Pons no longer has"), economics)
        );
        l.run();
        vm.stopBroadcast(); // the script was stopped in the middle of its own
        vm.clearMockedCalls();
        vm.revertToState(snap);
        assertEq(address(h.burnPot.token()), address(0), "nothing was launched on changed terms");
        vm.setEnv("FACTOR_EXPECTED_ECONOMICS", vm.toString(economics));

        // the launch itself carries the pin: this exact call reaches the real factory
        IPonsV2LaunchFactory.TokenParams memory sent = _params(keccak256("FACTOR"));
        sent.creatorFeeRecipient = address(h.splitter);
        sent.creatorTaxBps = 300;
        sent.expectedEconomics = economics;
        address[] memory exempt = new address[](1);
        exempt[0] = admin;
        vm.expectCall(FACTORY, fee, abi.encodeCall(IPonsV2LaunchFactory.launchToken, (sent, 0, address(0), exempt)));
        address t = l.run();

        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(t);
        assertEq(info.deployer, address(h.burnPot));
        assertEq(info.creatorFeeRecipient, address(h.splitter));
        assertEq(info.creatorTaxBps, 300);
        assertEq(IPonsToken(t).name(), "Factor");
        assertEq(IPonsToken(t).symbol(), "FACTOR");
        assertEq(IPonsToken(t).logo(), "https://factoragents.fun/factor.png");
        assertEq(address(h.burnPot.token()), t);
        assertEq(h.burnPot.openingBuyEth(), 0.05 ether);
        assertEq(IPonsToken(t).balanceOf(admin), h.burnPot.openingBuyTokens(), "the opening buy is in the admin wallet");
        assertTrue(ICurveX(info.curve).snipeTaxExempt(admin));
        l.check();

        // and it cannot be run twice
        vm.expectRevert(bytes("$FACTOR is already launched"));
        l.run();
    }
}
