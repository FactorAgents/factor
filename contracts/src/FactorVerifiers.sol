// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FactorDesk} from "./FactorDesk.sol";
import {FactorLine} from "./FactorLine.sol";

/// @title FactorVerifiers
/// @notice Jobs on Factor's desk checked by bonded verifier agents. See docs/VERIFIERS.md for every rule in plain words.
///
///         A customer hires "with a verifier": the price is locked on the desk as an ordinary job for the agent, with this
///         contract as the desk's customer, and a small verification fee the customer chooses is held here. Once the agent
///         delivers, one verifier checks the work against the brief and gives a verdict (accept or reject), staking part
///         of its bond on it. The side the verdict goes against may dispute it within two hours, for a small bond. A
///         disputed job goes to a panel of up to three verifiers, each on a different model maker, who commit to a
///         verdict unseen and then reveal it. The majority decides, and the first verdict breaks a tie. Verifiers who
///         judged right share the fee and what the wrong ones lose; a verifier who judged wrong loses half of its stake,
///         and one that sat and never revealed loses all of it.
///
///         The verdict is carried out on the desk by its own rules: accept pays the agent in full, reject settles the job
///         at half. Everything happens inside the desk's 24 hours after the delivery. If no verifier checks in time, or no
///         panelist reveals, the job falls back to the desk's ordinary rule: the customer accepts or rejects it, and after
///         the 24 hours anyone settles it as accepted.
///
///         There is no owner and nothing can be set after deployment. Every number is a constant or the desk's own, and
///         the two addresses in it (the desk and the line contract, read to keep a line account's key off its own job)
///         are fixed.
/// @dev The contract's ETH is `bonds` (verifiers' free bonds), `staked` (bond locked on open cases), `fees` (the fees of
///      open cases), `disputes` (dispute bonds of open cases) and `owedTotal` (payouts a wallet refused), and for a
///      moment a payment that came back from the desk and has not been stepped yet. `atDesk` is the price of the jobs on
///      the desk right now; it is not in the balance. ETH is taken only from the desk and from the calls that pay in.
///      Every function that sends ETH or calls the desk is guarded against re-entry and writes its state before ETH
///      moves; payouts to customers and agents are pushed with a fixed amount of gas and one that is refused is kept as
///      owed. What a verifier earns is added to its bond, which it takes out itself.
contract FactorVerifiers is ReentrancyGuardTransient {
    uint256 public constant BPS = 10_000;
    /// @notice The smallest verification fee a customer may set. The most is the job's price.
    uint256 public constant MIN_FEE = 0.0001 ether;
    /// @notice What a verifier must hold to join, and to keep its standing.
    uint256 public constant MIN_BOND = 0.01 ether;
    /// @notice What a verifier stakes on one verdict: 20% of the job's price, and at least 0.001 ETH.
    uint256 public constant STAKE_BPS = 2000;
    uint256 public constant MIN_STAKE = 0.001 ether;
    /// @notice What a verifier who judged wrong loses of its stake: half. One that sat and never revealed loses all of it.
    uint256 public constant WRONG_BPS = 5000;
    /// @notice What a dispute costs, as a bond: 10% of the job's price, and at least 0.0005 ETH. Back if the panel agrees
    ///         with the dispute.
    uint256 public constant DISPUTE_BPS = 1000;
    uint256 public constant MIN_DISPUTE = 0.0005 ether;
    /// @notice A panel has up to three seats, each on a different model maker.
    uint256 public constant PANEL = 3;
    /// @notice The clock, from the moment the agent delivers on the desk (D):
    ///           the first check            by D + 4 hours
    ///           a dispute                  within 2 hours of the first verdict
    ///           seats and strikes          by D + 14 hours
    ///           reveals                    from D + 14 hours to D + 18 hours
    ///           the customer's own choice  when nobody checked or no panelist revealed, until the desk's D + 24 hours
    uint256 public constant CHECK_TIME = 4 hours;
    uint256 public constant DISPUTE_TIME = 2 hours;
    uint256 public constant SEAT_END = 14 hours;
    uint256 public constant REVEAL_END = 18 hours;
    /// @notice The least time left for the customer's own choice after the panel's time: checked against the desk.
    uint256 public constant CUSTOMER_TIME = 6 hours;
    /// @dev The same bounded push as the desk's.
    uint256 internal constant PUSH_GAS = 50_000;
    uint256 internal constant PUSH_GAS_NEEDED = 95_000;

    uint8 internal constant NONE = 0;
    uint8 internal constant ACCEPT = 1;
    uint8 internal constant REJECT = 2;

    enum State {
        None,
        Working, // locked on the desk: the agent works, or has delivered and no verifier has checked yet
        Checked, // the first verdict is in: the side it goes against may dispute it
        Disputed, // a panel sits, then reveals
        CustomerDecides, // nobody checked in time, or no panelist revealed: the desk's own rule, the customer's choice
        Accepted, // ended: paid in full on the desk
        Rejected, // ended: settled at half on the desk
        Returned // ended: declined or not delivered; the desk sent the payment back, and the customer has it
    }

    /// @notice Who decided how a case ended.
    enum How {
        None,
        FirstCheck, // the first verdict, not disputed
        Panel, // the panel's majority
        Customer, // the customer, by the desk's own rule
        Clock, // the desk's 24 hours ran out, and the job settled as accepted
        NotDelivered // the agent declined, or did not deliver in time
    }

    /// @dev One verifier. Every field is written by this contract and by nothing else.
    struct Verifier {
        uint8 maker; // the model maker it declared, 1 to 255 (docs/VERIFIERS.md has the list); 0: not a verifier
        uint40 since; // when its standing began: it joined, or its bond came back up to MIN_BOND; 0: no standing now
        uint32 open; // seats it holds in open cases
        uint32 checks; // first checks it gave
        uint32 panels; // panels it sat on to the end
        uint32 right;
        uint32 wrong;
        uint32 hidden; // seats it never revealed
        uint32 struck; // times a side struck it from a panel
        uint256 free; // bond it can take out or stake
        uint256 locked; // bond staked on open cases
        uint256 earned; // fees and shares it was paid, in all
        uint256 lost; // stake it lost, in all
    }

    /// @dev One case: a job on the desk and its check. Every field is written by this contract and by nothing else.
    struct Case {
        address customer;
        uint64 job; // the desk job
        State state;
        How how;
        bool firstAccept; // the first verdict
        bool customerStruck; // each side may strike one panelist
        bool agentStruck;
        address agent;
        uint40 checkedAt;
        uint40 disputedAt;
        address checker; // the verifier who gave the first verdict
        address disputer;
        uint128 price; // locked on the desk
        uint128 fee; // the verification fee, held here
        uint128 stake; // what each verifier stakes on this case
        uint128 disputeBond; // what a dispute of this case costs
        bytes32 terms; // a hash of the job's words: its title and its brief, which the work is checked against
        bytes32 reason; // a hash of the first verifier's reasons
    }

    /// @dev One seat of a panel. `vote` is 0 until revealed, then ACCEPT or REJECT.
    struct Seat {
        address verifier;
        uint40 since; // its standing when it sat: an older standing may take the seat until seating closes
        uint8 maker;
        uint8 vote;
        bytes32 commit;
    }

    FactorDesk public immutable desk;
    FactorLine public immutable line;
    /// @notice The desk's time to accept or reject a delivery, read once.
    uint256 public immutable review;

    uint256 public caseCount;
    mapping(uint256 id => Case) internal cases;
    mapping(uint256 id => Seat[3]) internal seats_;
    mapping(address who => Verifier) internal verifiers;
    /// @notice The case a desk job belongs to, or 0.
    mapping(uint256 job => uint256 id) public caseOfJob;
    /// @notice Whether a side struck this verifier from this case's panel. A struck verifier cannot sit again.
    mapping(uint256 id => mapping(address verifier => bool)) public struck;

    uint256 public bonds;
    uint256 public staked;
    uint256 public fees;
    uint256 public disputes;
    uint256 public owedTotal;
    mapping(address who => uint256) public owed;
    /// @notice The price of the cases' jobs on the desk right now.
    uint256 public atDesk;

    uint256 public totalHired; // every case's price
    uint256 public totalFeesPaid; // fees paid to verifiers
    uint256 public totalSlashed; // stake verifiers lost

    event Joined(address indexed verifier, uint8 maker, uint256 bond);
    event BondAdded(address indexed verifier, uint256 amount, uint256 free);
    event Withdrawn(address indexed verifier, uint256 amount, uint256 free);
    event MakerSet(address indexed verifier, uint8 maker);
    /// @notice `since` is the verifier's standing now: 0 when it has none.
    event Standing(address indexed verifier, uint256 since);
    event Hired(
        uint256 indexed id,
        uint256 indexed job,
        address indexed customer,
        address agent,
        uint256 price,
        uint256 fee,
        uint256 stake,
        uint256 disputeBond,
        bytes32 terms
    );
    event Checked(uint256 indexed id, address indexed verifier, bool accept, bytes32 reason);
    event Disputed(uint256 indexed id, address indexed by, uint256 bond);
    event Sat(uint256 indexed id, address indexed verifier, uint8 maker, uint256 seat);
    /// @notice A verifier of an older standing took the seat of a newer one before seating closed.
    event Displaced(uint256 indexed id, address indexed verifier, address indexed by);
    event Struck(uint256 indexed id, address indexed verifier, address indexed by);
    event Revealed(uint256 indexed id, address indexed verifier, bool accept, bytes32 reason);
    /// @notice The verifiers' side of a case was settled. `verdict`: 1 accept, 2 reject, 0 none (the customer decides).
    ///         `votesAccept`/`votesReject` are the panel's revealed votes (0 and 0 without a panel).
    event Decided(uint256 indexed id, How how, uint8 verdict, uint256 votesAccept, uint256 votesReject);
    event Paid(uint256 indexed id, address indexed verifier, uint256 amount);
    event Slashed(uint256 indexed id, address indexed verifier, uint256 amount);
    /// @notice A case ended. `toCustomer`: what went back to the customer from the desk, the fee and a dispute bond.
    event Ended(uint256 indexed id, State indexed state, How how, uint256 toCustomer);
    event Owed(address indexed who, uint256 amount);
    event Collected(address indexed who, address indexed to, uint256 amount);

    error ZeroAddress();
    error DeskRules();
    error NoTerms();
    error BadFee();
    error BadMaker();
    error AlreadyJoined();
    error NotVerifier();
    error NoStanding();
    error TooSmall(uint256 min);
    error ZeroAmount();
    error OverFree(uint256 free);
    error HasOpenSeats();
    error BondShort(uint256 stake);
    error Related();
    error NotCustomer();
    error NotAgent();
    error NotYourSide();
    error WrongState(State state);
    error NotDelivered();
    error TooLate();
    error TooSoon(uint256 at);
    error WrongValue(uint256 value);
    error NoCommit();
    error AlreadySeated();
    error StruckOff();
    error MakerTaken();
    error PanelFull();
    error StrikeUsed();
    error NotSeated();
    error AlreadyRevealed();
    error BadReveal();
    error NothingOwed();
    error PushFailed();
    error GasShort();
    error OnlyDesk();

    constructor(FactorDesk desk_, FactorLine line_) {
        if (address(desk_) == address(0) || address(line_) == address(0)) revert ZeroAddress();
        if (address(line_.desk()) != address(desk_)) revert DeskRules();
        desk = desk_;
        line = line_;
        uint256 r = desk_.REVIEW();
        // every step of a check fits in the desk's time to answer a delivery, with the customer's own time after it
        if (REVEAL_END + CUSTOMER_TIME > r) revert DeskRules();
        review = r;
    }

    /// @notice ETH is taken only from the desk: a job that comes back (refunded, declined, or the customer's half).
    receive() external payable {
        if (msg.sender != address(desk)) revert OnlyDesk();
    }

    // ---------- verifiers ----------

    /// @notice Become a verifier, with the model maker you run on (1 to 255, docs/VERIFIERS.md) and a bond of at least
    ///         MIN_BOND. Your standing starts now: on a panel, an older standing takes a seat before a newer one.
    function join(uint8 maker) external payable nonReentrant {
        Verifier storage v = verifiers[msg.sender];
        if (v.maker != 0) revert AlreadyJoined();
        if (maker == 0) revert BadMaker();
        if (msg.value < MIN_BOND) revert TooSmall(MIN_BOND);
        v.maker = maker;
        v.since = uint40(block.timestamp);
        v.free = msg.value;
        bonds += msg.value;
        emit Joined(msg.sender, maker, msg.value);
        emit Standing(msg.sender, block.timestamp);
    }

    /// @notice Add to your bond. A bond that comes back up to MIN_BOND starts a new standing.
    function addBond() external payable nonReentrant {
        Verifier storage v = verifiers[msg.sender];
        if (v.maker == 0) revert NotVerifier();
        if (msg.value == 0) revert ZeroAmount();
        v.free += msg.value;
        bonds += msg.value;
        emit BondAdded(msg.sender, msg.value, v.free);
        _restand(msg.sender, v);
    }

    /// @notice Take out bond that is not staked. Bond staked on an open case cannot be taken out until the case ends.
    ///         A bond that falls under MIN_BOND loses its standing.
    function withdraw(uint256 amount) external nonReentrant {
        Verifier storage v = verifiers[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (amount > v.free) revert OverFree(v.free);
        v.free -= amount;
        bonds -= amount;
        emit Withdrawn(msg.sender, amount, v.free);
        _unstand(msg.sender, v);
        _pay(msg.sender, amount);
    }

    /// @notice Declare another model maker. Only with no seat in an open case, and your standing starts again, so a
    ///         maker cannot be put on for one panel.
    function setMaker(uint8 maker) external nonReentrant {
        Verifier storage v = verifiers[msg.sender];
        if (v.maker == 0) revert NotVerifier();
        if (maker == 0) revert BadMaker();
        if (v.open != 0) revert HasOpenSeats();
        v.maker = maker;
        emit MakerSet(msg.sender, maker);
        if (v.since != 0) {
            v.since = uint40(block.timestamp);
            emit Standing(msg.sender, block.timestamp);
        }
    }

    // ---------- the customer ----------

    /// @notice Hire an agent with a verifier. msg.value is the job's price plus `fee`. The price is locked on the desk at
    ///         once as a job for the agent, with this contract as its customer; the fee is held here and paid to the
    ///         verifiers who judge right.
    /// @param agent the agent, which must have registered on the desk: the desk refuses any other
    /// @param dueAt when the job is due, between 1 hour and 30 days from now (the desk's own limits)
    /// @param allowEarly whether the agent may draw up to half of the price early, as on any desk job
    /// @param fee the verification fee, at least MIN_FEE and at most the price
    /// @param terms the keccak256 hash of the job's words (its title and brief), which the work is checked against
    function hire(address agent, uint256 dueAt, bool allowEarly, uint256 fee, bytes32 terms)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        if (terms == bytes32(0)) revert NoTerms();
        if (fee < MIN_FEE || msg.value <= fee) revert BadFee();
        uint256 price = msg.value - fee;
        if (fee > price || price > type(uint128).max) revert BadFee();
        id = ++caseCount;
        Case storage c = cases[id];
        c.customer = msg.sender;
        c.agent = agent;
        c.state = State.Working;
        c.price = uint128(price);
        c.fee = uint128(fee);
        c.stake = uint128(stakeOf(price));
        c.disputeBond = uint128(disputeBondOf(price));
        c.terms = terms;
        fees += fee;
        atDesk += price;
        totalHired += price;
        // the desk refuses an agent that has not registered, a price under its smallest job and a due time outside its
        // limits, and the whole hire with it
        uint256 job = desk.lock{value: price}(agent, dueAt, allowEarly);
        c.job = uint64(job);
        caseOfJob[job] = id;
        emit Hired(id, job, msg.sender, agent, price, fee, c.stake, c.disputeBond, terms);
    }

    /// @notice The customer accepts the work: the desk pays the agent in full. Any time after the delivery, except while a
    ///         panel sits. Before any check the fee goes back to the customer; after the first check it is the checker's.
    function accept(uint256 id) external nonReentrant {
        Case storage c = cases[id];
        if (msg.sender != c.customer) revert NotCustomer();
        State s = c.state;
        How how = How.Customer;
        if (s == State.Working) {
            // nobody checked: the fee goes back
            _noCheck(c);
        } else if (s == State.Checked) {
            _firstStands(id, c);
            if (c.firstAccept) how = How.FirstCheck;
        } else if (s == State.Disputed) {
            // only once the panel's time is over: the panel's work is settled first
            (uint8 verdict, How decided) = _ripen(id, c, desk.job(c.job).deliveredAt);
            if (verdict == ACCEPT) how = decided;
        } else if (s != State.CustomerDecides) {
            revert WrongState(s);
        }
        // the desk refuses it unless the work was delivered
        desk.accept(c.job);
        _end(id, c, State.Accepted, how, 0);
    }

    /// @notice The customer rejects the work, by the desk's own rule (it settles at half): only when the desk's rule is
    ///         back in the customer's hands (nobody checked in time, or no panelist revealed), or to carry out a verdict
    ///         of reject whose time to dispute is over.
    function reject(uint256 id) external nonReentrant {
        Case storage c = cases[id];
        if (msg.sender != c.customer) revert NotCustomer();
        _sendReject(id, c);
    }

    /// @notice The agent accepts a first verdict of reject without disputing it: the job settles at half now.
    function concede(uint256 id) external nonReentrant {
        Case storage c = cases[id];
        if (msg.sender != c.agent) revert NotAgent();
        if (c.state != State.Checked || c.firstAccept) revert WrongState(c.state);
        _firstStands(id, c);
        desk.reject(c.job);
        _end(id, c, State.Rejected, How.FirstCheck, _half(c));
    }

    // ---------- the first check ----------

    /// @notice A verifier checks the delivered work against the brief and gives its verdict, staking `stake` of its free
    ///         bond on it. The first verdict given is the one; by D + 4 hours.
    /// @param reason the keccak256 hash of the verifier's reasons (the text is kept off the chain)
    function check(uint256 id, bool accept_, bytes32 reason) external nonReentrant {
        Case storage c = cases[id];
        if (c.state != State.Working) revert WrongState(c.state);
        FactorDesk.Job memory j = desk.job(c.job);
        if (j.state != FactorDesk.State.Delivered) revert NotDelivered();
        if (block.timestamp >= uint256(j.deliveredAt) + CHECK_TIME) revert TooLate();
        Verifier storage v = _seatable(id, c, msg.sender);
        _lock(v, c.stake);
        c.checker = msg.sender;
        c.firstAccept = accept_;
        c.reason = reason;
        c.checkedAt = uint40(block.timestamp);
        c.state = State.Checked;
        v.checks += 1;
        emit Checked(id, msg.sender, accept_, reason);
    }

    // ---------- a dispute and its panel ----------

    /// @notice The side the first verdict goes against disputes it: the customer a verdict of accept, the agent a verdict
    ///         of reject. msg.value is the dispute bond. Within 2 hours of the verdict.
    function dispute(uint256 id) external payable nonReentrant {
        Case storage c = cases[id];
        if (c.state != State.Checked) revert WrongState(c.state);
        if (block.timestamp >= uint256(c.checkedAt) + DISPUTE_TIME) revert TooLate();
        if (msg.sender != (c.firstAccept ? c.customer : c.agent)) revert NotYourSide();
        if (msg.value != c.disputeBond) revert WrongValue(c.disputeBond);
        c.disputer = msg.sender;
        c.disputedAt = uint40(block.timestamp);
        c.state = State.Disputed;
        disputes += msg.value;
        emit Disputed(id, msg.sender, msg.value);
    }

    /// @notice A verifier takes a panel seat with its verdict sealed: `commit` is commitOf(id, you, accept, reason, salt).
    ///         Until D + 14 hours. Seats go to different model makers. A verifier of an older standing takes the seat of
    ///         the same maker, or when the panel is full the seat of the newest standing, so being fast wins nothing.
    function sit(uint256 id, bytes32 commit) external nonReentrant {
        Case storage c = cases[id];
        if (c.state != State.Disputed) revert WrongState(c.state);
        if (block.timestamp >= _delivered(c) + SEAT_END) revert TooLate();
        if (commit == bytes32(0)) revert NoCommit();
        if (msg.sender == c.checker) revert Related();
        if (struck[id][msg.sender]) revert StruckOff();
        Verifier storage v = _seatable(id, c, msg.sender);
        Seat[3] storage p = seats_[id];
        uint256 at = PANEL;
        uint256 empty = PANEL;
        uint256 newest = PANEL;
        for (uint256 i = 0; i < PANEL; ++i) {
            address s = p[i].verifier;
            if (s == msg.sender) revert AlreadySeated();
            if (s == address(0)) {
                if (empty == PANEL) empty = i;
            } else if (p[i].maker == v.maker) {
                at = i;
            } else if (newest == PANEL || p[i].since > p[newest].since) {
                newest = i;
            }
        }
        if (at != PANEL) {
            // the same maker sits: only an older standing takes its seat
            if (v.since >= p[at].since) revert MakerTaken();
        } else if (empty != PANEL) {
            at = empty;
        } else {
            if (v.since >= p[newest].since) revert PanelFull();
            at = newest;
        }
        if (p[at].verifier != address(0)) {
            address out = p[at].verifier;
            _unlock(verifiers[out], c.stake);
            emit Displaced(id, out, msg.sender);
        }
        _lock(v, c.stake);
        p[at] = Seat({verifier: msg.sender, since: v.since, maker: v.maker, vote: NONE, commit: commit});
        emit Sat(id, msg.sender, v.maker, at);
    }

    /// @notice The customer or the agent strikes one panelist from the case, once each, until seating closes. No reason
    ///         is needed: the case page shows what Factor sees that ties a verifier to a side. The struck verifier has its
    ///         stake back and cannot sit on this case again; its seat is open to the next verifier.
    function strike(uint256 id, address who) external nonReentrant {
        Case storage c = cases[id];
        if (c.state != State.Disputed) revert WrongState(c.state);
        if (block.timestamp >= _delivered(c) + SEAT_END) revert TooLate();
        if (msg.sender == c.customer) {
            if (c.customerStruck) revert StrikeUsed();
            c.customerStruck = true;
        } else if (msg.sender == c.agent) {
            if (c.agentStruck) revert StrikeUsed();
            c.agentStruck = true;
        } else {
            revert NotYourSide();
        }
        Seat[3] storage p = seats_[id];
        uint256 i = _seatOf(p, who);
        delete p[i];
        struck[id][who] = true;
        Verifier storage v = verifiers[who];
        v.struck += 1;
        _unlock(v, c.stake);
        emit Struck(id, who, msg.sender);
    }

    /// @notice A panelist reveals its sealed verdict, from D + 14 hours to D + 18 hours.
    function reveal(uint256 id, bool accept_, bytes32 reason, bytes32 salt) external nonReentrant {
        Case storage c = cases[id];
        if (c.state != State.Disputed) revert WrongState(c.state);
        uint256 d = _delivered(c);
        if (block.timestamp < d + SEAT_END) revert TooSoon(d + SEAT_END);
        if (block.timestamp >= d + REVEAL_END) revert TooLate();
        Seat storage s = seats_[id][_seatOf(seats_[id], msg.sender)];
        if (s.vote != NONE) revert AlreadyRevealed();
        if (commitOf(id, msg.sender, accept_, reason, salt) != s.commit) revert BadReveal();
        s.vote = accept_ ? ACCEPT : REJECT;
        emit Revealed(id, msg.sender, accept_, reason);
    }

    // ---------- every timed step: anyone ----------

    /// @notice Anyone, once a case's time has come. It does whatever is next:
    ///           not delivered past the due time and grace   refunded on the desk; the payment and the fee go back
    ///           declined, or refunded on the desk           the payment and the fee go back
    ///           a first verdict whose dispute time is over  carried out on the desk
    ///           a panel whose time is over                  its majority carried out on the desk, or the customer decides
    ///           nobody checked by D + 4 hours               the fee goes back, and the customer decides
    ///           the customer's choice past the desk's 24 h  settled on the desk as accepted
    function step(uint256 id) external nonReentrant {
        Case storage c = cases[id];
        State s = c.state;
        if (s != State.Working && s != State.Checked && s != State.Disputed && s != State.CustomerDecides) {
            revert WrongState(s);
        }
        FactorDesk.Job memory j = desk.job(c.job);
        if (j.state == FactorDesk.State.Locked || j.state == FactorDesk.State.Advanced) {
            // the desk refuses it before the due time and its grace
            desk.refund(c.job);
            _end(id, c, State.Returned, How.NotDelivered, j.price - j.early);
        } else if (j.state == FactorDesk.State.Refunded) {
            _end(id, c, State.Returned, How.NotDelivered, j.price - j.early);
        } else if (j.state == FactorDesk.State.Declined) {
            _end(id, c, State.Returned, How.NotDelivered, j.price);
        } else if (j.state == FactorDesk.State.Settled) {
            // somebody settled it on the desk directly after its 24 hours: every time of the case is over by then
            _ripen(id, c, j.deliveredAt);
            _end(id, c, State.Accepted, How.Clock, 0);
        } else if (j.state == FactorDesk.State.Delivered) {
            if (s == State.CustomerDecides) {
                _settleOnClock(id, c, j.deliveredAt);
                return;
            }
            (uint8 verdict, How how) = _ripen(id, c, j.deliveredAt);
            if (verdict == ACCEPT) {
                desk.accept(c.job);
                _end(id, c, State.Accepted, how, 0);
            } else if (verdict == REJECT) {
                _rejectOrClock(id, c, j.deliveredAt, how);
            } else if (block.timestamp >= uint256(j.deliveredAt) + review) {
                // the customer's choice and its time are both over
                _settleOnClock(id, c, j.deliveredAt);
            }
            // otherwise the case now waits for the customer's own choice, until the desk's 24 hours
        } else {
            // settled at half takes a reject only this contract sends, and every reject ends the case in the same call
            revert WrongState(s);
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

    /// @notice A case, whole. A number never given out reads as a case in state None.
    function getCase(uint256 id) external view returns (Case memory) {
        return cases[id];
    }

    /// @notice A case's three panel seats. An empty seat has the zero address.
    function seats(uint256 id) external view returns (Seat[3] memory) {
        return seats_[id];
    }

    /// @notice A verifier, whole. An address that never joined reads with maker 0.
    function verifier(address who) external view returns (Verifier memory) {
        return verifiers[who];
    }

    /// @notice What a verifier stakes on a job of this price.
    function stakeOf(uint256 price) public pure returns (uint256 s) {
        s = (price * STAKE_BPS) / BPS;
        if (s < MIN_STAKE) s = MIN_STAKE;
    }

    /// @notice What a dispute of a job of this price costs.
    function disputeBondOf(uint256 price) public pure returns (uint256 b) {
        b = (price * DISPUTE_BPS) / BPS;
        if (b < MIN_DISPUTE) b = MIN_DISPUTE;
    }

    /// @notice The sealed verdict a panelist commits to.
    function commitOf(uint256 id, address who, bool accept_, bytes32 reason, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(id, who, accept_, reason, salt));
    }

    /// @notice Whether the chain ties `who` to a side of the case: the customer, the agent, or a line account's key on
    ///         either side. Such a verifier can neither check nor sit. Ties the chain cannot show are for the sides to
    ///         strike.
    function related(uint256 id, address who) public view returns (bool) {
        Case storage c = cases[id];
        if (who == c.customer || who == c.agent) return true;
        if (line.keyOf(c.agent) == who || line.keyOf(c.customer) == who) return true;
        address acct = line.accountOf(who);
        return acct != address(0) && (acct == c.agent || acct == c.customer);
    }

    /// @notice A case's clock, from the delivery on the desk (all 0 before it): the last moment for the first check, for
    ///         a dispute (0 until checked), for seats and strikes, for reveals, and the desk's own end of its 24 hours.
    function deadlines(uint256 id)
        external
        view
        returns (uint256 checkBy, uint256 disputeBy, uint256 seatBy, uint256 revealBy, uint256 reviewBy)
    {
        Case storage c = cases[id];
        if (c.state == State.None) return (0, 0, 0, 0, 0);
        uint256 d = desk.job(c.job).deliveredAt;
        if (d == 0) return (0, 0, 0, 0, 0);
        checkBy = d + CHECK_TIME;
        disputeBy = c.checkedAt == 0 ? 0 : uint256(c.checkedAt) + DISPUTE_TIME;
        seatBy = d + SEAT_END;
        revealBy = d + REVEAL_END;
        reviewBy = d + review;
    }

    // ---------- internals: the case ----------

    function _delivered(Case storage c) internal view returns (uint256) {
        return desk.job(c.job).deliveredAt;
    }

    function _half(Case storage c) internal view returns (uint256) {
        return (uint256(c.price) * desk.REJECTED_BPS()) / desk.BPS();
    }

    /// @dev The verifiers' side is settled once its time has come: nobody checked by D + 4 hours, a first verdict past its
    ///      two hours, or a panel past its time. Returns the verdict to carry out (NONE: the customer decides) and who
    ///      decided it. Reverts TooSoon while its time has not come.
    function _ripen(uint256 id, Case storage c, uint256 d) internal returns (uint8 verdict, How how) {
        State s = c.state;
        if (s == State.Working) {
            if (block.timestamp < d + CHECK_TIME) revert TooSoon(d + CHECK_TIME);
            _noCheck(c);
            c.state = State.CustomerDecides;
            emit Decided(id, How.Customer, NONE, 0, 0);
            return (NONE, How.Customer);
        }
        if (s == State.Checked) {
            uint256 at = uint256(c.checkedAt) + DISPUTE_TIME;
            if (block.timestamp < at) revert TooSoon(at);
            _firstStands(id, c);
            return (c.firstAccept ? ACCEPT : REJECT, How.FirstCheck);
        }
        if (s == State.Disputed) return _decide(id, c, d);
        return (NONE, How.Customer);
    }

    /// @dev Nobody checked: the fee goes back to the customer.
    function _noCheck(Case storage c) internal {
        uint256 fee = c.fee;
        c.fee = 0;
        fees -= fee;
        _pay(c.customer, fee);
    }

    /// @dev The first verdict stands, undisputed: its verifier is paid the fee and has its stake back.
    function _firstStands(uint256 id, Case storage c) internal {
        Verifier storage v = verifiers[c.checker];
        v.right += 1;
        _unlock(v, c.stake);
        uint256 fee = c.fee;
        c.fee = 0;
        fees -= fee;
        _credit(id, c.checker, v, fee);
        emit Decided(id, How.FirstCheck, c.firstAccept ? ACCEPT : REJECT, 0, 0);
    }

    /// @dev The panel's time is over, or every seat has revealed once seating closed. The majority of the revealed votes
    ///      decides and the first verdict breaks a tie. The verifiers who judged right share the fee, half the stake of
    ///      each one who judged wrong, the whole stake of each panelist who never revealed, and the dispute bond if the
    ///      dispute lost. With no vote revealed at all there is no panel: the first verifier is paid the fee, the dispute
    ///      bond and the stakes of the silent seats, and the customer decides by the desk's own rule.
    function _decide(uint256 id, Case storage c, uint256 d) internal returns (uint8 verdict, How how) {
        (uint256 forAccept, uint256 forReject, bool allIn) = tally(id);
        if (block.timestamp < d + REVEAL_END && !(allIn && block.timestamp >= d + SEAT_END)) {
            revert TooSoon(allIn ? d + SEAT_END : d + REVEAL_END);
        }
        uint256 pot = c.fee;
        fees -= pot;
        c.fee = 0;
        disputes -= c.disputeBond;
        if (forAccept + forReject == 0) {
            _noPanel(id, c, pot);
            return (NONE, How.Customer);
        }
        verdict = forAccept > forReject ? ACCEPT : forReject > forAccept ? REJECT : (c.firstAccept ? ACCEPT : REJECT);
        bool firstRight = (verdict == ACCEPT) == c.firstAccept;
        // the dispute lost: its bond goes to the verifiers who judged right
        if (firstRight) pot += c.disputeBond;
        _panelPays(id, c, verdict, firstRight, pot);
        emit Decided(id, How.Panel, verdict, forAccept, forReject);
        // the dispute won: its bond goes back to the side that raised it
        if (!firstRight) _pay(c.disputer, c.disputeBond);
        return (verdict, How.Panel);
    }

    /// @notice A panel's revealed votes so far, and whether every seated panelist has revealed.
    function tally(uint256 id) public view returns (uint256 forAccept, uint256 forReject, bool allIn) {
        Seat[3] storage p = seats_[id];
        allIn = true;
        for (uint256 i = 0; i < PANEL; ++i) {
            if (p[i].verifier == address(0)) continue;
            if (p[i].vote == ACCEPT) ++forAccept;
            else if (p[i].vote == REJECT) ++forReject;
            else allIn = false;
        }
    }

    /// @dev No panelist revealed: the silent seats lose their stake to the first verifier, with the fee and the dispute
    ///      bond, and the customer decides.
    function _noPanel(uint256 id, Case storage c, uint256 pot) internal {
        Seat[3] storage p = seats_[id];
        uint256 stake = c.stake;
        for (uint256 i = 0; i < PANEL; ++i) {
            if (p[i].verifier != address(0)) pot += _hidden(id, p[i].verifier, stake);
        }
        Verifier storage f = verifiers[c.checker];
        _unlock(f, stake);
        _credit(id, c.checker, f, pot + c.disputeBond);
        c.state = State.CustomerDecides;
        emit Decided(id, How.Customer, NONE, 0, 0);
    }

    /// @dev Who judged right shares the pot, with what the others lose added to it. Equal shares; what does not divide
    ///      goes to the first of them (the first verifier when it was right), so not a wei is left over.
    function _panelPays(uint256 id, Case storage c, uint8 verdict, bool firstRight, uint256 pot) internal {
        Seat[3] storage p = seats_[id];
        uint256 stake = c.stake;
        address[4] memory rightOnes;
        uint256 n;
        if (firstRight) {
            Verifier storage f = verifiers[c.checker];
            f.right += 1;
            _unlock(f, stake);
            rightOnes[n++] = c.checker;
        } else {
            pot += _wrong(id, c.checker, stake);
        }
        for (uint256 i = 0; i < PANEL; ++i) {
            address who = p[i].verifier;
            if (who == address(0)) continue;
            uint8 vote = p[i].vote;
            if (vote == NONE) {
                pot += _hidden(id, who, stake);
                continue;
            }
            verifiers[who].panels += 1;
            if (vote == verdict) {
                verifiers[who].right += 1;
                _unlock(verifiers[who], stake);
                rightOnes[n++] = who;
            } else {
                pot += _wrong(id, who, stake);
            }
        }
        uint256 share = pot / n;
        uint256 rest = pot - share * n;
        for (uint256 i = 0; i < n; ++i) {
            _credit(id, rightOnes[i], verifiers[rightOnes[i]], i == 0 ? share + rest : share);
        }
    }

    /// @dev A verifier who judged wrong: half its stake goes into the pot, the other half back to its free bond.
    function _wrong(uint256 id, address who, uint256 stake) internal returns (uint256 cut) {
        Verifier storage v = verifiers[who];
        cut = (stake * WRONG_BPS) / BPS;
        v.wrong += 1;
        _slash(id, who, v, stake, cut);
    }

    /// @dev A panelist that sat and never revealed: all of its stake goes into the pot.
    function _hidden(uint256 id, address who, uint256 stake) internal returns (uint256) {
        Verifier storage v = verifiers[who];
        v.hidden += 1;
        v.panels += 1;
        _slash(id, who, v, stake, stake);
        return stake;
    }

    /// @dev The customer's own choice of reject, or a verdict of reject carried out.
    function _sendReject(uint256 id, Case storage c) internal {
        FactorDesk.Job memory j = desk.job(c.job);
        if (j.state != FactorDesk.State.Delivered) revert NotDelivered();
        State s = c.state;
        How how = How.Customer;
        if (s != State.CustomerDecides) {
            (uint8 verdict, How decided) = _ripen(id, c, j.deliveredAt);
            if (verdict == REJECT) how = decided;
            else if (verdict == ACCEPT) revert WrongState(s);
        }
        // the desk refuses it after its 24 hours
        desk.reject(c.job);
        _end(id, c, State.Rejected, how, _half(c));
    }

    /// @dev A verdict of reject, carried out by anyone: on the desk while its 24 hours last, and after them the desk's own
    ///      rule has already made the job settle as accepted.
    function _rejectOrClock(uint256 id, Case storage c, uint256 d, How how) internal {
        if (block.timestamp < d + review) {
            desk.reject(c.job);
            _end(id, c, State.Rejected, how, _half(c));
        } else {
            desk.settle(c.job);
            _end(id, c, State.Accepted, How.Clock, 0);
        }
    }

    /// @dev The customer's choice, once the desk's 24 hours are over: the desk settles the job as accepted.
    function _settleOnClock(uint256 id, Case storage c, uint256 d) internal {
        uint256 at = d + review;
        if (block.timestamp < at) revert TooSoon(at);
        desk.settle(c.job);
        _end(id, c, State.Accepted, How.Clock, 0);
    }

    /// @dev The case ends: its job leaves the books, and what came back from the desk goes to the customer with any fee
    ///      still held (a case that was never checked).
    function _end(uint256 id, Case storage c, State state, How how, uint256 fromDesk) internal {
        c.state = state;
        c.how = how;
        atDesk -= c.price;
        uint256 fee = c.fee;
        if (fee != 0) {
            c.fee = 0;
            fees -= fee;
        }
        emit Ended(id, state, how, fromDesk + fee);
        _pay(c.customer, fromDesk + fee);
    }

    // ---------- internals: verifiers ----------

    /// @dev A verifier that may check or sit on this case: it joined, has a standing, and the chain does not tie it to
    ///      either side.
    function _seatable(uint256 id, Case storage c, address who) internal view returns (Verifier storage v) {
        v = verifiers[who];
        if (v.maker == 0) revert NotVerifier();
        if (v.since == 0) revert NoStanding();
        if (related(id, who)) revert Related();
        if (v.free < c.stake) revert BondShort(c.stake);
    }

    function _seatOf(Seat[3] storage p, address who) internal view returns (uint256) {
        for (uint256 i = 0; i < PANEL; ++i) {
            if (p[i].verifier == who && who != address(0)) return i;
        }
        revert NotSeated();
    }

    function _lock(Verifier storage v, uint256 stake) internal {
        v.free -= stake;
        v.locked += stake;
        v.open += 1;
        bonds -= stake;
        staked += stake;
    }

    function _unlock(Verifier storage v, uint256 stake) internal {
        v.locked -= stake;
        v.free += stake;
        v.open -= 1;
        staked -= stake;
        bonds += stake;
    }

    /// @dev `cut` of a locked stake is lost; the rest goes back to the verifier's free bond.
    function _slash(uint256 id, address who, Verifier storage v, uint256 stake, uint256 cut) internal {
        v.locked -= stake;
        v.open -= 1;
        staked -= stake;
        v.free += stake - cut;
        bonds += stake - cut;
        v.lost += cut;
        totalSlashed += cut;
        emit Slashed(id, who, cut);
        _unstand(who, v);
    }

    /// @dev What a verifier is paid goes into its free bond, for it to take out.
    function _credit(uint256 id, address who, Verifier storage v, uint256 amount) internal {
        if (amount == 0) return;
        v.free += amount;
        v.earned += amount;
        bonds += amount;
        totalFeesPaid += amount;
        emit Paid(id, who, amount);
        _restand(who, v);
    }

    /// @dev A bond under MIN_BOND has no standing.
    function _unstand(address who, Verifier storage v) internal {
        if (v.since != 0 && v.free + v.locked < MIN_BOND) {
            v.since = 0;
            emit Standing(who, 0);
        }
    }

    /// @dev A bond back up to MIN_BOND starts a new standing.
    function _restand(address who, Verifier storage v) internal {
        if (v.since == 0 && v.free + v.locked >= MIN_BOND) {
            v.since = uint40(block.timestamp);
            emit Standing(who, block.timestamp);
        }
    }

    // ---------- internals: payouts ----------

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
