// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {FactorMilestones} from "../src/FactorMilestones.sol";
import {Config} from "./Config.sol";

interface IEthUsdFeedM {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Deploys the milestone contract: one transaction, given the desk and nothing else. There is no owner, and nothing is
/// set afterwards, because nothing can be. Nothing needs seeding: every budget is its customer's own.
///
///   FACTOR_ADMIN=… FACTOR_GATEWAY=… FACTOR_BURN_POT=… FACTOR_DESK=… FACTOR_SPLITTER=… FACTOR_ACCOUNTS=… \
///     forge script script/DeployMilestones.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --broadcast --interactive --sender <the deploying wallet>
///
/// contracts/deploy-milestones.sh runs exactly this with every value filled in. Without --broadcast it is a dry run.
/// costs() says what the deploy and each call cost, from a simulation against the chain as it is now.
contract DeployMilestones is Script, Config {
    address internal constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    function run() external returns (FactorMilestones m) {
        _requireChain();
        Factor memory h = _deployed();
        vm.startBroadcast();
        m = new FactorMilestones(h.desk);
        vm.stopBroadcast();
        _verify(m, h.desk);
        require(m.planCount() == 0 && m.held() == 0, "a fresh milestone contract has no plan and holds nothing");
        console.log("FACTOR_MILESTONES=%s", address(m));
    }

    /// Reads a deployed milestone contract back from the chain and checks every wire. No broadcast, no key.
    function check() external view {
        _requireChain();
        Factor memory h = _deployed();
        FactorMilestones m = FactorMilestones(payable(vm.envAddress("FACTOR_MILESTONES")));
        require(address(m).code.length > 0, "no contract at FACTOR_MILESTONES");
        _verify(m, h.desk);
        console.log("OK: the milestone contract is wired to the desk.");
        console.log("    milestones %s", address(m));
        console.log("    desk       %s", address(m.desk()));
        console.log("    plans      %s", m.planCount());
        console.log("    held       %s wei", m.held());
        console.log("    at desk    %s wei", m.atDesk());
    }

    /// What it costs, simulated against the chain as it is now and sent nowhere: the deploy, posting two and six stages,
    /// the agent's delivery, an accept that opens the next stage, the last accept, and a step that sends the rest back.
    /// Gas at the base fee plus 25%.
    function costs() external {
        _requireChain();
        Factor memory h = _deployed();
        uint256 gasPrice = (block.basefee * 125) / 100;
        if (gasPrice == 0) gasPrice = 0.02 gwei;
        (, int256 answer,,,) = IEthUsdFeedM(ETH_USD_FEED).latestRoundData();
        uint256 usd8 = uint256(answer);
        uint256[7] memory gas = _simulate(h.desk);
        console.log("gas price used: %s wei (the base fee plus 25%%)", gasPrice);
        console.log("ETH price: %s (8 decimals)", usd8);
        _say("the deploy (paid once, by the deploying wallet)", gas[0], gasPrice, usd8);
        _say("posting two stages, with the first locked on the desk (the customer)", gas[1], gasPrice, usd8);
        _say("posting six stages (the customer)", gas[2], gasPrice, usd8);
        _say("delivering a stage on the desk (the agent)", gas[3], gasPrice, usd8);
        _say("accepting a stage, which opens the next (the customer)", gas[4], gasPrice, usd8);
        _say("accepting the last stage (the customer)", gas[5], gasPrice, usd8);
        _say("a step after a missed stage, which sends the rest back (the engine or anyone)", gas[6], gasPrice, usd8);
        console.log("MILESTONES_DEPLOY_GAS=%s", gas[0]);
    }

    function _simulate(FactorDesk desk) internal returns (uint256[7] memory gas) {
        uint256 g = gasleft();
        FactorMilestones m = new FactorMilestones(desk);
        gas[0] = g - gasleft() + 21_000 + type(FactorMilestones).creationCode.length * 16;

        address customer = makeAddr("a throwaway customer");
        address agent = makeAddr("a throwaway milestone agent");
        vm.deal(customer, 10 ether);
        vm.prank(agent);
        desk.register();
        uint256[] memory two = new uint256[](2);
        two[0] = 0.001 ether;
        two[1] = 0.001 ether;
        uint256[] memory twoT = new uint256[](2);
        twoT[0] = 1 days;
        twoT[1] = 1 days;
        uint256[] memory six = new uint256[](6);
        uint256[] memory sixT = new uint256[](6);
        for (uint256 i = 0; i < 6; ++i) {
            six[i] = 0.001 ether;
            sixT[i] = 1 days;
        }

        vm.prank(customer);
        g = gasleft();
        uint256 id = m.post{value: 0.002 ether}(agent, two, twoT, false, keccak256("terms"));
        gas[1] = g - gasleft() + 21_000;
        vm.prank(customer);
        g = gasleft();
        uint256 id6 = m.post{value: 0.006 ether}(agent, six, sixT, false, keccak256("terms"));
        gas[2] = g - gasleft() + 21_000;
        uint256 job = m.currentJob(id);
        vm.prank(agent);
        g = gasleft();
        desk.deliver(job, keccak256("work"));
        gas[3] = g - gasleft() + 21_000;
        vm.prank(customer);
        g = gasleft();
        m.accept(id);
        gas[4] = g - gasleft() + 21_000;
        job = m.currentJob(id);
        vm.prank(agent);
        desk.deliver(job, keccak256("work"));
        vm.prank(customer);
        g = gasleft();
        m.accept(id);
        gas[5] = g - gasleft() + 21_000;
        vm.warp(block.timestamp + 2 days);
        g = gasleft();
        m.step(id6);
        gas[6] = g - gasleft() + 21_000;
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

    /// Everything about the milestone contract that can be read back, read back against the deployed desk.
    function _verify(FactorMilestones m, FactorDesk desk) internal view {
        require(address(m.desk()) == address(desk), "milestones: wrong desk");
        require(
            m.MIN_STAGES() == 2 && m.MAX_STAGES() == 6 && m.MIN_STAGE() == 0.001 ether,
            "milestones: the stages or the smallest stage"
        );
        require(m.MIN_TIME() == 1 hours && m.MAX_TIME() == 30 days, "milestones: the times");
        require(m.MIN_STAGE() >= desk.MIN_JOB(), "milestones: a stage under the desk's smallest job");
        require(m.MIN_TIME() >= desk.MIN_DUE() && m.MAX_TIME() <= desk.MAX_DUE(), "milestones: the desk's due times");
        require(address(m).code.length > 0 && address(m).code.length <= 24_576, "milestones: size");
    }
}
