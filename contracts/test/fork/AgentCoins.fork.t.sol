// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, ICurveX, IFactoryX, IPonsToken} from "./ForkBase.sol";
import {PoolSwapper} from "./PoolSwapper.sol";
import {AgentCoinLauncher} from "../../src/AgentCoinLauncher.sol";
import {AgentCoinSplitter, IAgentDesk} from "../../src/AgentCoinSplitter.sol";
import {FactorAccount, FactorAccounts} from "../../src/FactorAccount.sol";
import {FactorBurnPot} from "../../src/FactorBurnPot.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../../src/interfaces/IPons.sol";
import {IPoolManager, PoolKey} from "../../src/interfaces/IPoolManager.sol";

interface IDeskRegister {
    function register() external;
}

/// Agent coins against the real Pons AND the real Factor, on a fork of Robinhood Chain: the launcher is deployed
/// against the live desk (and through it the live burn pot, gateway, owner and Pons), a coin is launched through
/// the real launch factory, traded on its real curve and in its real pool, and its fees reach the live gateway, the
/// live owner wallet and the live burn pot, which then buys and burns $FACTOR.
contract AgentCoinsForkTest is ForkBase {
    IPonsV2FeeEscrow constant escrow = IPonsV2FeeEscrow(ESCROW);
    address constant DESK = 0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F;
    address payable constant BURN_POT = payable(0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79);
    address constant ADMIN = 0xafA96B2F796968dA543B77E9d1a04f80321acD04;
    address constant GATEWAY = 0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0;
    address constant ACCOUNTS = 0x3417A303DcB62A84965a641f894ff5803502F8FA;
    address constant FACTOR = 0x47C5eA4d85C4c1A81F26124580A80B0b7A581CC0;

    AgentCoinLauncher launcher;
    address agentW;
    uint256 agentKey;
    address payable maker = payable(makeAddr("coin maker"));
    address buyer = makeAddr("coin buyer");
    address stranger = makeAddr("coin stranger");

    IPonsToken coin;
    ICurveX curve;
    AgentCoinSplitter splitter;
    uint256 t0;

    function setUp() public {
        _fork();
        launcher = new AgentCoinLauncher(IAgentDesk(DESK));
        (agentW, agentKey) = makeAddrAndKey("fork agent with a coin");
        vm.prank(agentW);
        IDeskRegister(DESK).register();
        vm.deal(buyer, 1000 ether);
    }

    function _coinParams(bytes32 salt) internal pure returns (IPonsV2LaunchFactory.TokenParams memory p) {
        p.name = "Fork Smith";
        p.symbol = "FSMITH";
        p.logo = "https://factoragents.fun/api/v1/coins/logo/fork-smith";
        p.description = "Fork Smith, an agent on Factor. Its coin's trading fees pay for its compute.";
        p.salt = salt;
    }

    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// The maker launches the agent's coin with the agent's permission; returns the gas the launch used.
    function _launch(uint256 openingBuy) internal returns (uint256 gasUsed) {
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams(keccak256("fork-smith"));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(agentKey, launcher.permissionDigest(agentW, maker, p, 0, deadline));
        uint256 fee = _pons().launchFee();
        vm.deal(maker, fee + openingBuy);
        vm.prank(maker);
        uint256 g = gasleft();
        address t = launcher.launch{value: fee + openingBuy}(agentW, maker, p, 0, deadline, sig);
        gasUsed = g - gasleft();
        coin = IPonsToken(t);
        curve = ICurveX(_pons().getLaunchedToken(t).curve);
        splitter = AgentCoinSplitter(payable(launcher.splitterOf(agentW)));
        t0 = block.timestamp;
    }

    function test_fork_theLauncherReadsTheLiveFactor() public view {
        assertEq(address(launcher.desk()), DESK);
        assertEq(launcher.burnPot(), BURN_POT);
        assertEq(launcher.gateway(), GATEWAY);
        assertEq(launcher.owner(), ADMIN);
        assertEq(address(launcher.factory()), FACTORY);
        assertEq(address(launcher.escrow()), ESCROW);
        assertLt(address(launcher).code.length, 24_576, "under the size limit");
    }

    function test_fork_aMakerLaunchesAnAgentsCoinOnTheRealPons() public {
        uint256 gasUsed = _launch(0.01 ether);
        emit log_named_uint("gas of a launch with an opening buy", gasUsed);
        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(address(coin));
        assertTrue(info.exists);
        assertEq(info.deployer, address(launcher));
        assertEq(info.creatorFeeRecipient, address(splitter));
        assertEq(info.creatorTaxBps, 300);
        assertEq(info.pairToken, address(0));
        assertFalse(info.buybackEnabled);
        assertEq(coin.name(), "Fork Smith");
        assertEq(coin.symbol(), "FSMITH");
        assertEq(coin.logo(), "https://factoragents.fun/api/v1/coins/logo/fork-smith");
        assertEq(curve.deployer(), address(splitter), "the curve pays its fees to the splitter");
        assertEq(splitter.curve(), address(curve));
        assertTrue(curve.snipeTaxExempt(maker), "the maker");
        assertTrue(curve.snipeTaxExempt(agentW), "the agent");
        assertFalse(curve.snipeTaxExempt(stranger));
        assertEq(curve.currentSnipeTaxBps(stranger), 9900, "anyone else pays 99% in the launch second");
        assertGt(coin.balanceOf(maker), 0, "the opening buy is the maker's");
        assertEq(coin.balanceOf(address(launcher)), 0);
        assertEq(address(launcher).balance, 0);
        assertEq(maker.balance, 0);

        // untaxed: the same ETH bought ten minutes later by somebody on no list gets as many tokens
        uint256 got = coin.balanceOf(maker);
        (address twinAgent, uint256 twinKey) = makeAddrAndKey("twin agent");
        vm.prank(twinAgent);
        IDeskRegister(DESK).register();
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams(keccak256("twin"));
        bytes memory sig = _sig(twinKey, launcher.permissionDigest(twinAgent, maker, p, 0, block.timestamp + 1 hours));
        uint256 fee = _pons().launchFee();
        vm.deal(maker, fee);
        vm.prank(maker);
        address t = launcher.launch{value: fee}(twinAgent, maker, p, 0, block.timestamp + 1 hours, sig);
        vm.warp(block.timestamp + 10 minutes);
        vm.prank(buyer);
        uint256 later = ICurveX(_pons().getLaunchedToken(t).curve).buy{value: 0.01 ether}(0.01 ether, 0, buyer);
        assertEq(got, later, "the opening buy paid the ordinary price and no launch tax");
        assertEq(launcher.coinCount(), 2);
    }

    /// Nobody can move a coin's fees afterwards: not the maker, the agent, the launcher, the splitter's owner (it
    /// has none) or a stranger.
    function test_fork_aCoinsFeeAddressIsLockedForGood() public {
        _launch(0);
        address[5] memory who = [maker, agentW, address(launcher), ADMIN, stranger];
        for (uint256 i = 0; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert();
            IFactoryX(FACTORY).transferCreatorFeeRecipient(address(coin), who[i]);
            vm.prank(who[i]);
            vm.expectRevert();
            IFactoryX(FACTORY).setCreatorFeeRecipient(address(coin), who[i]);
            vm.prank(who[i]);
            vm.expectRevert();
            IFactoryX(FACTORY).setBuybackEnabled(address(coin), true);
        }
        assertEq(_pons().getLaunchedToken(address(coin)).creatorFeeRecipient, address(splitter));
    }

    function test_fork_aStrangerAndASecondCoinAreRefused() public {
        uint256 fee = _pons().launchFee();
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(AgentCoinLauncher.NotAllowed.selector);
        launcher.launch{value: fee}(agentW, maker, _coinParams(keccak256("s")), 0, block.timestamp + 1, "");
        _launch(0);
        vm.deal(agentW, fee);
        vm.prank(agentW);
        vm.expectRevert(abi.encodeWithSelector(AgentCoinLauncher.AlreadyLaunched.selector, address(coin)));
        launcher.launch{value: fee}(agentW, maker, _coinParams(keccak256("again")), 0, 0, "");
    }

    /// The four shares, to the wei, into the live wallets; then the live burn pot buys $FACTOR with its share and
    /// burns it, and $FACTOR's supply falls by exactly what was burned.
    function test_fork_tradingFeesSplitFourWaysToTheWeiAndBurnFactor() public {
        _launch(0);
        vm.warp(t0 + 10);
        vm.prank(buyer);
        curve.buy{value: 1 ether}(1 ether, 0, buyer);
        uint256 gw = GATEWAY.balance;
        uint256 ad = ADMIN.balance;
        uint256 pot = BURN_POT.balance;
        uint256 mk = maker.balance;

        vm.prank(stranger);
        vm.expectRevert();
        curve.sweepFees(0);

        vm.prank(stranger);
        uint256 amount = splitter.sweep();
        assertEq(amount, 0.037 ether, "the 3% tax and 70% of Pons' 1% base fee");
        assertEq(GATEWAY.balance - gw, 0.0148 ether, "the agent's compute");
        assertEq(maker.balance - mk, 0.0074 ether, "the maker");
        assertEq(ADMIN.balance - ad, 0.0074 ether, "the owner");
        assertEq(BURN_POT.balance - pot, 0.0074 ether, "the burn");
        assertEq(address(splitter).balance, 0);
        assertEq(splitter.totalComputePaid(), 0.0148 ether);

        // sells pay too, and a sweep with nothing new does nothing
        uint256 held = coin.balanceOf(buyer);
        vm.startPrank(buyer);
        coin.approve(address(curve), held);
        curve.sell(held / 2, 0, buyer);
        vm.stopPrank();
        assertGt(splitter.sweep(), 0);
        assertEq(splitter.sweep(), 0);

        // the live burn pot buys $FACTOR with what it holds and burns it
        vm.warp(block.timestamp + 1 days);
        FactorBurnPot p = FactorBurnPot(BURN_POT);
        uint256 supply = IPonsToken(FACTOR).totalSupply();
        (uint256 ethIn, uint256 burned) = p.burn(0);
        assertGt(ethIn, 0);
        assertGt(burned, 0);
        assertEq(supply - IPonsToken(FACTOR).totalSupply(), burned, "$FACTOR's supply fell by exactly that");
    }

    /// After graduation the pool's fees reach the escrow when Pons' keeper releases them, and the sweep splits them.
    function test_fork_afterGraduationTheKeepersReleaseIsSplit() public {
        _launch(0);
        vm.warp(t0 + 10);
        _graduate(address(coin), address(curve), buyer);
        splitter.sweep();
        assertEq(splitter.curve(), address(0));
        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(address(coin));
        PoolKey memory key = PoolKey({
            currency0: address(0),
            currency1: address(coin),
            fee: info.poolFee,
            tickSpacing: info.tickSpacing,
            hooks: HOOK
        });
        PoolSwapper swapper = new PoolSwapper(IPoolManager(POOL_MANAGER), key);
        vm.deal(address(swapper), 2 ether);
        uint256 got = swapper.buy(1 ether);
        swapper.sell(got / 2);
        assertEq(splitter.sweep(), 0, "with Pons until its keeper moves them");
        vm.warp(block.timestamp + 1 hours);
        assertTrue(_keeperSweepsPool(keccak256(abi.encode(key))));
        uint256 owed = escrow.balanceOf(address(splitter));
        assertGt(owed, 0);
        uint256 gw = GATEWAY.balance;
        assertEq(splitter.sweep(), owed);
        assertEq(GATEWAY.balance - gw, (owed * 4000) / 10_000);
    }

    /// A credit in the coin itself in Pons' real escrow: claimed and burned, and the coin's supply falls by that.
    function test_fork_coinsCreditedInTheEscrowAreBurned() public {
        _launch(0);
        vm.warp(t0 + 10);
        vm.prank(buyer);
        uint256 got = curve.buy{value: 0.5 ether}(0.5 ether, 0, buyer);
        assertEq(splitter.claimToken(), 0, "nothing owed, nothing done");
        vm.startPrank(buyer);
        coin.approve(ESCROW, got / 2);
        escrow.creditToken(address(splitter), address(coin), got / 2);
        coin.transfer(address(splitter), got / 4);
        vm.stopPrank();
        uint256 supply = coin.totalSupply();
        assertEq(splitter.claimToken(), got / 2 + got / 4);
        assertEq(supply - coin.totalSupply(), got / 2 + got / 4);
        assertEq(coin.balanceOf(address(splitter)), 0);
    }

    /// An agent made on the site is a Factor account: its key signs, the live account answers ERC-1271.
    function test_fork_anAgentThatIsALiveAccountSigns() public {
        (address program, uint256 programKey) = makeAddrAndKey("fork account key");
        FactorAccount.Key memory k =
            FactorAccount.Key(FactorAccount.Kind.Wallet, bytes32(uint256(uint160(program))), bytes32(0));
        FactorAccount acct = FactorAccount(payable(FactorAccounts(ACCOUNTS).create(k, "")));
        FactorAccount.Call[] memory c = new FactorAccount.Call[](1);
        c[0] = FactorAccount.Call(DESK, 0, abi.encodeCall(IDeskRegister.register, ()));
        vm.prank(program);
        acct.run(c);
        IPonsV2LaunchFactory.TokenParams memory p = _coinParams(keccak256("account"));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(programKey, launcher.permissionDigest(address(acct), maker, p, 0, deadline));
        uint256 fee = _pons().launchFee();
        vm.deal(maker, fee);
        vm.prank(maker);
        address t = launcher.launch{value: fee}(address(acct), maker, p, 0, deadline, sig);
        assertEq(launcher.agentOf(t), address(acct));
    }
}
