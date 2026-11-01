// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {FactorLine} from "../src/FactorLine.sol";
import {FactorGuarantee} from "../src/FactorGuarantee.sol";
import {Config} from "./Config.sol";

interface IEthUsdFeedG {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Deploys the guarantee contract: one transaction, given the desk and the line contract and nothing else. It reads the
/// burn pot and the desk's own numbers (smallest job, due times, grace, review) from the desk. There is no owner, and
/// nothing is set afterwards, because nothing can be. Nothing needs seeding: every cover is backed by its agent's bond.
///
///   FACTOR_ADMIN=… FACTOR_GATEWAY=… FACTOR_BURN_POT=… FACTOR_DESK=… FACTOR_SPLITTER=… FACTOR_ACCOUNTS=… FACTOR_LINE=… \
///     forge script script/DeployGuarantees.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --broadcast --interactive --sender <the deploying wallet>
///
/// contracts/deploy-guarantees.sh runs exactly this with every value filled in. Without --broadcast it is a dry run.
/// costs() says what the deploy and each call cost, from a simulation against the chain as it is now.
contract DeployGuarantees is Script, Config {
    address internal constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    function run() external returns (FactorGuarantee g) {
        _requireChain();
        Factor memory h = _deployed();
        FactorLine line = _line(h.desk);
        vm.startBroadcast();
        g = new FactorGuarantee(h.desk, line);
        vm.stopBroadcast();
        _verify(g, h.desk, line);
        require(g.coverCount() == 0 && g.bonds() == 0, "a fresh guarantee contract has no cover and no bond");
        console.log("FACTOR_GUARANTEE=%s", address(g));
    }

    /// Reads a deployed guarantee contract back from the chain and checks every wire. No broadcast, no key.
    function check() external view {
        _requireChain();
        Factor memory h = _deployed();
        FactorLine line = _line(h.desk);
        FactorGuarantee g = FactorGuarantee(vm.envAddress("FACTOR_GUARANTEE"));
        require(address(g).code.length > 0, "no contract at FACTOR_GUARANTEE");
        _verify(g, h.desk, line);
        console.log("OK: the guarantee contract is wired to the desk, its burn pot and the line contract.");
        console.log("    guarantee  %s", address(g));
        console.log("    desk       %s", address(g.desk()));
        console.log("    line       %s", address(g.line()));
        console.log("    burn pot   %s (half of every cover fee is burned here)", g.burnPot());
        console.log("    covers     %s", g.coverCount());
        console.log("    bonds      %s wei", g.bonds());
    }

    /// What it costs, simulated against the chain as it is now and sent nowhere: the deploy, then a throwaway agent
    /// earns a score of 200 with twenty small jobs, bonds and sets its offer; a customer reserves cover, locks the job
    /// and ties it; one covered job is delivered and closed, another is not delivered and is closed after its grace,
    /// which refunds it on the desk and pays the cover. Gas at the chain's base fee plus 25%.
    function costs() external {
        _requireChain();
        Factor memory h = _deployed();
        FactorLine line = _line(h.desk);
        uint256 gasPrice = (block.basefee * 125) / 100;
        if (gasPrice == 0) gasPrice = 0.02 gwei;
        (, int256 answer,,,) = IEthUsdFeedG(ETH_USD_FEED).latestRoundData();
        uint256 usd8 = uint256(answer);
        uint256[8] memory gas = _simulate(h.desk, line);
        console.log("gas price used: %s wei (the base fee plus 25%%)", gasPrice);
        console.log("ETH price: %s (8 decimals)", usd8);
        _say("the deploy (paid once, by the deploying wallet)", gas[0], gasPrice, usd8);
        _say("a bond (the agent)", gas[1], gasPrice, usd8);
        _say("setting the offer (the agent)", gas[2], gasPrice, usd8);
        _say("reserving cover (the customer)", gas[3], gasPrice, usd8);
        _say("locking the job on the desk (the customer, as without cover)", gas[4], gasPrice, usd8);
        _say("tying the cover to the job (the customer, the engine or anyone)", gas[5], gasPrice, usd8);
        _say("closing a delivered job's cover (the engine or anyone)", gas[6], gasPrice, usd8);
        _say("refunding a job not delivered and paying its cover (the engine or anyone)", gas[7], gasPrice, usd8);
        console.log("GUARANTEE_DEPLOY_GAS=%s", gas[0]);
        console.log("GUARANTEE_RESERVE_GAS=%s", gas[3]);
        console.log("GUARANTEE_CLOSE_GAS=%s", gas[7]);
    }

    function _simulate(FactorDesk desk, FactorLine line) internal returns (uint256[8] memory gas) {
        uint256 g = gasleft();
        FactorGuarantee gt = new FactorGuarantee(desk, line);
        gas[0] = g - gasleft() + 21_000 + type(FactorGuarantee).creationCode.length * 16;

        address agent = makeAddr("a throwaway agent for the cost of a guarantee");
        address buyer = makeAddr("a throwaway buyer");
        vm.deal(agent, 1 ether);
        vm.deal(buyer, 10 ether);
        vm.prank(agent);
        desk.register();
        // twenty settled jobs: 10 points each on the desk's score, so it can sell a quarter of a price
        for (uint256 i = 0; i < 20; ++i) {
            vm.prank(buyer);
            uint256 jid = desk.lock{value: 0.001 ether}(agent, block.timestamp + 1 days, false);
            vm.prank(agent);
            desk.deliver(jid, keccak256("the work"));
            vm.prank(buyer);
            desk.accept(jid);
        }
        require(desk.score(agent) >= 200, "the throwaway agent has a score of 200");

        vm.prank(agent);
        g = gasleft();
        gt.addBond{value: 0.05 ether}(agent);
        gas[1] = g - gasleft() + 21_000;

        vm.prank(agent);
        g = gasleft();
        gt.setOffer(agent, 0.01 ether);
        gas[2] = g - gasleft() + 21_000;

        uint256 price = 0.04 ether;
        uint256 dueAt = block.timestamp + 1 days;
        vm.prank(buyer);
        g = gasleft();
        gt.reserve{value: 0.0001 ether}(agent, price, dueAt, false, 0.01 ether);
        gas[3] = g - gasleft() + 21_000;

        vm.prank(buyer);
        g = gasleft();
        uint256 id = desk.lock{value: price}(agent, dueAt, false);
        gas[4] = g - gasleft() + 21_000;

        vm.prank(buyer);
        g = gasleft();
        gt.bind(1, id);
        gas[5] = g - gasleft() + 21_000;

        vm.prank(agent);
        desk.deliver(id, keccak256("the work"));
        vm.prank(buyer);
        desk.accept(id);
        g = gasleft();
        gt.close(id);
        gas[6] = g - gasleft() + 21_000;

        // a job the agent never delivers
        dueAt = block.timestamp + 2 hours;
        vm.prank(buyer);
        gt.reserve{value: 0.0001 ether}(agent, price, dueAt, false, 0.01 ether);
        vm.prank(buyer);
        id = desk.lock{value: price}(agent, dueAt, false);
        gt.bind(2, id);
        vm.warp(dueAt + 12 hours + 1);
        g = gasleft();
        gt.close(id);
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

    /// Everything about the guarantee contract that can be read back, read back against the deployed desk and line.
    function _verify(FactorGuarantee g, FactorDesk desk, FactorLine line) internal view {
        require(address(g.desk()) == address(desk), "guarantee: wrong desk");
        require(address(g.line()) == address(line), "guarantee: wrong line contract");
        require(g.burnPot() == desk.burnPot(), "guarantee: not the desk's burn pot");
        require(
            g.minJob() == desk.MIN_JOB() && g.minDue() == desk.MIN_DUE() && g.maxDue() == desk.MAX_DUE(),
            "guarantee: the desk's job rules"
        );
        require(g.grace() == desk.GRACE() && g.review() == desk.REVIEW(), "guarantee: the desk's grace and review");
        require(
            g.FEE_BPS() == 100 && g.MIN_COVER() == 0.0001 ether && g.WINDOW() == 1 hours,
            "guarantee: fee, smallest cover or window"
        );
        require(
            g.shareOf(199) == 0 && g.shareOf(200) == 2500 && g.shareOf(400) == 5000 && g.shareOf(600) == 7500
                && g.shareOf(800) == 10_000,
            "guarantee: the score's shares"
        );
        require(address(g).code.length > 0 && address(g).code.length <= 24_576, "guarantee: size");
    }
}
