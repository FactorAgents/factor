// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FactorTest} from "../FactorTest.sol";
import {FactorLine} from "../../src/FactorLine.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorBounty} from "../../src/FactorBounty.sol";
import {BountyHandler} from "./BountyHandler.sol";

/// The bounty's rules that must hold whatever anybody does, in whatever order, beside the desk. The handler does the
/// doing and checks each payout as it happens; each function here is one rule, checked after every step.
contract BountyInvariantTest is FactorTest {
    BountyHandler internal handler;
    FactorBounty internal b;

    function setUp() public override {
        super.setUp();
        b = new FactorBounty(desk, new FactorLine(desk));
        handler = new BountyHandler(desk, b);
        vm.deal(address(this), 5 ether);
        (bool ok,) = address(desk).call{value: 2 ether}("");
        assertTrue(ok);
        targetContract(address(handler));
        bytes4[] memory moves = new bytes4[](17);
        moves[0] = BountyHandler.post.selector;
        moves[1] = BountyHandler.enter.selector;
        moves[2] = BountyHandler.enter.selector; // more than one entry on most bounties
        moves[3] = BountyHandler.enter.selector;
        moves[4] = BountyHandler.pick.selector;
        moves[5] = BountyHandler.deliver.selector;
        moves[6] = BountyHandler.deliver.selector;
        moves[7] = BountyHandler.decline.selector;
        moves[8] = BountyHandler.draw.selector;
        moves[9] = BountyHandler.deskCloses.selector;
        moves[10] = BountyHandler.returnBonds.selector;
        moves[11] = BountyHandler.close.selector;
        moves[12] = BountyHandler.close.selector;
        moves[13] = BountyHandler.collect.selector;
        moves[14] = BountyHandler.warp.selector;
        moves[15] = BountyHandler.pick.selector; // most bounties get a pick
        moves[16] = BountyHandler.pick.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: moves}));
    }

    /// The books as they should be, worked out bounty by bounty from what each one is.
    function _worked() internal view returns (uint256 held, uint256 bonds, uint256 atDesk, uint256 backHere) {
        uint256 n = b.bountyCount();
        for (uint256 id = 1; id <= n; ++id) {
            FactorBounty.Bounty memory x = b.bounty(id);
            uint256 count = b.entrants(id).length;
            if (x.state == FactorBounty.State.Open) {
                held += x.prize + x.fee;
                bonds += x.bond * count;
            } else if (x.state == FactorBounty.State.Picked) {
                atDesk += x.prize;
                bonds += x.bondsBack ? x.bond : x.bond * count;
                FactorDesk.State s = desk.job(x.job).state;
                if (s == FactorDesk.State.Refunded || s == FactorDesk.State.Declined) backHere += x.prize;
            }
        }
    }

    /// Nothing the handler saw was against the rulebook.
    function invariant_everyMoveKeptTheRules() public view {
        assertFalse(handler.wrong(), handler.why());
    }

    /// The contract holds exactly its books: open prizes and fees, entry bonds, what it owes wallets, and any prize the
    /// desk has paid back that has not been closed yet.
    function invariant_theBalanceIsExactlyTheBooks() public view {
        (,,, uint256 backHere) = _worked();
        assertEq(address(b).balance, b.held() + b.bonds() + b.owedTotal() + backHere);
    }

    /// Each of the books is exactly the sum of what every bounty should have there.
    function invariant_eachBookIsTheSumOfItsBounties() public view {
        (uint256 held, uint256 bonds, uint256 atDesk,) = _worked();
        assertEq(b.held(), held, "held");
        assertEq(b.bonds(), bonds, "bonds");
        assertEq(b.atDesk(), atDesk, "at the desk");
    }

    /// Every prize ever posted is open, on the desk, paid, split or returned, and nowhere twice.
    function invariant_everyPrizeIsSomewhereOnce() public view {
        (uint256 held, , uint256 atDesk,) = _worked();
        uint256 openPrizes;
        uint256 n = b.bountyCount();
        for (uint256 id = 1; id <= n; ++id) {
            FactorBounty.Bounty memory x = b.bounty(id);
            if (x.state == FactorBounty.State.Open) openPrizes += x.prize;
        }
        assertLe(openPrizes, held);
        assertEq(b.totalPrizes(), openPrizes + atDesk + b.totalWon() + b.totalSplit() + b.totalReturned());
    }

    /// A bounty that picked has a job of its own, and that job points back; nothing else has one.
    function invariant_oneJobPerPick() public view {
        uint256 n = b.bountyCount();
        for (uint256 id = 1; id <= n; ++id) {
            FactorBounty.Bounty memory x = b.bounty(id);
            if (x.job != 0) {
                assertEq(b.bountyOfJob(x.job), id);
                assertEq(desk.job(x.job).customer, address(b));
                assertEq(desk.job(x.job).price, x.prize);
                assertFalse(desk.job(x.job).allowEarly);
            }
            assertLe(b.entrants(id).length, b.MAX_ENTRIES());
        }
    }

    /// The contract never rejects: no prize ever settles at half.
    function invariant_noPrizeSettlesAtHalf() public view {
        uint256 n = b.bountyCount();
        for (uint256 id = 1; id <= n; ++id) {
            uint256 job = b.bounty(id).job;
            if (job != 0) assertTrue(desk.job(job).state != FactorDesk.State.SettledAtHalf);
        }
    }

    /// The desk's books are untouched by all of it.
    function invariant_theDeskStillHoldsItsBooks() public view {
        assertEq(address(desk).balance, desk.pool() + desk.held() + desk.bonds() + desk.owedTotal());
    }

    /// Nothing stuck: run time far forward, have everybody do what is open to them, and every bounty ends with no ETH in
    /// the contract but what wallets refused. This runs at the end of every sequence.
    function afterInvariant() external {
        vm.warp(block.timestamp + 31 days);
        vm.warp(block.timestamp + 4 days);
        uint256 n = b.bountyCount();
        // a winner that delivered with a wrong hash settles by the desk's clock; a job with no delivery is refunded
        for (uint256 id = 1; id <= n; ++id) {
            FactorBounty.State s = b.bounty(id).state;
            if (s == FactorBounty.State.Open || s == FactorBounty.State.Picked) b.close(id);
        }
        for (uint256 id = 1; id <= n; ++id) {
            FactorBounty.State s = b.bounty(id).state;
            assertTrue(s != FactorBounty.State.Open && s != FactorBounty.State.Picked, "every bounty can be ended by anyone");
        }
        assertEq(b.held(), 0, "nothing held");
        assertEq(b.bonds(), 0, "no bond out");
        assertEq(b.atDesk(), 0, "nothing at the desk");
        assertEq(address(b).balance, b.owedTotal(), "all that is left is what wallets refused");
        assertEq(b.totalPrizes(), b.totalWon() + b.totalSplit() + b.totalReturned(), "every prize ended once");
        console.log(
            "posts %s, entries %s, picks %s", handler.posts(), handler.entered(), handler.picks()
        );
        console.log(
            "won %s, unpicked %s, undelivered %s", handler.won(), handler.unpicked(), handler.undelivered()
        );
        console.log("empty %s, delivered %s, declined %s", handler.empty(), handler.delivered(), handler.declined());
    }
}
