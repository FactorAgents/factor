// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../src/FactorLine.sol";
import {Config} from "./Config.sol";

interface IEthUsdFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Deploys the line contract: one transaction, given the desk and nothing else. It reads the burn pot and the
/// gateway from the desk and makes the code every line account runs in its own constructor. There is no owner, and
/// nothing is set afterwards, because nothing can be. The pool is seeded afterwards by plain ETH sent to it.
///
///   FACTOR_ADMIN=… FACTOR_GATEWAY=… FACTOR_BURN_POT=… FACTOR_DESK=… FACTOR_SPLITTER=… FACTOR_ACCOUNTS=… \
///     forge script script/DeployLines.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --broadcast --interactive --sender <the deploying wallet>
///
/// contracts/deploy-lines.sh runs exactly this with every value filled in. Without --broadcast it is a dry run.
/// costs() says what the deploy, opening a line and drawing, sweeping and repaying cost, from a simulation against
/// the chain as it is now.
contract DeployLines is Script, Config {
    address internal constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    function run() external returns (FactorLine line) {
        _requireChain();
        Factor memory h = _deployed();
        vm.startBroadcast();
        line = new FactorLine(h.desk);
        vm.stopBroadcast();
        _verifyLine(line, h.desk);
        require(line.lineCount() == 0 && line.pool() == 0, "a fresh line contract has no line and no pool");
        console.log("FACTOR_LINE=%s", address(line));
    }

    /// Reads a deployed line contract back from the chain and checks every wire. No broadcast, no key.
    function check() external view {
        _requireChain();
        Factor memory h = _deployed();
        FactorLine line = FactorLine(payable(vm.envAddress("FACTOR_LINE")));
        require(address(line).code.length > 0, "no contract at FACTOR_LINE");
        _verifyLine(line, h.desk);
        console.log("OK: the line contract is wired to the desk, its burn pot and its gateway.");
        console.log("    line       %s", address(line));
        console.log("    desk       %s", address(line.desk()));
        console.log("    burn pot   %s", line.burnPot());
        console.log("    gateway    %s (a draw as compute is paid here)", line.gateway());
        console.log("    accounts   %s (the code every line account runs)", line.accountImplementation());
        console.log("    lines      %s", line.lineCount());
        console.log("    pool       %s wei", line.pool());
    }

    /// What it costs, simulated against the chain as it is now and sent nowhere: the deploy, then a throwaway agent
    /// registers on the real desk, opens its line, bonds, draws as cash and as compute, is paid by a job into its
    /// line account, and the payment is swept into the line. Gas at the chain's base fee plus 25%.
    function costs() external {
        _requireChain();
        Factor memory h = _deployed();
        uint256 gasPrice = (block.basefee * 125) / 100;
        if (gasPrice == 0) gasPrice = 0.02 gwei;
        (, int256 answer,,,) = IEthUsdFeed(ETH_USD_FEED).latestRoundData();
        uint256 usd8 = uint256(answer);
        uint256[7] memory gas = _simulate(h.desk);
        console.log("gas price used: %s wei (the base fee plus 25%%)", gasPrice);
        console.log("ETH price: %s (8 decimals)", usd8);
        _say("the deploy (paid once, by the deploying wallet)", gas[0], gasPrice, usd8);
        _say("opening a line (the agent, once)", gas[1], gasPrice, usd8);
        _say("a bond at the line account", gas[2], gasPrice, usd8);
        _say("a draw as cash", gas[3], gasPrice, usd8);
        _say("a draw as compute", gas[4], gasPrice, usd8);
        _say("a sweep of income into the line (the engine or anyone)", gas[5], gasPrice, usd8);
        _say("a repayment", gas[6], gasPrice, usd8);
        console.log("LINE_DEPLOY_GAS=%s", gas[0]);
        console.log("LINE_OPEN_GAS=%s", gas[1]);
        console.log("LINE_DRAW_GAS=%s", gas[3]);
    }

    /// Each step's gas, plus the transaction's base cost (and for the deploy, its calldata).
    function _simulate(FactorDesk desk) internal returns (uint256[7] memory gas) {
        uint256 g = gasleft();
        FactorLine line = new FactorLine(desk);
        gas[0] = g - gasleft() + 21_000 + type(FactorLine).creationCode.length * 16;

        address key = makeAddr("a throwaway agent for the cost of a line");
        address buyer = makeAddr("a throwaway buyer");
        vm.deal(key, 1 ether);
        vm.deal(buyer, 1 ether);
        address seeder = makeAddr("a throwaway seeder");
        vm.deal(seeder, 1 ether);
        vm.prank(seeder);
        (bool ok,) = address(line).call{value: 0.1 ether}("");
        require(ok, "the seed");
        vm.prank(key);
        desk.register();

        vm.prank(key);
        g = gasleft();
        FactorLineAccount acct = FactorLineAccount(payable(line.open()));
        gas[1] = g - gasleft() + 21_000;

        vm.prank(key);
        g = gasleft();
        acct.addBond{value: 0.01 ether}(0);
        gas[2] = g - gasleft() + 21_000;

        vm.prank(key);
        g = gasleft();
        line.draw(0.004 ether, false);
        gas[3] = g - gasleft() + 21_000;

        vm.prank(key);
        g = gasleft();
        line.draw(0.001 ether, true);
        gas[4] = g - gasleft() + 21_000;

        vm.prank(buyer);
        uint256 id = desk.lock{value: 0.01 ether}(address(acct), block.timestamp + 1 days, false);
        vm.prank(key);
        acct.deliver(id, keccak256("the work"));
        vm.prank(buyer);
        desk.accept(id);
        g = gasleft();
        acct.sweep();
        gas[5] = g - gasleft() + 21_000;

        vm.prank(key);
        line.draw(0.001 ether, false);
        vm.prank(buyer);
        g = gasleft();
        line.repay{value: 0.001 ether}(address(acct));
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

    /// Everything about the line contract that can be read back, read back against the deployed desk.
    function _verifyLine(FactorLine line, FactorDesk desk) internal view {
        require(address(line.desk()) == address(desk), "line: wrong desk");
        require(line.burnPot() == desk.burnPot(), "line: not the desk's burn pot");
        require(line.gateway() == desk.gateway(), "line: not the desk's gateway");
        FactorLineAccount impl = FactorLineAccount(payable(line.accountImplementation()));
        require(address(impl).code.length > 0, "line: no account code");
        require(address(impl.line()) == address(line) && address(impl.desk()) == address(desk), "line: account wiring");
        require(impl.key() == address(0), "line: the account code has no key");
        require(line.DRAW_FEE_BPS() == 200 && line.BURN_BPS() == 100, "line: the fee is not 2%, half burned");
        require(line.TERM() == 30 days && line.DEFAULT_AFTER() == 30 days, "line: not 30 + 30 days");
        require(line.POOL_OUT_MAX_BPS() == 8000 && line.MIN_DRAW() == 0.0001 ether, "line: pool rule or smallest draw");
        require(address(line).code.length > 0 && address(line).code.length <= 24_576, "line: size");
    }
}
