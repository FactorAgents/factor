// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LineBase} from "../lines/LineBase.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorVerifiers} from "../../src/FactorVerifiers.sol";

/// The desk and the line contract of the other tests with a verifier contract beside them, five verifiers of four
/// model makers who joined one after another (so each has an older standing than the next), and the moves the
/// verifiers' tests start from.
abstract contract VerifierBase is LineBase {
    FactorVerifiers internal vf;
    address internal hirer = makeAddr("a customer hiring with a verifier");
    // in order of standing, oldest first
    address internal claude = makeAddr("a verifier on Claude");
    address internal gemini = makeAddr("a verifier on Gemini");
    address internal gpt = makeAddr("a verifier on GPT");
    address internal grok = makeAddr("a verifier on Grok");
    address internal claude2 = makeAddr("a second verifier on Claude, newer");

    uint8 internal constant ANTHROPIC = 1;
    uint8 internal constant GOOGLE = 2;
    uint8 internal constant OPENAI = 3;
    uint8 internal constant XAI = 4;

    uint256 internal constant PRICE = 0.01 ether;
    uint256 internal constant FEE = 0.0003 ether;
    uint256 internal constant BOND = 0.05 ether;
    bytes32 internal constant TERMS =
        keccak256('{"title":"A lease, read","brief":"Read the lease and list the dates"}');
    bytes32 internal constant WHY = keccak256("the dates are all there, and the sums add up");

    function setUp() public virtual override {
        super.setUp();
        vf = new FactorVerifiers(desk, line);
        _join(claude, ANTHROPIC);
        vm.warp(block.timestamp + 1 days);
        _join(gemini, GOOGLE);
        vm.warp(block.timestamp + 1 days);
        _join(gpt, OPENAI);
        vm.warp(block.timestamp + 1 days);
        _join(grok, XAI);
        vm.warp(block.timestamp + 1 days);
        _join(claude2, ANTHROPIC);
        vm.warp(block.timestamp + 1 days);
    }

    // ---------- the moves ----------

    function _join(address who, uint8 maker) internal {
        vm.deal(who, who.balance + BOND);
        vm.prank(who);
        vf.join{value: BOND}(maker);
    }

    function _hire(address from, address agent, uint256 price, uint256 fee) internal returns (uint256 id) {
        vm.deal(from, from.balance + price + fee);
        vm.prank(from);
        id = vf.hire{value: price + fee}(agent, block.timestamp + 1 days, false, fee, TERMS);
    }

    /// A job of PRICE for agent a, with a fee of FEE.
    function _hire() internal returns (uint256) {
        return _hire(hirer, agentA, PRICE, FEE);
    }

    function _jobOf(uint256 id) internal view returns (uint256) {
        return vf.getCase(id).job;
    }

    function _deliverCase(uint256 id) internal {
        uint256 job = _jobOf(id);
        vm.prank(vf.getCase(id).agent);
        desk.deliver(job, keccak256(abi.encode("the work of job", job)));
    }

    function _check(uint256 id, address who, bool accept) internal {
        vm.prank(who);
        vf.check(id, accept, WHY);
    }

    /// Hired, delivered and checked by Claude.
    function _checked(bool accept) internal returns (uint256 id) {
        id = _hire();
        _deliverCase(id);
        _check(id, claude, accept);
    }

    function _dispute(uint256 id) internal {
        FactorVerifiers.Case memory c = vf.getCase(id);
        address side = c.firstAccept ? c.customer : c.agent;
        vm.deal(side, side.balance + c.disputeBond);
        vm.prank(side);
        vf.dispute{value: c.disputeBond}(id);
    }

    function _salt(address who) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", who));
    }

    function _sit(uint256 id, address who, bool accept) internal {
        bytes32 commit = vf.commitOf(id, who, accept, WHY, _salt(who));
        vm.prank(who);
        vf.sit(id, commit);
    }

    function _reveal(uint256 id, address who, bool accept) internal {
        vm.prank(who);
        vf.reveal(id, accept, WHY, _salt(who));
    }

    function _delivered(uint256 id) internal view returns (uint256) {
        return desk.job(_jobOf(id)).deliveredAt;
    }

    function _toReveals(uint256 id) internal {
        vm.warp(_delivered(id) + vf.SEAT_END());
    }

    function _pastReveals(uint256 id) internal {
        vm.warp(_delivered(id) + vf.REVEAL_END());
    }

    function _stateOf(uint256 id) internal view returns (FactorVerifiers.State) {
        return vf.getCase(id).state;
    }

    function _free(address who) internal view returns (uint256) {
        return vf.verifier(who).free;
    }

    function _locked(address who) internal view returns (uint256) {
        return vf.verifier(who).locked;
    }

    /// The contract holds exactly its books, and the desk its own. `back`: a payment that came back from the desk and
    /// has not been stepped yet.
    function _vbooks(uint256 back) internal view {
        assertEq(
            address(vf).balance,
            vf.bonds() + vf.staked() + vf.fees() + vf.disputes() + vf.owedTotal() + back,
            "the verifier contract holds exactly its books"
        );
        _books();
    }

    function _vbooks() internal view {
        _vbooks(0);
    }

    /// The sum of the five verifiers' free and locked bonds is the contract's books of them.
    function _verifierBooks() internal view {
        address[5] memory all = [claude, gemini, gpt, grok, claude2];
        uint256 free;
        uint256 locked;
        for (uint256 i = 0; i < 5; ++i) {
            free += _free(all[i]);
            locked += _locked(all[i]);
        }
        assertEq(free, vf.bonds(), "free bonds add up");
        assertEq(locked, vf.staked(), "staked bonds add up");
    }
}
