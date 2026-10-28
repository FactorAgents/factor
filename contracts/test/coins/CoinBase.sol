// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeskBase} from "../DeskBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {AgentCoinLauncher} from "../../src/AgentCoinLauncher.sol";
import {AgentCoinSplitter, IAgentDesk} from "../../src/AgentCoinSplitter.sol";
import {IPonsV2LaunchFactory} from "../../src/interfaces/IPons.sol";
import {MockCurve, MockFactorToken} from "../mocks/MockPons.sol";

/// Factor deployed as the deploy script deploys it, the coin launcher beside it, and an agent on the desk with its
/// own key, ready to have a coin. The moves the coin tests start from.
abstract contract CoinBase is DeskBase {
    AgentCoinLauncher internal launcher;
    address internal agentW;
    uint256 internal agentKey;
    address payable internal maker = payable(makeAddr("maker"));
    address internal buyer = makeAddr("a buyer of the coin");

    function setUp() public virtual override {
        super.setUp();
        launcher = new AgentCoinLauncher(IAgentDesk(address(desk)));
        (agentW, agentKey) = makeAddrAndKey("an agent with a coin");
        vm.prank(agentW);
        desk.register();
    }

    function _coinParams() internal pure returns (IPonsV2LaunchFactory.TokenParams memory p) {
        p.name = "Page Smith";
        p.symbol = "SMITH";
        p.logo = "https://factoragents.fun/api/v1/coins/logo/page-smith";
        p.description = "Page Smith, an agent on Factor. Its coin's trading fees pay for its compute.";
        p.salt = keccak256("page-smith");
    }

    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// The agent's permission for `maker_`, at its current number, good for a day.
    function _permission(uint256 key, address agent, address maker_, IPonsV2LaunchFactory.TokenParams memory p)
        internal
        view
        returns (bytes memory sig, uint256 deadline)
    {
        deadline = block.timestamp + 1 days;
        sig = _sig(key, launcher.permissionDigest(agent, maker_, p, launcher.nonces(agent), deadline));
    }

    /// The maker launches the agent's coin with the agent's permission, paying the fee and `openingBuy`.
    function _launchByMaker(uint256 openingBuy)
        internal
        returns (MockFactorToken coin, AgentCoinSplitter s, MockCurve c)
    {
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams();
        (bytes memory sig, uint256 deadline) = _permission(agentKey, agentW, maker, p);
        uint256 value = factory.launchFee() + openingBuy;
        vm.deal(maker, maker.balance + value);
        vm.prank(maker);
        address t = launcher.launch{value: value}(agentW, maker, p, 0, deadline, sig);
        return _found(t);
    }

    /// The agent launches its own coin from its own wallet, naming `maker_`.
    function _launchByAgent(address maker_, uint256 openingBuy)
        internal
        returns (MockFactorToken coin, AgentCoinSplitter s, MockCurve c)
    {
        uint256 value = factory.launchFee() + openingBuy;
        vm.deal(agentW, agentW.balance + value);
        vm.prank(agentW);
        address t = launcher.launch{value: value}(agentW, payable(maker_), _coinParams(), 0, 0, "");
        return _found(t);
    }

    function _found(address t) internal view returns (MockFactorToken coin, AgentCoinSplitter s, MockCurve c) {
        coin = MockFactorToken(t);
        s = AgentCoinSplitter(payable(launcher.splitterOf(launcher.agentOf(t))));
        c = MockCurve(IPonsV2LaunchFactory(address(factory)).getLaunchedToken(t).curve);
    }

    /// Somebody buys the coin past its launch seconds: the trade leaves fees on its curve.
    function _buyCoin(MockCurve c, uint256 eth) internal returns (uint256 got) {
        if (block.timestamp < c.launchedAt() + 5) vm.warp(c.launchedAt() + 5);
        vm.deal(buyer, buyer.balance + eth);
        vm.prank(buyer);
        got = c.buy{value: eth}(eth, 0, buyer);
    }

    /// The agent fails to repay a pool advance, which bars it on the desk for good.
    function _bar(address who) internal {
        _fund(1 ether);
        _bond(who, 0.05 ether);
        uint256 id = _lock(who, 0.1 ether, false);
        _draw(who, id, 0.03 ether, FactorDesk.Kind.Pool);
        vm.warp(block.timestamp + 1 days + 12 hours + 1);
        desk.refund(id);
        assertTrue(desk.agent(who).barred);
    }
}
