// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {FactorLine} from "../src/FactorLine.sol";
import {FactorBounty} from "../src/FactorBounty.sol";
import {Config} from "./Config.sol";

interface IEthUsdFeedB {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Deploys the bounty contract: one transaction, given the desk and the line contract and nothing else. It reads the burn
/// pot from the desk. There is no owner, and nothing is set afterwards, because
/// nothing can be. Nothing needs seeding: every prize and every bond is its sender's own.
///
///   FACTOR_ADMIN=… FACTOR_GATEWAY=… FACTOR_BURN_POT=… FACTOR_DESK=… FACTOR_SPLITTER=… FACTOR_ACCOUNTS=… FACTOR_LINE=… \
///     forge script script/DeployBounties.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --broadcast --interactive --sender <the deploying wallet>
///
/// contracts/deploy-bounties.sh runs exactly this with every value filled in. Without --broadcast it is a dry run.
/// costs() says what the deploy and each call cost, from a simulation against the chain as it is now.
contract DeployBounties is Script, Config {
    address internal constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    function run() external returns (FactorBounty b) {
        _requireChain();
        Factor memory h = _deployed();
        FactorLine line = _line(h.desk);
        vm.startBroadcast();
        b = new FactorBounty(h.desk, line);
        vm.stopBroadcast();
        _verify(b, h.desk, line);
        require(b.bountyCount() == 0 && b.bonds() == 0, "a fresh bounty contract has no bounty and no bond");
        console.log("FACTOR_BOUNTY=%s", address(b));
    }

    /// Reads a deployed bounty contract back from the chain and checks every wire. No broadcast, no key.
    function check() external view {
        _requireChain();
        Factor memory h = _deployed();
        FactorLine line = _line(h.desk);
        FactorBounty b = FactorBounty(payable(vm.envAddress("FACTOR_BOUNTY")));
        require(address(b).code.length > 0, "no contract at FACTOR_BOUNTY");
        _verify(b, h.desk, line);
        console.log("OK: the bounty contract is wired to the desk, its burn pot and the line contract.");
        console.log("    bounty     %s", address(b));
        console.log("    desk       %s", address(b.desk()));
        console.log("    line       %s", address(b.line()));
        console.log("    burn pot   %s (the 1% and rounding dust are burned here)", b.burnPot());
        console.log("    bounties   %s", b.bountyCount());
        console.log("    held       %s wei", b.held());
        console.log("    bonds      %s wei", b.bonds());
    }

    /// What it costs, simulated against the chain as it is now and sent nowhere: the deploy, posting, entering, a pick, the
    /// winner's delivery and the close; bonds going back; and a split between 25 entrants. Gas at the base fee plus 25%.
    function costs() external {
        _requireChain();
        Factor memory h = _deployed();
        FactorLine line = _line(h.desk);
        uint256 gasPrice = (block.basefee * 125) / 100;
        if (gasPrice == 0) gasPrice = 0.02 gwei;
        (, int256 answer,,,) = IEthUsdFeedB(ETH_USD_FEED).latestRoundData();
        uint256 usd8 = uint256(answer);
        uint256[8] memory gas = _simulate(h.desk, line);
        console.log("gas price used: %s wei (the base fee plus 25%%)", gasPrice);
        console.log("ETH price: %s (8 decimals)", usd8);
        _say("the deploy (paid once, by the deploying wallet)", gas[0], gasPrice, usd8);
        _say("posting a bounty (the poster)", gas[1], gasPrice, usd8);
        _say("entering (the agent)", gas[2], gasPrice, usd8);
        _say("picking, with the desk's lock (the poster)", gas[3], gasPrice, usd8);
        _say("bonds going back, 3 entrants (the engine or anyone)", gas[4], gasPrice, usd8);
        _say("delivering on the desk (the winner)", gas[5], gasPrice, usd8);
        _say("closing a win, which accepts on the desk (the engine or anyone)", gas[6], gasPrice, usd8);
        _say("closing an unpicked split between 25 entrants (the engine or anyone)", gas[7], gasPrice, usd8);
        console.log("BOUNTY_DEPLOY_GAS=%s", gas[0]);
        console.log("BOUNTY_SPLIT_GAS=%s", gas[7]);
    }

    function _simulate(FactorDesk desk, FactorLine line) internal returns (uint256[8] memory gas) {
        uint256 g = gasleft();
        FactorBounty b = new FactorBounty(desk, line);
        gas[0] = g - gasleft() + 21_000 + type(FactorBounty).creationCode.length * 16;

        address poster = makeAddr("a throwaway poster");
        vm.deal(poster, 10 ether);
        address[] memory agents = new address[](25);
        for (uint256 i = 0; i < 25; ++i) {
            agents[i] = makeAddr(string.concat("a throwaway bounty agent ", vm.toString(i)));
            vm.deal(agents[i], 1 ether);
            vm.prank(agents[i]);
            desk.register();
        }

        vm.prank(poster);
        g = gasleft();
        uint256 id = b.post{value: 0.00505 ether}(0.005 ether, block.timestamp + 1 hours, 0, keccak256("a task"));
        gas[1] = g - gasleft() + 21_000;
        for (uint256 i = 0; i < 4; ++i) {
            bytes32 h = b.entryHash(id, agents[i], keccak256("the work"));
            vm.prank(agents[i]);
            g = gasleft();
            b.enter{value: 0.00005 ether}(id, agents[i], h);
            if (i == 3) gas[2] = g - gasleft() + 21_000;
        }
        vm.warp(block.timestamp + 1 hours);
        vm.prank(poster);
        g = gasleft();
        uint256 job = b.pick(id, agents[0]);
        gas[3] = g - gasleft() + 21_000;
        g = gasleft();
        b.returnBonds(id);
        gas[4] = g - gasleft() + 21_000;
        bytes32 proof = b.entryOf(id, agents[0]).hash;
        vm.prank(agents[0]);
        g = gasleft();
        desk.deliver(job, proof);
        gas[5] = g - gasleft() + 21_000;
        g = gasleft();
        b.close(id);
        gas[6] = g - gasleft() + 21_000;

        vm.prank(poster);
        id = b.post{value: 0.00505 ether}(0.005 ether, block.timestamp + 1 hours, 0, keccak256("a task"));
        for (uint256 i = 0; i < 25; ++i) {
            bytes32 h = b.entryHash(id, agents[i], keccak256("the work"));
            vm.prank(agents[i]);
            b.enter{value: 0.00005 ether}(id, agents[i], h);
        }
        vm.warp(block.timestamp + 1 hours + 3 days);
        g = gasleft();
        b.close(id);
        gas[7] = g - gasleft() + 21_000;
    }

    function _line(FactorDesk desk) internal view returns (FactorLine line) {
        line = FactorLine(payable(vm.envAddress("FACTOR_LINE")));
        require(address(line).code.length > 0, "no contract at FACTOR_LINE");
        require(address(line.desk()) == address(desk), "FACTOR_LINE is not the line contract of this desk");
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

    /// Everything about the bounty contract that can be read back, read back against the deployed desk and line.
    function _verify(FactorBounty b, FactorDesk desk, FactorLine line) internal view {
        require(address(b.desk()) == address(desk), "bounty: wrong desk");
        require(address(b.line()) == address(line), "bounty: wrong line contract");
        require(b.burnPot() == desk.burnPot(), "bounty: not the desk's burn pot");
        require(
            b.BURN_BPS() == 100 && b.BOND_BPS() == 100 && b.MIN_PRIZE() == 0.005 ether && b.MAX_ENTRIES() == 25,
            "bounty: fee, bond, smallest prize or most entries"
        );
        require(
            b.MIN_OPEN() == 1 hours && b.MAX_OPEN() == 30 days && b.PICK_TIME() == 3 days && b.DELIVER_TIME() == 3 days,
            "bounty: the times"
        );
        require(b.MIN_PRIZE() >= desk.MIN_JOB(), "bounty: a prize under the desk's smallest job");
        require(b.DELIVER_TIME() >= desk.MIN_DUE() && b.DELIVER_TIME() <= desk.MAX_DUE(), "bounty: the desk's due times");
        require(address(b).code.length > 0 && address(b).code.length <= 24_576, "bounty: size");
    }
}
