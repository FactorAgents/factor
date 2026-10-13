// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FactorBurnPot} from "../../src/FactorBurnPot.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorSplitter} from "../../src/FactorSplitter.sol";
import {IPonsV2LaunchFactory} from "../../src/interfaces/IPons.sol";
import {PoolKey} from "../../src/interfaces/IPoolManager.sol";
import {ForceSend} from "../mocks/Actors.sol";
import {MockCurve, MockEscrow, MockFactory, MockFactorToken, MockPoolManager} from "../mocks/MockPons.sol";

/// Everything anybody can do to the two contracts, in any order the fuzzer likes: trades and fee sweeps, gifts and
/// forced ETH, $FACTOR sent to the splitter or the pot, time passing, the admin moving its own tokens, burns and
/// graduation. It keeps its own books beside the contracts' so the invariants can compare the two.
contract FactorHandler is Test {
    struct Refs {
        FactorBurnPot burnPot;
        FactorDesk desk;
        FactorSplitter splitter;
        MockFactory factory;
        MockPoolManager pm;
        MockEscrow escrow;
        MockFactorToken token;
        MockCurve curve;
        address admin;
    }

    Refs internal r;
    address[3] public buyers;

    // ---- the handler's own books ----
    uint256 public burnEthIn; // every wei that reached the burn pot, by any road
    uint256 public potSupplyDrop; // tokens the pot's burns destroyed, as the handler saw the supply fall
    uint256 public adminMoved; // tokens the admin itself sent out of its wallet
    uint256 public adminGot; // tokens that came back to it
    uint256 public adminTokensAtStart;
    uint256 public supplyAtStart;
    bool public graduated;
    uint256 public poolEthIn; // every wei the splitter sent to the desk's pool
    bool public splitMismatch; // a sweep whose shares were not 70 / 20 / 10 of what it split
    bool public burnMismatch; // a burn whose figures did not match what really happened

    constructor(Refs memory refs) {
        r = refs;
        buyers = [makeAddr("buyer one"), makeAddr("buyer two"), makeAddr("buyer three")];
        adminTokensAtStart = refs.token.balanceOf(refs.admin);
        supplyAtStart = refs.token.totalSupply();
    }

    // ---------- trading and fees ----------

    function trade(uint96 eth, uint8 who) external {
        if (graduated) return;
        uint256 a = bound(eth, 0.001 ether, 0.5 ether);
        if (block.timestamp < r.curve.launchedAt() + 5) vm.warp(r.curve.launchedAt() + 5);
        address buyer = buyers[who % 3];
        vm.deal(buyer, buyer.balance + a);
        vm.prank(buyer);
        r.curve.buy{value: a}(a, 0, buyer);
    }

    /// After graduation Pons releases the pool's fees itself, late and in lumps.
    function lateFees(uint96 eth) external {
        if (!graduated) return;
        uint256 a = bound(eth, 0.0001 ether, 0.2 ether);
        vm.deal(address(this), a);
        r.escrow.credit{value: a}(address(r.splitter));
    }

    function _split(uint256 which) internal {
        uint256 a0 = r.admin.balance;
        uint256 b0 = address(r.burnPot).balance;
        uint256 p0 = r.desk.pool();
        uint256 amount = which == 0 ? r.splitter.sweep() : which == 1 ? r.splitter.claim() : r.splitter.distribute();
        uint256 toAdmin = r.admin.balance - a0;
        uint256 toBurn = address(r.burnPot).balance - b0;
        uint256 toPool = r.desk.pool() - p0;
        if (toAdmin + toBurn + toPool != amount) splitMismatch = true;
        if (toAdmin != (amount * 7000) / 10_000) splitMismatch = true;
        if (toPool != (amount * 1000) / 10_000) splitMismatch = true;
        burnEthIn += toBurn;
        poolEthIn += toPool;
    }

    function sweep() external {
        _split(0);
    }

    function claim() external {
        _split(1);
    }

    function distribute() external {
        _split(2);
    }

    function giftSplitter(uint64 eth) external {
        vm.deal(address(this), eth);
        (bool ok,) = address(r.splitter).call{value: eth}("");
        require(ok);
    }

    function forceSplitter(uint64 eth) external {
        vm.deal(address(this), eth);
        new ForceSend{value: eth}(payable(address(r.splitter)));
    }

    function giftBurnPot(uint64 eth) external {
        vm.deal(address(this), eth);
        (bool ok,) = address(r.burnPot).call{value: eth}("");
        require(ok);
        burnEthIn += eth;
    }

    /// A buyer sends some of their $FACTOR to the splitter or straight to the pot; from the splitter it is passed on.
    function giftFactor(uint8 who, uint96 amount, bool toPot) external {
        address buyer = buyers[who % 3];
        uint256 a = bound(amount, 0, r.token.balanceOf(buyer));
        vm.prank(buyer);
        r.token.transfer(toPot ? address(r.burnPot) : address(r.splitter), a);
        if (!toPot) r.splitter.claimToken();
    }

    function retry() external {
        r.splitter.retry();
    }

    // ---------- time ----------

    function wait(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 minutes, 2 days));
    }

    // ---------- the admin's tokens ----------

    /// The admin's tokens are in its wallet and it can move them. Nothing else can.
    function adminMovesTokens(uint96 amount, bool back) external {
        if (back) {
            address buyer = buyers[0];
            uint256 a = bound(amount, 0, r.token.balanceOf(buyer));
            vm.prank(buyer);
            r.token.transfer(r.admin, a);
            adminGot += a;
        } else {
            uint256 a = bound(amount, 0, r.token.balanceOf(r.admin));
            vm.prank(r.admin);
            r.token.transfer(buyers[0], a);
            adminMoved += a;
        }
    }

    // ---------- the burn pot ----------

    function burn(bool fund) external {
        if (fund) {
            vm.deal(address(this), 0.01 ether);
            (bool ok,) = address(r.burnPot).call{value: 0.01 ether}("");
            require(ok);
            burnEthIn += 0.01 ether;
            vm.warp(block.timestamp + 30 minutes);
        }
        uint256 supply = r.token.totalSupply();
        uint256 eth = address(r.burnPot).balance;
        try r.burnPot.burn(0) returns (uint256 ethIn, uint256 burned) {
            if (supply - r.token.totalSupply() != burned) burnMismatch = true;
            if (eth - address(r.burnPot).balance != ethIn) burnMismatch = true;
            potSupplyDrop += burned;
        } catch {
            if (r.token.totalSupply() != supply) burnMismatch = true;
            if (address(r.burnPot).balance != eth) burnMismatch = true;
        }
    }

    function graduate() external {
        if (graduated) return;
        graduated = true;
        r.factory.setPhase(address(r.token), IPonsV2LaunchFactory.GraduationPhase.PoolCreated);
        PoolKey memory key = PoolKey({
            currency0: address(0), currency1: address(r.token), fee: 0, tickSpacing: 200, hooks: r.factory.memeHook()
        });
        r.pm.setPool(keccak256(abi.encode(key)), 2 ** 96, 50 ether);
        r.pm.setRate(1_000_000e18);
        vm.prank(address(r.curve));
        r.token.transfer(address(r.pm), 300_000_000e18);
    }
}
