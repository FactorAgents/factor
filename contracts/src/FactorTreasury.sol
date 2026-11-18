// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FactorDesk} from "./FactorDesk.sol";
import {FactorLine} from "./FactorLine.sol";
import {FactorGuarantee} from "./FactorGuarantee.sol";
import {FactorVouch} from "./FactorVouch.sol";
import {FactorClaims} from "./FactorClaims.sol";

/// @title FactorTreasury
/// @notice Agent treasury: an agent's idle earnings work on their own, inside rules the agent sets once. See
///         docs/TREASURY.md for every rule in plain words.
///
///         Every address has a treasury here: ETH put in for it, which only that address can take out, at any time and
///         in full. The agent sets its rules: a floor a run never spends below, and for each of five uses whether it
///         is on and how far it goes. Then anyone may call `run(agent)`, and the treasury does, in this fixed order,
///         with what it holds above the floor:
///
///           1 repay      pays the agent's own credit line (FactorLine.repay), up to what it owes and the rule's amount
///                        a day. While this use is on and the line still owes anything, nothing below is done
///           2 compute    prepays compute: sends ETH to the desk's compute gateway, up to the rule's amount a day
///           3 claims     buys locked pay (FactorClaims.buy) from the claims the caller names, only those inside the
///                        agent's rules: a price of at most so much, at least so far under its face, a seller with a
///                        desk score of at least so much, only a delivered job if the agent says so; up to the rule's
///                        amount a day. A claim bought is handed to the agent at once (FactorClaims.give), so the job's
///                        payout goes straight to the agent
///           4 guarantee  tops up the agent's own guarantee bond (FactorGuarantee.addBond) to the level the rule names
///           5 vouch      tops up the agent's own vouching bond (FactorVouch.addBond) to the level the rule names: the
///                        money that stands behind the newer agents it vouches for
///
///         It uses only doors of those contracts that are open to everybody. None of them knows of it, and it changes
///         none of them. A door that refuses (a claim somebody else just bought, an agent not on the desk) is skipped
///         and its ETH stays in the treasury.
///
///         There is no owner, no fee, and nothing can be set after deployment but an agent's own rules by that agent.
///         Every address is read from the vouching contract or is the claims contract's.
/// @dev The contract's ETH is `held`, the sum of every treasury's balance. Every function that moves ETH is guarded
///      against re-entry and writes its state before ETH moves; a step whose door refuses puts its amount back.
contract FactorTreasury is ReentrancyGuardTransient {
    uint256 public constant BPS = 10_000;
    /// @notice The smallest compute prepayment and the smallest bond top-up a run makes.
    uint256 public constant MIN_STEP = 0.0001 ether;
    /// @notice The most claims a caller can name in one run.
    uint256 public constant MAX_CLAIMS = 10;
    /// @notice The length of the day the daily amounts are counted over, from midnight UTC.
    uint256 public constant DAY = 1 days;

    enum Step {
        Repay,
        Compute,
        Claims,
        Guarantee,
        Vouch
    }

    /// @dev An agent's rules. Every field is set by the agent itself and by nobody else. All off until it sets them.
    struct Rules {
        uint256 floor; // a run never takes the treasury below this
        bool repay; // 1: repay its own credit line
        uint256 repayDaily; // the most a day
        bool compute; // 2: prepay compute at the gateway
        uint256 computeDaily; // the most a day
        bool claims; // 3: buy locked pay
        uint256 claimsDaily; // the most a day
        uint256 claimMaxPrice; // the most for one claim
        uint16 claimMinDiscountBps; // a claim's price must be at least this far under its face
        uint16 claimMinScore; // the least desk score of the seller's pay account
        bool claimDeliveredOnly; // only claims whose job is already delivered
        bool guarantee; // 4: top up its own guarantee bond
        uint256 guaranteeUpTo; // to this level
        bool vouch; // 5: top up its own vouching bond
        uint256 vouchUpTo; // to this level
    }

    /// @dev What a treasury has done, in all. Written by this contract and by nothing else.
    struct Totals {
        uint256 deposited;
        uint256 withdrawn;
        uint256 repaid;
        uint256 compute;
        uint256 claims;
        uint256 guarantee;
        uint256 vouch;
        uint32 runs;
        uint32 claimsBought;
    }

    struct Day {
        uint64 day;
        uint192 spent;
    }

    FactorDesk public immutable desk;
    FactorLine public immutable line;
    FactorGuarantee public immutable guarantee;
    FactorVouch public immutable vouch;
    FactorClaims public immutable claims;
    /// @notice The desk's compute gateway: a compute prepayment is paid here, never to the agent.
    address public immutable gateway;

    /// @notice What each treasury holds.
    mapping(address agent => uint256) public balanceOf;
    mapping(address agent => Rules) internal rules_;
    mapping(address agent => Totals) internal totals_;
    mapping(address agent => mapping(Step step => Day)) internal days_;
    /// @notice All treasuries together: the contract's ETH.
    uint256 public held;

    event Deposited(address indexed agent, address indexed from, uint256 amount, uint256 balance);
    event Withdrawn(address indexed agent, address indexed to, uint256 amount, uint256 balance);
    event RulesSet(address indexed agent, Rules rules);
    event LineRepaid(address indexed agent, address indexed account, uint256 amount, uint256 debt);
    event ComputePrepaid(address indexed agent, address indexed gateway, uint256 amount);
    event ClaimBought(address indexed agent, uint256 indexed id, uint256 indexed job, uint256 price, uint256 face);
    event GuaranteeBacked(address indexed agent, address indexed deskAddress, uint256 amount, uint256 bond);
    event VouchBacked(address indexed agent, address indexed deskAddress, uint256 amount, uint256 bond);
    /// @notice A door refused a step, and its ETH stayed in the treasury. `ref` is the claim, for a claim.
    event Skipped(address indexed agent, Step step, uint256 ref);
    event Ran(address indexed agent, address indexed by, uint256 spent, uint256 balance);

    error ZeroAddress();
    error ZeroAmount();
    error WrongDesk();
    error BadRules();
    error OverBalance(uint256 balance);
    error TooMany();
    error NothingToDo();
    error PushFailed();

    constructor(FactorVouch vouch_, FactorClaims claims_) {
        if (address(vouch_) == address(0) || address(claims_) == address(0)) revert ZeroAddress();
        vouch = vouch_;
        claims = claims_;
        guarantee = vouch_.guarantee();
        line = vouch_.line();
        desk = vouch_.desk();
        if (address(claims_.desk()) != address(desk)) revert WrongDesk();
        gateway = desk.gateway();
        if (gateway == address(0)) revert ZeroAddress();
    }

    /// @notice Plain ETH is a deposit. From an agent's line account or pay account it goes into its key's treasury (so
    ///         a key can withdraw from either straight into its treasury); from anybody else, into the sender's own.
    receive() external payable {
        address agent = line.keyOf(msg.sender);
        if (agent == address(0)) agent = claims.keyOf(msg.sender);
        _deposit(agent == address(0) ? msg.sender : agent);
    }

    // ---------- the agent's money ----------

    /// @notice Put the ETH sent into an agent's treasury. Anyone may; nobody gets a claim on it by doing so.
    function deposit(address agent) external payable {
        if (agent == address(0)) revert ZeroAddress();
        _deposit(agent);
    }

    /// @notice Take ETH out of your own treasury, to any address. No rule, floor or run stands in the way.
    function withdraw(address payable to, uint256 amount) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 b = balanceOf[msg.sender];
        if (amount > b) revert OverBalance(b);
        balanceOf[msg.sender] = b - amount;
        held -= amount;
        totals_[msg.sender].withdrawn += amount;
        emit Withdrawn(msg.sender, to, amount, b - amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PushFailed();
    }

    /// @notice Set your own treasury's rules, whole. They hold from the next run.
    function setRules(Rules calldata r) external {
        if (r.claimMinDiscountBps > BPS || r.claimMinScore > 1000) revert BadRules();
        rules_[msg.sender] = r;
        emit RulesSet(msg.sender, r);
    }

    // ---------- a run ----------

    /// @notice Anyone: run an agent's treasury by its rules, in the fixed order. `claimIds` are the listed claims the
    ///         caller offers it to buy; each is bought only if it is inside the agent's rules. Refuses when there is
    ///         nothing to do.
    function run(address agent, uint256[] calldata claimIds) external nonReentrant returns (uint256 spent) {
        if (claimIds.length > MAX_CLAIMS) revert TooMany();
        Rules storage r = rules_[agent];
        uint256 start = balanceOf[agent];
        address deskAddress = vouch.agentOf(agent);
        // 1 the line first: while it is on and the line still owes, nothing else is done
        if (!_runRepay(agent, r, deskAddress)) {
            _runCompute(agent, r);
            for (uint256 i = 0; i < claimIds.length; ++i) {
                _runClaim(agent, r, claimIds[i]);
            }
            _runGuarantee(agent, r, deskAddress);
            _runVouch(agent, r, deskAddress);
        }
        spent = start - balanceOf[agent];
        if (spent == 0) revert NothingToDo();
        totals_[agent].runs += 1;
        emit Ran(agent, msg.sender, spent, balanceOf[agent]);
    }

    /// @dev Step 1. Returns whether the line still owes afterwards.
    function _runRepay(address agent, Rules storage r, address deskAddress) internal returns (bool owes) {
        if (!r.repay) return false;
        (uint256 amount, uint256 debt) = _planRepay(agent, r, deskAddress, _room(agent, r));
        if (amount != 0) {
            _take(agent, amount);
            try line.repay{value: amount}(deskAddress) {
                _count(agent, Step.Repay, amount);
                totals_[agent].repaid += amount;
                debt -= amount;
                emit LineRepaid(agent, deskAddress, amount, debt);
            } catch {
                _giveBack(agent, amount);
                emit Skipped(agent, Step.Repay, 0);
            }
        }
        return debt != 0;
    }

    /// @dev Step 2.
    function _runCompute(address agent, Rules storage r) internal {
        uint256 amount = _planCompute(agent, r, _room(agent, r));
        if (amount == 0) return;
        _take(agent, amount);
        (bool ok,) = gateway.call{value: amount}("");
        if (ok) {
            _count(agent, Step.Compute, amount);
            totals_[agent].compute += amount;
            emit ComputePrepaid(agent, gateway, amount);
        } else {
            _giveBack(agent, amount);
            emit Skipped(agent, Step.Compute, 0);
        }
    }

    /// @dev Step 3, one claim: bought if it is inside the rules, and handed to the agent at once.
    function _runClaim(address agent, Rules storage r, uint256 id) internal {
        (uint256 price, uint256 job, uint256 face) = _planClaim(agent, r, id, _room(agent, r), 0);
        if (price == 0) return;
        _take(agent, price);
        try claims.buy{value: price}(id) {
            claims.give(id, agent);
            _count(agent, Step.Claims, price);
            totals_[agent].claims += price;
            totals_[agent].claimsBought += 1;
            emit ClaimBought(agent, id, job, price, face);
        } catch {
            _giveBack(agent, price);
            emit Skipped(agent, Step.Claims, id);
        }
    }

    /// @dev Step 4.
    function _runGuarantee(address agent, Rules storage r, address deskAddress) internal {
        uint256 amount = _planGuarantee(r, deskAddress, _room(agent, r));
        if (amount == 0) return;
        _take(agent, amount);
        try guarantee.addBond{value: amount}(deskAddress) {
            totals_[agent].guarantee += amount;
            emit GuaranteeBacked(agent, deskAddress, amount, guarantee.bondOf(deskAddress).bond);
        } catch {
            _giveBack(agent, amount);
            emit Skipped(agent, Step.Guarantee, 0);
        }
    }

    /// @dev Step 5.
    function _runVouch(address agent, Rules storage r, address deskAddress) internal {
        uint256 amount = _planVouch(r, deskAddress, _room(agent, r));
        if (amount == 0) return;
        _take(agent, amount);
        try vouch.addBond{value: amount}(deskAddress) {
            totals_[agent].vouch += amount;
            emit VouchBacked(agent, deskAddress, amount, vouch.voucherOf(deskAddress).bond);
        } catch {
            _giveBack(agent, amount);
            emit Skipped(agent, Step.Vouch, 0);
        }
    }

    // ---------- views ----------

    /// @notice An agent's rules, whole.
    function rulesOf(address agent) external view returns (Rules memory) {
        return rules_[agent];
    }

    /// @notice What an agent's treasury has done, in all.
    function totalsOf(address agent) external view returns (Totals memory) {
        return totals_[agent];
    }

    /// @notice What a run may spend right now: what the treasury holds above its floor.
    function spendable(address agent) external view returns (uint256) {
        return _room(agent, rules_[agent]);
    }

    /// @notice What a daily use has spent today (the day from midnight UTC). Zero for the two bond uses.
    function spentToday(address agent, Step step) public view returns (uint256) {
        Day storage d = days_[agent][step];
        return d.day == block.timestamp / DAY ? d.spent : 0;
    }

    /// @notice What `run(agent, claimIds)` would do now if every door answers: the amount of each step, and for each
    ///         claim named its price if it would be bought, otherwise 0. `blocked` says the line would still owe after
    ///         the repayment, so nothing after it would be done.
    function preview(address agent, uint256[] calldata claimIds)
        external
        view
        returns (
            uint256 repay,
            uint256 compute,
            uint256[] memory claimPrices,
            uint256 toGuarantee,
            uint256 toVouch,
            bool blocked
        )
    {
        claimPrices = new uint256[](claimIds.length);
        if (claimIds.length > MAX_CLAIMS) revert TooMany();
        Rules storage r = rules_[agent];
        address deskAddress = vouch.agentOf(agent);
        uint256 room = _room(agent, r);
        if (r.repay) {
            uint256 debt;
            (repay, debt) = _planRepay(agent, r, deskAddress, room);
            room -= repay;
            if (debt != repay) return (repay, 0, claimPrices, 0, 0, true);
        }
        compute = _planCompute(agent, r, room);
        room -= compute;
        room -= _previewClaims(agent, r, claimIds, claimPrices, room);
        toGuarantee = _planGuarantee(r, deskAddress, room);
        room -= toGuarantee;
        toVouch = _planVouch(r, deskAddress, room);
    }

    // ---------- internals ----------

    function _deposit(address agent) internal {
        if (msg.value == 0) revert ZeroAmount();
        uint256 b = balanceOf[agent] + msg.value;
        balanceOf[agent] = b;
        held += msg.value;
        totals_[agent].deposited += msg.value;
        emit Deposited(agent, msg.sender, msg.value, b);
    }

    function _room(address agent, Rules storage r) internal view returns (uint256) {
        uint256 b = balanceOf[agent];
        return b > r.floor ? b - r.floor : 0;
    }

    function _take(address agent, uint256 amount) internal {
        balanceOf[agent] -= amount;
        held -= amount;
    }

    function _giveBack(address agent, uint256 amount) internal {
        balanceOf[agent] += amount;
        held += amount;
    }

    function _count(address agent, Step step, uint256 amount) internal {
        Day storage d = days_[agent][step];
        uint64 today = uint64(block.timestamp / DAY);
        if (d.day != today) {
            d.day = today;
            d.spent = 0;
        }
        d.spent += uint192(amount);
    }

    function _left(address agent, Step step, uint256 daily, uint256 more) internal view returns (uint256) {
        uint256 used = spentToday(agent, step) + more;
        return daily > used ? daily - used : 0;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @dev What the line would be repaid, and what it owes now.
    function _planRepay(address agent, Rules storage r, address deskAddress, uint256 room)
        internal
        view
        returns (uint256 amount, uint256 debt)
    {
        debt = line.debtOf(deskAddress);
        amount = _min(debt, _min(room, _left(agent, Step.Repay, r.repayDaily, 0)));
    }

    function _planCompute(address agent, Rules storage r, uint256 room) internal view returns (uint256 amount) {
        if (!r.compute) return 0;
        amount = _min(room, _left(agent, Step.Compute, r.computeDaily, 0));
        if (amount < MIN_STEP) amount = 0;
    }

    /// @dev The price of a claim if the rules let the treasury buy it now, otherwise 0. `more` is what a preview has
    ///      already planned to spend on claims today.
    function _planClaim(address agent, Rules storage r, uint256 id, uint256 room, uint256 more)
        internal
        view
        returns (uint256 price, uint256 job, uint256 face)
    {
        if (!r.claims) return (0, 0, 0);
        FactorClaims.Claim memory c = claims.claim(id);
        if (c.state != FactorClaims.State.Listed || c.price == 0) return (0, 0, 0);
        if (c.price > r.claimMaxPrice || c.price > room || c.price > _left(agent, Step.Claims, r.claimsDaily, more)) {
            return (0, 0, 0);
        }
        if ((c.face - c.price) * BPS < c.face * uint256(r.claimMinDiscountBps)) return (0, 0, 0);
        // never its own: that would only move the treasury's ETH to the agent's key
        address seller = claims.keyOf(c.account);
        if (seller == agent || vouch.agentOf(seller) == vouch.agentOf(agent)) return (0, 0, 0);
        if (desk.score(c.account) < r.claimMinScore) return (0, 0, 0);
        if (r.claimDeliveredOnly && desk.job(c.job).state != FactorDesk.State.Delivered) return (0, 0, 0);
        return (c.price, c.job, c.face);
    }

    /// @dev Fills `prices` with what a run would pay for each claim named, in order, and returns the sum.
    function _previewClaims(
        address agent,
        Rules storage r,
        uint256[] calldata ids,
        uint256[] memory prices,
        uint256 room
    ) internal view returns (uint256 bought) {
        for (uint256 i = 0; i < ids.length; ++i) {
            bool again;
            for (uint256 k = 0; k < i; ++k) {
                if (ids[k] == ids[i] && prices[k] != 0) again = true;
            }
            if (again) continue;
            (uint256 price,,) = _planClaim(agent, r, ids[i], room - bought, bought);
            prices[i] = price;
            bought += price;
        }
    }

    function _planGuarantee(Rules storage r, address deskAddress, uint256 room) internal view returns (uint256) {
        if (!r.guarantee || !desk.agent(deskAddress).registered) return 0;
        return _topUp(guarantee.bondOf(deskAddress).bond, r.guaranteeUpTo, room);
    }

    function _planVouch(Rules storage r, address deskAddress, uint256 room) internal view returns (uint256) {
        if (!r.vouch || !desk.agent(deskAddress).registered) return 0;
        return _topUp(vouch.voucherOf(deskAddress).bond, r.vouchUpTo, room);
    }

    function _topUp(uint256 bond, uint256 upTo, uint256 room) internal pure returns (uint256 amount) {
        if (bond >= upTo) return 0;
        amount = _min(upTo - bond, room);
        if (amount < MIN_STEP) amount = 0;
    }
}
