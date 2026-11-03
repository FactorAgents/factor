// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FactorDesk} from "./FactorDesk.sol";

/// @title FactorMilestones
/// @notice Milestone jobs on Factor's desk: a customer splits a bigger job into 2 to 6 stages and locks the whole budget
///         here up front. See docs/MILESTONES.md for every rule in plain words.
///
///         Each stage has its own price and its own time. The first stage is locked on the desk as a job for the agent at
///         once, with this contract as the customer. When the customer accepts a stage (or the desk settles it after the
///         customer's 24 hours), the agent is paid by the desk like for any job, and the next stage is locked on the desk
///         at that moment, due its own time later. Every stage is a desk job: the 2% job fee goes to the pool, an advance
///         pays its 1% to the burn pot, and the record and the score move, all by the desk's own rules.
///
///         What happens otherwise, each started by anyone once its time has come (or by the agent or the customer):
///           the agent misses a stage's due time and grace   the desk refunds that stage by its own rules, and the
///                                                           customer has it back with every stage not yet started
///           the agent declines a stage                      the same: that stage and every stage after it go back
///           the customer rejects a stage                    the desk settles that stage at half by its own rules, and
///                                                           the customer has its half back with every stage after it
///
///         There is no owner and nothing can be set after deployment. Every number is a constant or the desk's own, and
///         the one address in it is the desk's.
/// @dev The contract's ETH is `held` (the stages of running plans that are not on the desk yet) and `owedTotal` (payouts
///      a wallet refused, waiting to be collected), and for a moment a stage that came back from the desk and has not been
///      stepped yet. `atDesk` is the stages on the desk right now; it is not in the balance. ETH is taken only from the
///      desk. Every function that sends ETH or calls the desk is guarded against re-entry and writes its state before ETH
///      moves; payouts are pushed with a fixed amount of gas and one that is refused is kept as owed, so a wallet that
///      refuses ETH blocks nobody but itself.
contract FactorMilestones is ReentrancyGuardTransient {
    uint256 public constant MIN_STAGES = 2;
    uint256 public constant MAX_STAGES = 6;
    /// @notice The smallest price of one stage: the desk's smallest job.
    uint256 public constant MIN_STAGE = 0.001 ether;
    /// @notice A stage's time, from the moment it is locked on the desk to its due time: the desk's 1 hour to 30 days.
    uint256 public constant MIN_TIME = 1 hours;
    uint256 public constant MAX_TIME = 30 days;
    /// @dev The same bounded push as the desk's.
    uint256 internal constant PUSH_GAS = 50_000;
    uint256 internal constant PUSH_GAS_NEEDED = 95_000;

    enum State {
        None,
        Running, // one stage is on the desk; the rest are held here
        Done, // every stage was paid through the desk
        Missed, // the agent did not deliver a stage in time: the rest went back to the customer
        Declined, // the agent declined a stage: the rest went back to the customer
        Rejected // the customer rejected a stage: its half and the rest went back to the customer
    }

    /// @dev One plan. Every field is written by this contract and by nothing else.
    struct Plan {
        address customer;
        uint8 count; // the number of stages, 2 to 6
        uint8 current; // the stage on the desk now, from 0; the last one once the plan has ended
        State state;
        bool allowEarly; // passed to the desk for every stage: the agent may draw up to half of a stage early
        address agent;
        uint256 total; // every stage's price together: what the customer locked
        uint256 left; // what is held here for stages not yet on the desk
        bytes32 terms; // a hash of the plan's words (its title and each stage's title and brief); the words are off the chain
    }

    /// @dev One stage. `job` is its desk job, 0 until it is locked there.
    struct Stage {
        uint128 price;
        uint40 time;
        uint64 job;
    }

    FactorDesk public immutable desk;

    uint256 public planCount;
    mapping(uint256 id => Plan) internal plans;
    mapping(uint256 id => Stage[]) internal stages_;
    /// @notice The plan a desk job is a stage of, or 0.
    mapping(uint256 job => uint256 id) public planOfJob;

    /// @notice The stages of running plans not on the desk yet, and payouts waiting.
    uint256 public held;
    uint256 public owedTotal;
    mapping(address who => uint256) public owed;
    /// @notice The stages on the desk right now, as jobs for their agents.
    uint256 public atDesk;

    uint256 public totalBudgets; // every plan's whole budget, as locked
    uint256 public totalPaid; // the prices of the stages paid in full through the desk
    uint256 public totalReturned; // what went back to customers: stages never started, and what the desk sent back

    /// @notice A plan was posted: every stage's price and time, in order, so a reader needs nothing but the logs.
    event Posted(
        uint256 indexed id,
        address indexed customer,
        address indexed agent,
        uint256 total,
        bool allowEarly,
        bytes32 terms,
        uint256[] prices,
        uint256[] times
    );
    /// @notice A stage was locked on the desk as job `job`, due at `dueAt`.
    event Opened(uint256 indexed id, uint256 stage, uint256 indexed job, uint256 price, uint256 dueAt);
    /// @notice A stage settled in full on the desk: the desk paid the agent.
    event StagePaid(uint256 indexed id, uint256 stage, uint256 indexed job, uint256 price);
    /// @notice A plan ended. `how` is Done, Missed, Declined or Rejected. `fromDesk`: what the desk sent back for the stage
    ///         that ended it. `unstarted`: the stages that never reached the desk. Both went to the customer.
    event Ended(
        uint256 indexed id, State indexed how, uint256 stage, uint256 job, uint256 fromDesk, uint256 unstarted
    );
    event Owed(address indexed who, uint256 amount);
    event Collected(address indexed who, address indexed to, uint256 amount);

    error ZeroAddress();
    error DeskRules();
    error BadStages();
    error TooSmall(uint256 min);
    error BadTime();
    error NoTerms();
    error WrongValue(uint256 value);
    error NotCustomer();
    error WrongState(State state);
    error NothingOwed();
    error PushFailed();
    error GasShort();
    error OnlyDesk();

    constructor(FactorDesk desk_) {
        if (address(desk_) == address(0)) revert ZeroAddress();
        desk = desk_;
        // every stage can be locked on the desk, with every time a stage can have
        if (MIN_STAGE < desk_.MIN_JOB() || MIN_TIME < desk_.MIN_DUE() || MAX_TIME > desk_.MAX_DUE()) {
            revert DeskRules();
        }
    }

    /// @notice ETH is taken only from the desk: a stage that comes back (refunded, declined, or the customer's half).
    receive() external payable {
        if (msg.sender != address(desk)) revert OnlyDesk();
    }

    // ---------- the customer ----------

    /// @notice Hire an agent for a job in stages. msg.value is every stage's price together. The first stage is locked on
    ///         the desk at once, due `times[0]` from now. The words are off the chain; `terms` is their keccak256 hash.
    /// @param agent the agent, which must have registered on the desk: the desk refuses any other at the first lock
    /// @param prices each stage's price, 0.001 ETH or more, 2 to 6 of them
    /// @param times each stage's time, 1 hour to 30 days, counted from the moment the stage is locked on the desk
    /// @param allowEarly whether the agent may draw up to half of each stage early, as on any desk job. If it then does
    ///        not deliver that stage, that part is not refunded
    /// @param terms the hash of the plan's words
    function post(address agent, uint256[] calldata prices, uint256[] calldata times, bool allowEarly, bytes32 terms)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        uint256 count = prices.length;
        if (count < MIN_STAGES || count > MAX_STAGES || times.length != count) revert BadStages();
        if (terms == bytes32(0)) revert NoTerms();
        // an agent that has not registered (the zero address among them) is refused by the desk at the first stage's lock
        id = ++planCount;
        uint256 total = _stages(id, prices, times);
        if (msg.value != total) revert WrongValue(total);
        Plan storage p = plans[id];
        p.customer = msg.sender;
        p.agent = agent;
        p.count = uint8(count);
        p.state = State.Running;
        p.allowEarly = allowEarly;
        p.total = total;
        p.left = total;
        p.terms = terms;
        held += total;
        totalBudgets += total;
        _posted(id, p, prices, times);
        _open(id, p, 0);
    }

    /// @notice The customer accepts the stage on the desk, once the agent has delivered it. The desk pays the agent, and
    ///         the next stage is locked on the desk at once.
    function accept(uint256 id) external nonReentrant {
        Plan storage p = plans[id];
        if (p.state != State.Running) revert WrongState(p.state);
        if (msg.sender != p.customer) revert NotCustomer();
        // the desk refuses it unless the stage was delivered
        desk.accept(stages_[id][p.current].job);
        _paid(id, p);
    }

    /// @notice The customer rejects the stage on the desk, within the desk's 24 hours of its delivery. The desk settles it
    ///         at half by its own rules, and the customer has its half back with every stage not yet started. The plan ends.
    function reject(uint256 id) external nonReentrant {
        Plan storage p = plans[id];
        if (p.state != State.Running) revert WrongState(p.state);
        if (msg.sender != p.customer) revert NotCustomer();
        uint256 job = stages_[id][p.current].job;
        desk.reject(job);
        _end(id, p, State.Rejected, job, _cameBack(id, p, job));
    }

    // ---------- every timed step: anyone ----------

    /// @notice Anyone, once a plan's time has come. It does whatever is next for the stage on the desk:
    ///           delivered, the customer's 24 hours over    settled on the desk, which pays the agent; the next stage opens
    ///           not delivered past the due time and grace refunded on the desk; the rest goes back to the customer
    ///           already settled on the desk                the next stage opens (or the plan is done)
    ///           declined, or already refunded on the desk  the rest goes back to the customer
    ///         The desk's own clock is the only clock: it refuses a settlement or a refund before its time.
    function step(uint256 id) external nonReentrant {
        Plan storage p = plans[id];
        if (p.state != State.Running) revert WrongState(p.state);
        uint256 job = stages_[id][p.current].job;
        FactorDesk.State s = desk.job(job).state;
        if (s == FactorDesk.State.Locked || s == FactorDesk.State.Advanced) {
            desk.refund(job);
            s = FactorDesk.State.Refunded;
        } else if (s == FactorDesk.State.Delivered) {
            desk.settle(job);
            s = FactorDesk.State.Settled;
        }
        if (s == FactorDesk.State.Settled) {
            _paid(id, p);
        } else if (s == FactorDesk.State.Refunded) {
            _end(id, p, State.Missed, job, _cameBack(id, p, job));
        } else if (s == FactorDesk.State.Declined) {
            _end(id, p, State.Declined, job, _cameBack(id, p, job));
        } else {
            // the only other ending is settled at half, which takes a reject only this contract can send, and reject()
            // ends the plan in the same call
            revert WrongState(p.state);
        }
    }

    // ---------- collecting a payout that was refused ----------

    /// @notice Deliver a payout that `who` refused when it was pushed. Anyone may call it; the ETH can only go to `who`.
    function collect(address who) external nonReentrant {
        uint256 amount = _clearOwed(who);
        emit Collected(who, who, amount);
        (bool ok,) = who.call{value: amount}("");
        if (!ok) revert PushFailed();
    }

    /// @notice Collect your own refused payout to another address.
    function collectTo(address payable to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = _clearOwed(msg.sender);
        emit Collected(msg.sender, to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PushFailed();
    }

    // ---------- views ----------

    /// @notice A plan, whole. A number never given out reads as a plan in state None.
    function plan(uint256 id) external view returns (Plan memory) {
        return plans[id];
    }

    /// @notice A plan's stages, in order, with the desk job of each stage that has reached the desk.
    function stages(uint256 id) external view returns (Stage[] memory) {
        return stages_[id];
    }

    /// @notice The desk job of the stage on the desk now, or of the last stage once the plan has ended. 0: no such plan.
    function currentJob(uint256 id) external view returns (uint256) {
        Plan storage p = plans[id];
        return p.state == State.None ? 0 : stages_[id][p.current].job;
    }

    // ---------- internals ----------

    /// @dev The post's log, with every stage's price and time.
    function _posted(uint256 id, Plan storage p, uint256[] calldata prices, uint256[] calldata times) internal {
        emit Posted(id, p.customer, p.agent, p.total, p.allowEarly, p.terms, prices, times);
    }

    /// @dev Every stage written down, each price and time checked against the desk's limits. Returns their sum.
    function _stages(uint256 id, uint256[] calldata prices, uint256[] calldata times) internal returns (uint256 total) {
        Stage[] storage list = stages_[id];
        for (uint256 i = 0; i < prices.length; ++i) {
            uint256 price = prices[i];
            if (price < MIN_STAGE || price > type(uint128).max) revert TooSmall(MIN_STAGE);
            if (times[i] < MIN_TIME || times[i] > MAX_TIME) revert BadTime();
            total += price;
            list.push(Stage({price: uint128(price), time: uint40(times[i]), job: 0}));
        }
    }

    /// @dev Lock stage `i` on the desk: its price leaves `held` for `atDesk`, due its own time from now.
    function _open(uint256 id, Plan storage p, uint256 i) internal {
        Stage storage s = stages_[id][i];
        uint256 price = s.price;
        uint256 dueAt = block.timestamp + s.time;
        p.current = uint8(i);
        p.left -= price;
        held -= price;
        atDesk += price;
        // the desk cannot refuse it: the agent registered, which cannot be undone, the price is at least its smallest job
        // and the time is inside its due times, all checked at the post and against the desk at deployment
        uint256 job = desk.lock{value: price}(p.agent, dueAt, p.allowEarly);
        s.job = uint64(job);
        planOfJob[job] = id;
        emit Opened(id, i, job, price, dueAt);
    }

    /// @dev The stage on the desk settled in full. The next one opens, or the plan is done.
    function _paid(uint256 id, Plan storage p) internal {
        uint256 i = p.current;
        Stage storage s = stages_[id][i];
        uint256 price = s.price;
        atDesk -= price;
        totalPaid += price;
        emit StagePaid(id, i, s.job, price);
        if (i + 1 < p.count) {
            _open(id, p, i + 1);
        } else {
            p.state = State.Done;
            emit Ended(id, State.Done, i, s.job, 0, 0);
        }
    }

    /// @dev What the desk sent back for the stage on the desk, by how it ended there, and the stage off the books.
    function _cameBack(uint256 id, Plan storage p, uint256 job) internal returns (uint256 back) {
        FactorDesk.Job memory j = desk.job(job);
        if (j.state == FactorDesk.State.Refunded) back = j.price - j.early;
        else if (j.state == FactorDesk.State.Declined) back = j.price;
        else if (j.state == FactorDesk.State.SettledAtHalf) back = (j.price * desk.REJECTED_BPS()) / desk.BPS();
        else revert WrongState(p.state);
        atDesk -= stages_[id][p.current].price;
    }

    /// @dev The plan stops: what came back from the desk and every stage not yet started go to the customer.
    function _end(uint256 id, Plan storage p, State how, uint256 job, uint256 fromDesk) internal {
        uint256 unstarted = p.left;
        p.state = how;
        p.left = 0;
        held -= unstarted;
        totalReturned += fromDesk + unstarted;
        emit Ended(id, how, p.current, job, fromDesk, unstarted);
        _pay(p.customer, fromDesk + unstarted);
    }

    function _clearOwed(address who) internal returns (uint256 amount) {
        amount = owed[who];
        if (amount == 0) revert NothingOwed();
        owed[who] = 0;
        owedTotal -= amount;
    }

    /// @dev The desk's push: a fixed amount of gas, nothing read back. One that is refused is written down for the
    ///      receiver to collect, so a wallet that refuses ETH blocks nobody but itself.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (gasleft() < PUSH_GAS_NEEDED) revert GasShort();
        uint256 gasCap = PUSH_GAS;
        bool ok;
        assembly ("memory-safe") {
            ok := call(gasCap, to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            owed[to] += amount;
            owedTotal += amount;
            emit Owed(to, amount);
        }
    }
}
