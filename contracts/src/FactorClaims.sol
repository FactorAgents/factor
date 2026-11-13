// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FactorDesk} from "./FactorDesk.sol";

/// @title FactorClaims
/// @notice Selling locked pay: a job's locked payment on Factor's desk, turned into a claim that an agent can sell.
///         See docs/LOCKED-PAY.md for every rule in plain words.
///
///         The desk pays a job's payout to the job's agent and to nobody else. So an agent that wants to sell its pay
///         works from a **pay account**: a small contract this contract makes for its key, registered on the desk as an
///         agent. Customers lock jobs for the pay account; the key runs it through this contract (deliver, decline,
///         draw, bond). Everything the desk pays it stays in it until this contract says where it goes:
///
///           list      the key offers the claim on one of its jobs for a price, at most 10% under what the job pays the
///                     agent if it settles in full (the face)
///           buy       anyone else pays that price, straight to the key. From then the buyer holds the claim, and the
///                     key can no longer decline the job or draw on it
///           give      the holder hands the claim to another address
///           settle    once the job has ended, anyone: whatever the job paid the agent goes to the holder. If that is
///                     less than the buyer paid (the job was refunded, declined or settled at half), the difference is
///                     the pay account's debt to the holder, paid first out of everything the account holds or is paid
///                     later, its desk bond included, before the key can take anything out
///
///         Factor's own money is never in it: the buyer pays the seller, the desk pays the account, the account pays
///         the holder. There is no owner and nothing can be set after deployment. Every number is a constant and the
///         desk's address is fixed.
/// @dev The contract's own ETH is only `owedTotal`: payouts a holder refused, waiting to be collected. Every ETH a pay
///      account holds is either (a) a finished sold job's payout, which `sweep` sends to its holder before anything
///      else can leave, or (b) free, which pays the account's debts first and only then can the key withdraw it. Every
///      function that moves ETH or calls the desk is guarded against re-entry and writes its state first.
contract FactorClaims is ReentrancyGuardTransient {
    uint256 public constant BPS = 10_000;
    /// @notice The most a claim can be sold under its face: 10%.
    uint256 public constant MAX_DISCOUNT_BPS = 1000;
    /// @notice The smallest face a claim can have.
    uint256 public constant MIN_FACE = 0.0005 ether;
    /// @notice The most claims one pay account can have listed or sold and not yet ended.
    uint256 public constant MAX_OPEN = 10;
    /// @dev The same bounded push as the desk's.
    uint256 internal constant PUSH_GAS = 50_000;
    uint256 internal constant PUSH_GAS_NEEDED = 95_000;

    enum State {
        None,
        Listed, // offered for sale by the key
        Sold, // bought: the holder is paid when the job ends
        Paid, // the job ended and its payout went to the holder (any shortfall is in `owing`)
        Closed // taken off sale, or the job ended before anyone bought it
    }

    /// @dev One claim. Every field is written by this contract and by nothing else.
    struct Claim {
        address account; // the pay account: the job's agent on the desk
        uint40 listedAt;
        uint40 soldAt;
        State state;
        uint256 job; // the desk job
        uint256 face; // what the job pays the agent if it settles in full, at listing
        uint256 price; // what the buyer pays the seller
        address seller; // the key that listed it
        address holder; // who is paid when the job ends
        address buyer; // who bought it
        uint256 paid; // what the job paid the holder
        uint256 owing; // what the pay account still owes the holder
    }

    FactorDesk public immutable desk;
    /// @notice The code every pay account runs.
    address public immutable accountCode;
    /// @notice The desk's own numbers, read from it once.
    uint256 public immutable jobFeeBps;
    uint256 public immutable rejectedBps;
    uint256 public immutable grace;
    uint256 public immutable review;

    uint256 public claimCount;
    mapping(uint256 id => Claim) internal claims_;
    /// @notice A key's pay account, and a pay account's key.
    mapping(address key => address) public accountOf;
    mapping(address account => address) public keyOf;
    /// @notice The claim listed or sold on a desk job, or 0.
    mapping(uint256 job => uint256 id) public claimOn;
    /// @notice What a pay account owes holders, in all.
    mapping(address account => uint256) public debtOf;
    mapping(address account => uint256[]) internal open_;
    mapping(address account => uint256[]) internal debts_;

    uint256 public owedTotal;
    mapping(address who => uint256) public owed;

    uint256 public totalSold; // the faces of every claim bought
    uint256 public totalPrice; // what buyers paid sellers
    uint256 public totalPaid; // what jobs paid holders
    uint256 public totalOwedBack; // shortfalls that became debts
    uint256 public totalRepaid; // debts paid back

    event Opened(address indexed key, address indexed account);
    event Listed(uint256 indexed id, uint256 indexed job, address indexed account, uint256 face, uint256 price);
    event Unlisted(uint256 indexed id, uint256 indexed job);
    event Bought(uint256 indexed id, uint256 indexed job, address indexed buyer, address seller, uint256 price);
    event Given(uint256 indexed id, address indexed from, address indexed to);
    event Paid(uint256 indexed id, uint256 indexed job, address indexed holder, uint256 paid, uint256 owing);
    event Repaid(uint256 indexed id, address indexed holder, uint256 amount, uint256 owing);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    event Owed(address indexed who, uint256 amount);
    event Collected(address indexed who, address indexed to, uint256 amount);

    error ZeroAddress();
    error HasAccount(address account);
    error NoAccount();
    error NotYourJob();
    error NotForSale();
    error Taken(uint256 id);
    error TooMany();
    error TooSmall(uint256 min);
    error BadPrice(uint256 min, uint256 max);
    error WrongState(State state);
    error NotSeller();
    error NotHolder();
    error WrongAmount(uint256 price);
    error OwnClaim();
    error Changed();
    error Owes(uint256 debt);
    error HasClaim(uint256 id);
    error NotEnded();
    error NotFree(uint256 free);
    error NothingOwed();
    error PushFailed();
    error GasShort();
    error OnlyAccounts();

    constructor(FactorDesk desk_) {
        if (address(desk_) == address(0)) revert ZeroAddress();
        desk = desk_;
        accountCode = address(new FactorPayAccount(desk_));
        jobFeeBps = desk_.JOB_FEE_BPS();
        rejectedBps = desk_.REJECTED_BPS();
        grace = desk_.GRACE();
        review = desk_.REVIEW();
    }

    /// @notice ETH from a pay account on its way to a holder. Nobody else sends ETH here.
    receive() external payable {
        if (keyOf[msg.sender] == address(0)) revert OnlyAccounts();
    }

    // ---------- the pay account ----------

    /// @notice Make your pay account, registered on the desk as an agent. Once per key, at an address known ahead.
    function open() external nonReentrant returns (address account) {
        if (accountOf[msg.sender] != address(0)) revert HasAccount(accountOf[msg.sender]);
        account = Clones.cloneDeterministic(accountCode, bytes32(uint256(uint160(msg.sender))));
        accountOf[msg.sender] = account;
        keyOf[account] = msg.sender;
        FactorPayAccount(payable(account)).initialize();
        emit Opened(msg.sender, account);
    }

    /// @notice Where a key's pay account is, or will be.
    function accountAddress(address key) external view returns (address) {
        return Clones.predictDeterministicAddress(accountCode, bytes32(uint256(uint160(key))));
    }

    /// @notice The key delivers on a job of its pay account.
    function deliver(uint256 job, bytes32 proof) external nonReentrant {
        address a = _jobOfMine(job);
        FactorPayAccount(payable(a)).call_(0, abi.encodeCall(FactorDesk.deliver, (job, proof)));
    }

    /// @notice The key declines a job. Not while a claim on it is listed or sold.
    function decline(uint256 job) external nonReentrant {
        address a = _jobOfMine(job);
        if (claimOn[job] != 0) revert HasClaim(claimOn[job]);
        FactorPayAccount(payable(a)).call_(0, abi.encodeCall(FactorDesk.decline, (job)));
    }

    /// @notice The key draws an advance on a job. Not while a claim on it is listed or sold: it would shrink the pay.
    function draw(uint256 job, uint256 amount, FactorDesk.Kind kind) external nonReentrant {
        address a = _jobOfMine(job);
        if (claimOn[job] != 0) revert HasClaim(claimOn[job]);
        FactorPayAccount(payable(a)).call_(0, abi.encodeCall(FactorDesk.draw, (job, amount, kind)));
    }

    /// @notice The key adds what it sends to its pay account's desk bond.
    function addBond() external payable nonReentrant {
        address a = _mine();
        FactorPayAccount(payable(a)).call_{value: msg.value}(msg.value, abi.encodeCall(FactorDesk.addBond, ()));
    }

    /// @notice The key takes desk bond back into its pay account (the desk allows it only while no pool advance is
    ///         out). From there it pays the account's debts first, like everything the account holds.
    function takeBond(uint256 amount) external nonReentrant {
        address a = _mine();
        FactorPayAccount(payable(a)).call_(0, abi.encodeCall(FactorDesk.takeBond, (amount)));
    }

    /// @notice The key takes ETH out of its pay account. Every ended claim is settled first and every debt to a holder
    ///         must be paid; then all the account holds is free.
    function withdraw(address payable to, uint256 amount) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        address a = _mine();
        _sweep(a);
        if (debtOf[a] != 0) revert Owes(debtOf[a]);
        if (amount > a.balance) revert NotFree(a.balance);
        emit Withdrawn(a, to, amount);
        FactorPayAccount(payable(a)).send_(to, amount);
    }

    // ---------- claims ----------

    /// @notice The key lists the claim on one of its pay account's jobs for `price`, at most 10% under its face.
    ///         The job must be locked, advanced or delivered and still in time; the account must owe nothing.
    function list(uint256 job, uint256 price) external nonReentrant returns (uint256 id) {
        address a = _jobOfMine(job);
        FactorDesk.Job memory j = desk.job(job);
        if (!_forSale(j)) revert NotForSale();
        if (claimOn[job] != 0) revert Taken(claimOn[job]);
        if (debtOf[a] != 0) revert Owes(debtOf[a]);
        if (open_[a].length >= MAX_OPEN) revert TooMany();
        uint256 f = _face(j);
        if (f < MIN_FACE) revert TooSmall(MIN_FACE);
        uint256 min = (f * (BPS - MAX_DISCOUNT_BPS)) / BPS;
        if (price < min || price > f) revert BadPrice(min, f);
        id = ++claimCount;
        Claim storage c = claims_[id];
        c.account = a;
        c.listedAt = uint40(block.timestamp);
        c.state = State.Listed;
        c.job = job;
        c.face = f;
        c.price = price;
        c.seller = msg.sender;
        claimOn[job] = id;
        open_[a].push(id);
        emit Listed(id, job, a, f, price);
    }

    /// @notice The key takes its claim off sale, before anyone buys it.
    function unlist(uint256 id) external nonReentrant {
        Claim storage c = claims_[id];
        if (msg.sender != keyOf[c.account]) revert NotSeller();
        if (c.state != State.Listed) revert WrongState(c.state);
        _close(id, c);
    }

    /// @notice Buy a listed claim: send its price, which goes straight to the seller. From then you are paid what the
    ///         job pays its agent when it ends.
    function buy(uint256 id) external payable nonReentrant {
        Claim storage c = claims_[id];
        if (c.state != State.Listed) revert WrongState(c.state);
        if (msg.value != c.price) revert WrongAmount(c.price);
        address key = keyOf[c.account];
        if (msg.sender == key || msg.sender == c.account) revert OwnClaim();
        FactorDesk.Job memory j = desk.job(c.job);
        if (!_forSale(j)) revert NotForSale();
        if (_face(j) != c.face) revert Changed();
        if (debtOf[c.account] != 0) revert Owes(debtOf[c.account]);
        c.state = State.Sold;
        c.soldAt = uint40(block.timestamp);
        c.holder = msg.sender;
        c.buyer = msg.sender;
        totalSold += c.face;
        totalPrice += c.price;
        emit Bought(id, c.job, msg.sender, key, c.price);
        (bool ok,) = key.call{value: msg.value}("");
        if (!ok) revert PushFailed();
    }

    /// @notice The holder hands the claim, and anything still owed on it, to another address.
    function give(uint256 id, address to) external nonReentrant {
        Claim storage c = claims_[id];
        if (msg.sender != c.holder) revert NotHolder();
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        if (c.state != State.Sold && !(c.state == State.Paid && c.owing != 0)) revert WrongState(c.state);
        c.holder = to;
        emit Given(id, msg.sender, to);
    }

    /// @notice Anyone: settle every claim of a pay account whose job has ended, ending on the desk first a job that
    ///         can be ended, and pay the account's debts out of what it holds.
    function sweep(address account) external nonReentrant {
        if (keyOf[account] == address(0)) revert NoAccount();
        _sweep(account);
    }

    /// @notice Anyone: settle one claim, as `sweep` does for its whole account. It refuses a claim whose job has not
    ///         ended and cannot be ended yet.
    function settle(uint256 id) external nonReentrant {
        Claim storage c = claims_[id];
        if (c.state != State.Listed && c.state != State.Sold && !(c.state == State.Paid && c.owing != 0)) {
            revert WrongState(c.state);
        }
        _sweep(c.account);
        if (c.state == State.Listed || c.state == State.Sold) revert NotEnded();
    }

    // ---------- collecting a payout that was refused ----------

    function collect(address who) external nonReentrant {
        uint256 amount = _clearOwed(who);
        emit Collected(who, who, amount);
        (bool ok,) = who.call{value: amount}("");
        if (!ok) revert PushFailed();
    }

    function collectTo(address payable to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = _clearOwed(msg.sender);
        emit Collected(msg.sender, to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PushFailed();
    }

    // ---------- views ----------

    function claim(uint256 id) external view returns (Claim memory) {
        return claims_[id];
    }

    /// @notice A pay account's claims listed or sold that have not ended.
    function openOf(address account) external view returns (uint256[] memory) {
        return open_[account];
    }

    /// @notice A pay account's claims that ended with a debt still owed.
    function debtsOf(address account) external view returns (uint256[] memory) {
        return debts_[account];
    }

    /// @notice What a desk job pays its agent if it settles in full, as it stands now.
    function faceOf(uint256 job) external view returns (uint256) {
        return _face(desk.job(job));
    }

    /// @notice Whether a claim on this job could be listed or bought now, by the job alone.
    function forSale(uint256 job) external view returns (bool) {
        return _forSale(desk.job(job));
    }

    // ---------- internals ----------

    function _mine() internal view returns (address a) {
        a = accountOf[msg.sender];
        if (a == address(0)) revert NoAccount();
    }

    function _jobOfMine(uint256 job) internal view returns (address a) {
        a = _mine();
        if (desk.job(job).agent != a) revert NotYourJob();
    }

    /// @dev Locked or advanced and not yet due, or delivered and still in the customer's review time.
    function _forSale(FactorDesk.Job memory j) internal view returns (bool) {
        if (j.state == FactorDesk.State.Locked || j.state == FactorDesk.State.Advanced) {
            return block.timestamp <= j.dueAt;
        }
        if (j.state == FactorDesk.State.Delivered) return block.timestamp < uint256(j.deliveredAt) + review;
        return false;
    }

    /// @dev The desk's own arithmetic for a job settled in full: the price less what was advanced and the job fee.
    function _face(FactorDesk.Job memory j) internal view returns (uint256) {
        uint256 fee = (j.price * jobFeeBps) / BPS;
        uint256 taken = j.early + j.fromPool + fee;
        return j.price > taken ? j.price - taken : 0;
    }

    /// @dev What the desk paid the agent when the job ended: the desk's own arithmetic for each ending.
    function _payout(FactorDesk.Job memory j) internal view returns (uint256) {
        if (j.state == FactorDesk.State.Settled) return _face(j);
        if (j.state == FactorDesk.State.SettledAtHalf) {
            uint256 toCustomer = (j.price * rejectedBps) / BPS;
            uint256 left = j.price - toCustomer - j.early - j.fromPool;
            uint256 fee = ((j.price - toCustomer) * jobFeeBps) / BPS;
            if (fee > left) fee = left;
            return left - fee;
        }
        return 0; // declined, refunded: nothing to the agent
    }

    function _ended(FactorDesk.State s) internal pure returns (bool) {
        return s == FactorDesk.State.Settled || s == FactorDesk.State.SettledAtHalf || s == FactorDesk.State.Declined
            || s == FactorDesk.State.Refunded;
    }

    function _close(uint256 id, Claim storage c) internal {
        c.state = State.Closed;
        claimOn[c.job] = 0;
        _removeOpen(c.account, id);
        emit Unlisted(id, c.job);
    }

    function _removeOpen(address a, uint256 id) internal {
        uint256[] storage o = open_[a];
        uint256 n = o.length;
        for (uint256 i = 0; i < n; ++i) {
            if (o[i] == id) {
                o[i] = o[n - 1];
                o.pop();
                return;
            }
        }
    }

    /// @dev Ends on the desk what can be ended, pays every ended sold claim's holder out of the payout the desk sent the
    ///      account, closes every ended listing, then pays the account's debts out of what is left, its desk bond
    ///      included. Afterwards everything the account holds is free.
    function _sweep(address a) internal {
        uint256[] storage o = open_[a];
        // 1. end on the desk the jobs that can be ended: a delivery past its review, a job past its due time and grace
        for (uint256 i = 0; i < o.length; ++i) {
            uint256 job = claims_[o[i]].job;
            FactorDesk.Job memory j = desk.job(job);
            if (j.state == FactorDesk.State.Delivered && block.timestamp >= uint256(j.deliveredAt) + review) {
                desk.settle(job);
            } else if (
                (j.state == FactorDesk.State.Locked || j.state == FactorDesk.State.Advanced)
                    && block.timestamp > uint256(j.dueAt) + grace
            ) {
                desk.refund(job);
            }
        }
        // 2. a payout the account was owed by the desk comes in
        if (desk.owed(a) != 0) desk.collect(a);
        // 3. every ended claim
        uint256 i = o.length;
        while (i > 0) {
            --i;
            uint256 id = o[i];
            Claim storage c = claims_[id];
            FactorDesk.Job memory j = desk.job(c.job);
            if (!_ended(j.state)) continue;
            if (c.state == State.Listed) {
                _close(id, c);
                continue;
            }
            uint256 p = _payout(j);
            c.state = State.Paid;
            c.paid = p;
            claimOn[c.job] = 0;
            _removeOpen(a, id);
            totalPaid += p;
            if (p < c.price) {
                c.owing = c.price - p;
                debtOf[a] += c.owing;
                totalOwedBack += c.owing;
                debts_[a].push(id);
            }
            emit Paid(id, c.job, c.holder, p, c.owing);
            _toHolder(a, c.holder, p);
        }
        // 4. the debts, oldest first, out of what the account holds and then its desk bond
        uint256[] storage d = debts_[a];
        while (d.length != 0 && debtOf[a] != 0) {
            uint256 id = d[0];
            Claim storage c = claims_[id];
            uint256 have = a.balance;
            if (have < c.owing) {
                FactorDesk.Agent memory ag = desk.agent(a);
                if (ag.bond != 0 && ag.advancedNow == 0) {
                    uint256 want = c.owing - have;
                    FactorPayAccount(payable(a)).call_(
                        0, abi.encodeCall(FactorDesk.takeBond, (want < ag.bond ? want : ag.bond))
                    );
                    have = a.balance;
                }
            }
            uint256 pay = have < c.owing ? have : c.owing;
            if (pay == 0) break;
            c.owing -= pay;
            debtOf[a] -= pay;
            totalRepaid += pay;
            emit Repaid(id, c.holder, pay, c.owing);
            _toHolder(a, c.holder, pay);
            if (c.owing != 0) break;
            // drop the first, keeping the order
            uint256 n = d.length;
            for (uint256 k = 1; k < n; ++k) {
                d[k - 1] = d[k];
            }
            d.pop();
        }
    }

    /// @dev The account sends the amount here, and it is pushed to the holder with the desk's bounded push; one that is
    ///      refused is kept for the holder to collect.
    function _toHolder(address a, address holder, uint256 amount) internal {
        if (amount == 0) return;
        FactorPayAccount(payable(a)).send_(payable(address(this)), amount);
        if (gasleft() < PUSH_GAS_NEEDED) revert GasShort();
        uint256 gasCap = PUSH_GAS;
        bool ok;
        assembly ("memory-safe") {
            ok := call(gasCap, holder, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            owed[holder] += amount;
            owedTotal += amount;
            emit Owed(holder, amount);
        }
    }

    function _clearOwed(address who) internal returns (uint256 amount) {
        amount = owed[who];
        if (amount == 0) revert NothingOwed();
        owed[who] = 0;
        owedTotal -= amount;
    }
}

/// @title FactorPayAccount
/// @notice An agent's pay account: its desk address when it sells its pay. A small copy of this code made by
///         FactorClaims for one key, for good. It obeys FactorClaims and nothing else, and FactorClaims lets it make
///         only the desk's agent calls (deliver, decline, draw, bond, collect) for its key, and send ETH where the
///         rules of the claims say. ETH it is paid stays here until then.
contract FactorPayAccount {
    address public immutable claims;
    FactorDesk public immutable desk;

    error OnlyClaims();
    error CallFailed();

    constructor(FactorDesk desk_) {
        claims = msg.sender;
        desk = desk_;
    }

    /// @notice ETH from anybody: a job's payout, an advance, a bond taken back. It does nothing else, so the desk's
    ///         bounded push always lands.
    receive() external payable {}

    modifier onlyClaims() {
        if (msg.sender != claims) revert OnlyClaims();
        _;
    }

    /// @notice Registered on the desk once, when FactorClaims makes it.
    function initialize() external onlyClaims {
        desk.register();
    }

    /// @notice A call to the desk, and only the desk.
    function call_(uint256 value, bytes calldata data) external payable onlyClaims returns (bytes memory out) {
        bool ok;
        (ok, out) = address(desk).call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(out, 32), mload(out))
            }
        }
    }

    /// @notice Send ETH where FactorClaims says.
    function send_(address payable to, uint256 amount) external onlyClaims {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert CallFailed();
    }
}
