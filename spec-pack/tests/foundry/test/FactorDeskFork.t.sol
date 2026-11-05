// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// The live desk's interface, written from its ABI (abi/FactorDesk.abi.json). No Factor source is needed: these
/// tests run against the bytecode that is deployed on Robinhood Chain, on a fork.
interface IFactorDesk {
    enum Kind {
        Early,
        Pool,
        Compute
    }

    struct Job {
        address customer;
        uint40 dueAt;
        uint40 deliveredAt;
        uint8 state; // 0 None, 1 Locked, 2 Advanced, 3 Delivered, 4 Settled, 5 SettledAtHalf, 6 Declined, 7 Refunded
        bool allowEarly;
        bool late;
        address agent;
        uint256 price;
        uint256 early;
        uint256 fromPool;
        bytes32 proof;
    }

    struct Agent {
        bool registered;
        bool barred;
        uint40 firstSettledAt;
        uint32 settled;
        uint32 settledAtHalf;
        uint32 notDelivered;
        uint32 unanswered;
        uint32 customers;
        uint32 onTime;
        uint32 late;
        uint32 advancesRepaid;
        uint32 advancesNotRepaid;
        uint32 earlyKept;
        uint256 bond;
        uint256 feesPaid;
        uint256 advancedNow;
        uint256 volume;
    }

    function register() external;
    function addBond() external payable;
    function lock(address to, uint256 dueAt, bool allowEarly) external payable returns (uint256 id);
    function draw(uint256 id, uint256 amount, Kind kind) external;
    function deliver(uint256 id, bytes32 proof) external;
    function decline(uint256 id) external;
    function accept(uint256 id) external;
    function settle(uint256 id) external;
    function reject(uint256 id) external;
    function refund(uint256 id) external;

    function job(uint256 id) external view returns (Job memory);
    function agent(address who) external view returns (Agent memory);
    function canDrawOn(uint256 id) external view returns (uint256 early, uint256 fromPool);
    function canDraw(address who) external view returns (uint256);
    function poolRoom() external view returns (uint256);
    function jobCount() external view returns (uint256);
    function burnPot() external view returns (address);
    function gateway() external view returns (address);
    function pool() external view returns (uint256);
    function held() external view returns (uint256);
    function bonds() external view returns (uint256);
    function owedTotal() external view returns (uint256);
}

/// The desk on a fork of Robinhood Chain (chain id 4663). Run with:
///   forge test --fork-url <an RPC of Robinhood Chain, or an anvil fork of it> -vv
contract FactorDeskForkTest is Test {
    IFactorDesk constant DESK = IFactorDesk(0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F);
    address constant BURN_POT = 0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79;
    address constant GATEWAY = 0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0;
    /// keccak256 of the desk's runtime code, read from the live chain on 2026-11-05.
    bytes32 constant DESK_CODE_HASH = 0x62f56fb1f0e0ebf6371132f36d3b8b134f6ac1913a27697cd064ee51ae90eafc;

    uint8 constant LOCKED = 1;
    uint8 constant ADVANCED = 2;
    uint8 constant DELIVERED = 3;
    uint8 constant SETTLED = 4;
    uint8 constant HALF = 5;
    uint8 constant DECLINED = 6;
    uint8 constant REFUNDED = 7;

    address customer = makeAddr("kit customer");
    address agentW = makeAddr("kit agent");
    address stranger = makeAddr("kit stranger");

    function setUp() public {
        require(block.chainid == 4663, "fork Robinhood Chain (4663)");
        assertEq(address(DESK).codehash, DESK_CODE_HASH, "the desk's code is not the audited build");
        assertEq(DESK.burnPot(), BURN_POT);
        assertEq(DESK.gateway(), GATEWAY);
        vm.deal(customer, 10 ether);
        vm.deal(agentW, 1 ether);
        vm.deal(stranger, 1 ether);
    }

    // ---------- helpers ----------

    function _register(address who) internal {
        vm.prank(who);
        DESK.register();
    }

    function _lock(uint256 price, uint256 dueIn, bool early) internal returns (uint256 id) {
        vm.prank(customer);
        id = DESK.lock{value: price}(agentW, block.timestamp + dueIn, early);
    }

    function _err(string memory sig) internal pure returns (bytes4) {
        return bytes4(keccak256(bytes(sig)));
    }

    function _books() internal view {
        // the desk's own invariant: its balance always covers what it owes
        assertGe(address(DESK).balance, DESK.pool() + DESK.held() + DESK.bonds() + DESK.owedTotal());
    }

    // ---------- the happy path ----------

    /// T1: lock, sign up, bond, draw from the pool, deliver, accept.
    function test_T01_happyPath_lock_register_draw_deliver_accept() public {
        _register(agentW);
        assertTrue(DESK.agent(agentW).registered);

        uint256 price = 0.01 ether;
        uint256 before = DESK.jobCount();
        uint256 id = _lock(price, 24 hours, false);
        assertEq(id, before + 1);
        assertEq(DESK.job(id).state, LOCKED);

        // a new agent's pool limit is its bond plus the job fees it has paid: 0 until it bonds
        (uint256 e0, uint256 p0) = DESK.canDrawOn(id);
        assertEq(e0, 0);
        assertEq(p0, 0);
        vm.prank(agentW);
        DESK.addBond{value: 0.002 ether}();
        (, uint256 p1) = DESK.canDrawOn(id);
        assertEq(p1, 0.002 ether);

        uint256 agentBefore = agentW.balance;
        uint256 potBefore = BURN_POT.balance;
        vm.prank(agentW);
        DESK.draw(id, 0.002 ether, IFactorDesk.Kind.Pool);
        assertEq(agentW.balance - agentBefore, 0.00198 ether, "advance less the 1% fee");
        assertEq(BURN_POT.balance - potBefore, 0.00002 ether, "the 1% fee goes to the burn pot");
        assertEq(DESK.job(id).state, ADVANCED);
        assertEq(DESK.job(id).fromPool, 0.002 ether);

        bytes32 proof = keccak256(bytes("the work, exactly as handed over"));
        vm.prank(agentW);
        DESK.deliver(id, proof);
        assertEq(DESK.job(id).state, DELIVERED);
        assertEq(DESK.job(id).proof, proof);
        assertFalse(DESK.job(id).late);

        agentBefore = agentW.balance;
        vm.prank(customer);
        DESK.accept(id);
        // price 0.01 - pool advance 0.002 (repaid to the pool) - job fee 2% (0.0002)
        assertEq(agentW.balance - agentBefore, 0.0078 ether);
        assertEq(DESK.job(id).state, SETTLED);
        assertEq(DESK.agent(agentW).advancedNow, 0);
        assertEq(DESK.agent(agentW).settled, 1);
        assertEq(DESK.agent(agentW).feesPaid, 0.0002 ether);
        _books();
    }

    /// T2: an early advance the customer allowed, then the customer says nothing for 24 hours: anyone settles.
    function test_T02_happyPath_earlyDraw_thenSettleAfterReview() public {
        _register(agentW);
        uint256 id = _lock(0.004 ether, 2 hours, true);
        (uint256 early,) = DESK.canDrawOn(id);
        assertEq(early, 0.002 ether);
        vm.prank(agentW);
        DESK.draw(id, 0.002 ether, IFactorDesk.Kind.Early);
        vm.prank(agentW);
        DESK.deliver(id, keccak256("w"));
        uint256 at = uint256(DESK.job(id).deliveredAt) + 24 hours;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(_err("TooSoon(uint256)"), at));
        DESK.settle(id);
        vm.warp(at);
        uint256 agentBefore = agentW.balance;
        vm.prank(stranger);
        DESK.settle(id);
        // 0.004 - early 0.002 - fee 0.00008
        assertEq(agentW.balance - agentBefore, 0.00192 ether);
        assertEq(DESK.job(id).state, SETTLED);
        _books();
    }

    /// T3: the customer rejects within 24 hours: the job settles at half.
    function test_T03_reject_settlesAtHalf() public {
        _register(agentW);
        uint256 id = _lock(0.01 ether, 24 hours, false);
        vm.prank(agentW);
        DESK.deliver(id, keccak256("w"));
        uint256 c0 = customer.balance;
        uint256 a0 = agentW.balance;
        vm.prank(customer);
        DESK.reject(id);
        assertEq(customer.balance - c0, 0.005 ether, "half back to the customer");
        // the agent's half, less the 2% job fee on that half
        assertEq(agentW.balance - a0, 0.0049 ether);
        assertEq(DESK.job(id).state, HALF);
        assertEq(DESK.agent(agentW).settledAtHalf, 1);
    }

    /// T4: the agent declines before drawing: the customer has all of it back, the record is not marked.
    function test_T04_decline_beforeDrawing() public {
        _register(agentW);
        uint256 id = _lock(0.003 ether, 24 hours, false);
        uint256 c0 = customer.balance;
        vm.prank(agentW);
        DESK.decline(id);
        assertEq(customer.balance - c0, 0.003 ether);
        assertEq(DESK.job(id).state, DECLINED);
        assertEq(DESK.agent(agentW).unanswered, 0);
        assertEq(DESK.agent(agentW).notDelivered, 0);
    }

    /// T5: a delivery inside the 12 hours of grace counts, marked late.
    function test_T05_deliverInGrace_isLate() public {
        _register(agentW);
        uint256 id = _lock(0.002 ether, 1 hours, false);
        vm.warp(DESK.job(id).dueAt + 6 hours);
        vm.prank(agentW);
        DESK.deliver(id, keccak256("w"));
        assertTrue(DESK.job(id).late);
    }

    // ---------- failure cases ----------

    /// F1: registering twice.
    function test_F01_registerTwice_reverts() public {
        _register(agentW);
        vm.prank(agentW);
        vm.expectRevert(_err("AlreadyRegistered()"));
        DESK.register();
    }

    /// F2: a lock for a wallet that never registered, a lock under 0.001 ETH, a due time out of range.
    function test_F02_lockRefusals() public {
        vm.prank(customer);
        vm.expectRevert(_err("NotRegistered()"));
        DESK.lock{value: 0.01 ether}(agentW, block.timestamp + 1 days, false);
        _register(agentW);
        vm.prank(customer);
        vm.expectRevert(abi.encodeWithSelector(_err("TooSmall(uint256)"), 0.001 ether));
        DESK.lock{value: 0.0009 ether}(agentW, block.timestamp + 1 days, false);
        vm.prank(customer);
        vm.expectRevert(_err("BadDueTime()"));
        DESK.lock{value: 0.01 ether}(agentW, block.timestamp + 59 minutes, false);
        vm.prank(customer);
        vm.expectRevert(_err("BadDueTime()"));
        DESK.lock{value: 0.01 ether}(agentW, block.timestamp + 30 days + 1, false);
    }

    /// F3: drawing over half of the job.
    function test_F03_drawOverHalf_reverts() public {
        _register(agentW);
        vm.prank(agentW);
        DESK.addBond{value: 0.1 ether}();
        uint256 id = _lock(0.01 ether, 24 hours, true);
        vm.prank(agentW);
        DESK.draw(id, 0.003 ether, IFactorDesk.Kind.Early);
        // early and pool share the half: 0.005 - 0.003 = 0.002 left
        vm.prank(agentW);
        vm.expectRevert(abi.encodeWithSelector(_err("OverHalf(uint256)"), 0.002 ether));
        DESK.draw(id, 0.0021 ether, IFactorDesk.Kind.Pool);
    }

    /// F4: drawing from the pool over the agent's own limit (bond + fees paid - advanced now).
    function test_F04_drawOverLimit_reverts() public {
        _register(agentW);
        vm.prank(agentW);
        DESK.addBond{value: 0.001 ether}();
        uint256 id = _lock(0.01 ether, 24 hours, false);
        vm.prank(agentW);
        vm.expectRevert(abi.encodeWithSelector(_err("OverLimit(uint256)"), 0.001 ether));
        DESK.draw(id, 0.002 ether, IFactorDesk.Kind.Pool);
        // with no bond at all the limit is 0
        address fresh = makeAddr("kit fresh agent");
        _register(fresh);
        vm.prank(customer);
        uint256 id2 = DESK.lock{value: 0.01 ether}(fresh, block.timestamp + 1 days, false);
        vm.prank(fresh);
        vm.expectRevert(abi.encodeWithSelector(_err("OverLimit(uint256)"), 0));
        DESK.draw(id2, 0.001 ether, IFactorDesk.Kind.Compute);
    }

    /// F5: an early draw the customer did not allow; a draw of zero.
    function test_F05_earlyNotAllowed_and_zero() public {
        _register(agentW);
        uint256 id = _lock(0.01 ether, 24 hours, false);
        vm.prank(agentW);
        vm.expectRevert(_err("EarlyNotAllowed()"));
        DESK.draw(id, 0.001 ether, IFactorDesk.Kind.Early);
        vm.prank(agentW);
        vm.expectRevert(_err("ZeroAmount()"));
        DESK.draw(id, 0, IFactorDesk.Kind.Early);
    }

    /// F6: delivering (or drawing) after the due time and the 12 hours of grace.
    function test_F06_deliverAfterDueAndGrace_reverts() public {
        _register(agentW);
        uint256 id = _lock(0.002 ether, 1 hours, false);
        vm.warp(DESK.job(id).dueAt + 12 hours + 1);
        vm.prank(agentW);
        vm.expectRevert(_err("TooLate()"));
        DESK.deliver(id, keccak256("w"));
        vm.prank(agentW);
        vm.expectRevert(_err("TooLate()"));
        DESK.draw(id, 0.0001 ether, IFactorDesk.Kind.Pool);
        (uint256 e, uint256 p) = DESK.canDrawOn(id);
        assertEq(e + p, 0, "canDrawOn reads 0 past the grace");
    }

    /// F7: declining after drawing is refused: the agent must deliver or the job is refunded.
    function test_F07_declineAfterDrawing_reverts() public {
        _register(agentW);
        uint256 id = _lock(0.01 ether, 24 hours, true);
        vm.prank(agentW);
        DESK.draw(id, 0.001 ether, IFactorDesk.Kind.Early);
        vm.prank(agentW);
        vm.expectRevert(abi.encodeWithSelector(_err("WrongState(uint8)"), ADVANCED));
        DESK.decline(id);
    }

    /// F8: the wrong caller: only the job's agent draws, delivers or declines; only its customer accepts or rejects.
    function test_F08_wrongCaller_reverts() public {
        _register(agentW);
        uint256 id = _lock(0.01 ether, 24 hours, true);
        vm.startPrank(stranger);
        vm.expectRevert(_err("NotAgent()"));
        DESK.draw(id, 0.001 ether, IFactorDesk.Kind.Early);
        vm.expectRevert(_err("NotAgent()"));
        DESK.deliver(id, keccak256("w"));
        vm.expectRevert(_err("NotAgent()"));
        DESK.decline(id);
        vm.stopPrank();
        vm.prank(agentW);
        DESK.deliver(id, keccak256("w"));
        vm.prank(stranger);
        vm.expectRevert(_err("NotCustomer()"));
        DESK.accept(id);
        vm.prank(agentW);
        vm.expectRevert(_err("NotCustomer()"));
        DESK.reject(id);
    }

    /// F9: rejecting once the customer's 24 hours are over.
    function test_F09_rejectAfterReview_reverts() public {
        _register(agentW);
        uint256 id = _lock(0.01 ether, 24 hours, false);
        vm.prank(agentW);
        DESK.deliver(id, keccak256("w"));
        vm.warp(block.timestamp + 24 hours);
        vm.prank(customer);
        vm.expectRevert(_err("TooLate()"));
        DESK.reject(id);
    }

    /// F10: drawn and not delivered: refunded after the grace, the bond repays the pool, the agent is barred for good.
    function test_F10_drawnUndelivered_refund_barsForGood() public {
        _register(agentW);
        vm.prank(agentW);
        DESK.addBond{value: 0.005 ether}();
        uint256 id = _lock(0.01 ether, 1 hours, false);
        vm.prank(agentW);
        DESK.draw(id, 0.002 ether, IFactorDesk.Kind.Pool);
        uint256 at = uint256(DESK.job(id).dueAt) + 12 hours;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(_err("TooSoon(uint256)"), at + 1));
        DESK.refund(id);
        vm.warp(at + 1);
        uint256 c0 = customer.balance;
        vm.prank(stranger);
        DESK.refund(id);
        assertEq(customer.balance - c0, 0.01 ether, "a pool advance never costs the customer");
        assertEq(DESK.job(id).state, REFUNDED);
        IFactorDesk.Agent memory a = DESK.agent(agentW);
        assertTrue(a.barred);
        assertEq(a.bond, 0.003 ether, "the bond repaid the 0.002 advance");
        assertEq(DESK.canDraw(agentW), 0);
        // a new job: the pool never advances it again, whatever its bond
        vm.prank(agentW);
        DESK.addBond{value: 0.5 ether}();
        uint256 id2 = _lock(0.01 ether, 24 hours, true);
        (uint256 e, uint256 p) = DESK.canDrawOn(id2);
        assertEq(p, 0);
        assertEq(e, 0.005 ether, "an early draw the customer allows is still possible");
        vm.prank(agentW);
        vm.expectRevert(_err("Barred()"));
        DESK.draw(id2, 0.001 ether, IFactorDesk.Kind.Pool);
        _books();
    }

    /// F11: an agent address that refuses ETH (a contract, or a wallet with code) is not paid on settle: the payout
    ///      is written down in owed() and has to be collected.
    function test_F11_payoutRefused_landsInOwed_thenCollectTo() public {
        RefusingAgent bot = new RefusingAgent(DESK);
        bot.register();
        vm.prank(customer);
        uint256 id = DESK.lock{value: 0.01 ether}(address(bot), block.timestamp + 1 days, false);
        bot.deliver(id, keccak256("w"));
        vm.prank(customer);
        DESK.accept(id);
        assertEq(DESK.job(id).state, SETTLED, "the settlement itself goes through");
        assertEq(IOwed(address(DESK)).owed(address(bot)), 0.0098 ether, "price less the 2% job fee, waiting");
        address payable to = payable(makeAddr("kit payout wallet"));
        bot.collectTo(to);
        assertEq(to.balance, 0.0098 ether);
        assertEq(IOwed(address(DESK)).owed(address(bot)), 0);
    }
}

interface IOwed {
    function owed(address who) external view returns (uint256);
    function collectTo(address payable to) external;
}

/// An agent that is a contract with no way to take ETH.
contract RefusingAgent {
    IFactorDesk immutable desk;

    constructor(IFactorDesk d) {
        desk = d;
    }

    function register() external {
        desk.register();
    }

    function deliver(uint256 id, bytes32 proof) external {
        desk.deliver(id, proof);
    }

    function collectTo(address payable to) external {
        IOwed(address(desk)).collectTo(to);
    }

    receive() external payable {
        revert("no ETH here");
    }
}
