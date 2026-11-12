// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FactorDesk} from "../src/FactorDesk.sol";
import {FactorLine, FactorLineAccount} from "../src/FactorLine.sol";
import {FactorGuarantee} from "../src/FactorGuarantee.sol";
import {FactorVouch} from "../src/FactorVouch.sol";
import {Config} from "./Config.sol";

interface IEthUsdFeedVo {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Deploys the vouching contract: one transaction, given the guarantee contract and nothing else (the desk, the line
/// contract and the burn pot are read from it). There is no owner, and nothing is set afterwards, because nothing can be.
/// Nothing needs seeding: every bond is its voucher's own and every fee its vouched agent's.
///
///   FACTOR_ADMIN=… FACTOR_GATEWAY=… FACTOR_BURN_POT=… FACTOR_DESK=… FACTOR_SPLITTER=… FACTOR_ACCOUNTS=… \
///   FACTOR_GUARANTEE=… forge script script/DeployVouch.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --broadcast --interactive --sender <the deploying wallet>
///
/// contracts/deploy-vouch.sh runs exactly this with every value filled in. Without --broadcast it is a dry run.
/// costs() says what the deploy and each call cost, from a simulation against the chain as it is now.
contract DeployVouch is Script, Config {
    address internal constant ETH_USD_FEED = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;

    function _guarantee() internal view returns (FactorGuarantee g) {
        g = FactorGuarantee(payable(vm.envAddress("FACTOR_GUARANTEE")));
        require(address(g).code.length > 0, "no contract at FACTOR_GUARANTEE");
    }

    function run() external returns (FactorVouch v) {
        _requireChain();
        Factor memory h = _deployed();
        FactorGuarantee g = _guarantee();
        vm.startBroadcast();
        v = new FactorVouch(g);
        vm.stopBroadcast();
        _verify(v, h.desk, g);
        require(v.vouchCount() == 0 && v.bonds() == 0, "a fresh vouching contract has no vouch and holds nothing");
        console.log("FACTOR_VOUCH=%s", address(v));
    }

    /// Reads a deployed vouching contract back from the chain and checks every wire. No broadcast, no key.
    function check() external view {
        _requireChain();
        Factor memory h = _deployed();
        FactorGuarantee g = _guarantee();
        FactorVouch v = FactorVouch(payable(vm.envAddress("FACTOR_VOUCH")));
        require(address(v).code.length > 0, "no contract at FACTOR_VOUCH");
        _verify(v, h.desk, g);
        console.log("OK: the vouching contract is wired to the desk, the line contract and the guarantee contract.");
        console.log("    vouching   %s", address(v));
        console.log("    guarantee  %s", address(v.guarantee()));
        console.log("    line       %s", address(v.line()));
        console.log("    desk       %s", address(v.desk()));
        console.log("    burn pot   %s", v.burnPot());
        console.log("    vouches    %s", v.vouchCount());
        console.log("    bonds      %s wei", v.bonds());
        console.log("    held       %s wei", v.held());
        console.log("    fees held  %s wei", v.feesHeld());
    }

    /// What it costs, simulated against the chain as it is now and sent nowhere: the deploy, a bond, an offer on a line,
    /// an acceptance, a release (a line vouch kept), an offer on a cover and a settle that closes the cover and keeps the
    /// vouch. Gas at the base fee plus 25%.
    function costs() external {
        _requireChain();
        Factor memory h = _deployed();
        FactorGuarantee g = _guarantee();
        uint256 gasPrice = (block.basefee * 125) / 100;
        if (gasPrice == 0) gasPrice = 0.02 gwei;
        (, int256 answer,,,) = IEthUsdFeedVo(ETH_USD_FEED).latestRoundData();
        uint256 usd8 = uint256(answer);
        uint256[7] memory gas = _simulate(h.desk, g);
        console.log("gas price used: %s wei (the base fee plus 25%%)", gasPrice);
        console.log("ETH price: %s (8 decimals)", usd8);
        _say("the deploy (paid once, by the deploying wallet)", gas[0], gasPrice, usd8);
        _say("a voucher adds to its bond (the voucher)", gas[1], gasPrice, usd8);
        _say("an offer on a credit line (the voucher)", gas[2], gasPrice, usd8);
        _say("accepting a vouch with its fee (the vouched agent)", gas[3], gasPrice, usd8);
        _say("releasing a line vouch, kept (the vouched agent)", gas[4], gasPrice, usd8);
        _say("an offer on a cover (the voucher)", gas[5], gasPrice, usd8);
        _say("a settle that closes the cover and keeps the vouch (the engine or anyone)", gas[6], gasPrice, usd8);
        console.log("VOUCH_DEPLOY_GAS=%s", gas[0]);
    }

    function _simulate(FactorDesk desk, FactorGuarantee g) internal returns (uint256[7] memory gas) {
        uint256 left = gasleft();
        FactorVouch v = new FactorVouch(g);
        gas[0] = left - gasleft() + 21_000 + type(FactorVouch).creationCode.length * 16;

        FactorLine line = g.line();
        address voucher = makeAddr("a throwaway voucher");
        address key = makeAddr("a throwaway newer agent");
        address agent = makeAddr("a throwaway covered agent");
        address customer = makeAddr("a throwaway customer");
        vm.deal(voucher, 10 ether);
        vm.deal(key, 1 ether);
        vm.deal(agent, 1 ether);
        vm.deal(customer, 10 ether);
        vm.prank(voucher);
        desk.register();
        vm.prank(agent);
        desk.register();
        vm.prank(key);
        desk.register();
        vm.prank(key);
        address account = line.open();
        // the voucher and the covered agent earn their scores with real jobs; the score is mocked past the time part
        for (uint256 i = 0; i < 20; ++i) {
            _job(desk, customer, voucher);
            _job(desk, customer, agent);
        }
        vm.mockCall(address(desk), abi.encodeCall(FactorDesk.score, (voucher)), abi.encode(uint256(400)));

        vm.prank(voucher);
        left = gasleft();
        v.addBond{value: 0.04 ether}(voucher);
        gas[1] = left - gasleft() + 21_000;
        vm.prank(voucher);
        left = gasleft();
        uint256 id = v.offerLine(voucher, account, 0.01 ether);
        gas[2] = left - gasleft() + 21_000;
        vm.prank(key);
        left = gasleft();
        v.accept{value: 0.0002 ether}(id);
        gas[3] = left - gasleft() + 21_000;
        vm.prank(key);
        left = gasleft();
        v.release(id);
        gas[4] = left - gasleft() + 21_000;

        vm.prank(agent);
        g.addBond{value: 0.02 ether}(agent);
        vm.prank(agent);
        g.setOffer(agent, 0.01 ether);
        uint256 dueAt = block.timestamp + 1 days;
        vm.prank(customer);
        uint256 cover = g.reserve{value: 0.0001 ether}(agent, 0.04 ether, dueAt, false, 0.01 ether);
        vm.prank(customer);
        uint256 job = desk.lock{value: 0.04 ether}(agent, dueAt, false);
        g.bind(cover, job);
        vm.prank(voucher);
        left = gasleft();
        uint256 id2 = v.offerCover(voucher, cover, 0.01 ether);
        gas[5] = left - gasleft() + 21_000;
        vm.prank(agent);
        v.accept{value: 0.0002 ether}(id2);
        vm.prank(agent);
        desk.deliver(job, keccak256("work"));
        vm.prank(customer);
        desk.accept(job);
        left = gasleft();
        v.settle(id2);
        gas[6] = left - gasleft() + 21_000;
    }

    function _job(FactorDesk desk, address customer, address agent) internal {
        vm.prank(customer);
        uint256 id = desk.lock{value: 0.001 ether}(agent, block.timestamp + 1 days, false);
        vm.prank(agent);
        desk.deliver(id, keccak256("work"));
        vm.prank(customer);
        desk.accept(id);
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

    /// Everything about the vouching contract that can be read back, read back against the deployed desk and guarantee
    /// contract.
    function _verify(FactorVouch v, FactorDesk desk, FactorGuarantee g) internal view {
        require(address(v.guarantee()) == address(g), "vouch: wrong guarantee contract");
        require(address(v.desk()) == address(desk) && address(g.desk()) == address(desk), "vouch: wrong desk");
        require(address(v.line()) == address(g.line()) && address(v.line()) != address(0), "vouch: wrong line contract");
        require(address(v.line().desk()) == address(desk), "vouch: the line contract is another desk's");
        require(v.burnPot() == desk.burnPot(), "vouch: the desk's burn pot");
        require(v.lineDue() == v.line().TERM() && v.lineDefaultAfter() == v.line().DEFAULT_AFTER(), "vouch: the line's clock");
        require(v.grace() == desk.GRACE() && v.review() == desk.REVIEW(), "vouch: the desk's clock");
        require(
            v.MIN_SCORE() == 300 && v.MAX_SHARE_BPS() == 2500 && v.FEE_BPS() == 200 && v.VOUCHER_BPS() == 5000
                && v.MIN_VOUCH() == 0.0001 ether && v.LINE_TERM() == 30 days && v.OFFER_WINDOW() == 7 days,
            "vouch: the numbers"
        );
        require(address(v).code.length > 0 && address(v).code.length <= 24_576, "vouch: size");
    }
}
