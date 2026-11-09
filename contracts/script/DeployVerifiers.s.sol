// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {FactorLine} from "../src/FactorLine.sol";
import {FactorVerifiers} from "../src/FactorVerifiers.sol";
import {Config} from "./Config.sol";

interface IEthUsdFeedV {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Deploys the verifier contract: one transaction, given the desk and the line contract and nothing else. There is no
/// owner, and nothing is set afterwards, because nothing can be. Nothing needs seeding: every fee is its customer's own
/// and every bond its verifier's.
///
///   FACTOR_ADMIN=… FACTOR_GATEWAY=… FACTOR_BURN_POT=… FACTOR_DESK=… FACTOR_SPLITTER=… FACTOR_ACCOUNTS=… FACTOR_LINE=… \
///     forge script script/DeployVerifiers.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --broadcast --interactive --sender <the deploying wallet>
///
/// contracts/deploy-verifiers.sh runs exactly this with every value filled in. Without --broadcast it is a dry run.
/// costs() says what the deploy and each call cost, from a simulation against the chain as it is now.
contract DeployVerifiers is Script, Config {
    address internal constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    function _line() internal view returns (FactorLine l) {
        l = FactorLine(payable(vm.envAddress("FACTOR_LINE")));
        require(address(l).code.length > 0, "no contract at FACTOR_LINE");
    }

    function run() external returns (FactorVerifiers v) {
        _requireChain();
        Factor memory h = _deployed();
        FactorLine l = _line();
        vm.startBroadcast();
        v = new FactorVerifiers(h.desk, l);
        vm.stopBroadcast();
        _verify(v, h.desk, l);
        require(v.caseCount() == 0 && v.bonds() == 0, "a fresh verifier contract has no case and holds nothing");
        console.log("FACTOR_VERIFIERS=%s", address(v));
    }

    /// Reads a deployed verifier contract back from the chain and checks every wire. No broadcast, no key.
    function check() external view {
        _requireChain();
        Factor memory h = _deployed();
        FactorLine l = _line();
        FactorVerifiers v = FactorVerifiers(payable(vm.envAddress("FACTOR_VERIFIERS")));
        require(address(v).code.length > 0, "no contract at FACTOR_VERIFIERS");
        _verify(v, h.desk, l);
        console.log("OK: the verifier contract is wired to the desk and the line contract.");
        console.log("    verifiers  %s", address(v));
        console.log("    desk       %s", address(v.desk()));
        console.log("    line       %s", address(v.line()));
        console.log("    cases      %s", v.caseCount());
        console.log("    bonds      %s wei", v.bonds());
        console.log("    staked     %s wei", v.staked());
        console.log("    fees       %s wei", v.fees());
    }

    /// What it costs, simulated against the chain as it is now and sent nowhere: the deploy, a verifier joining, a hire,
    /// the first check, the step that carries out an undisputed verdict, a dispute, a seat, a reveal, and the step that
    /// settles a panel of three. Gas at the base fee plus 25%.
    function costs() external {
        _requireChain();
        Factor memory h = _deployed();
        FactorLine l = _line();
        uint256 gasPrice = (block.basefee * 125) / 100;
        if (gasPrice == 0) gasPrice = 0.02 gwei;
        (, int256 answer,,,) = IEthUsdFeedV(ETH_USD_FEED).latestRoundData();
        uint256 usd8 = uint256(answer);
        uint256[9] memory gas = _simulate(h.desk, l);
        console.log("gas price used: %s wei (the base fee plus 25%%)", gasPrice);
        console.log("ETH price: %s (8 decimals)", usd8);
        _say("the deploy (paid once, by the deploying wallet)", gas[0], gasPrice, usd8);
        _say("a verifier joins with its bond (the verifier)", gas[1], gasPrice, usd8);
        _say("hiring with a verifier, the job locked on the desk (the customer)", gas[2], gasPrice, usd8);
        _say("the first check (a verifier)", gas[3], gasPrice, usd8);
        _say("a step that carries out an undisputed verdict (the engine or anyone)", gas[4], gasPrice, usd8);
        _say("a dispute (the customer or the agent)", gas[5], gasPrice, usd8);
        _say("taking a panel seat (a verifier)", gas[6], gasPrice, usd8);
        _say("a reveal (a panelist)", gas[7], gasPrice, usd8);
        _say("a step that settles a panel of three (the engine or anyone)", gas[8], gasPrice, usd8);
        console.log("VERIFIERS_DEPLOY_GAS=%s", gas[0]);
    }

    function _simulate(FactorDesk desk, FactorLine l) internal returns (uint256[9] memory gas) {
        uint256 g = gasleft();
        FactorVerifiers v = new FactorVerifiers(desk, l);
        gas[0] = g - gasleft() + 21_000 + type(FactorVerifiers).creationCode.length * 16;

        address customer = makeAddr("a throwaway customer");
        address agent = makeAddr("a throwaway verified agent");
        vm.deal(customer, 10 ether);
        vm.prank(agent);
        desk.register();
        address[4] memory vs;
        for (uint256 i = 0; i < 4; ++i) {
            vs[i] = makeAddr(string.concat("a throwaway verifier ", vm.toString(i)));
            vm.deal(vs[i], 1 ether);
            vm.prank(vs[i]);
            g = gasleft();
            v.join{value: 0.01 ether}(uint8(i + 1));
            if (i == 0) gas[1] = g - gasleft() + 21_000;
            vm.warp(block.timestamp + 1);
        }

        vm.prank(customer);
        g = gasleft();
        uint256 id = v.hire{value: 0.0011 ether}(agent, block.timestamp + 1 days, false, 0.0001 ether, keccak256("t"));
        gas[2] = g - gasleft() + 21_000;
        uint256 job = v.getCase(id).job;
        vm.prank(agent);
        desk.deliver(job, keccak256("work"));
        vm.prank(vs[0]);
        g = gasleft();
        v.check(id, true, keccak256("why"));
        gas[3] = g - gasleft() + 21_000;
        vm.warp(block.timestamp + 2 hours);
        g = gasleft();
        v.step(id);
        gas[4] = g - gasleft() + 21_000;

        vm.prank(customer);
        uint256 id2 = v.hire{value: 0.0011 ether}(agent, block.timestamp + 1 days, false, 0.0001 ether, keccak256("t"));
        job = v.getCase(id2).job;
        vm.prank(agent);
        desk.deliver(job, keccak256("work"));
        vm.prank(vs[0]);
        v.check(id2, true, keccak256("why"));
        vm.prank(customer);
        g = gasleft();
        v.dispute{value: 0.0005 ether}(id2);
        gas[5] = g - gasleft() + 21_000;
        for (uint256 i = 1; i < 4; ++i) {
            bytes32 commit = v.commitOf(id2, vs[i], true, keccak256("why"), bytes32(i));
            vm.prank(vs[i]);
            g = gasleft();
            v.sit(id2, commit);
            if (i == 1) gas[6] = g - gasleft() + 21_000;
        }
        vm.warp(desk.job(v.getCase(id2).job).deliveredAt + 14 hours);
        for (uint256 i = 1; i < 4; ++i) {
            vm.prank(vs[i]);
            g = gasleft();
            v.reveal(id2, true, keccak256("why"), bytes32(i));
            if (i == 1) gas[7] = g - gasleft() + 21_000;
        }
        g = gasleft();
        v.step(id2);
        gas[8] = g - gasleft() + 21_000;
    }

    function _say(string memory what, uint256 gas, uint256 gasPrice, uint256 usd8) internal pure {
        uint256 wei_ = gas * gasPrice;
        uint256 tenthCents = (wei_ * usd8) / 1e23;
        console.log(what);
        console.log("    %s gas, %s wei", gas, wei_);
        console.log("    about $%s.%s", tenthCents / 1000, _three(tenthCents % 1000));
    }

    function _three(uint256 n) internal pure returns (string memory) {
        return
            n < 10 ? string.concat("00", vm.toString(n)) : n < 100 ? string.concat("0", vm.toString(n)) : vm.toString(n);
    }

    /// Everything about the verifier contract that can be read back, read back against the deployed desk and line.
    function _verify(FactorVerifiers v, FactorDesk desk, FactorLine l) internal view {
        require(address(v.desk()) == address(desk), "verifiers: wrong desk");
        require(address(v.line()) == address(l), "verifiers: wrong line contract");
        require(address(l.desk()) == address(desk), "verifiers: the line contract is another desk's");
        require(v.review() == desk.REVIEW(), "verifiers: the desk's review time");
        require(v.REVEAL_END() + v.CUSTOMER_TIME() <= desk.REVIEW(), "verifiers: the clock does not fit the desk's");
        require(
            v.MIN_FEE() == 0.0001 ether && v.MIN_BOND() == 0.01 ether && v.MIN_STAKE() == 0.001 ether
                && v.STAKE_BPS() == 2000 && v.WRONG_BPS() == 5000 && v.DISPUTE_BPS() == 1000
                && v.MIN_DISPUTE() == 0.0005 ether && v.PANEL() == 3,
            "verifiers: the numbers"
        );
        require(
            v.CHECK_TIME() == 4 hours && v.DISPUTE_TIME() == 2 hours && v.SEAT_END() == 14 hours
                && v.REVEAL_END() == 18 hours,
            "verifiers: the clock"
        );
        require(address(v).code.length > 0 && address(v).code.length <= 24_576, "verifiers: size");
    }
}
