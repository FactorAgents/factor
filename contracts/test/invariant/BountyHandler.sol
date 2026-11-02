// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {FactorDesk} from "../../src/FactorDesk.sol";
import {FactorBounty} from "../../src/FactorBounty.sol";
import {Rejecter} from "../mocks/Actors.sol";

/// Random moves over bounties and the desk together. Every move anybody can make: posting, entering, picking, the
/// winner delivering (the right hash and a wrong one), declining, drawing, the desk's own settling and refunding, bonds
/// going back, closing, collecting, time. Each payout is checked as it happens against the rulebook; `wrong` stays false
/// unless something broke a rule.
contract BountyHandler is CommonBase, StdCheats, StdUtils {
    FactorDesk public desk;
    FactorBounty public b;
    address[6] public agents;
    address[2] public posters;
    Rejecter public refuser;

    bool public wrong;
    string public why;

    uint256 public posts;
    uint256 public entered;
    uint256 public picks;
    uint256 public won;
    uint256 public unpicked;
    uint256 public undelivered;
    uint256 public empty;
    uint256 public delivered;
    uint256 public declined;

    constructor(FactorDesk desk_, FactorBounty b_) {
        desk = desk_;
        b = b_;
        refuser = new Rejecter();
        for (uint256 i = 0; i < 5; ++i) {
            agents[i] = makeAddr(string.concat("bounty agent ", vm.toString(i)));
        }
        agents[5] = address(refuser); // a wallet that refuses ETH, until a collect makes it take it
        for (uint256 i = 0; i < 6; ++i) {
            vm.prank(agents[i]);
            desk.register();
        }
        posters[0] = makeAddr("bounty poster a");
        posters[1] = makeAddr("bounty poster b");
    }

    function _say(string memory what) internal {
        wrong = true;
        why = what;
    }

    function _id(uint256 seed) internal view returns (uint256) {
        uint256 n = b.bountyCount();
        return n == 0 ? 0 : (seed % n) + 1;
    }

    function post(uint8 who, uint96 prize_, uint32 open_, uint16 minScore) external {
        uint256 prize = bound(prize_, 0.005 ether, 2 ether);
        // most end soon, so most runs reach every ending; now and then one that runs long
        uint256 open = open_ % 8 == 0 ? bound(open_, 1 hours, 30 days) : bound(open_, 1 hours, 2 days);
        address p = posters[who % 2];
        uint256 value = prize + b.feeFor(prize);
        vm.deal(p, p.balance + value);
        vm.prank(p);
        b.post{value: value}(prize, block.timestamp + open, minScore % 11 == 0 ? 10 : 0, keccak256("a task"));
        posts++;
    }

    function enter(uint256 seed, uint8 who) external {
        uint256 id = _id(seed);
        if (id == 0) return;
        FactorBounty.Bounty memory x = b.bounty(id);
        address a = agents[who % 6];
        bytes32 h = b.entryHash(id, a, keccak256(abi.encode("work", a)));
        vm.deal(a, a.balance + x.bond);
        vm.prank(a);
        try b.enter{value: x.bond}(id, a, h) {
            entered++;
        } catch {}
    }

    function pick(uint256 seed, uint8 who) external {
        uint256 id = _id(seed);
        if (id == 0) return;
        FactorBounty.Bounty memory x = b.bounty(id);
        address[] memory list = b.entrants(id);
        if (list.length == 0) return;
        address w = list[who % list.length];
        vm.prank(x.poster);
        try b.pick(id, w) returns (uint256 job) {
            picks++;
            FactorDesk.Job memory j = desk.job(job);
            if (j.customer != address(b) || j.agent != w || j.price != x.prize) _say("a pick locked the wrong job");
            if (block.timestamp < x.deadline) _say("a pick before the deadline");
        } catch {}
    }

    function deliver(uint256 seed, bool rightHash) external {
        uint256 id = _id(seed);
        if (id == 0) return;
        FactorBounty.Bounty memory x = b.bounty(id);
        if (x.job == 0) return;
        bytes32 h = rightHash ? b.entryOf(id, x.winner).hash : keccak256("a wrong proof");
        vm.prank(x.winner);
        try desk.deliver(x.job, h) {
            delivered++;
        } catch {}
    }

    function decline(uint256 seed) external {
        uint256 id = _id(seed);
        if (id == 0) return;
        FactorBounty.Bounty memory x = b.bounty(id);
        if (x.job == 0) return;
        vm.prank(x.winner);
        try desk.decline(x.job) {
            declined++;
        } catch {}
    }

    function draw(uint256 seed, uint96 amount) external {
        uint256 id = _id(seed);
        if (id == 0) return;
        FactorBounty.Bounty memory x = b.bounty(id);
        if (x.job == 0) return;
        vm.deal(x.winner, x.winner.balance + 0.01 ether);
        vm.prank(x.winner);
        try desk.addBond{value: 0.01 ether}() {} catch {}
        vm.prank(x.winner);
        try desk.draw(x.job, bound(amount, 1, 0.002 ether), FactorDesk.Kind.Pool) {} catch {}
    }

    /// The desk's own clock, called directly, as anyone may.
    function deskCloses(uint256 seed, bool refund_) external {
        uint256 id = _id(seed);
        if (id == 0) return;
        FactorBounty.Bounty memory x = b.bounty(id);
        if (x.job == 0) return;
        if (refund_) {
            try desk.refund(x.job) {} catch {}
        } else {
            try desk.settle(x.job) {} catch {}
        }
    }

    function returnBonds(uint256 seed) external {
        uint256 id = _id(seed);
        if (id == 0) return;
        FactorBounty.Bounty memory x = b.bounty(id);
        address[] memory list = b.entrants(id);
        uint256 before = _bondsOutside(list, x.winner);
        try b.returnBonds(id) {
            uint256 count = list.length == 0 ? 0 : list.length - 1;
            if (_bondsOutside(list, x.winner) != before + x.bond * count) _say("returnBonds did not give back each bond");
        } catch {}
    }

    function close(uint256 seed) external {
        uint256 id = _id(seed);
        if (id == 0) return;
        FactorBounty.Bounty memory x = b.bounty(id);
        address[] memory list = b.entrants(id);
        uint256 burnedBefore = b.totalBurned();
        try b.close(id) {
            FactorBounty.Bounty memory after_ = b.bounty(id);
            if (after_.state == FactorBounty.State.Won) {
                won++;
                if (desk.job(x.job).state != FactorDesk.State.Settled) _say("won without a settled job");
            } else if (after_.state == FactorBounty.State.Unpicked) {
                unpicked++;
                if (block.timestamp < uint256(x.deadline) + 3 days) _say("split before the pick ended");
                if (list.length == 0) _say("split with no entrants");
                if (b.totalBurned() - burnedBefore != x.fee + (x.prize - (x.prize / list.length) * list.length)) {
                    _say("an unpicked split burned the wrong amount");
                }
            } else if (after_.state == FactorBounty.State.Undelivered) {
                undelivered++;
                FactorDesk.State s = desk.job(x.job).state;
                if (s != FactorDesk.State.Refunded && s != FactorDesk.State.Declined) _say("undelivered with a live job");
            } else if (after_.state == FactorBounty.State.Empty) {
                empty++;
                if (list.length != 0) _say("empty with entrants");
                if (block.timestamp < x.deadline) _say("returned before the deadline");
            } else {
                _say("a close that closed nothing");
            }
            if (!after_.bondsBack && after_.state != FactorBounty.State.Empty && list.length > 1) {
                _say("a bounty ended with bonds out");
            }
        } catch {}
    }

    function collect(uint8 who) external {
        address a = agents[who % 6];
        if (a == address(refuser)) refuser.setAccept(who % 2 == 0);
        try b.collect(a) {} catch {}
    }

    function warp(uint32 by) external {
        vm.warp(block.timestamp + bound(by, 1 minutes, 2 days));
    }

    // ---------- for the invariants ----------

    function agentCount() external pure returns (uint256) {
        return 6;
    }

    function _bondsOutside(address[] memory list, address winner) internal view returns (uint256 total) {
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i] != winner) total += list[i].balance + b.owed(list[i]);
        }
    }
}
