// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FactorTest} from "../FactorTest.sol";
import {FactorHandler} from "./FactorHandler.sol";

/// The rules that must hold whatever anybody does, in whatever order. The handler does the doing; each function
/// here is one rule, checked after every step of every run.
contract FactorInvariantTest is FactorTest {
    FactorHandler internal handler;
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    function setUp() public override {
        super.setUp();
        _launch(0.05 ether);
        handler = new FactorHandler(
            FactorHandler.Refs({
                burnPot: burnPot,
                desk: desk,
                splitter: splitter,
                factory: factory,
                pm: pm,
                escrow: escrow,
                token: token,
                curve: curve,
                admin: admin
            })
        );
        // Start with the buyers holding some $FACTOR, so the runs spend their steps on the rules.
        vm.warp(START + 1 minutes);
        for (uint8 i = 0; i < 3; ++i) {
            handler.trade(0.05 ether, i);
        }
        targetContract(address(handler));
    }

    /// The same rules, checked along one scripted month rather than a random walk, so that the slow things are
    /// certain to have happened under them: days of trading with a sweep and a burn each half hour of it, $FACTOR
    /// sent to the splitter and to the pot, the admin moving its own tokens, graduation, and the pool's fees
    /// arriving late and in lumps afterwards.
    function test_aScriptedMonthKeepsEveryRule() public {
        for (uint256 day = 0; day < 30; ++day) {
            if (day == 12) handler.graduate();
            for (uint256 slot = 0; slot < 6; ++slot) {
                handler.trade(uint96(0.02 ether + slot * 0.01 ether), uint8(slot));
                handler.lateFees(uint96(0.01 ether + day * 0.001 ether));
                handler.sweep();
                handler.wait(30 minutes);
                handler.burn(false);
                _everyRule();
            }
            if (day % 5 == 1) handler.giftFactor(uint8(day), uint96(1000e18), day % 2 == 0);
            if (day % 7 == 3) handler.adminMovesTokens(uint96(10_000e18), day % 2 == 0);
            if (day % 4 == 2) handler.giftSplitter(uint64(0.3 ether));
            if (day % 9 == 4) handler.forceSplitter(uint64(0.05 ether));
            handler.distribute();
            handler.wait(20 hours);
            handler.burn(true);
            _everyRule();
        }
        assertGt(burnPot.burnCount(), 60, "it burned through the whole month");
        assertGt(splitter.totalToAdmin(), 0);
        assertLt(token.totalSupply(), SUPPLY);
    }

    function _everyRule() internal view {
        invariant_splitterSharesSumToWhatCameIn();
        invariant_onlyTheAdminMovesTheAdminsTokens();
        invariant_burnPotOnlyBuysAndBurns();
        invariant_supplyOnlyFallsByBurns();
        invariant_theSplitterKeepsNoFactor();
    }

    // ---------- the splitter ----------

    /// The two shares always sum to what came in, and the admin never has more than 70% of it.
    function invariant_splitterSharesSumToWhatCameIn() public view {
        assertEq(
            splitter.totalToAdmin() + splitter.totalToBurn() + splitter.totalToPool(),
            splitter.totalSplit(),
            "three shares, one whole"
        );
        assertLe(splitter.totalToAdmin() * 10_000, splitter.totalSplit() * 7000, "admin at most 70%");
        assertGe(splitter.totalToBurn() * 10_000, splitter.totalSplit() * 2000, "burn at least 20%");
        assertLe(splitter.totalToPool() * 10_000, splitter.totalSplit() * 1000, "pool at most 10%");
        assertFalse(handler.splitMismatch(), "every single split was exact");
        // both destinations here accept ETH, so nothing is ever left waiting
        assertEq(splitter.adminPending() + splitter.burnPending(), 0);
        assertEq(address(splitter).balance, splitter.unsplit());
    }

    /// $FACTOR never rests in the splitter and is never split: whatever reaches it goes whole to the burn pot.
    function invariant_theSplitterKeepsNoFactor() public view {
        assertEq(token.balanceOf(address(splitter)), 0);
    }

    // ---------- the admin's own tokens ----------

    /// The opening buy's tokens are in the admin wallet and no contract here can move them: the wallet's balance
    /// is what it began with, plus what it was sent, less what it sent itself. No contract holds an approval.
    function invariant_onlyTheAdminMovesTheAdminsTokens() public view {
        assertEq(
            token.balanceOf(admin) + handler.adminMoved(),
            handler.adminTokensAtStart() + handler.adminGot(),
            "nothing but the admin itself moved the admin's tokens"
        );
        assertEq(token.allowance(admin, address(burnPot)), 0);
        assertEq(token.allowance(admin, address(splitter)), 0);
    }

    // ---------- the burn pot, and the supply as a whole ----------

    /// ETH only leaves the burn pot into a buy, and every token it bought was destroyed.
    function invariant_burnPotOnlyBuysAndBurns() public view {
        assertEq(address(burnPot).balance, handler.burnEthIn() - burnPot.totalEthBurned(), "ETH in, less ETH spent");
        assertEq(burnPot.totalTokensBurned(), handler.potSupplyDrop(), "what it says it burned left the supply");
        assertFalse(handler.burnMismatch());
        assertEq(token.balanceOf(0x000000000000000000000000000000000000dEaD), 0, "nothing parked at a dead address");
    }

    /// The supply is the billion at launch less what the burn pot destroyed. Nothing else changes it.
    function invariant_supplyOnlyFallsByBurns() public view {
        assertEq(token.totalSupply(), SUPPLY - burnPot.totalTokensBurned());
        assertLe(token.totalSupply(), handler.supplyAtStart());
    }
}
