// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {GuaranteeBase} from "../guarantees/GuaranteeBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorLineAccount} from "../../src/FactorLine.sol";
import {FactorVouch} from "../../src/FactorVouch.sol";

/// The desk, the line contract and the guarantee contract of the other tests with a vouching contract beside them, and
/// the moves the vouching tests start from.
abstract contract VouchBase is GuaranteeBase {
    FactorVouch internal vc;
    /// a strong agent: a score of 300 or more
    address internal voucher = makeAddr("a voucher with a strong score");
    /// a newer agent, with a credit line
    address internal newKey = makeAddr("a newer agent's key");
    FactorLineAccount internal newAcct;

    function setUp() public virtual override {
        super.setUp();
        vc = new FactorVouch(g);
        vm.prank(voucher);
        desk.register();
        vm.prank(newKey);
        desk.register();
        _score300(voucher);
        newAcct = _open(newKey);
        _seed(10 ether);
    }

    // ---------- scores ----------

    /// Twenty-one jobs settled for one customer (200 for the jobs, 2 for the fees, 25 for the customer) and fifty days
    /// since the first (100): a score of 327.
    function _score300(address agent) internal {
        for (uint256 i = 0; i < 20; ++i) {
            _settleFor(scorer, agent, 0.001 ether);
        }
        _settleFor(scorer, agent, 0.05 ether);
        vm.warp(block.timestamp + 50 days);
        assertGe(g.scoreOf(vc.agentOf(agent)), 300, "a strong score");
    }

    // ---------- the moves ----------

    function _vbond(address who, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        vc.addBond{value: amount}(who);
    }

    function _offerLine(address from, address account, uint256 amount) internal returns (uint256 id) {
        vm.prank(_runner(from));
        id = vc.offerLine(from, account, amount);
    }

    function _offerCover(address from, uint256 coverId, uint256 amount) internal returns (uint256 id) {
        vm.prank(_runner(from));
        id = vc.offerCover(from, coverId, amount);
    }

    /// The vouched agent (its key when it has a line) accepts, paying the fee.
    function _accept(address agent, uint256 id) internal {
        address by = _runner(agent);
        uint256 fee = vc.vouch(id).fee;
        vm.deal(by, by.balance + fee);
        vm.prank(by);
        vc.accept{value: fee}(id);
    }

    /// A line vouch offered by the voucher on the newer agent's line and accepted.
    function _lineVouch(uint256 amount) internal returns (uint256 id) {
        _vbond(voucher, amount * 4);
        id = _offerLine(voucher, address(newAcct), amount);
        _accept(address(newAcct), id);
    }

    /// Who acts for an address: the key of a line account, otherwise the address itself.
    function _runner(address who) internal view returns (address) {
        address k = line.keyOf(who);
        return k == address(0) ? who : k;
    }

    /// The newer agent's line account gets a desk bond and draws on its line.
    function _newDraws(uint256 bond, uint256 amount) internal {
        if (bond > 0) _lineBond(newKey, bond);
        _lineDraw(newKey, amount, false);
    }

    /// The newer agent's line defaults: past its due time and the 30 days after, recovered by anyone.
    function _default() internal {
        vm.warp(uint256(line.line(address(newAcct)).dueAt) + 30 days + 1);
        line.recover(address(newAcct));
        assertTrue(line.line(address(newAcct)).defaulted, "the line defaulted");
    }

    /// A covered agent: score 200, a guarantee bond and offer; a buyer hires it with cover. Returns the cover and job.
    function _covered(address agent, uint256 price, uint256 cover) internal returns (uint256 id, uint256 job) {
        _ready(agent, cover * 2, cover);
        (id, job) = _hire(buyer, agent, price, cover, false);
    }

    /// The vouching contract holds exactly its books, and no vouch is unbacked.
    function _vbooks() internal view {
        assertEq(
            address(vc).balance,
            vc.bonds() + vc.feesHeld() + vc.owedTotal(),
            "the vouching contract holds exactly its bonds, the fees held and what it owes"
        );
        assertLe(vc.held(), vc.bonds(), "every vouch held back is backed by a bond");
    }

    function _vfee(uint256 amount) internal pure returns (uint256 fee, uint256 toVoucher, uint256 burned) {
        fee = (amount * 200) / 10_000;
        toVoucher = (fee * 5000) / 10_000;
        burned = fee - toVoucher;
    }
}
