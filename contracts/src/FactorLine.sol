// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {FactorDesk} from "./FactorDesk.sol";

/// @title FactorLine
/// @notice Credit lines for agents on Factor's desk: credit with no job behind it, paid back from the agent's next
///         income. See docs/CREDIT-LINES.md for every rule in plain words.
///
///         An agent opens its line once, from the wallet it uses on the desk (its key). This contract then makes the
///         agent a line account (a FactorLineAccount clone), which registers on the desk in the same transaction and
///         is the agent's desk address for new jobs. Every payment into the account pays the line first: the agent
///         can only take out what is left once the line owes nothing.
///
///         The key draws as cash (to the key) or as compute (to the desk's compute gateway, never to the agent), up
///         to its room:
///
///           limit = the account's bond + the job fees the account's jobs paid into the desk's pool (the desk's own
///                   limit for the account); 0 if the account or the key is barred on the desk, or the line defaulted
///           room  = limit - what the desk has advanced the account now - what the line is owed; 0 while late
///
///         so one bond and one set of fees never back two loans: the account refuses a pool advance from the desk
///         bigger than the room the line leaves, and the line subtracts what the desk has out. The fee on a draw is
///         2%, taken out of it: 1% to the burn pot (buy back and burn $FACTOR) and 1% back into this pool.
///
///         A line is due 30 days after the draw that took it above zero. Past that it is late and cannot draw. Still
///         owed 30 days later, anyone may recover it: the account's desk bond and whatever the account holds pay the
///         line, and what is still owed defaults: written off the pool's books, the line barred for good.
///
///         The pool belongs to the protocol. ETH sent here is the pool's for good; nobody can take it out, and the
///         only way ETH leaves the pool is as a draw. There is no owner and nothing can be set after deployment.
///         Every number is a constant, and every address is the desk's or read from the desk.
/// @dev The contract's ETH is `pool` plus `owedTotal` (payouts a wallet refused, waiting to be collected). `out` is
///      what lines that have not defaulted owe; `lost` what defaulted lines still owe. Neither is in the balance.
///      Every function that sends ETH writes its state first and is guarded against re-entry. A repayment (plain
///      ETH from a line account, or `repay`) moves no ETH out, so it is not guarded and may arrive in the middle of
///      `recover`, which reads the debt only after it.
contract FactorLine is ReentrancyGuardTransient {
    uint256 public constant BPS = 10_000;
    /// @notice The fee on a draw, taken out of it: half to the burn pot, half back into this pool.
    uint256 public constant DRAW_FEE_BPS = 200;
    /// @notice The part of the fee that goes to the burn pot.
    uint256 public constant BURN_BPS = 100;
    /// @notice The most of the pool that can be out with lines at one time.
    uint256 public constant POOL_OUT_MAX_BPS = 8000;
    uint256 public constant MIN_DRAW = 0.0001 ether;
    /// @notice A line is due this long after the draw that took its debt above zero.
    uint256 public constant TERM = 30 days;
    /// @notice A line still owed this long after its due time can be recovered, and defaults on what is left.
    uint256 public constant DEFAULT_AFTER = 30 days;
    /// @dev The same bounded push as the desk's.
    uint256 internal constant PUSH_GAS = 50_000;
    uint256 internal constant PUSH_GAS_NEEDED = 95_000;

    /// @dev One line, by its account. Every field is written by this contract and by nothing else.
    struct Line {
        address key; // the agent's wallet on the desk, which opened the line and draws on it
        uint40 openedAt;
        uint40 dueAt; // 0 while nothing is owed
        bool defaulted; // for good
        uint32 draws;
        uint32 onTime; // times the debt was repaid in full by its due time
        uint32 late; // times it was repaid in full after its due time
        uint256 debt;
        uint256 drawn; // everything ever drawn
        uint256 repaid; // everything ever repaid
    }

    FactorDesk public immutable desk;
    /// @notice The desk's burn pot: half of every draw fee buys back and burns $FACTOR there.
    address public immutable burnPot;
    /// @notice The desk's compute gateway: a draw as compute is paid here, never to the agent.
    address public immutable gateway;
    /// @notice The code every line account runs.
    address public immutable accountImplementation;

    mapping(address account => Line) internal lines;
    mapping(address key => address account) public accountOf;
    uint256 public lineCount;

    /// @notice Pool ETH that is here, pool ETH owed by lines, and what defaulted lines still owe.
    uint256 public pool;
    uint256 public out;
    uint256 public lost;
    /// @notice Payouts a wallet refused, waiting to be collected.
    uint256 public owedTotal;
    mapping(address who => uint256) public owed;

    uint256 public totalPoolIn; // everything sent to the pool from outside
    uint256 public totalDrawn;
    uint256 public totalBurned; // the burn half of every draw fee
    uint256 public totalFeesToPool; // the pool half of every draw fee
    uint256 public totalRepaid;
    uint256 public totalRecovered; // repaid on lines that had defaulted

    event Opened(address indexed key, address indexed account);
    event Drawn(
        address indexed account,
        address indexed key,
        uint256 amount,
        uint256 burned,
        uint256 toPool,
        bool asCompute,
        uint256 dueAt
    );
    event Repaid(address indexed account, address indexed from, uint256 amount, uint256 debt, bool late);
    event Defaulted(address indexed account, address indexed key, uint256 debt);
    event PoolIn(address indexed from, uint256 amount);
    event Owed(address indexed who, uint256 amount);
    event Collected(address indexed who, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NotRegistered();
    error Barred();
    error HasLine(address account);
    error IsLineAccount();
    error NoLine();
    error TooSmall(uint256 min);
    error IsDefaulted();
    error IsLate(uint256 dueAt);
    error OverLimit(uint256 room);
    error PoolShort(uint256 room);
    error OverDebt(uint256 debt);
    error NothingOwed();
    error TooSoon(uint256 at);
    error PushFailed();
    error GasShort();

    constructor(FactorDesk desk_) {
        if (address(desk_) == address(0)) revert ZeroAddress();
        desk = desk_;
        burnPot = desk_.burnPot();
        gateway = desk_.gateway();
        if (burnPot == address(0) || gateway == address(0)) revert ZeroAddress();
        accountImplementation = address(new FactorLineAccount(desk_));
    }

    /// @notice ETH from a line account repays that account's line. ETH from anybody else goes into the pool, for
    ///         good: whoever sends it gets no claim on it. To repay a line from elsewhere, use `repay`.
    receive() external payable {
        Line storage l = lines[msg.sender];
        if (l.key != address(0)) {
            _repay(msg.sender, l, msg.value);
            return;
        }
        pool += msg.value;
        totalPoolIn += msg.value;
        emit PoolIn(msg.sender, msg.value);
    }

    // ---------- a line ----------

    /// @notice Open the caller's line, once. The caller must be a registered agent on the desk and not barred there.
    ///         Its line account is made at an address that follows from the caller alone and registers on the desk.
    function open() external nonReentrant returns (address account) {
        if (accountOf[msg.sender] != address(0)) revert HasLine(accountOf[msg.sender]);
        if (lines[msg.sender].key != address(0)) revert IsLineAccount();
        FactorDesk.Agent memory a = desk.agent(msg.sender);
        if (!a.registered) revert NotRegistered();
        if (a.barred) revert Barred();
        account = Clones.cloneDeterministic(accountImplementation, _salt(msg.sender));
        accountOf[msg.sender] = account;
        Line storage l = lines[account];
        l.key = msg.sender;
        l.openedAt = uint40(block.timestamp);
        lineCount += 1;
        emit Opened(msg.sender, account);
        FactorLineAccount(payable(account)).initialize(msg.sender);
    }

    /// @notice Draw on the caller's line: as cash to the caller, or as compute to the gateway. The 2% fee comes out
    ///         of `amount`; the whole of `amount` is owed.
    function draw(uint256 amount, bool asCompute) external nonReentrant {
        address account = accountOf[msg.sender];
        if (account == address(0)) revert NoLine();
        Line storage l = lines[account];
        if (amount < MIN_DRAW) revert TooSmall(MIN_DRAW);
        if (l.defaulted) revert IsDefaulted();
        if (_late(l)) revert IsLate(l.dueAt);
        uint256 room_ = _room(account, l);
        if (amount > room_) revert OverLimit(room_);
        uint256 poolRoom_ = poolRoom();
        if (amount > poolRoom_) revert PoolShort(poolRoom_);

        uint256 fee = (amount * DRAW_FEE_BPS) / BPS;
        uint256 burned = (amount * BURN_BPS) / BPS;
        uint256 toPool = fee - burned;
        if (l.debt == 0) l.dueAt = uint40(block.timestamp + TERM);
        l.debt += amount;
        l.drawn += amount;
        l.draws += 1;
        // the room is never more than the pool holds: 80% of (pool + out) less out is at most the pool
        pool -= amount;
        pool += toPool;
        out += amount;
        totalDrawn += amount;
        totalBurned += burned;
        totalFeesToPool += toPool;
        emit Drawn(account, msg.sender, amount, burned, toPool, asCompute, l.dueAt);
        _pay(burnPot, burned);
        _pay(asCompute ? gateway : msg.sender, amount - fee);
    }

    /// @notice Pay toward a line's debt, from anyone, up to what it owes.
    /// @dev Moves no ETH out, so it is not guarded (see the contract's notes).
    function repay(address account) external payable {
        Line storage l = lines[account];
        if (l.key == address(0)) revert NoLine();
        _repay(account, l, msg.value);
    }

    /// @notice Anyone, once a line is still owed 30 days after its due time (or has defaulted already): what the
    ///         desk owes the account comes home, the account's desk bond pays what the account's ETH does not (only
    ///         while the desk has no advance out to it: the desk's pool comes first), and the account pays the line.
    ///         What is still owed then defaults: written off as lost, the line barred for good. Can be called again
    ///         after a default, to recover what has come in since.
    function recover(address account) external nonReentrant {
        Line storage l = lines[account];
        if (l.key == address(0)) revert NoLine();
        if (l.debt == 0) revert NothingOwed();
        if (!l.defaulted) {
            uint256 at = uint256(l.dueAt) + DEFAULT_AFTER;
            if (block.timestamp <= at) revert TooSoon(at + 1);
        }
        FactorLineAccount acct = FactorLineAccount(payable(account));
        if (desk.owed(account) > 0) desk.collect(account);
        uint256 have = account.balance;
        if (l.debt > have) acct.releaseBond(l.debt - have);
        // the account pays the line with plain ETH, which arrives in receive() as a repayment
        acct.sweep();
        if (l.debt > 0 && !l.defaulted) {
            l.defaulted = true;
            out -= l.debt;
            lost += l.debt;
            emit Defaulted(account, l.key, l.debt);
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

    /// @notice A line, whole, by its account. An address that is no line account reads as an empty line.
    function line(address account) external view returns (Line memory) {
        return lines[account];
    }

    /// @notice The key of a line account, or zero.
    function keyOf(address account) external view returns (address) {
        return lines[account].key;
    }

    /// @notice What a line account owes its line.
    function debtOf(address account) external view returns (uint256) {
        return lines[account].debt;
    }

    /// @notice Where `key`'s line account is, or will be once it opens its line.
    function accountAddress(address key) external view returns (address) {
        return Clones.predictDeterministicAddress(accountImplementation, _salt(key));
    }

    /// @notice How far a line goes: the account's bond plus the fees its jobs paid into the desk's pool (the desk's
    ///         own limit for it). Zero once the account or the key is barred on the desk, or the line defaulted.
    function limit(address account) public view returns (uint256) {
        Line storage l = lines[account];
        if (l.key == address(0) || l.defaulted || desk.agent(l.key).barred) return 0;
        return desk.limit(account);
    }

    /// @notice What is left of the limit, counted once with the desk: less what the desk has advanced the account
    ///         and what the line is owed. Zero while late. The account holds its own pool advances from the desk to
    ///         this as well.
    function room(address account) external view returns (uint256) {
        Line storage l = lines[account];
        if (l.key == address(0)) return 0;
        return _room(account, l);
    }

    /// @notice What `key` can draw on its line right now: its room, and never more than the pool can send out.
    function canDraw(address key) external view returns (uint256) {
        address account = accountOf[key];
        if (account == address(0)) return 0;
        Line storage l = lines[account];
        if (l.defaulted) return 0;
        uint256 r = _room(account, l);
        uint256 p = poolRoom();
        return r < p ? r : p;
    }

    /// @notice Whether a line is past its due time and still owes.
    function isLate(address account) external view returns (bool) {
        return _late(lines[account]);
    }

    /// @notice What the pool can still send out: it never has more than 80% of itself out with lines.
    function poolRoom() public view returns (uint256) {
        uint256 cap = ((pool + out) * POOL_OUT_MAX_BPS) / BPS;
        return cap > out ? cap - out : 0;
    }

    // ---------- internals ----------

    function _salt(address key) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(key)));
    }

    function _late(Line storage l) internal view returns (bool) {
        return l.debt > 0 && block.timestamp > l.dueAt;
    }

    function _room(address account, Line storage l) internal view returns (uint256) {
        if (l.defaulted || _late(l) || desk.agent(l.key).barred) return 0;
        // the desk's canDraw is its limit (0 once the account is barred) less what it has out with the account
        uint256 can = desk.canDraw(account);
        return can > l.debt ? can - l.debt : 0;
    }

    /// @dev A repayment: the pool has its ETH back. On a line that defaulted it is counted as recovered.
    function _repay(address account, Line storage l, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        if (amount > l.debt) revert OverDebt(l.debt);
        l.debt -= amount;
        l.repaid += amount;
        pool += amount;
        totalRepaid += amount;
        bool late_ = block.timestamp > l.dueAt;
        if (l.defaulted) {
            lost -= amount;
            totalRecovered += amount;
        } else {
            out -= amount;
            if (l.debt == 0) {
                if (late_) l.late += 1;
                else l.onTime += 1;
            }
        }
        if (l.debt == 0) l.dueAt = 0;
        emit Repaid(account, msg.sender, amount, l.debt, late_);
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

/// @title FactorLineAccount
/// @notice An agent's line account: its desk address once it has a credit line. It is a small copy that runs this
///         code, made by FactorLine for one key, for good.
///
///         It does desk business for its key and nothing else: the agent's side of a job (bond, advance, deliver,
///         decline) and the customer's (lock, accept, reject), so it can hire other agents too. ETH it is paid stays
///         here until anyone calls `sweep`, which pays the line what it owes; the key can take ETH out only once the
///         line owes nothing. ETH it spends (a bond, a lock) comes from what the key sends with the call or from what
///         it holds beyond what it owes, never from money the line is owed.
///
///         The line contract can make it do one thing more: release its desk bond to pay the line, in `recover`.
///         There is no owner, no other key, no upgrade.
contract FactorLineAccount is ReentrancyGuardTransient {
    bytes4 private constant ERC1271_VALID = 0x1626ba7e;
    bytes4 private constant ERC1271_INVALID = 0xffffffff;

    FactorLine public immutable line;
    FactorDesk public immutable desk;
    /// @notice The agent's wallet, which runs this account. Set once, when the line opens.
    address public key;

    event Withdrawn(address indexed to, uint256 amount);

    error OnlyLine();
    error NotKey();
    error ZeroAddress();
    error Owes(uint256 debt);
    error NotFree(uint256 free);
    error OverLineRoom(uint256 room);
    error PushFailed();

    constructor(FactorDesk desk_) {
        line = FactorLine(payable(msg.sender));
        desk = desk_;
    }

    /// @notice ETH from anybody: a job's payout, a refund, an advance, a gift. It does nothing else, so the desk's
    ///         bounded push always lands; `sweep` sends what the line is owed.
    receive() external payable {}

    /// @notice Given its key by the line contract in the transaction that makes it, and registered on the desk.
    function initialize(address key_) external {
        if (msg.sender != address(line) || key != address(0)) revert OnlyLine();
        key = key_;
        desk.register();
    }

    modifier onlyKey() {
        if (msg.sender != key) revert NotKey();
        _;
    }

    // ---------- money ----------

    /// @notice What the line is owed.
    function owes() public view returns (uint256) {
        return line.debtOf(address(this));
    }

    /// @notice What the account holds beyond what its line is owed: what the key can withdraw or spend.
    function free() public view returns (uint256) {
        uint256 d = owes();
        uint256 b = address(this).balance;
        return b > d ? b - d : 0;
    }

    /// @notice Anyone: pay the line as much as it is owed out of what the account holds.
    function sweep() external nonReentrant returns (uint256 paid) {
        return _sweep();
    }

    /// @notice The key takes ETH out. The line is paid first, and nothing leaves while it is owed anything.
    function withdraw(address payable to, uint256 amount) external nonReentrant onlyKey {
        if (to == address(0)) revert ZeroAddress();
        _sweep();
        uint256 d = owes();
        if (d != 0) revert Owes(d);
        if (amount > address(this).balance) revert NotFree(address(this).balance);
        emit Withdrawn(to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PushFailed();
    }

    // ---------- the desk, as the agent ----------

    /// @notice Add to the account's desk bond: what the key sends, plus `fromBalance` of the account's free ETH.
    function addBond(uint256 fromBalance) external payable nonReentrant onlyKey {
        _spendable(fromBalance);
        desk.addBond{value: msg.value + fromBalance}();
    }

    /// @notice Take bond out of the desk, back into this account. Only while the line owes nothing.
    function takeBond(uint256 amount) external nonReentrant onlyKey {
        uint256 d = owes();
        if (d != 0) revert Owes(d);
        desk.takeBond(amount);
    }

    /// @notice Draw an advance on a job locked for this account. A pool or compute advance comes from the same bond
    ///         and fees as the line, so it is held to the room the line leaves.
    function drawAdvance(uint256 id, uint256 amount, FactorDesk.Kind kind) external nonReentrant onlyKey {
        if (kind != FactorDesk.Kind.Early) {
            uint256 r = line.room(address(this));
            if (amount > r) revert OverLineRoom(r);
        }
        desk.draw(id, amount, kind);
    }

    function deliver(uint256 id, bytes32 proof) external nonReentrant onlyKey {
        desk.deliver(id, proof);
    }

    function decline(uint256 id) external nonReentrant onlyKey {
        desk.decline(id);
    }

    // ---------- the desk, as a customer ----------

    /// @notice Lock a job for another agent: what the key sends, plus `fromBalance` of the account's free ETH.
    function lock(address to, uint256 dueAt, bool allowEarly, uint256 fromBalance)
        external
        payable
        nonReentrant
        onlyKey
        returns (uint256 id)
    {
        _spendable(fromBalance);
        return desk.lock{value: msg.value + fromBalance}(to, dueAt, allowEarly);
    }

    function accept(uint256 id) external nonReentrant onlyKey {
        desk.accept(id);
    }

    function reject(uint256 id) external nonReentrant onlyKey {
        desk.reject(id);
    }

    /// @notice Anyone: have the desk deliver a payout this account was owed. It can only come here.
    function collect() external nonReentrant {
        desk.collect(address(this));
    }

    // ---------- the line ----------

    /// @notice The line contract only, in `recover`: take up to `want` of the desk bond back here, so that it pays the
    ///         line. Nothing happens while the desk has an advance out to this account (its pool comes first).
    function releaseBond(uint256 want) external nonReentrant {
        if (msg.sender != address(line)) revert OnlyLine();
        FactorDesk.Agent memory a = desk.agent(address(this));
        if (a.advancedNow != 0 || a.bond == 0 || want == 0) return;
        desk.takeBond(want < a.bond ? want : a.bond);
    }

    // ---------- signatures ----------

    /// @notice ERC-1271: a signature by the key is the account's. The key can be a wallet or a contract that answers
    ///         ERC-1271 itself, such as a Factor account. Texts Factor asks to be signed carry the address they are
    ///         for, so a signature for the key is not taken for the account, or the reverse.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return SignatureChecker.isValidSignatureNow(key, hash, signature) ? ERC1271_VALID : ERC1271_INVALID;
    }

    // ---------- internals ----------

    function _sweep() internal returns (uint256 paid) {
        uint256 d = owes();
        uint256 b = address(this).balance;
        paid = d < b ? d : b;
        if (paid == 0) return 0;
        (bool ok,) = address(line).call{value: paid}("");
        if (!ok) revert PushFailed();
    }

    /// @dev `fromBalance` may only come out of what the account held before this call beyond what the line is owed.
    function _spendable(uint256 fromBalance) internal view {
        if (fromBalance == 0) return;
        uint256 d = owes();
        uint256 b = address(this).balance - msg.value;
        uint256 f = b > d ? b - d : 0;
        if (fromBalance > f) revert NotFree(f);
    }
}
