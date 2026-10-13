// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FactorDesk
/// @notice Jobs between customers and AI agents, paid in ETH, and advances on those jobs.
///         A customer locks the whole price of a job here for one agent. The agent may draw up to half of it
///         before delivering, in three ways:
///           Early    out of the job's own locked payment, only if the customer switched that on. The customer
///                    carries it: that part is not refunded if the agent does not deliver.
///           Pool     from the pool, up to the agent's limit. The customer is refunded in full if the agent does
///                    not deliver; the agent's bond pays first, then the pool.
///           Compute  from the pool like the one above, but paid to the compute gateway's address, never to the
///                    agent.
///         When the job is delivered and settles, the contract repays the pool before the agent is paid.
///
///         The pool belongs to the protocol. It is filled by ETH sent to this contract (a share of $FACTOR's
///         trading fees, from the splitter) and by the fee on every settled job. Nobody deposits into it and
///         nobody can take it out: the only way ETH leaves the pool is as an advance on a locked job.
///
///         An agent's limit with the pool is its own bond plus the job fees its jobs have paid into the pool,
///         counted once. So an agent can never take more out of the pool than it has put in, and hiring itself
///         from another wallet to grow the limit costs exactly what the limit grows by.
///
///         There is no owner and nothing can be set after deployment. Every number is a constant, and the two
///         addresses (the burn pot and the compute gateway) are fixed in the bytecode.
/// @dev The contract's ETH is counted in four parts that never mix: `held` (open jobs' payments), `bonds`,
///      `owedTotal` (payouts a wallet refused, waiting to be collected) and `pool`. The balance is always at least
///      their sum. `out` is pool ETH that is with agents right now; it is not in the balance.
///
///      Every function that moves ETH is guarded against re-entry and writes its state first. Payouts are pushed
///      with a fixed amount of gas; one that is refused is written down in `owed` and blocks nobody else.
contract FactorDesk is ReentrancyGuard {
    uint256 public constant BPS = 10_000;
    /// @notice The most of a job that can be advanced, in all three ways together: half.
    uint256 public constant ADVANCE_MAX_BPS = 5000;
    /// @notice The fee on an advance, taken out of it as it is drawn. All of it goes to the burn pot.
    uint256 public constant ADVANCE_FEE_BPS = 100;
    /// @notice The fee on a job, taken from the agent's payout when it settles. All of it goes to the pool.
    uint256 public constant JOB_FEE_BPS = 200;
    /// @notice What goes back to a customer who rejects a delivery: half. The other half is the agent's side.
    uint256 public constant REJECTED_BPS = 5000;
    /// @notice The most of the pool that can be out with agents at one time.
    uint256 public constant POOL_OUT_MAX_BPS = 8000;
    uint256 public constant MIN_JOB = 0.001 ether;
    uint256 public constant MIN_DUE = 1 hours;
    uint256 public constant MAX_DUE = 30 days;
    /// @notice After the due time the agent has this much longer. A delivery in it counts and is marked late.
    uint256 public constant GRACE = 12 hours;
    /// @notice The customer's time to accept or reject a delivery. After it anyone can settle the job.
    uint256 public constant REVIEW = 24 hours;
    /// @notice A customer counts toward an agent's score once its settled jobs with that agent have paid this much
    ///         in job fees (0.05 ETH of settled work). Dust jobs from many wallets do not make customers.
    uint256 public constant CUSTOMER_FEES_MIN = 0.001 ether;
    /// @dev A wallet can carry code. A bounded push keeps such code from eating all the gas of a settlement.
    uint256 internal constant PUSH_GAS = 50_000;
    /// @dev What a caller must still have when a push starts, so that nobody can make a payout fail (and land in
    ///      `owed`) by sending a transaction with too little gas: the push itself, the cost of the call, and the
    ///      part the EVM keeps back.
    uint256 internal constant PUSH_GAS_NEEDED = 95_000;

    enum State {
        None,
        Locked,
        Advanced,
        Delivered,
        Settled,
        SettledAtHalf,
        Declined,
        Refunded
    }

    enum Kind {
        Early,
        Pool,
        Compute
    }

    struct Job {
        address customer;
        uint40 dueAt;
        uint40 deliveredAt;
        State state;
        bool allowEarly;
        bool late;
        address agent;
        uint256 price; // what the customer locked
        uint256 early; // drawn out of the job's own payment
        uint256 fromPool; // drawn from the pool, to the agent or as compute
        bytes32 proof; // a hash of what the agent handed over
    }

    /// @dev An agent's record. Every field is written by this contract and by nothing else.
    struct Agent {
        bool registered;
        bool barred; // once it failed to repay the pool, or kept an early advance without delivering
        uint40 firstSettledAt;
        uint32 settled;
        uint32 settledAtHalf;
        uint32 notDelivered; // jobs it drew an advance on and did not deliver
        uint32 unanswered; // jobs it neither took nor declined, which came back to the customer by themselves
        uint32 customers; // different customers whose settled jobs with it have paid CUSTOMER_FEES_MIN in fees
        uint32 onTime;
        uint32 late;
        uint32 advancesRepaid;
        uint32 advancesNotRepaid;
        uint32 earlyKept; // early advances kept without delivering
        uint256 bond;
        uint256 feesPaid; // job fees its jobs have paid into the pool
        uint256 advancedNow; // pool advances it has out right now
        uint256 volume; // the total price of its settled jobs
    }

    struct Customer {
        uint32 accepted; // jobs of theirs that settled in full
        uint32 rejected;
    }

    /// @notice Advance fees go here: the burn pot buys $FACTOR with them and burns it.
    address public immutable burnPot;
    /// @notice Compute advances are paid here, with the job's number in the event, never to the agent.
    address public immutable gateway;

    uint256 public jobCount;
    mapping(uint256 id => Job) internal jobs;
    mapping(address agent => Agent) internal agents;
    mapping(address customer => Customer) public customers;
    /// @notice The job fees one customer's settled jobs with one agent have paid.
    mapping(address agent => mapping(address customer => uint256)) public feesFrom;

    /// @notice Pool ETH that is here, and pool ETH that is out with agents. The pool is both together.
    uint256 public pool;
    uint256 public out;
    /// @notice What open jobs hold, all bonds, and payouts waiting to be collected.
    uint256 public held;
    uint256 public bonds;
    uint256 public owedTotal;
    mapping(address who => uint256) public owed;

    uint256 public totalAdvanced;
    uint256 public totalAdvanceFees;
    uint256 public totalJobFees;
    uint256 public totalSettled; // the price of every job that settled in full
    uint256 public totalPoolIn; // everything sent to the pool from outside
    /// @notice Pool advances that were never repaid and that no bond covered.
    uint256 public totalLost;

    event Registered(address indexed agent);
    event Locked(
        uint256 indexed id,
        address indexed customer,
        address indexed agent,
        uint256 price,
        uint256 dueAt,
        bool allowEarly
    );
    event Advanced(uint256 indexed id, address indexed agent, Kind kind, uint256 amount, uint256 fee);
    event Delivered(uint256 indexed id, address indexed agent, bytes32 proof, bool late);
    event Settled(uint256 indexed id, address indexed agent, uint256 toAgent, uint256 poolRepaid, uint256 jobFee);
    event SettledAtHalf(
        uint256 indexed id,
        address indexed agent,
        uint256 toCustomer,
        uint256 toAgent,
        uint256 poolRepaid,
        uint256 jobFee
    );
    event Declined(uint256 indexed id, address indexed agent, uint256 toCustomer);
    event Refunded(
        uint256 indexed id, address indexed agent, uint256 toCustomer, uint256 notRepaid, uint256 fromBond, uint256 lost
    );
    event BondAdded(address indexed agent, uint256 amount, uint256 bond);
    event BondTaken(address indexed agent, uint256 amount, uint256 bond);
    event PoolIn(address indexed from, uint256 amount);
    event Owed(address indexed who, uint256 amount);
    event Collected(address indexed who, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NotRegistered();
    error AlreadyRegistered();
    error TooSmall(uint256 min);
    error BadDueTime();
    error NotAgent();
    error NotCustomer();
    error WrongState(State state);
    error TooLate();
    error TooSoon(uint256 at);
    error OverHalf(uint256 room);
    error EarlyNotAllowed();
    error Barred();
    error OverLimit(uint256 canDraw);
    error PoolShort(uint256 room);
    error OwesThePool(uint256 advancedNow);
    error OverBond(uint256 bond);
    error NothingOwed();
    error PushFailed();
    error GasShort();

    constructor(address burnPot_, address gateway_) {
        if (burnPot_ == address(0) || gateway_ == address(0)) revert ZeroAddress();
        burnPot = burnPot_;
        gateway = gateway_;
    }

    /// @notice ETH sent here goes into the pool. This is how the splitter delivers the pool's share of $FACTOR's
    ///         trading fees. Anyone may add to the pool; nobody gets a claim on it by doing so.
    receive() external payable {
        pool += msg.value;
        totalPoolIn += msg.value;
        emit PoolIn(msg.sender, msg.value);
    }

    // ---------- agents ----------

    /// @notice Become an agent. Once.
    function register() external {
        Agent storage a = agents[msg.sender];
        if (a.registered) revert AlreadyRegistered();
        a.registered = true;
        emit Registered(msg.sender);
    }

    /// @notice Add to your bond. It raises your limit with the pool, and it pays first if you do not repay.
    function addBond() external payable nonReentrant {
        Agent storage a = agents[msg.sender];
        if (!a.registered) revert NotRegistered();
        if (msg.value == 0) revert ZeroAmount();
        a.bond += msg.value;
        bonds += msg.value;
        emit BondAdded(msg.sender, msg.value, a.bond);
    }

    /// @notice Take bond out. Only while you owe the pool nothing.
    function takeBond(uint256 amount) external nonReentrant {
        Agent storage a = agents[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (a.advancedNow != 0) revert OwesThePool(a.advancedNow);
        if (amount > a.bond) revert OverBond(a.bond);
        a.bond -= amount;
        bonds -= amount;
        emit BondTaken(msg.sender, amount, a.bond);
        _pay(msg.sender, amount);
    }

    // ---------- a job ----------

    /// @notice Lock the price of a job for one agent. msg.value is the price.
    /// @param to the agent, which must have registered
    /// @param dueAt when the job is due, between 1 hour and 30 days from now
    /// @param allowEarly whether the agent may draw up to half of this payment early. If it then does not
    ///        deliver, that part is not refunded.
    function lock(address to, uint256 dueAt, bool allowEarly) external payable nonReentrant returns (uint256 id) {
        if (!agents[to].registered) revert NotRegistered();
        if (msg.value < MIN_JOB) revert TooSmall(MIN_JOB);
        if (dueAt < block.timestamp + MIN_DUE || dueAt > block.timestamp + MAX_DUE) revert BadDueTime();
        id = ++jobCount;
        Job storage j = jobs[id];
        j.customer = msg.sender;
        j.agent = to;
        j.dueAt = uint40(dueAt);
        j.allowEarly = allowEarly;
        j.price = msg.value;
        j.state = State.Locked;
        held += msg.value;
        emit Locked(id, msg.sender, to, msg.value, dueAt, allowEarly);
    }

    /// @notice The agent draws an advance on a job. The 1% fee comes out of the advance and goes to the burn pot;
    ///         the rest goes to the agent, or to the compute gateway for a compute advance.
    function draw(uint256 id, uint256 amount, Kind kind) external nonReentrant {
        Job storage j = jobs[id];
        if (msg.sender != j.agent) revert NotAgent();
        if (j.state != State.Locked && j.state != State.Advanced) revert WrongState(j.state);
        // a job that can already be refunded is not advanced on
        if (block.timestamp > uint256(j.dueAt) + GRACE) revert TooLate();
        if (amount == 0) revert ZeroAmount();
        uint256 room = (j.price * ADVANCE_MAX_BPS) / BPS - j.early - j.fromPool;
        if (amount > room) revert OverHalf(room);

        address to = msg.sender;
        if (kind == Kind.Early) {
            if (!j.allowEarly) revert EarlyNotAllowed();
            j.early += amount;
            held -= amount;
        } else {
            Agent storage a = agents[msg.sender];
            if (a.barred) revert Barred();
            uint256 can = canDraw(msg.sender);
            if (amount > can) revert OverLimit(can);
            uint256 poolRoom_ = poolRoom();
            if (amount > poolRoom_) revert PoolShort(poolRoom_);
            j.fromPool += amount;
            a.advancedNow += amount;
            pool -= amount;
            out += amount;
            if (kind == Kind.Compute) to = gateway;
        }
        j.state = State.Advanced;
        uint256 fee = (amount * ADVANCE_FEE_BPS) / BPS;
        totalAdvanced += amount;
        totalAdvanceFees += fee;
        emit Advanced(id, msg.sender, kind, amount, fee);
        _pay(burnPot, fee);
        _pay(to, amount - fee);
    }

    /// @notice The agent delivers. `proof` is a hash of what it handed over; the work itself stays between the
    ///         agent and the customer. Valid through the 12 hours of grace, and marked late after the due time.
    function deliver(uint256 id, bytes32 proof) external nonReentrant {
        Job storage j = jobs[id];
        if (msg.sender != j.agent) revert NotAgent();
        if (j.state != State.Locked && j.state != State.Advanced) revert WrongState(j.state);
        if (block.timestamp > uint256(j.dueAt) + GRACE) revert TooLate();
        j.state = State.Delivered;
        j.deliveredAt = uint40(block.timestamp);
        j.late = block.timestamp > j.dueAt;
        j.proof = proof;
        emit Delivered(id, msg.sender, proof, j.late);
    }

    /// @notice The agent says no, before drawing or delivering. The customer has everything back.
    function decline(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (msg.sender != j.agent) revert NotAgent();
        if (j.state != State.Locked) revert WrongState(j.state);
        j.state = State.Declined;
        held -= j.price;
        emit Declined(id, msg.sender, j.price);
        _pay(j.customer, j.price);
    }

    /// @notice The customer accepts the delivery: the pool is repaid, the agent gets the rest.
    function accept(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (msg.sender != j.customer) revert NotCustomer();
        if (j.state != State.Delivered) revert WrongState(j.state);
        _settle(id, j);
    }

    /// @notice Anyone, once the customer's 24 hours have passed without a word: the job settles as if accepted.
    function settle(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.state != State.Delivered) revert WrongState(j.state);
        uint256 at = uint256(j.deliveredAt) + REVIEW;
        if (block.timestamp < at) revert TooSoon(at);
        _settle(id, j);
    }

    /// @notice The customer rejects the delivery, within 24 hours of it. The job settles at half: half of the
    ///         price goes back to the customer. The other half is the agent's side: it repays the pool first,
    ///         pays the job fee on that half, and the agent keeps what is left. An early advance the agent
    ///         already drew counts as part of its half. There is no judge and no vote.
    function reject(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (msg.sender != j.customer) revert NotCustomer();
        if (j.state != State.Delivered) revert WrongState(j.state);
        if (block.timestamp >= uint256(j.deliveredAt) + REVIEW) revert TooLate();
        j.state = State.SettledAtHalf;

        uint256 toCustomer = (j.price * REJECTED_BPS) / BPS;
        // the agent's side is never smaller than what was advanced: advances stop at half, rounded down, and
        // this half is rounded up
        uint256 left = j.price - toCustomer - j.early - j.fromPool;
        uint256 fee = ((j.price - toCustomer) * JOB_FEE_BPS) / BPS;
        if (fee > left) fee = left;
        uint256 toAgent = left - fee;

        held -= j.price - j.early;
        Agent storage a = agents[j.agent];
        _repayPool(a, j.fromPool);
        _takeJobFee(a, fee);
        a.settledAtHalf += 1;
        customers[j.customer].rejected += 1;
        emit SettledAtHalf(id, j.agent, toCustomer, toAgent, j.fromPool, fee);
        _pay(j.customer, toCustomer);
        _pay(j.agent, toAgent);
    }

    /// @notice Anyone, once the due time and the 12 hours of grace have passed without a delivery: the customer
    ///         gets the payment back, less any early advance the customer allowed. A pool advance on the job was
    ///         not repaid: it is taken from the agent's bond, and what the bond does not cover is the pool's
    ///         loss. The agent is never advanced by the pool again.
    /// @dev Only a job the agent drew on marks its record. Anyone can lock a job for any agent, so a job the
    ///      agent never touched is counted as unanswered and costs it nothing.
    function refund(uint256 id) external nonReentrant {
        Job storage j = jobs[id];
        if (j.state != State.Locked && j.state != State.Advanced) revert WrongState(j.state);
        uint256 at = uint256(j.dueAt) + GRACE;
        if (block.timestamp <= at) revert TooSoon(at + 1);
        j.state = State.Refunded;

        uint256 toCustomer = j.price - j.early;
        held -= toCustomer;
        Agent storage a = agents[j.agent];
        if (j.early + j.fromPool > 0) a.notDelivered += 1;
        else a.unanswered += 1;
        uint256 notRepaid = j.fromPool;
        uint256 fromBond;
        uint256 lost;
        if (notRepaid > 0) {
            fromBond = a.bond < notRepaid ? a.bond : notRepaid;
            lost = notRepaid - fromBond;
            a.bond -= fromBond;
            bonds -= fromBond;
            a.advancedNow -= notRepaid;
            out -= notRepaid;
            pool += fromBond;
            totalLost += lost;
            a.advancesNotRepaid += 1;
            a.barred = true;
        }
        if (j.early > 0) {
            a.earlyKept += 1;
            a.barred = true;
        }
        emit Refunded(id, j.agent, toCustomer, notRepaid, fromBond, lost);
        _pay(j.customer, toCustomer);
    }

    // ---------- collecting a payout that was refused ----------

    /// @notice Deliver a payout that `who` refused when it was pushed. Anyone may call it; the ETH can only go to
    ///         `who`.
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

    /// @notice A job, whole. A number that was never given out reads as a job in state None.
    function job(uint256 id) external view returns (Job memory) {
        return jobs[id];
    }

    /// @notice An agent's record, whole.
    function agent(address who) external view returns (Agent memory) {
        return agents[who];
    }

    /// @notice How far the pool will go for an agent: its bond plus the job fees it has paid in. Zero once barred.
    function limit(address who) public view returns (uint256) {
        Agent storage a = agents[who];
        return a.barred ? 0 : a.bond + a.feesPaid;
    }

    /// @notice What an agent can still draw from the pool, by its own limit.
    function canDraw(address who) public view returns (uint256) {
        uint256 l = limit(who);
        uint256 now_ = agents[who].advancedNow;
        return l > now_ ? l - now_ : 0;
    }

    /// @notice What the pool can still send out: it never has more than 80% of itself with agents.
    function poolRoom() public view returns (uint256) {
        uint256 cap = ((pool + out) * POOL_OUT_MAX_BPS) / BPS;
        return cap > out ? cap - out : 0;
    }

    /// @notice What can be drawn on one job right now: early (from the job's own payment) and from the pool.
    ///         The two share the job's half, so drawing one lowers the other.
    function canDrawOn(uint256 id) external view returns (uint256 early, uint256 fromPool) {
        Job storage j = jobs[id];
        if (j.state != State.Locked && j.state != State.Advanced) return (0, 0);
        if (block.timestamp > uint256(j.dueAt) + GRACE) return (0, 0);
        uint256 room = (j.price * ADVANCE_MAX_BPS) / BPS - j.early - j.fromPool;
        early = j.allowEarly ? room : 0;
        fromPool = room;
        uint256 can = canDraw(j.agent);
        if (can < fromPool) fromPool = can;
        uint256 poolRoom_ = poolRoom();
        if (poolRoom_ < fromPool) fromPool = poolRoom_;
    }

    /// @notice An agent's score, 0 to 1000, by one public formula. It moves no money: the pool's limit uses only
    ///         the bond and the fees paid.
    ///           0 if an advance was ever not repaid, or an early advance was kept without delivering
    ///           otherwise  fees paid, 1 point per 0.0005 ETH, at most 350
    ///                    + 25 per different customer whose jobs have paid 0.001 ETH in fees, at most 250
    ///                    + 10 per job settled, at most 200
    ///                    + 2 per day since its first settled job, at most 100
    ///                    + 10 per advance repaid, at most 100
    ///                    - 50 per job settled at half
    ///         A job it drew on and did not deliver always leaves one of the two marks in the first line.
    function score(address who) external view returns (uint256 s) {
        Agent storage a = agents[who];
        if (a.advancesNotRepaid > 0 || a.earlyKept > 0) return 0;
        s = _capped(a.feesPaid / 0.0005 ether, 350) + _capped(uint256(a.customers) * 25, 250)
            + _capped(uint256(a.settled) * 10, 200) + _capped(uint256(a.advancesRepaid) * 10, 100);
        if (a.firstSettledAt != 0) s += _capped(((block.timestamp - a.firstSettledAt) / 1 days) * 2, 100);
        uint256 less = uint256(a.settledAtHalf) * 50;
        s = s > less ? s - less : 0;
    }

    // ---------- internals ----------

    function _capped(uint256 v, uint256 max) internal pure returns (uint256) {
        return v < max ? v : max;
    }

    /// @dev A job that settles in full: the pool gets its advance back first, then the job fee, and the agent
    ///      gets the rest. The advance and the fee together are never more than what the job still holds:
    ///      advances stop at half of the price and the fee is 2% of it.
    function _settle(uint256 id, Job storage j) internal {
        j.state = State.Settled;
        uint256 fee = (j.price * JOB_FEE_BPS) / BPS;
        uint256 toAgent = j.price - j.early - j.fromPool - fee;

        held -= j.price - j.early;
        Agent storage a = agents[j.agent];
        _repayPool(a, j.fromPool);
        _takeJobFee(a, fee);
        a.settled += 1;
        a.volume += j.price;
        totalSettled += j.price;
        if (j.late) a.late += 1;
        else a.onTime += 1;
        if (a.firstSettledAt == 0) a.firstSettledAt = uint40(block.timestamp);
        // a customer is counted the moment its fees with this agent reach the floor, and only then
        uint256 before = feesFrom[j.agent][j.customer];
        feesFrom[j.agent][j.customer] = before + fee;
        if (before < CUSTOMER_FEES_MIN && before + fee >= CUSTOMER_FEES_MIN) a.customers += 1;
        customers[j.customer].accepted += 1;
        emit Settled(id, j.agent, toAgent, j.fromPool, fee);
        _pay(j.agent, toAgent);
    }

    function _repayPool(Agent storage a, uint256 amount) internal {
        if (amount == 0) return;
        a.advancedNow -= amount;
        a.advancesRepaid += 1;
        out -= amount;
        pool += amount;
    }

    function _takeJobFee(Agent storage a, uint256 fee) internal {
        a.feesPaid += fee;
        pool += fee;
        totalJobFees += fee;
    }

    function _clearOwed(address who) internal returns (uint256 amount) {
        amount = owed[who];
        if (amount == 0) revert NothingOwed();
        owed[who] = 0;
        owedTotal -= amount;
    }

    /// @dev A push with a fixed amount of gas that reads nothing the receiver returns. One that is refused is
    ///      written down for the receiver to collect, so a wallet that refuses ETH blocks nobody but itself.
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
