// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, ICurveX, IFactoryX, IPonsToken} from "./ForkBase.sol";
import {PoolSwapper} from "./PoolSwapper.sol";
import {FactorBurnPot} from "../../src/FactorBurnPot.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorSplitter} from "../../src/FactorSplitter.sol";
import {IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "../../src/interfaces/IPons.sol";
import {IPoolManager, PoolKey} from "../../src/interfaces/IPoolManager.sol";

interface IChainlink {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Factor against the real Pons, on a fork of Robinhood Chain: the token is launched through the real launch
/// factory, traded on the real bonding curve and the real Uniswap v4 pool, and its fees come through the real
/// fee escrow.
contract FactorForkTest is ForkBase {
    IPonsV2FeeEscrow constant escrow = IPonsV2FeeEscrow(ESCROW);

    address admin = makeAddr("factor admin");
    address gateway = makeAddr("factor gateway");
    address buyer = makeAddr("factor buyer");
    address stranger = makeAddr("factor stranger");

    FactorBurnPot burnPot;
    FactorSplitter splitter;
    FactorDesk desk;

    IPonsToken token;
    ICurveX curve;
    uint256 t0; // the launch

    function setUp() public {
        _fork();
        Factor memory h = _deployFactor(address(this), admin, gateway, _pons());
        _verifyFactor(h, admin, gateway, _pons());
        (burnPot, splitter, desk) = (h.burnPot, h.splitter, h.desk);
        vm.deal(buyer, 1000 ether);
    }

    // ---------- helpers ----------

    /// A dollar amount of ETH at Chainlink's price on the fork, the way contracts/launch.sh sizes the opening buy
    /// from the openingBuyUsd in contracts/launch.json (which is checked to be the amount asked for here).
    function _usd(uint256 usd) internal view returns (uint256) {
        assertEq(vm.parseJsonUint(vm.readFile("launch.json"), ".openingBuyUsd"), usd);
        (, int256 price,,,) = IChainlink(ETH_USD_FEED).latestRoundData();
        return (usd * 1e26) / uint256(price);
    }

    function _launch(uint256 openingBuy) internal {
        uint256 fee = _pons().launchFee();
        vm.deal(admin, fee + openingBuy);
        vm.prank(admin);
        address t = burnPot.launch{value: fee + openingBuy}(_params(keccak256("factor-fork")), 0, new address[](0));
        token = IPonsToken(t);
        curve = ICurveX(_pons().getLaunchedToken(t).curve);
        t0 = block.timestamp;
    }

    function _buy(address who, uint256 eth) internal returns (uint256 got) {
        vm.prank(who);
        got = curve.buy{value: eth}(eth, 0, who);
    }

    function _poolKey() internal view returns (PoolKey memory) {
        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(address(token));
        return PoolKey({
            currency0: address(0),
            currency1: address(token),
            fee: info.poolFee,
            tickSpacing: info.tickSpacing,
            hooks: HOOK
        });
    }

    // ---------- the facts everything else rests on ----------

    /// A Pons token has burn(uint256) and burnFrom(address,uint256), and both make totalSupply() fall. Checked on
    /// a token somebody else launched on the live chain the day this was written, and on one launched through
    /// the live factory in this test, so it is the factory's current token code.
    function test_fork_ponsTokensBurnAndTheSupplyFalls() public {
        // a real token and a real holder of it: its curve, or the pool once it has graduated
        IPonsToken live = IPonsToken(LIVE_TOKEN);
        assertTrue(_pons().getLaunchedToken(LIVE_TOKEN).exists, "it is a Pons launch");
        address holder = _pons().getLaunchedToken(LIVE_TOKEN).curve;
        if (live.balanceOf(holder) == 0) holder = POOL_MANAGER;
        uint256 held = live.balanceOf(holder);
        assertGt(held, 0, "found a holder");
        uint256 supply = live.totalSupply();
        vm.prank(holder);
        live.burn(held / 1000);
        assertEq(supply - live.totalSupply(), held / 1000, "burn(uint256) lowered totalSupply by exactly that");
        assertEq(live.balanceOf(holder), held - held / 1000);

        // and the one this test launches
        _launch(0.05 ether);
        assertEq(token.totalSupply(), 1_000_000_000e18);
        uint256 mine = token.balanceOf(admin);
        vm.prank(admin);
        token.burn(mine / 4);
        assertEq(token.totalSupply(), 1_000_000_000e18 - mine / 4);
        // burnFrom: against an allowance, which it spends
        vm.prank(admin);
        token.approve(stranger, mine / 4);
        vm.prank(stranger);
        token.burnFrom(admin, mine / 8);
        assertEq(token.totalSupply(), 1_000_000_000e18 - mine / 4 - mine / 8);
        assertEq(token.allowance(admin, stranger), mine / 4 - mine / 8);
        vm.prank(stranger);
        vm.expectRevert();
        token.burnFrom(admin, mine / 4); // more than is left of the allowance
        assertEq(token.balanceOf(0x000000000000000000000000000000000000dEaD), 0);
    }

    /// A Pons token has no EIP-2612 permit: none of its three functions exist. Nobody can be given a spending right
    /// over the admin's tokens by a signature alone.
    function test_fork_ponsTokensHaveNoPermit() public {
        _launch(0.05 ether);
        address[2] memory tokens = [address(token), LIVE_TOKEN];
        for (uint256 i = 0; i < tokens.length; ++i) {
            (bool ok,) = tokens[i].staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
            assertFalse(ok, "no DOMAIN_SEPARATOR()");
            (ok,) = tokens[i].staticcall(abi.encodeWithSignature("nonces(address)", admin));
            assertFalse(ok, "no nonces(address)");
            (ok,) = tokens[i].staticcall(abi.encodeWithSignature("eip712Domain()"));
            assertFalse(ok, "no eip712Domain()");
            (ok,) = tokens[i].call(
                abi.encodeWithSignature(
                    "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
                    admin,
                    address(burnPot),
                    1,
                    block.timestamp + 1 hours,
                    uint8(27),
                    bytes32(uint256(1)),
                    bytes32(uint256(1))
                )
            );
            assertFalse(ok, "no permit(...)");
        }
        // nor anything that makes new tokens or names an owner
        (bool minted,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", admin, 1));
        assertFalse(minted, "no mint");
        (bool owned,) = address(token).staticcall(abi.encodeWithSignature("owner()"));
        assertFalse(owned, "no owner");
    }

    // ---------- the launch ----------

    function test_fork_theLaunchIsWhatThePotForces() public {
        _launch(0.05 ether);
        IPonsV2LaunchFactory.LaunchedToken memory info = _pons().getLaunchedToken(address(token));
        assertTrue(info.exists);
        assertEq(info.deployer, address(burnPot), "the burn pot is the launch's deployer");
        assertEq(info.creatorFeeRecipient, address(splitter), "fees are aimed at the splitter");
        assertEq(info.creatorTaxBps, 300, "3%");
        assertEq(info.pairToken, address(0), "paired with ETH");
        assertFalse(info.buybackEnabled);
        assertEq(uint8(info.phase), 0);
        assertEq(token.name(), "Factor");
        assertEq(token.symbol(), "FACTOR");
        assertEq(token.logo(), "https://factoragents.fun/factor.png", "the metadata is on chain, set in the launch");
        assertEq(curve.deployer(), address(splitter), "the curve pays its fees to the splitter");
        assertEq(address(burnPot.token()), address(token));
        assertEq(burnPot.startedAt(), t0);
        assertEq(splitter.curve(), address(curve));

        assertTrue(curve.snipeTaxExempt(address(burnPot)), "the pot is exempt as the deployer");
        assertTrue(curve.snipeTaxExempt(address(splitter)), "the splitter as the fee recipient");
        assertTrue(curve.snipeTaxExempt(admin), "the admin because the pot put it on the list");
        assertFalse(curve.snipeTaxExempt(stranger));
        assertEq(curve.currentSnipeTaxBps(stranger), 9900, "anyone else pays 99% in the launch second");
    }

    /// The opening buy: $30 of ETH in the launch transaction. The tokens are in the admin wallet, all of them,
    /// and no launch-seconds tax was taken from them.
    function test_fork_theOpeningBuyLandsWholeInTheAdminWallet() public {
        uint256 eth = _usd(30);
        emit log_named_decimal_uint("opening buy, ETH", eth, 18);
        vm.deal(address(burnPot), 1 ether); // the pot's own ETH must not pay for it
        _launch(eth);
        uint256 got = token.balanceOf(admin);
        emit log_named_decimal_uint("tokens bought", got, 18);
        emit log_named_decimal_uint("percent of supply (x100)", (got * 10_000) / 1_000_000_000e18, 2);
        assertEq(burnPot.openingBuyTokens(), got, "the pot wrote down exactly what arrived");
        assertEq(burnPot.openingBuyEth(), eth);
        assertEq(token.balanceOf(address(burnPot)), 0);
        assertEq(address(burnPot).balance, 1 ether, "the pot's own ETH is untouched");
        assertEq(admin.balance, 0, "the admin paid the fee and the buy, nothing else");
        assertEq(token.totalSupply() - token.balanceOf(address(curve)) - got, 0, "nobody else holds a token yet");

        // untaxed: an identical launch where the same ETH is bought ten minutes later, by somebody who is not on
        // any list and pays no launch-seconds tax, gets exactly the same number of tokens
        Factor memory twin = _deployFactor(address(this), admin, gateway, _pons());
        uint256 fee = _pons().launchFee();
        vm.deal(admin, fee);
        vm.prank(admin);
        address t = twin.burnPot.launch{value: fee}(_params(keccak256("factor-twin")), 0, new address[](0));
        vm.warp(block.timestamp + 10 minutes);
        vm.prank(buyer);
        uint256 later = ICurveX(_pons().getLaunchedToken(t).curve).buy{value: eth}(eth, 0, buyer);
        assertEq(got, later, "the opening buy paid the ordinary price and no launch tax");
    }

    function test_fork_onlyTheAdminLaunchesAndOnlyOnce() public {
        uint256 fee = _pons().launchFee();
        vm.deal(stranger, fee);
        vm.prank(stranger);
        vm.expectRevert(FactorBurnPot.NotAdmin.selector);
        burnPot.launch{value: fee}(_params(keccak256("x")), 0, new address[](0));
        vm.deal(admin, fee);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FactorBurnPot.LaunchFeeShort.selector, fee));
        burnPot.launch{value: fee - 1}(_params(keccak256("x")), 0, new address[](0));
        _launch(0);
        vm.deal(admin, fee);
        vm.prank(admin);
        vm.expectRevert(FactorBurnPot.TokenAlreadySet.selector);
        burnPot.launch{value: fee}(_params(keccak256("y")), 0, new address[](0));
    }

    /// Where the fees go cannot be changed afterwards by anybody: not the admin, not the pot's own address, not a
    /// stranger. Pons lets only the current fee recipient move it, and the splitter has no function that does.
    function test_fork_theFeeAddressIsLockedForGood() public {
        _launch(0);
        address[4] memory who = [admin, buyer, stranger, address(burnPot)];
        for (uint256 i = 0; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert();
            IFactoryX(FACTORY).transferCreatorFeeRecipient(address(token), who[i]);
            vm.prank(who[i]);
            vm.expectRevert();
            IFactoryX(FACTORY).setCreatorFeeRecipient(address(token), who[i]);
            vm.prank(who[i]);
            vm.expectRevert();
            IFactoryX(FACTORY).setBuybackEnabled(address(token), true);
        }
        assertEq(_pons().getLaunchedToken(address(token)).creatorFeeRecipient, address(splitter));
    }

    /// Somebody launches their own token with its fees aimed at our splitter before we launch. The pot cannot be
    /// made to adopt it: its token is the one it launches itself and no other.
    function test_fork_aDecoyTokenCannotBeAdopted() public {
        (address decoy,) = _launchDirect(stranger, address(splitter), 300, false, keccak256("decoy"));
        assertEq(_pons().getLaunchedToken(decoy).creatorFeeRecipient, address(splitter));
        (bool ok,) = address(burnPot).call(abi.encodeWithSignature("setToken(address)", decoy));
        assertFalse(ok);
        assertEq(address(burnPot.token()), address(0));
        _launch(0);
        assertTrue(address(token) != decoy);
        // fees the decoy earns are ETH like any other and split the same way; nothing else about it reaches us
        assertEq(splitter.curve(), address(curve), "the splitter sweeps the real token's curve");
    }

    // ---------- fees ----------

    function test_fork_tradingFeesSplitThreeWaysToTheWei() public {
        _launch(0);
        vm.warp(t0 + 10);
        _buy(buyer, 1 ether);
        assertEq(escrow.balanceOf(address(splitter)), 0, "the fees are still on the curve");

        // only the fee recipient or Pons' keeper may release them, which is why sweep() lives on the splitter
        vm.prank(stranger);
        vm.expectRevert();
        curve.sweepFees(0);

        vm.prank(stranger);
        uint256 amount = splitter.sweep();
        assertEq(amount, 0.037 ether, "the 3% tax and 70% of Pons' 1% base fee");
        assertEq(admin.balance, 0.0259 ether, "70%");
        assertEq(address(burnPot).balance, 0.0074 ether, "20%");
        assertEq(address(desk).balance, 0.0037 ether, "10%, in the desk");
        assertEq(desk.pool(), 0.0037 ether, "where it is the pool that advances agents");
        assertEq(address(splitter).balance, 0);
        assertEq(escrow.balanceOf(address(splitter)), 0);

        // sells pay too, and with nothing new it is a no-op that never reverts
        uint256 held = token.balanceOf(buyer);
        vm.startPrank(buyer);
        token.approve(address(curve), held);
        curve.sell(held / 2, 0, buyer);
        vm.stopPrank();
        assertGt(splitter.sweep(), 0);
        assertEq(splitter.sweep(), 0);
    }

    function test_fork_ponsKeeperCanReleaseTheCurveTooAndClaimStillSplits() public {
        _launch(0);
        vm.warp(t0 + 10);
        _buy(buyer, 1 ether);
        vm.prank(FEE_SWEEP_OPERATOR);
        curve.sweepFees(0);
        assertEq(escrow.balanceOf(address(splitter)), 0.037 ether);
        assertEq(splitter.claim(), 0.037 ether);
        assertEq(admin.balance, 0.0259 ether);
    }

    /// After graduation the pool's fees are held by Pons' hook until Pons' keeper releases them, in ETH, late and
    /// in lumps. The splitter cannot hurry that. This runs the keeper's real release on the fork.
    function test_fork_afterGraduationFeesArriveWhenPonsReleasesThem() public {
        _launch(0);
        vm.warp(t0 + 10);
        _graduate(address(token), address(curve), buyer);
        splitter.sweep(); // what graduation itself released
        assertEq(splitter.curve(), address(0), "no curve to sweep any more");
        uint256 adminBefore = admin.balance;

        // trades in the pool, both ways
        PoolKey memory key = _poolKey();
        PoolSwapper swapper = new PoolSwapper(IPoolManager(POOL_MANAGER), key);
        vm.deal(address(swapper), 2 ether);
        uint256 got = swapper.buy(1 ether);
        assertGt(got, 0);
        swapper.sell(got / 2);

        assertEq(splitter.sweep(), 0, "the pool's fees are with Pons until its keeper moves them");
        assertEq(escrow.balanceOf(address(splitter)), 0);
        assertEq(escrow.balanceOfToken(address(splitter), address(token)), 0);

        // an hour later, Pons' keeper
        vm.warp(block.timestamp + 1 hours);
        assertTrue(_keeperSweepsPool(keccak256(abi.encode(key))), "the keeper's release went through");
        uint256 owed = escrow.balanceOf(address(splitter));
        assertGt(owed, 0.03 ether, "the tax on the pool trades, in ETH");
        assertEq(escrow.balanceOfToken(address(splitter), address(token)), 0, "nothing is credited in tokens");

        vm.prank(stranger);
        assertEq(splitter.sweep(), owed);
        assertEq(admin.balance - adminBefore, (owed * 7000) / 10_000);
        assertEq(escrow.balanceOf(address(splitter)), 0);
    }

    /// Pons pays fees in ETH. Its escrow also keeps a ledger in tokens, which anybody with an approval can credit
    /// and whose claimToken() reverts when nothing is owed. If $FACTOR is ever credited there for the splitter,
    /// claimToken() takes it out of the real escrow and all of it lands in the burn pot.
    function test_fork_aTokenCreditInTheEscrowGoesToTheBurnPot() public {
        _launch(0);
        vm.warp(t0 + 10);
        uint256 got = _buy(buyer, 1 ether);

        // nothing owed: the real escrow would revert, the splitter does not ask it and does nothing
        vm.prank(address(splitter));
        (bool ok,) = ESCROW.call(abi.encodeCall(escrow.claimToken, (address(token))));
        assertFalse(ok, "the escrow's own claimToken reverts with nothing owed");
        assertEq(splitter.claimToken(), 0);

        vm.startPrank(buyer);
        token.approve(ESCROW, got / 2);
        escrow.creditToken(address(splitter), address(token), got / 2);
        vm.stopPrank();
        assertEq(escrow.balanceOfToken(address(splitter), address(token)), got / 2);

        vm.prank(stranger);
        assertEq(splitter.claimToken(), got / 2);
        assertEq(escrow.balanceOfToken(address(splitter), address(token)), 0);
        assertEq(token.balanceOf(address(splitter)), 0);
        assertEq(token.balanceOf(address(burnPot)), got / 2, "all of it, in the burn pot");

        // and the next burn destroys it
        splitter.sweep();
        vm.warp(t0 + 30 minutes);
        uint256 supply = token.totalSupply();
        (, uint256 burned) = burnPot.burn(0);
        assertGt(burned, got / 2);
        assertEq(supply - token.totalSupply(), burned);
        assertEq(token.balanceOf(address(burnPot)), 0);
    }

    // ---------- the burn ----------

    function test_fork_aBurnBuysOnTheCurveAndTheSupplyFalls() public {
        _launch(0);
        vm.deal(address(burnPot), 0.005 ether);

        // not in the launch seconds, and not for thirty minutes after: the pot is exempt from Pons' launch tax
        // anyway, and its own schedule keeps it out of that window
        assertEq(curve.currentSnipeTaxBps(address(burnPot)), 0);
        vm.expectRevert(abi.encodeWithSelector(FactorBurnPot.TooSoon.selector, t0 + 30 minutes));
        burnPot.burn(0);

        vm.warp(t0 + 30 minutes);
        uint256 supply = token.totalSupply();
        vm.prank(stranger);
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertEq(ethIn, 0.005 ether, "everything the pot held");
        assertGt(burned, 0);
        assertEq(supply - token.totalSupply(), burned, "total supply fell by exactly what was burned");
        assertEq(token.balanceOf(address(burnPot)), 0);
        assertEq(token.balanceOf(0x000000000000000000000000000000000000dEaD), 0);
        assertEq(burnPot.totalTokensBurned(), burned);
    }

    function test_fork_betweenGraduationAndThePoolThereIsNoBurnThenItBuysInThePool() public {
        _launch(0);
        vm.warp(t0 + 10);
        _buy(buyer, 10 ether); // buys the curve out
        assertEq(uint8(_pons().getLaunchedToken(address(token)).phase), 1, "graduated, no pool yet");
        vm.deal(address(burnPot), 0.005 ether);
        vm.warp(t0 + 1 hours);
        (uint256 amount,, bool ready) = burnPot.preview();
        assertEq(amount, 0.005 ether);
        assertFalse(ready);
        vm.expectRevert(FactorBurnPot.MarketNotReady.selector);
        burnPot.burn(0);

        IFactoryX(FACTORY).createGraduatedPool(address(token));
        (bool open, bool viaCurve, uint256 depthCap) = burnPot.market();
        assertTrue(open);
        assertFalse(viaCurve);
        emit log_named_decimal_uint("pool depth cap (1% of in-range ETH depth)", depthCap, 18);
        assertGt(depthCap, 0.01 ether);
        uint256 supply = token.totalSupply();
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertEq(ethIn, 0.005 ether);
        assertEq(supply - token.totalSupply(), burned, "burned through the pool: total supply fell by exactly that");
        assertEq(token.balanceOf(address(burnPot)), 0);
    }

    /// A burn that is the curve's last buy: the curve fills what it can and refunds the rest, and only what was
    /// really spent is counted.
    function test_fork_aBurnThatCrossesGraduationCountsOnlyWhatItSpent() public {
        _launch(0);
        vm.warp(t0 + 10);
        _buy(buyer, 4.35 ether);
        assertFalse(curve.readyToGraduate());
        vm.deal(address(burnPot), 96 ether);
        vm.warp(t0 + 1 hours);
        (uint256 planned,,) = burnPot.preview();
        uint256 before = address(burnPot).balance;
        uint256 supply = token.totalSupply();
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertEq(ethIn, before - address(burnPot).balance);
        assertLe(ethIn, planned);
        assertEq(supply - token.totalSupply(), burned);
        assertEq(burnPot.totalEthBurned(), ethIn);
    }

    function test_fork_tokensSentToThePotAreBurnedWithTheNextBurn() public {
        _launch(0);
        vm.warp(t0 + 10);
        uint256 got = _buy(buyer, 0.1 ether);
        vm.prank(buyer);
        token.transfer(address(burnPot), got / 2);
        vm.deal(address(burnPot), 0.01 ether);
        vm.warp(t0 + 1 hours);
        uint256 supply = token.totalSupply();
        (, uint256 burned) = burnPot.burn(0);
        assertGt(burned, got / 2);
        assertEq(supply - token.totalSupply(), burned);
    }

    // ---------- everything, in the order it will happen ----------

    struct Flow {
        uint256 opening; // the opening buy, wei
        uint256 bought; // the tokens it bought
        uint256 toBurn; // the burn pot's share of the first sweep
        uint256 supply; // total supply, followed step by step
    }

    /// One life of the system on the real Pons: deploy, launch with the $30 opening buy, trading, the fee split,
    /// a buy back and burn, then graduation, late fees released by Pons, and a burn in the pool.
    function test_fork_theWholeFlowEndToEnd() public {
        Flow memory f;
        f.opening = _usd(30);
        _launch(f.opening);
        f.bought = token.balanceOf(admin);
        f.supply = token.totalSupply();
        // what the page will say about the opening buy has to be true: under 3% of the supply
        assertLt(f.bought * 100, f.supply * 3, "the $30 opening buy is under 3% of the supply");
        emit log_named_decimal_uint("opening buy, tokens", f.bought, 18);

        _flowTradingAndFees(f);
        _flowBuyBackAndBurn(f);
        _flowGraduation(f);

        // and through all of it the opening buy's tokens sat in the admin wallet: no contract moved one of them
        assertEq(token.balanceOf(admin), f.bought);
        // the wallet can burn them itself with the token's own burn(), which is what contracts/burn-mine.sh sends
        uint256 supply = token.totalSupply();
        vm.prank(admin);
        token.burn(f.bought);
        assertEq(token.balanceOf(admin), 0);
        assertEq(supply - token.totalSupply(), f.bought, "the supply fell by exactly what the wallet burned");
        emit log_named_decimal_uint("total supply at the end", token.totalSupply(), 18);
    }

    /// Trading, and the fees it leaves: 70% to the admin, 10% to the desk's pool, the rest to the burn pot.
    function _flowTradingAndFees(Flow memory f) internal {
        vm.warp(t0 + 10);
        _buy(buyer, 1 ether);
        vm.prank(stranger);
        uint256 fees = splitter.sweep();
        // the opening buy paid the same fees as any trade: they are in this first sweep too
        assertApproxEqAbs(fees, ((1 ether + f.opening) * 37) / 1000, 2, "3.7% of everything traded so far");
        uint256 toAdmin = (fees * 7000) / 10_000;
        uint256 toPool = (fees * 1000) / 10_000;
        f.toBurn = fees - toAdmin - toPool;
        assertEq(admin.balance, toAdmin, "70% to the admin wallet");
        assertEq(address(desk).balance, toPool, "10% to the desk");
        assertEq(desk.pool(), toPool, "where it is the pool");
        assertEq(address(burnPot).balance, f.toBurn, "20% (and the rounding) to the burn pot");
    }

    function _flowBuyBackAndBurn(Flow memory f) internal {
        vm.warp(t0 + 30 minutes);
        vm.prank(stranger);
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertEq(ethIn, f.toBurn);
        assertEq(f.supply - token.totalSupply(), burned, "bought back and destroyed");
        f.supply -= burned;
    }

    /// Graduation, fees released late by Pons' keeper, a burn in the pool.
    function _flowGraduation(Flow memory) internal {
        _graduate(address(token), address(curve), buyer);
        splitter.sweep();
        PoolKey memory key = _poolKey();
        PoolSwapper swapper = new PoolSwapper(IPoolManager(POOL_MANAGER), key);
        vm.deal(address(swapper), 1 ether);
        swapper.buy(1 ether);
        vm.warp(block.timestamp + 1 hours);
        assertTrue(_keeperSweepsPool(keccak256(abi.encode(key))), "Pons' keeper released the pool's fees");
        uint256 potBefore = address(burnPot).balance;
        uint256 late = splitter.sweep();
        assertGt(late, 0);
        assertEq(address(burnPot).balance - potBefore, late - (late * 7000) / 10_000 - (late * 1000) / 10_000);
        uint256 supply = token.totalSupply();
        (uint256 ethIn, uint256 burned) = burnPot.burn(0);
        assertGt(ethIn, 0);
        assertEq(supply - token.totalSupply(), burned, "the pool burn lowered the supply too");
    }
}
