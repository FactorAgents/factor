// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FactorDesk} from "./FactorDesk.sol";
import {FactorLine} from "./FactorLine.sol";

/// @title FactorGuarantee
/// @notice Guarantees for agents on Factor's desk. See docs/GUARANTEES.md for every rule in plain words.
///
///         An agent puts up a guarantee bond here and sets an offer: the most cover it sells on one job. A customer
///         hiring it can buy cover: if the desk job ends refunded (the agent did not deliver by its due time and the
///         grace), the customer is paid the cover out of the agent's bond, on top of the desk's own refund. If the job
///         settles, settles at half or is declined, the cover goes back to the bond.
///
///         Every cover is held back from the agent's bond the moment it is reserved, so it is always backed in full:
///         no pool stands behind it and nothing is lent. A bond can only be taken out where it is free.
///
///         The desk takes the caller of lock() as the job's customer, so cover is bought before the job exists:
///           reserve  the customer names the agent and the job's terms and pays the 1% fee; the cover is held back
///           lock     the customer locks the job on the desk as usual
///           bind     anyone, within an hour: ties the reservation to the job, which must be locked after it, by the
///                    same customer, on exactly the terms reserved
///         A reservation not tied within the hour lapses and its cover goes back to the bond.
///
///         How much cover a job can have: the smallest of the agent's offer, its free bond, and a share of the price
///         set by the desk's own score (none under 200, a quarter from 200, half from 400, three quarters from 600, the
///         whole price from 800). The fee, held until the cover ends, then goes half to the burn pot and the rest to
///         the agent; back to the customer if the agent declined.
///
///         There is no owner and nothing can be set after deployment. Every number is a constant, and every address
///         is the desk's, the line contract's, or read from the desk.
/// @dev The contract's ETH is `bonds` (all agents' bonds, covers held back included), `feesHeld` (fees of covers that
///      have not ended) and `owedTotal` (payouts a wallet refused, waiting to be collected). `reserved` is the part of
///      `bonds` held back for covers. Every function that sends ETH or calls the desk is guarded against re-entry and
///      writes its state before ETH moves; payouts are pushed with a fixed amount of gas and one that is refused is
///      kept as owed.
contract FactorGuarantee is ReentrancyGuardTransient {
    uint256 public constant BPS = 10_000;
    /// @notice The fee on a cover, paid by the customer with the reservation.
    uint256 public constant FEE_BPS = 100;
    /// @notice The smallest cover.
    uint256 public constant MIN_COVER = 0.0001 ether;
    /// @notice A reservation is tied to its job within this long, or it lapses.
    uint256 public constant WINDOW = 1 hours;
    /// @dev The same bounded push as the desk's.
    uint256 internal constant PUSH_GAS = 50_000;
    uint256 internal constant PUSH_GAS_NEEDED = 95_000;

    enum State {
        None,
        Reserved, // held back from the bond, not tied to a job yet
        Bound, // tied to a desk job
        Released, // the job was delivered (settled or settled at half): back to the bond
        Paid, // the job was refunded: paid to the customer
        Declined, // the agent declined the job: back to the bond, the fee back to the customer
        Lapsed // not tied within the hour: back to the bond
    }

    /// @dev One cover. Every field is written by this contract and by nothing else.
    struct Cover {
        address customer;
        uint40 dueAt; // the job's due time, as reserved
        uint40 expiresAt; // the end of the hour to tie it
        State state;
        bool allowEarly; // the job's early switch, as reserved
        address agent;
        uint256 price; // the job's price, as reserved
        uint256 amount; // the cover
        uint256 fee;
        uint256 afterJob; // the desk's job count at the reservation: its job is locked after it
        uint256 job; // the desk job, once tied
    }

    /// @dev One agent's guarantee bond and record.
    struct Bond {
        uint256 bond; // all of it, covers held back included
        uint256 reserved; // held back for covers that have not ended
        uint256 offer; // the most cover it sells on one job
        uint32 covers; // tied to a job
        uint32 released; // delivered: back to the bond
        uint32 paid; // paid to a customer
        uint32 declined;
        uint32 lapsed;
        uint256 coveredTotal; // the cover of every job tied
        uint256 paidTotal; // paid out to customers
        uint256 feesEarned; // the agent's half of the fees
    }

    FactorDesk public immutable desk;
    /// @notice The credit line contract: a line account's key runs its bond and offer. Zero: no line accounts.
    FactorLine public immutable line;
    /// @notice The desk's burn pot: half of every fee buys back and burns $FACTOR there.
    address public immutable burnPot;
    /// @notice The desk's own numbers, read from it once.
    uint256 public immutable minJob;
    uint256 public immutable minDue;
    uint256 public immutable maxDue;
    uint256 public immutable grace;
    uint256 public immutable review;

    mapping(address agent => Bond) internal bonds_;
    mapping(uint256 id => Cover) internal covers;
    /// @notice The cover tied to a desk job, or 0.
    mapping(uint256 job => uint256 id) public coverOf;
    /// @notice A customer's latest reservation.
    mapping(address customer => uint256 id) public latestOf;
    uint256 public coverCount;

    /// @notice All bonds, the part held back for covers, the fees of covers that have not ended, and payouts waiting.
    uint256 public bonds;
    uint256 public reserved;
    uint256 public feesHeld;
    uint256 public owedTotal;
    mapping(address who => uint256) public owed;

    uint256 public totalCovered; // the cover of every job tied
    uint256 public totalPaid; // paid out to customers
    uint256 public totalFees;
    uint256 public totalBurned; // the burn half of every fee

    event BondAdded(address indexed agent, address indexed from, uint256 amount, uint256 bond);
    event BondTaken(address indexed agent, uint256 amount, uint256 bond);
    event OfferSet(address indexed agent, uint256 offer);
    event Reserved(
        uint256 indexed id,
        address indexed customer,
        address indexed agent,
        uint256 amount,
        uint256 fee,
        uint256 price,
        uint256 dueAt,
        bool allowEarly,
        uint256 expiresAt
    );
    event Bound(uint256 indexed id, uint256 indexed job, address indexed agent);
    /// @notice A cover ended: `paid` to the customer, the fee's halves to the agent and the burn, or `feeBack`.
    event Closed(
        uint256 indexed id,
        uint256 indexed job,
        address indexed agent,
        State how,
        uint256 paid,
        uint256 toAgent,
        uint256 burned,
        uint256 feeBack
    );
    event Owed(address indexed who, uint256 amount);
    event Collected(address indexed who, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error WrongDesk();
    error NotRegistered();
    error NotAgent();
    error SelfCover();
    error TooSmall(uint256 min);
    error JobTooSmall(uint256 min);
    error BadDueTime();
    error OverLimit(uint256 limit);
    error WrongFee(uint256 fee);
    error OverFree(uint256 free);
    error WrongState(State state);
    error Expired(uint256 at);
    error TooSoon(uint256 at);
    error NotTheJob();
    error JobCovered(uint256 id);
    error NoCover();
    error NotFinished(FactorDesk.State state);
    error NothingOwed();
    error PushFailed();
    error GasShort();

    constructor(FactorDesk desk_, FactorLine line_) {
        if (address(desk_) == address(0)) revert ZeroAddress();
        if (address(line_) != address(0) && address(line_.desk()) != address(desk_)) revert WrongDesk();
        desk = desk_;
        line = line_;
        burnPot = desk_.burnPot();
        if (burnPot == address(0)) revert ZeroAddress();
        minJob = desk_.MIN_JOB();
        minDue = desk_.MIN_DUE();
        maxDue = desk_.MAX_DUE();
        grace = desk_.GRACE();
        review = desk_.REVIEW();
    }

    // ---------- the agent's bond and offer ----------

    /// @notice Add the ETH sent to an agent's guarantee bond. Anyone may; nobody gets a claim on it by doing so.
    function addBond(address agent) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        if (!desk.agent(agent).registered) revert NotRegistered();
        Bond storage b = bonds_[agent];
        b.bond += msg.value;
        bonds += msg.value;
        emit BondAdded(agent, msg.sender, msg.value, b.bond);
    }

    /// @notice The agent (or its line key) takes out bond that no cover holds back. It goes to the agent's address.
    function takeBond(address agent, uint256 amount) external nonReentrant {
        _onlyAgent(agent);
        if (amount == 0) revert ZeroAmount();
        Bond storage b = bonds_[agent];
        uint256 free = b.bond - b.reserved;
        if (amount > free) revert OverFree(free);
        b.bond -= amount;
        bonds -= amount;
        emit BondTaken(agent, amount, b.bond);
        _pay(agent, amount);
    }

    /// @notice The agent (or its line key) sets the most cover it sells on one job: 0 for none.
    function setOffer(address agent, uint256 amount) external {
        _onlyAgent(agent);
        if (amount != 0 && amount < MIN_COVER) revert TooSmall(MIN_COVER);
        bonds_[agent].offer = amount;
        emit OfferSet(agent, amount);
    }

    // ---------- a cover ----------

    /// @notice Reserve cover for a job the caller is about to lock: the agent, the price, the due time and the early
    ///         switch it will be locked with, and the cover. msg.value is the fee, 1% of the cover. The cover is held
    ///         back from the agent's bond at once.
    function reserve(address agent, uint256 price, uint256 dueAt, bool allowEarly, uint256 amount)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        if (msg.sender == agent || msg.sender == keyOf(agent)) revert SelfCover();
        if (!desk.agent(agent).registered) revert NotRegistered();
        if (price < minJob) revert JobTooSmall(minJob);
        if (dueAt < block.timestamp + minDue || dueAt > block.timestamp + maxDue) revert BadDueTime();
        if (amount < MIN_COVER) revert TooSmall(MIN_COVER);
        uint256 cap = coverLimit(agent, price);
        if (amount > cap) revert OverLimit(cap);
        uint256 fee = feeFor(amount);
        if (msg.value != fee) revert WrongFee(fee);

        Bond storage b = bonds_[agent];
        b.reserved += amount;
        reserved += amount;
        feesHeld += fee;
        id = ++coverCount;
        Cover storage c = covers[id];
        c.customer = msg.sender;
        c.agent = agent;
        c.price = price;
        c.dueAt = uint40(dueAt);
        c.allowEarly = allowEarly;
        c.amount = amount;
        c.fee = fee;
        c.afterJob = desk.jobCount();
        c.expiresAt = uint40(block.timestamp + WINDOW);
        c.state = State.Reserved;
        latestOf[msg.sender] = id;
        emit Reserved(id, msg.sender, agent, amount, fee, price, dueAt, allowEarly, c.expiresAt);
    }

    /// @notice Anyone, within the hour: tie a reservation to its desk job. The job must have been locked after the
    ///         reservation, by its customer, for its agent, at its price, due time and early switch.
    function bind(uint256 id, uint256 job) external nonReentrant {
        _bind(id, job);
    }

    /// @notice Tie the caller's latest reservation to the newest job on the desk: for a reservation and a lock sent
    ///         together in one transaction (an account's order).
    function bindLatest() external nonReentrant {
        _bind(latestOf[msg.sender], desk.jobCount());
    }

    /// @notice Anyone, after the hour: a reservation that was never tied lapses. Its cover goes back to the bond and
    ///         its fee is split, for the hour the bond was held.
    function lapse(uint256 id) external nonReentrant {
        Cover storage c = covers[id];
        if (c.state != State.Reserved) revert WrongState(c.state);
        if (block.timestamp <= c.expiresAt) revert TooSoon(uint256(c.expiresAt) + 1);
        Bond storage b = bonds_[c.agent];
        c.state = State.Lapsed;
        b.reserved -= c.amount;
        reserved -= c.amount;
        b.lapsed += 1;
        _end(id, c, b, State.Lapsed, 0);
    }

    /// @notice Anyone, once a covered job is finished on the desk: refunded, the cover is paid to the customer out of
    ///         the agent's bond; settled, settled at half or declined, it goes back to the bond. A job due to be
    ///         refunded or settled is first refunded or settled on the desk, so one call is enough.
    function close(uint256 job) external nonReentrant {
        uint256 id = coverOf[job];
        if (id == 0) revert NoCover();
        Cover storage c = covers[id];
        if (c.state != State.Bound) revert WrongState(c.state);
        FactorDesk.Job memory j = desk.job(job);
        if (
            (j.state == FactorDesk.State.Locked || j.state == FactorDesk.State.Advanced)
                && block.timestamp > uint256(j.dueAt) + grace
        ) {
            desk.refund(job);
            j = desk.job(job);
        } else if (j.state == FactorDesk.State.Delivered && block.timestamp >= uint256(j.deliveredAt) + review) {
            desk.settle(job);
            j = desk.job(job);
        }
        Bond storage b = bonds_[c.agent];
        if (j.state == FactorDesk.State.Refunded) {
            c.state = State.Paid;
            b.reserved -= c.amount;
            reserved -= c.amount;
            b.bond -= c.amount;
            bonds -= c.amount;
            b.paid += 1;
            b.paidTotal += c.amount;
            totalPaid += c.amount;
            _end(id, c, b, State.Paid, c.amount);
        } else if (j.state == FactorDesk.State.Settled || j.state == FactorDesk.State.SettledAtHalf) {
            c.state = State.Released;
            b.reserved -= c.amount;
            reserved -= c.amount;
            b.released += 1;
            _end(id, c, b, State.Released, 0);
        } else if (j.state == FactorDesk.State.Declined) {
            c.state = State.Declined;
            b.reserved -= c.amount;
            reserved -= c.amount;
            b.declined += 1;
            _end(id, c, b, State.Declined, 0);
        } else {
            revert NotFinished(j.state);
        }
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

    /// @notice An agent's guarantee bond and record, whole.
    function bondOf(address agent) external view returns (Bond memory) {
        return bonds_[agent];
    }

    /// @notice A cover, whole. A number never given out reads as a cover in state None.
    function cover(uint256 id) external view returns (Cover memory) {
        return covers[id];
    }

    /// @notice What of an agent's bond no cover holds back: what it can take out, and the most a new cover can be.
    function freeOf(address agent) public view returns (uint256) {
        Bond storage b = bonds_[agent];
        return b.bond - b.reserved;
    }

    /// @notice The key of a line account, which runs its bond and offer; zero for any other address.
    function keyOf(address agent) public view returns (address) {
        return address(line) == address(0) ? address(0) : line.keyOf(agent);
    }

    /// @notice The score that sets an agent's share: the desk's own. For a line account, the better of the account's
    ///         and its key's, and 0 if either is barred on the desk or the line has defaulted.
    function scoreOf(address agent) public view returns (uint256 s) {
        s = desk.score(agent);
        address k = keyOf(agent);
        if (k == address(0)) return s;
        if (desk.agent(k).barred || desk.agent(agent).barred || line.line(agent).defaulted) return 0;
        uint256 ks = desk.score(k);
        if (ks > s) s = ks;
    }

    /// @notice The share of a job's price a score allows as cover, in hundredths of a percent.
    function shareOf(uint256 score) public pure returns (uint256) {
        if (score >= 800) return 10_000;
        if (score >= 600) return 7500;
        if (score >= 400) return 5000;
        if (score >= 200) return 2500;
        return 0;
    }

    /// @notice The most cover a job of `price` with `agent` can have right now: the smallest of the score's share of
    ///         the price, the agent's offer and its free bond.
    function coverLimit(address agent, uint256 price) public view returns (uint256 limit) {
        Bond storage b = bonds_[agent];
        limit = (price * shareOf(scoreOf(agent))) / BPS;
        if (b.offer < limit) limit = b.offer;
        uint256 free = b.bond - b.reserved;
        if (free < limit) limit = free;
    }

    /// @notice The fee on a cover: 1% of it.
    function feeFor(uint256 amount) public pure returns (uint256) {
        return (amount * FEE_BPS) / BPS;
    }

    // ---------- internals ----------

    function _onlyAgent(address agent) internal view {
        // a line account's key is never the zero address, and neither is a caller
        if (msg.sender != agent && msg.sender != keyOf(agent)) revert NotAgent();
    }

    function _bind(uint256 id, uint256 job) internal {
        Cover storage c = covers[id];
        if (c.state != State.Reserved) revert WrongState(c.state);
        if (block.timestamp > c.expiresAt) revert Expired(c.expiresAt);
        if (coverOf[job] != 0) revert JobCovered(coverOf[job]);
        if (job <= c.afterJob) revert NotTheJob();
        FactorDesk.Job memory j = desk.job(job);
        if (
            j.customer != c.customer || j.agent != c.agent || j.price != c.price || j.dueAt != c.dueAt
                || j.allowEarly != c.allowEarly
        ) revert NotTheJob();
        c.state = State.Bound;
        c.job = job;
        coverOf[job] = id;
        Bond storage b = bonds_[c.agent];
        b.covers += 1;
        b.coveredTotal += c.amount;
        totalCovered += c.amount;
        emit Bound(id, job, c.agent);
    }

    /// @dev A cover ends: its fee is no longer held. Declined, the fee goes back to the customer; otherwise half,
    ///      rounded down, to the burn pot and the rest to the agent. Then `paid` goes to the customer.
    function _end(uint256 id, Cover storage c, Bond storage b, State how, uint256 paid) internal {
        uint256 fee = c.fee;
        feesHeld -= fee;
        uint256 burned;
        uint256 toAgent;
        uint256 back;
        if (how == State.Declined) {
            back = fee;
        } else {
            burned = fee / 2;
            toAgent = fee - burned;
            b.feesEarned += toAgent;
            totalFees += fee;
            totalBurned += burned;
        }
        emit Closed(id, c.job, c.agent, how, paid, toAgent, burned, back);
        _pay(c.customer, paid + back);
        _pay(burnPot, burned);
        _pay(c.agent, toAgent);
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
