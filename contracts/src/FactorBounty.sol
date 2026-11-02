// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FactorDesk} from "./FactorDesk.sol";
import {FactorLine} from "./FactorLine.sol";

/// @title FactorBounty
/// @notice Bounties on Factor's desk: a customer locks a prize for a task, and agents enter with their finished work.
///         See docs/BOUNTIES.md for every rule in plain words.
///
///         A poster locks the prize here, plus 1% of it for the burn, and sets a deadline. Until the deadline any
///         registered agent can enter with a hash of its finished work and a bond of 1% of the prize. Only the hash is
///         on the chain, and the agent's address is inside it, so nobody can copy an entry by copying its hash.
///
///         From the deadline the poster has 3 days to pick one entrant. The prize is then locked on the desk as a job
///         for the winner, with this contract as the customer. The winner delivers it on the desk with its entry's
///         hash as the proof, anyone can then call close(), which accepts on the desk, and the desk pays the winner
///         and counts the win like any other job: the 2% job fee goes to the pool and the record and score move.
///
///         What happens otherwise, each started by anyone once its time has come:
///           no entries at the deadline     the poster has the prize and the 1% back
///           no pick in the 3 days          the prize is split between the entrants, the poster loses it, the 1% burns
///           the winner does not deliver    the desk refunds this contract, and the prize and the winner's own bond
///                                          are split between the other entrants; with no others the prize goes back
///                                          to the poster and the winner's bond is burned
///
///         Entry bonds go back when the bounty ends; every bond but the winner's can go back from the moment of the
///         pick (returnBonds). Rounding dust from a split goes to the burn pot, so every wei is counted.
///
///         There is no owner and nothing can be set after deployment. Every number is a constant or the desk's own,
///         and every address is the desk's, the line contract's, or read from the desk.
/// @dev The contract's ETH is `held` (the prizes and fees of bounties still open), `bonds` (entry bonds not yet
///      returned) and `owedTotal` (payouts a wallet refused, waiting to be collected), and for a moment the prize of a
///      picked bounty whose job came back and has not been closed yet. `atDesk` is the prizes on the desk right now; it
///      is not in the balance. ETH is taken only from the desk. Every function that sends ETH or calls the desk is
///      guarded against re-entry and writes its state before ETH moves; payouts are pushed with a fixed amount of gas
///      and one that is refused is kept as owed, so a wallet that refuses ETH blocks nobody but itself.
contract FactorBounty is ReentrancyGuardTransient {
    uint256 public constant BPS = 10_000;
    /// @notice What the poster adds on top of the prize for the burn: 1% of the prize.
    uint256 public constant BURN_BPS = 100;
    /// @notice An entry's bond: 1% of the prize, returned when the bounty ends.
    uint256 public constant BOND_BPS = 100;
    uint256 public constant MIN_PRIZE = 0.005 ether;
    uint256 public constant MAX_ENTRIES = 25;
    /// @notice The deadline is at least this long after the bounty is posted, and at most MAX_OPEN.
    uint256 public constant MIN_OPEN = 1 hours;
    uint256 public constant MAX_OPEN = 30 days;
    /// @notice The poster's time to pick a winner, from the deadline.
    uint256 public constant PICK_TIME = 3 days;
    /// @notice The desk job's due time, from the pick. The desk's own 12 hours of grace come after it.
    uint256 public constant DELIVER_TIME = 3 days;
    /// @notice The highest minimum score a poster can ask for: the top of the desk's score.
    uint256 public constant MAX_SCORE = 1000;
    /// @dev The same bounded push as the desk's.
    uint256 internal constant PUSH_GAS = 50_000;
    uint256 internal constant PUSH_GAS_NEEDED = 95_000;

    enum State {
        None,
        Open, // taking entries until the deadline, then waiting for the pick
        Picked, // the prize is on the desk as a job for the winner
        Won, // the desk paid the winner
        Unpicked, // no pick in time: the prize was split between the entrants
        Undelivered, // the winner did not deliver: the prize went to the other entrants, or back to the poster
        Empty // no entries at the deadline: everything went back to the poster
    }

    /// @dev One bounty. Every field is written by this contract and by nothing else.
    struct Bounty {
        address poster;
        uint40 deadline;
        uint16 minScore; // the score an agent must have to enter; 0 for none
        State state;
        bool bondsBack; // every bond but the winner's has gone back
        address winner;
        uint256 prize;
        uint256 fee; // 1% of the prize, for the burn
        uint256 bond; // what each entry puts up: 1% of the prize
        uint256 job; // the desk job, once picked
        bytes32 task; // a hash of the task's words; the words are off the chain
    }

    /// @dev One entry. Only the hash is on the chain: keccak256(abi.encode(this contract, the bounty, the agent, a hash
    ///      of the work)).
    struct Entry {
        bytes32 hash;
        uint40 at;
    }

    FactorDesk public immutable desk;
    /// @notice The credit line contract: a line account enters through its key. Zero: no line accounts.
    FactorLine public immutable line;
    /// @notice The desk's burn pot, which buys back and burns $FACTOR.
    address public immutable burnPot;
    /// @notice The desk's own numbers, read from it once.
    uint256 public immutable grace;
    uint256 public immutable review;

    uint256 public bountyCount;
    mapping(uint256 id => Bounty) internal bounties;
    mapping(uint256 id => address[]) internal entrants_;
    mapping(uint256 id => mapping(address agent => Entry)) internal entries;
    /// @notice The bounty a desk job came from, or 0.
    mapping(uint256 job => uint256 id) public bountyOfJob;

    /// @notice The prizes and fees of bounties still open, the entry bonds not yet returned, and payouts waiting.
    uint256 public held;
    uint256 public bonds;
    uint256 public owedTotal;
    mapping(address who => uint256) public owed;
    /// @notice The prizes on the desk right now, as jobs for winners.
    uint256 public atDesk;

    uint256 public totalPrizes; // every prize ever posted
    uint256 public totalBurned; // every wei sent to the burn pot: the 1%, rounding dust, forfeited bonds
    uint256 public totalWon; // prizes paid through the desk
    uint256 public totalSplit; // prizes split between entrants
    uint256 public totalReturned; // prizes that went back to their posters

    event Posted(
        uint256 indexed id,
        address indexed poster,
        uint256 prize,
        uint256 fee,
        uint256 bond,
        uint256 deadline,
        uint256 minScore,
        bytes32 task
    );
    event Entered(uint256 indexed id, address indexed agent, address indexed from, bytes32 hash, uint256 count);
    event Picked(uint256 indexed id, address indexed winner, uint256 indexed job, uint256 burned, uint256 dueAt);
    /// @notice A bounty ended. `share`: what each entrant paid from the prize was given. `burned`: rounding dust and
    ///         forfeited bond sent to the burn pot now (the 1% as well when nobody was picked). `toPoster`: what went back.
    event Closed(
        uint256 indexed id,
        State indexed how,
        address indexed winner,
        uint256 job,
        uint256 share,
        uint256 paidTo,
        uint256 burned,
        uint256 toPoster
    );
    /// @notice An entrant was paid: its share of a prize and its bond, either of which may be 0.
    event Paid(uint256 indexed id, address indexed who, uint256 share, uint256 bond);
    event Owed(address indexed who, uint256 amount);
    event Collected(address indexed who, address indexed to, uint256 amount);

    error ZeroAddress();
    error WrongDesk();
    error DeskRules();
    error TooSmall(uint256 min);
    error BadDeadline();
    error BadScore();
    error NoTask();
    error WrongValue(uint256 value);
    error WrongState(State state);
    error TooSoon(uint256 at);
    error TooLate(uint256 at);
    error NotAgent();
    error NotPoster();
    error NoHash();
    error NotRegistered();
    error Barred();
    error OwnBounty();
    error AlreadyIn();
    error Full();
    error ScoreTooLow(uint256 score, uint256 min);
    error NotAnEntrant();
    error BondsAlreadyBack();
    error NothingOwed();
    error PushFailed();
    error GasShort();
    error OnlyDesk();

    constructor(FactorDesk desk_, FactorLine line_) {
        if (address(desk_) == address(0)) revert ZeroAddress();
        if (address(line_) != address(0) && address(line_.desk()) != address(desk_)) revert WrongDesk();
        desk = desk_;
        line = line_;
        burnPot = desk_.burnPot();
        if (burnPot == address(0)) revert ZeroAddress();
        grace = desk_.GRACE();
        review = desk_.REVIEW();
        // every prize can be locked on the desk, and the desk takes the due time of every pick
        if (MIN_PRIZE < desk_.MIN_JOB() || DELIVER_TIME < desk_.MIN_DUE() || DELIVER_TIME > desk_.MAX_DUE()) {
            revert DeskRules();
        }
    }

    /// @notice ETH is taken only from the desk: a job that comes back (refunded or declined).
    receive() external payable {
        if (msg.sender != address(desk)) revert OnlyDesk();
    }

    // ---------- the poster ----------

    /// @notice Post a bounty. msg.value is the prize plus 1% of it. The task's words are off the chain; `task` is their
    ///         keccak256 hash.
    /// @param prize what the winner is paid through the desk, 0.005 ETH or more
    /// @param deadline when entries end: 1 hour to 30 days from now
    /// @param minScore the desk score an agent must have to enter, 0 for none
    /// @param task the hash of the task's words
    function post(uint256 prize, uint256 deadline, uint256 minScore, bytes32 task)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        if (prize < MIN_PRIZE) revert TooSmall(MIN_PRIZE);
        if (deadline < block.timestamp + MIN_OPEN || deadline > block.timestamp + MAX_OPEN) revert BadDeadline();
        if (minScore > MAX_SCORE) revert BadScore();
        if (task == bytes32(0)) revert NoTask();
        uint256 fee = feeFor(prize);
        if (msg.value != prize + fee) revert WrongValue(prize + fee);
        id = ++bountyCount;
        Bounty storage b = bounties[id];
        b.poster = msg.sender;
        b.deadline = uint40(deadline);
        b.minScore = uint16(minScore);
        b.state = State.Open;
        b.prize = prize;
        b.fee = fee;
        b.bond = bondFor(prize);
        b.task = task;
        held += msg.value;
        totalPrizes += prize;
        emit Posted(id, msg.sender, prize, fee, b.bond, deadline, minScore, task);
    }

    /// @notice The poster picks the winner, from the deadline until 3 days after it. The prize is locked on the desk as
    ///         a job for the winner, due in 3 days, and the 1% goes to the burn pot. There is no way back from a pick.
    function pick(uint256 id, address winner) external nonReentrant returns (uint256 job) {
        Bounty storage b = bounties[id];
        if (b.state != State.Open) revert WrongState(b.state);
        if (msg.sender != b.poster) revert NotPoster();
        if (block.timestamp < b.deadline) revert TooSoon(b.deadline);
        uint256 end = uint256(b.deadline) + PICK_TIME;
        if (block.timestamp >= end) revert TooLate(end);
        if (entries[id][winner].at == 0) revert NotAnEntrant();
        uint256 prize = b.prize;
        uint256 fee = b.fee;
        b.state = State.Picked;
        b.winner = winner;
        held -= prize + fee;
        atDesk += prize;
        totalBurned += fee;
        uint256 dueAt = block.timestamp + DELIVER_TIME;
        job = desk.lock{value: prize}(winner, dueAt, false);
        b.job = job;
        bountyOfJob[job] = id;
        emit Picked(id, winner, job, fee, dueAt);
        _pay(burnPot, fee);
    }

    // ---------- the entrant ----------

    /// @notice Enter a bounty with finished work, before its deadline. msg.value is the bond, 1% of the prize. The agent
    ///         must be registered on the desk and not barred, with the poster's minimum score, and is not the poster.
    ///         A line account cannot make calls of its own, so its key enters for it.
    /// @param agent the agent entering: the caller, or the line account whose key the caller is
    /// @param hash entryHash(id, agent, the hash of the work)
    function enter(uint256 id, address agent, bytes32 hash) external payable nonReentrant {
        Bounty storage b = bounties[id];
        if (b.state != State.Open) revert WrongState(b.state);
        if (block.timestamp >= b.deadline) revert TooLate(b.deadline);
        address key = keyOf(agent);
        if (msg.sender != agent && msg.sender != key) revert NotAgent();
        if (hash == bytes32(0)) revert NoHash();
        FactorDesk.Agent memory a = desk.agent(agent);
        if (!a.registered) revert NotRegistered();
        if (a.barred || (key != address(0) && _lineBarred(agent, key))) revert Barred();
        if (agent == b.poster || key == b.poster) revert OwnBounty();
        // one entry for one hand: a line account and its key are the same agent's two addresses
        if (entries[id][agent].at != 0) revert AlreadyIn();
        address sameHand = key != address(0) ? key : _accountOf(agent);
        if (sameHand != address(0) && entries[id][sameHand].at != 0) revert AlreadyIn();
        uint256 count = entrants_[id].length;
        if (count >= MAX_ENTRIES) revert Full();
        uint256 s = scoreOf(agent);
        if (s < b.minScore) revert ScoreTooLow(s, b.minScore);
        if (msg.value != b.bond) revert WrongValue(b.bond);
        entrants_[id].push(agent);
        entries[id][agent] = Entry({hash: hash, at: uint40(block.timestamp)});
        bonds += msg.value;
        emit Entered(id, agent, msg.sender, hash, count + 1);
    }

    // ---------- every timed step: anyone ----------

    /// @notice Anyone, from the pick: every bond but the winner's goes back, without waiting for the winner to deliver.
    function returnBonds(uint256 id) external nonReentrant {
        Bounty storage b = bounties[id];
        if (b.state != State.Picked) revert WrongState(b.state);
        if (b.bondsBack) revert BondsAlreadyBack();
        _payEntrants(id, b, b.winner, 0);
    }

    /// @notice Anyone, once a bounty's time has come. It does whatever is next:
    ///           open, no entries, from the deadline     everything back to the poster
    ///           open, entries, 3 days after the deadline  the prize split between the entrants, the 1% burned
    ///           picked, the winner delivered its entry's hash  accepted on the desk, which pays the winner
    ///           picked, delivered another hash           settled on the desk once the customer's 24 hours are over
    ///           picked, not delivered past the due time and the desk's grace  refunded on the desk, then split
    ///           picked, the winner declined, or the desk already settled or refunded it  ended accordingly
    function close(uint256 id) external nonReentrant {
        Bounty storage b = bounties[id];
        if (b.state == State.Open) _closeOpen(id, b);
        else if (b.state == State.Picked) _closePicked(id, b);
        else revert WrongState(b.state);
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

    /// @notice A bounty, whole. A number never given out reads as a bounty in state None.
    function bounty(uint256 id) external view returns (Bounty memory) {
        return bounties[id];
    }

    /// @notice The agents that entered a bounty, in the order they entered.
    function entrants(uint256 id) external view returns (address[] memory) {
        return entrants_[id];
    }

    /// @notice One agent's entry in a bounty: its hash and when it entered. Zeros: it has not entered.
    function entryOf(uint256 id, address agent) external view returns (Entry memory) {
        return entries[id][agent];
    }

    /// @notice What an entrant commits to: the bounty, the agent's address and the hash of its work, all in one hash.
    function entryHash(uint256 id, address agent, bytes32 workHash) external view returns (bytes32) {
        return keccak256(abi.encode(address(this), id, agent, workHash));
    }

    /// @notice The 1% a poster adds on top of a prize.
    function feeFor(uint256 prize) public pure returns (uint256) {
        return (prize * BURN_BPS) / BPS;
    }

    /// @notice The bond of one entry in a bounty of this prize.
    function bondFor(uint256 prize) public pure returns (uint256) {
        return (prize * BOND_BPS) / BPS;
    }

    /// @notice The key of a line account; zero for any other address.
    function keyOf(address agent) public view returns (address) {
        return address(line) == address(0) ? address(0) : line.keyOf(agent);
    }

    /// @notice The score a bounty's minimum is held to: the desk's own. For a line account, the better of the account's
    ///         and its key's, and 0 if either is barred on the desk or the line has defaulted.
    function scoreOf(address agent) public view returns (uint256 s) {
        s = desk.score(agent);
        address k = keyOf(agent);
        if (k == address(0)) return s;
        if (_lineBarred(agent, k)) return 0;
        uint256 ks = desk.score(k);
        if (ks > s) s = ks;
    }

    // ---------- internals ----------

    function _lineBarred(address account, address key) internal view returns (bool) {
        return desk.agent(key).barred || desk.agent(account).barred || line.line(account).defaulted;
    }

    function _accountOf(address key) internal view returns (address) {
        return address(line) == address(0) ? address(0) : line.accountOf(key);
    }

    function _closeOpen(uint256 id, Bounty storage b) internal {
        if (block.timestamp < b.deadline) revert TooSoon(b.deadline);
        uint256 count = entrants_[id].length;
        uint256 prize = b.prize;
        uint256 fee = b.fee;
        if (count == 0) {
            b.state = State.Empty;
            held -= prize + fee;
            totalReturned += prize;
            emit Closed(id, State.Empty, address(0), 0, 0, 0, 0, prize + fee);
            _pay(b.poster, prize + fee);
            return;
        }
        uint256 at = uint256(b.deadline) + PICK_TIME;
        if (block.timestamp < at) revert TooSoon(at);
        b.state = State.Unpicked;
        held -= prize + fee;
        uint256 share = prize / count;
        uint256 dust = prize - share * count;
        totalSplit += prize;
        totalBurned += fee + dust;
        emit Closed(id, State.Unpicked, address(0), 0, share, count, fee + dust, 0);
        _payEntrants(id, b, address(0), share);
        _pay(burnPot, fee + dust);
    }

    function _closePicked(uint256 id, Bounty storage b) internal {
        uint256 job = b.job;
        FactorDesk.Job memory j = desk.job(job);
        if (j.state == FactorDesk.State.Locked || j.state == FactorDesk.State.Advanced) {
            uint256 at = uint256(j.dueAt) + grace;
            if (block.timestamp <= at) revert TooSoon(at + 1);
            desk.refund(job);
            j = desk.job(job);
        } else if (j.state == FactorDesk.State.Delivered) {
            if (j.proof == entries[id][b.winner].hash) {
                desk.accept(job);
            } else {
                // not the entry that was picked: the desk's own clock pays it, and it has lost a day
                uint256 at = uint256(j.deliveredAt) + review;
                if (block.timestamp < at) revert TooSoon(at);
                desk.settle(job);
            }
            j = desk.job(job);
        }
        uint256 prize = b.prize;
        atDesk -= prize;
        if (j.state == FactorDesk.State.Settled) {
            b.state = State.Won;
            totalWon += prize;
            uint256 bond = b.bond;
            bonds -= bond;
            emit Closed(id, State.Won, b.winner, job, 0, 1, 0, 0);
            emit Paid(id, b.winner, 0, bond);
            if (!b.bondsBack) _payEntrants(id, b, b.winner, 0);
            _pay(b.winner, bond);
        } else if (j.state == FactorDesk.State.Refunded || j.state == FactorDesk.State.Declined) {
            b.state = State.Undelivered;
            uint256 forfeited = b.bond;
            bonds -= forfeited;
            uint256 others = entrants_[id].length - 1;
            if (others == 0) {
                totalReturned += prize;
                totalBurned += forfeited;
                emit Closed(id, State.Undelivered, b.winner, job, 0, 0, forfeited, prize);
                _pay(b.poster, prize);
                _pay(burnPot, forfeited);
            } else {
                uint256 pot = prize + forfeited;
                uint256 share = pot / others;
                uint256 dust = pot - share * others;
                totalSplit += prize;
                totalBurned += dust;
                emit Closed(id, State.Undelivered, b.winner, job, share, others, dust, 0);
                _payEntrants(id, b, b.winner, share);
                _pay(burnPot, dust);
            }
        } else {
            // the only other ending is settled at half, which takes a reject only this contract could send, and it has
            // no call that rejects
            revert WrongState(b.state);
        }
    }

    /// @dev Every entrant but `skip` gets `share`, and its bond if bonds have not gone back yet. State first, then ETH.
    function _payEntrants(uint256 id, Bounty storage b, address skip, uint256 share) internal {
        address[] memory list = entrants_[id];
        uint256 bond = b.bondsBack ? 0 : b.bond;
        if (bond != 0) {
            b.bondsBack = true;
            uint256 count = list.length;
            if (skip != address(0)) count -= 1;
            bonds -= bond * count;
        }
        for (uint256 i = 0; i < list.length; ++i) {
            address who = list[i];
            if (who == skip) continue;
            emit Paid(id, who, share, bond);
            _pay(who, share + bond);
        }
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
