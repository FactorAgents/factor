// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorVerifiers} from "../../src/FactorVerifiers.sol";
import {Rejecter} from "../mocks/Actors.sol";

/// Random moves over verified jobs and the desk together. Every move anybody can make: verifiers joining, adding,
/// withdrawing and switching makers; customers hiring, accepting and rejecting; agents delivering, declining and
/// conceding; first checks, disputes, seats, strikes and reveals; the desk settling and refunding around the contract;
/// stepping, collecting, time. A move that the contract refuses is simply refused.
contract VerifierHandler is CommonBase, StdCheats, StdUtils {
    FactorDesk public desk;
    FactorVerifiers public vf;
    address[2] public agents;
    address[3] public customers;
    address[6] public vers;
    Rejecter public refuser;

    uint256 public hires;
    uint256 public checks;
    uint256 public disputes;
    uint256 public seats;
    uint256 public reveals;
    uint256 public ended;
    uint256 public panels;

    constructor(FactorDesk desk_, FactorVerifiers vf_) {
        desk = desk_;
        vf = vf_;
        refuser = new Rejecter();
        for (uint256 i = 0; i < 2; ++i) {
            agents[i] = makeAddr(string.concat("verified agent ", vm.toString(i)));
            vm.prank(agents[i]);
            desk.register();
            vm.deal(agents[i], 1 ether);
        }
        customers[0] = makeAddr("verified customer a");
        customers[1] = makeAddr("verified customer b");
        customers[2] = address(refuser); // refuses ETH until a collect makes it take it
        for (uint256 i = 0; i < 3; ++i) {
            vm.deal(customers[i], 100 ether);
        }
        for (uint256 i = 0; i < 6; ++i) {
            vers[i] = makeAddr(string.concat("verifier ", vm.toString(i)));
            vm.deal(vers[i], 10 ether);
            vm.prank(vers[i]);
            vf.join{value: 0.2 ether}(uint8(1 + (i % 4)));
            vm.warp(block.timestamp + 1 hours);
        }
    }

    function _case(uint256 seed) internal view returns (uint256 id) {
        uint256 n = vf.caseCount();
        if (n == 0) return 0;
        id = 1 + (seed % n);
    }

    function _commit(uint256 id, address v) internal pure returns (bytes32 salt, bool accept_) {
        salt = keccak256(abi.encode(id, v));
        accept_ = uint256(salt) % 3 != 0;
    }

    // ---------- the moves ----------

    function hire(uint256 who, uint256 agent, uint256 price, uint256 fee) external {
        price = bound(price, 0.001 ether, 0.3 ether);
        fee = bound(fee, vf.MIN_FEE(), price);
        address c = customers[who % 3];
        vm.prank(c);
        try vf.hire{value: price + fee}(agents[agent % 2], block.timestamp + 1 days, false, fee, keccak256("terms")) {
            ++hires;
        } catch {}
    }

    function deliver(uint256 seed) external {
        uint256 id = _case(seed);
        if (id == 0) return;
        FactorVerifiers.Case memory c = vf.getCase(id);
        vm.prank(c.agent);
        try desk.deliver(c.job, keccak256(abi.encode(id))) {} catch {}
    }

    function decline(uint256 seed) external {
        uint256 id = _case(seed);
        if (id == 0) return;
        FactorVerifiers.Case memory c = vf.getCase(id);
        vm.prank(c.agent);
        try desk.decline(c.job) {} catch {}
    }

    function check(uint256 seed, uint256 v, bool accept_) external {
        uint256 id = _case(seed);
        if (id == 0) return;
        // most checks follow a delivery
        FactorVerifiers.Case memory c = vf.getCase(id);
        vm.prank(c.agent);
        try desk.deliver(c.job, keccak256(abi.encode(id))) {} catch {}
        vm.prank(vers[v % 6]);
        try vf.check(id, accept_, keccak256("why")) {
            ++checks;
        } catch {}
    }

    function dispute(uint256 seed) external {
        uint256 id = _case(seed);
        if (id == 0) return;
        FactorVerifiers.Case memory c = vf.getCase(id);
        address side = c.firstAccept ? c.customer : c.agent;
        vm.deal(side, side.balance + c.disputeBond);
        vm.prank(side);
        try vf.dispute{value: c.disputeBond}(id) {
            ++disputes;
        } catch {}
    }

    function sit(uint256 seed, uint256 v) external {
        uint256 id = _case(seed);
        if (id == 0) return;
        address who = vers[v % 6];
        (bytes32 salt, bool accept_) = _commit(id, who);
        bytes32 commit = vf.commitOf(id, who, accept_, keccak256("why"), salt);
        vm.prank(who);
        try vf.sit(id, commit) {
            ++seats;
        } catch {}
    }

    function strike(uint256 seed, uint256 v, bool byCustomer) external {
        uint256 id = _case(seed);
        if (id == 0) return;
        FactorVerifiers.Case memory c = vf.getCase(id);
        vm.prank(byCustomer ? c.customer : c.agent);
        try vf.strike(id, vers[v % 6]) {} catch {}
    }

    function reveal(uint256 seed, uint256 v) external {
        uint256 id = _case(seed);
        if (id == 0) return;
        address who = vers[v % 6];
        (bytes32 salt, bool accept_) = _commit(id, who);
        vm.prank(who);
        try vf.reveal(id, accept_, keccak256("why"), salt) {
            ++reveals;
        } catch {}
    }

    function accept(uint256 seed) external {
        uint256 id = _case(seed);
        if (id == 0) return;
        vm.prank(vf.getCase(id).customer);
        try vf.accept(id) {
            ++ended;
        } catch {}
    }

    function reject(uint256 seed) external {
        uint256 id = _case(seed);
        if (id == 0) return;
        vm.prank(vf.getCase(id).customer);
        try vf.reject(id) {
            ++ended;
        } catch {}
    }

    function concede(uint256 seed) external {
        uint256 id = _case(seed);
        if (id == 0) return;
        vm.prank(vf.getCase(id).agent);
        try vf.concede(id) {
            ++ended;
        } catch {}
    }

    function step(uint256 seed) external {
        uint256 id = _case(seed);
        if (id == 0) return;
        bool wasDisputed = vf.getCase(id).state == FactorVerifiers.State.Disputed;
        try vf.step(id) {
            if (wasDisputed) ++panels;
            FactorVerifiers.State s = vf.getCase(id).state;
            if (
                s == FactorVerifiers.State.Accepted || s == FactorVerifiers.State.Rejected
                    || s == FactorVerifiers.State.Returned
            ) ++ended;
        } catch {}
    }

    /// A whole panel in one move, so that panels are reached often: a dispute if the case is checked, every verifier
    /// tries a seat, time runs to the reveals, the seated reveal (one may stay silent), and a step.
    function panel(uint256 seed, uint256 silent) external {
        uint256 id = _case(seed);
        if (id == 0) return;
        FactorVerifiers.Case memory c = vf.getCase(id);
        if (c.state == FactorVerifiers.State.Checked) {
            address side = c.firstAccept ? c.customer : c.agent;
            vm.deal(side, side.balance + c.disputeBond);
            vm.prank(side);
            try vf.dispute{value: c.disputeBond}(id) {
                ++disputes;
            } catch {}
        }
        if (vf.getCase(id).state != FactorVerifiers.State.Disputed) return;
        for (uint256 i = 0; i < 6; ++i) {
            address who = vers[(seed + i) % 6];
            (bytes32 salt, bool accept_) = _commit(id, who);
            bytes32 commit = vf.commitOf(id, who, accept_, keccak256("why"), salt);
            vm.prank(who);
            try vf.sit(id, commit) {
                ++seats;
            } catch {}
        }
        uint256 d = desk.job(c.job).deliveredAt;
        if (block.timestamp < d + vf.SEAT_END()) vm.warp(d + vf.SEAT_END());
        for (uint256 i = 0; i < 6; ++i) {
            if (i == silent % 8) continue;
            address who = vers[i];
            (bytes32 salt, bool accept_) = _commit(id, who);
            vm.prank(who);
            try vf.reveal(id, accept_, keccak256("why"), salt) {
                ++reveals;
            } catch {}
        }
        try vf.step(id) {
            ++panels;
        } catch {}
    }

    /// The desk's own calls, open to anyone, made around the contract.
    function deskCloses(uint256 seed) external {
        uint256 id = _case(seed);
        if (id == 0) return;
        uint256 job = vf.getCase(id).job;
        try desk.settle(job) {} catch {}
        try desk.refund(job) {} catch {}
    }

    function bond(uint256 v, uint256 amount, bool take) external {
        address who = vers[v % 6];
        if (take) {
            amount = bound(amount, 1, 0.3 ether);
            vm.prank(who);
            try vf.withdraw(amount) {} catch {}
        } else {
            amount = bound(amount, 1, 0.1 ether);
            vm.prank(who);
            try vf.addBond{value: amount}() {} catch {}
        }
    }

    function setMaker(uint256 v, uint8 maker) external {
        vm.prank(vers[v % 6]);
        try vf.setMaker(maker) {} catch {}
    }

    function collect() external {
        refuser.setAccept(true);
        try vf.collect(address(refuser)) {} catch {}
        refuser.setAccept(false);
    }

    function warp(uint256 by) external {
        vm.warp(block.timestamp + bound(by, 1 minutes, 3 hours));
    }

    function verifierCount() external pure returns (uint256) {
        return 6;
    }
}
