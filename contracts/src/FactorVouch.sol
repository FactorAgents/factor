// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FactorDesk} from "./FactorDesk.sol";
import {FactorLine} from "./FactorLine.sol";
import {FactorGuarantee} from "./FactorGuarantee.sol";

/// @title FactorVouch
/// @notice Vouching on Factor's desk: an agent with a strong score co-signs a newer agent's credit line or one of its
///         guarantees, up to a share of its own vouching bond. See docs/VOUCHING.md for every rule in plain words.
///
///         A voucher puts up a vouching bond here and offers a vouch: on another agent's credit line (FactorLine), or
///         on a cover that agent sold on a desk job (FactorGuarantee). The offer holds that much of the voucher's bond
///         back at once. The vouched agent accepts it by paying the fee, 2% of the amount, held here until the vouch
///         ends. Then:
///
///           kept      the line owed nothing when the vouch's 30 days were over (or the debt open then was repaid),
///                     or the covered job was delivered: the amount is free in the voucher's bond again, and the fee
///                     goes half to the voucher (into its bond) and half to the burn pot
///           failed    the line defaulted on debt that was open while the vouch stood, or the covered job was never
///                     delivered: whoever bore the loss is paid out of the fee first and then the voucher's bond, up
///                     to the loss and the amount: the line pool (as a repayment of the line) or the job's customer
///                     (the vouched amount, on top of the cover and the desk's refund)
///           returned  the covered job was declined: nobody lost anything; the amount is free again and the fee goes
///                     back to whoever paid it
///
///         Nothing here changes the line contract, the guarantee contract or the desk, which know nothing of it: every
///         outcome is read from their own state, and anyone can settle a vouch once its outcome is there. A voucher's
///         score is the guarantee contract's own reading of the desk's score (the better of a line account's and its
///         key's, 0 once barred or defaulted). Nobody vouches for itself: an agent and its line account or key are one.
///
///         There is no owner and nothing can be set after deployment. Every number is a constant, and every address
///         is the guarantee contract's or read from it.
/// @dev The contract's ETH is `bonds` (all vouchers' bonds, the amounts held back for vouches included), `feesHeld`
///      (fees of vouches that have not ended) and `owedTotal` (payouts a wallet refused, waiting to be collected).
///      `held` is the part of `bonds` held back for vouches. Every function that sends ETH or calls another contract
///      is guarded against re-entry; payouts are pushed with a fixed amount of gas and one that is refused is kept as
///      owed. What a voucher earns is added to its bond, never pushed.
contract FactorVouch is ReentrancyGuardTransient {
    uint256 public constant BPS = 10_000;
    /// @notice The least score a voucher needs to offer a vouch: the guarantee contract's reading of the desk's score.
    uint256 public constant MIN_SCORE = 300;
    /// @notice The most of a voucher's bond that can stand behind one agent at once.
    uint256 public constant MAX_SHARE_BPS = 2500;
    /// @notice The fee, paid by the vouched agent when it accepts: 2% of the amount vouched.
    uint256 public constant FEE_BPS = 200;
    /// @notice The voucher's part of the fee when the vouch is kept; the rest goes to the burn pot.
    uint256 public constant VOUCHER_BPS = 5000;
    /// @notice The smallest vouch.
    uint256 public constant MIN_VOUCH = 0.0001 ether;
    /// @notice How long a vouch on a credit line stands once accepted.
    uint256 public constant LINE_TERM = 30 days;
    /// @notice How long an offer waits to be accepted.
    uint256 public constant OFFER_WINDOW = 7 days;
    /// @dev The same bounded push as the desk's.
    uint256 internal constant PUSH_GAS = 50_000;
    uint256 internal constant PUSH_GAS_NEEDED = 95_000;

    enum Kind {
        Line, // a credit line, by its line account
        Cover // a cover on one desk job, by its number in the guarantee contract
    }

    enum State {
        None,
        Offered, // held back from the voucher's bond, waiting for the agent to accept
        Active, // accepted, the fee paid
        Kept, // the agent repaid or delivered: the amount free again, the fee shared
        Failed, // the agent defaulted or did not deliver: the loss paid from the fee and the bond
        Returned, // the covered job was declined: the amount free again, the fee back
        Withdrawn // the offer was taken back, or never accepted in time
    }

    /// @dev One vouch. Every field is written by this contract and by nothing else.
    struct Vouch {
        address voucher; // its desk address: a line account when it has one
        uint40 offeredAt;
        uint40 startedAt; // when the agent accepted it
        uint40 endsAt; // a line vouch: the end of its 30 days. A cover vouch ends with its job: 0
        Kind kind;
        State state;
        address agent; // the vouched agent, its desk address: a line account when it has one
        address payer; // who paid the fee
        uint256 subject; // the line account (as a number) or the cover's number
        uint256 amount; // held back from the voucher's bond
        uint256 fee;
        uint256 debtAtOffer; // a line vouch: what the line owed when it was offered
        uint256 paid; // to whoever bore the loss, when it failed
        address paidTo;
    }

    /// @dev One voucher's bond and record.
    struct Voucher {
        uint256 bond; // all of it, amounts held back included
        uint256 held; // held back for vouches offered or standing
        uint32 vouches; // accepted
        uint32 kept;
        uint32 failed;
        uint32 returned;
        uint256 vouchedTotal; // the amounts of every vouch accepted
        uint256 lostTotal; // paid out of its bond for vouches that failed
        uint256 earned; // its part of the fees of vouches kept
    }

    FactorDesk public immutable desk;
    FactorLine public immutable line;
    FactorGuarantee public immutable guarantee;
    /// @notice The desk's burn pot: the rest of every fee kept buys back and burns $FACTOR there.
    address public immutable burnPot;
    /// @notice The line contract's own numbers, read from it once: a line is due this long after the draw that took
    ///         it above zero, and recoverable this long after that.
    uint256 public immutable lineDue;
    uint256 public immutable lineDefaultAfter;
    /// @notice The desk's own numbers, read from it once: the grace after a due time, the customer's review time.
    uint256 public immutable grace;
    uint256 public immutable review;

    mapping(address voucher => Voucher) internal vouchers_;
    mapping(uint256 id => Vouch) internal vouches_;
    uint256 public vouchCount;
    /// @notice What a voucher holds back for one agent, across its vouches offered or standing.
    mapping(address voucher => mapping(address agent => uint256)) public heldOn;
    /// @notice A voucher's vouch offered or standing on one line or cover, or 0: one at a time.
    mapping(address voucher => mapping(Kind kind => mapping(uint256 subject => uint256 id))) public openOf;

    /// @notice All bonds, the part held back for vouches, the fees of vouches that have not ended, payouts waiting.
    uint256 public bonds;
    uint256 public held;
    uint256 public feesHeld;
    uint256 public owedTotal;
    mapping(address who => uint256) public owed;

    uint256 public totalVouched; // the amounts of every vouch accepted
    uint256 public totalPaid; // paid to whoever bore a loss
    uint256 public totalEarned; // vouchers' part of the fees
    uint256 public totalBurned;

    event BondAdded(address indexed voucher, address indexed from, uint256 amount, uint256 bond);
    event BondTaken(address indexed voucher, uint256 amount, uint256 bond);
    event Offered(
        uint256 indexed id,
        address indexed voucher,
        address indexed agent,
        Kind kind,
        uint256 subject,
        uint256 amount,
        uint256 fee,
        uint256 expiresAt
    );
    event Accepted(uint256 indexed id, address indexed agent, address indexed payer, uint256 fee, uint256 endsAt);
    event Withdrawn(uint256 indexed id, address indexed voucher);
    /// @notice A vouch ended: kept (`toVoucher` and `burned`), failed (`paid` to `paidTo`, the rest of the fee
    ///         `burned`) or returned (`feeBack`).
    event Settled(
        uint256 indexed id,
        address indexed voucher,
        address indexed agent,
        State how,
        uint256 toVoucher,
        uint256 burned,
        uint256 paid,
        address paidTo,
        uint256 feeBack
    );
    event Owed(address indexed who, uint256 amount);
    event Collected(address indexed who, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NoLineContract();
    error NotRegistered();
    error NotVoucher();
    error NotAgent();
    error ScoreTooLow(uint256 score, uint256 min);
    error TooSmall(uint256 min);
    error Related();
    error OverShare(uint256 room);
    error OverFree(uint256 free);
    error AlreadyVouched(uint256 id);
    error NoLine();
    error LineDefaulted();
    error LineLate(uint256 dueAt);
    error DebtGrew(uint256 debt);
    error NotCovered();
    error JobNotOpen();
    error WrongState(State state);
    error WrongKind();
    error WrongFee(uint256 fee);
    error Expired(uint256 at);
    error TooSoon(uint256 at);
    error NotYet();
    error StillOwes(uint256 debt);
    error NothingOwed();
    error PushFailed();
    error GasShort();

    constructor(FactorGuarantee guarantee_) {
        if (address(guarantee_) == address(0)) revert ZeroAddress();
        FactorLine line_ = guarantee_.line();
        if (address(line_) == address(0)) revert NoLineContract();
        guarantee = guarantee_;
        line = line_;
        desk = guarantee_.desk();
        burnPot = guarantee_.burnPot();
        lineDue = line_.TERM();
        lineDefaultAfter = line_.DEFAULT_AFTER();
        grace = guarantee_.grace();
        review = guarantee_.review();
    }

    // ---------- the voucher's bond ----------

    /// @notice Add the ETH sent to a voucher's bond. Anyone may; nobody gets a claim on it by doing so. The voucher
    ///         must be registered on the desk; a key with a line account bonds as its line account.
    function addBond(address voucher) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        voucher = agentOf(voucher);
        if (!desk.agent(voucher).registered) revert NotRegistered();
        Voucher storage b = vouchers_[voucher];
        b.bond += msg.value;
        bonds += msg.value;
        emit BondAdded(voucher, msg.sender, msg.value, b.bond);
    }

    /// @notice The voucher (or its line key) takes out bond no vouch holds back. It goes to the voucher's desk address
    ///         (to a line account, where it repays the line first).
    function takeBond(address voucher, uint256 amount) external nonReentrant {
        voucher = _onlyRunner(voucher, false);
        if (amount == 0) revert ZeroAmount();
        Voucher storage b = vouchers_[voucher];
        uint256 free = b.bond - b.held;
        if (amount > free) revert OverFree(free);
        b.bond -= amount;
        bonds -= amount;
        emit BondTaken(voucher, amount, b.bond);
        _pay(voucher, amount);
    }

    // ---------- an offer ----------

    /// @notice The voucher (or its line key) offers to co-sign another agent's credit line, by its line account. The
    ///         amount is held back from the voucher's bond at once; the line's key accepts it by paying the fee.
    function offerLine(address voucher, address account, uint256 amount) external nonReentrant returns (uint256 id) {
        voucher = _onlyRunner(voucher, false);
        if (line.keyOf(account) == address(0)) revert NoLine();
        FactorLine.Line memory l = line.line(account);
        if (l.defaulted) revert LineDefaulted();
        if (line.isLate(account)) revert LineLate(l.dueAt);
        id = _offer(voucher, account, Kind.Line, uint256(uint160(account)), amount);
        vouches_[id].debtAtOffer = l.debt;
    }

    /// @notice The voucher (or its line key) offers to co-sign a cover the agent sold on a desk job, by the cover's
    ///         number in the guarantee contract. The cover must be tied to its job and the job not drawn on, delivered
    ///         or due yet. The covered agent accepts it by paying the fee.
    function offerCover(address voucher, uint256 coverId, uint256 amount) external nonReentrant returns (uint256 id) {
        voucher = _onlyRunner(voucher, false);
        FactorGuarantee.Cover memory c = _openCover(coverId);
        if (related(voucher, c.customer)) revert Related();
        id = _offer(voucher, agentOf(c.agent), Kind.Cover, coverId, amount);
    }

    /// @notice The vouched agent (or its line key) accepts an offer, paying the fee with it. The vouch stands from now:
    ///         a line vouch for 30 days, a cover vouch until its job ends.
    function accept(uint256 id) external payable nonReentrant {
        Vouch storage v = vouches_[id];
        if (v.state != State.Offered) revert WrongState(v.state);
        _onlyRunner(v.agent, true);
        uint256 lapsesAt = uint256(v.offeredAt) + OFFER_WINDOW;
        if (block.timestamp > lapsesAt) revert Expired(lapsesAt);
        if (msg.value != v.fee) revert WrongFee(v.fee);
        if (v.kind == Kind.Line) {
            address account = address(uint160(v.subject));
            FactorLine.Line memory l = line.line(account);
            if (l.defaulted) revert LineDefaulted();
            if (line.isLate(account)) revert LineLate(l.dueAt);
            if (l.debt > v.debtAtOffer) revert DebtGrew(l.debt);
            v.endsAt = uint40(block.timestamp + LINE_TERM);
        } else {
            _openCover(v.subject);
        }
        v.state = State.Active;
        v.startedAt = uint40(block.timestamp);
        v.payer = msg.sender;
        feesHeld += v.fee;
        Voucher storage b = vouchers_[v.voucher];
        b.vouches += 1;
        b.vouchedTotal += v.amount;
        totalVouched += v.amount;
        emit Accepted(id, v.agent, msg.sender, v.fee, v.endsAt);
    }

    /// @notice An offer not accepted yet is taken back: by the voucher (or its line key) at any time, by anyone once
    ///         its seven days are over. The amount is free in the voucher's bond again.
    function withdraw(uint256 id) external nonReentrant {
        Vouch storage v = vouches_[id];
        if (v.state != State.Offered) revert WrongState(v.state);
        if (!_runs(v.voucher, msg.sender)) {
            uint256 lapsesAt = uint256(v.offeredAt) + OFFER_WINDOW;
            if (block.timestamp <= lapsesAt) revert TooSoon(lapsesAt + 1);
        }
        v.state = State.Withdrawn;
        _release(v);
        emit Withdrawn(id, v.voucher);
    }

    // ---------- the end of a vouch ----------

    /// @notice Anyone, once a standing vouch's outcome is on the chain:
    ///         a line vouch is kept once its 30 days are over and the debt open then is repaid (or nothing was owed),
    ///         and fails once the line defaults on debt that was open while it stood (a line due to be recovered is
    ///         recovered first, so one call is enough);
    ///         a cover vouch is kept when the job was delivered, fails when it was refunded, and is returned when it
    ///         was declined (a cover whose job is finished, or due to be refunded or settled, is closed first).
    function settle(uint256 id) external nonReentrant {
        Vouch storage v = vouches_[id];
        if (v.state != State.Active) revert WrongState(v.state);
        if (v.kind == Kind.Line) _settleLine(id, v);
        else _settleCover(id, v);
    }

    /// @notice The vouched agent (or its line key) ends a line vouch early, while its line owes nothing: kept, as if
    ///         its 30 days were over. Only the agent can give up the vouch it paid for.
    function release(uint256 id) external nonReentrant {
        Vouch storage v = vouches_[id];
        if (v.state != State.Active) revert WrongState(v.state);
        if (v.kind != Kind.Line) revert WrongKind();
        _onlyRunner(v.agent, true);
        FactorLine.Line memory l = line.line(address(uint160(v.subject)));
        if (l.debt != 0) revert StillOwes(l.debt);
        _keep(id, v);
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

    /// @notice A vouch, whole. A number never given out reads as a vouch in state None.
    function vouch(uint256 id) external view returns (Vouch memory) {
        return vouches_[id];
    }

    /// @notice A voucher's bond and record, whole, by its desk address.
    function voucherOf(address voucher) external view returns (Voucher memory) {
        return vouchers_[agentOf(voucher)];
    }

    /// @notice What of a voucher's bond no vouch holds back: what it can take out, and the most a new vouch can be.
    function freeOf(address voucher) public view returns (uint256) {
        Voucher storage b = vouchers_[agentOf(voucher)];
        return b.bond - b.held;
    }

    /// @notice A voucher's score: the guarantee contract's reading of the desk's score, by its desk address.
    function scoreOf(address voucher) public view returns (uint256) {
        return guarantee.scoreOf(agentOf(voucher));
    }

    /// @notice The most `voucher` can vouch for `agent` right now: 0 if its score is under the least, or the two are
    ///         one; otherwise the smallest of its free bond and what its share for one agent leaves.
    function canVouch(address voucher, address agent) external view returns (uint256) {
        voucher = agentOf(voucher);
        agent = agentOf(agent);
        if (related(voucher, agent) || scoreOf(voucher) < MIN_SCORE) return 0;
        Voucher storage b = vouchers_[voucher];
        uint256 share = (b.bond * MAX_SHARE_BPS) / BPS;
        uint256 room = share > heldOn[voucher][agent] ? share - heldOn[voucher][agent] : 0;
        uint256 free = b.bond - b.held;
        return room < free ? room : free;
    }

    /// @notice The desk address an agent works from: its line account when it has one, otherwise itself.
    function agentOf(address who) public view returns (address) {
        if (line.keyOf(who) != address(0)) return who;
        address account = line.accountOf(who);
        return account == address(0) ? who : account;
    }

    /// @notice Whether two addresses are one agent as far as the chain can show: the same, or a line account and its
    ///         key. Such a pair cannot vouch for each other, nor a voucher co-sign a cover its own customer bought.
    function related(address a, address b) public view returns (bool) {
        return agentOf(a) == agentOf(b);
    }

    /// @notice The fee on a vouch of `amount`: 2% of it.
    function feeFor(uint256 amount) public pure returns (uint256) {
        return (amount * FEE_BPS) / BPS;
    }

    // ---------- internals ----------

    /// @dev Whether `who` runs `agent`: the agent itself, or the key of its line account.
    function _runs(address agent, address who) internal view returns (bool) {
        return who == agent || (who != address(0) && who == line.keyOf(agent));
    }

    /// @dev The caller must run `who` (given as any of its addresses); returns its desk address.
    function _onlyRunner(address who, bool asAgent) internal view returns (address agent) {
        agent = agentOf(who);
        if (!_runs(agent, msg.sender)) {
            if (asAgent) revert NotAgent();
            revert NotVoucher();
        }
    }

    function _offer(address voucher, address agent, Kind kind, uint256 subject, uint256 amount)
        internal
        returns (uint256 id)
    {
        if (amount < MIN_VOUCH) revert TooSmall(MIN_VOUCH);
        if (related(voucher, agent)) revert Related();
        if (!desk.agent(agent).registered) revert NotRegistered();
        uint256 score = guarantee.scoreOf(voucher);
        if (score < MIN_SCORE) revert ScoreTooLow(score, MIN_SCORE);
        uint256 open_ = openOf[voucher][kind][subject];
        if (open_ != 0) revert AlreadyVouched(open_);
        Voucher storage b = vouchers_[voucher];
        uint256 share = (b.bond * MAX_SHARE_BPS) / BPS;
        uint256 onAgent = heldOn[voucher][agent];
        if (onAgent + amount > share) revert OverShare(share > onAgent ? share - onAgent : 0);
        uint256 free = b.bond - b.held;
        if (amount > free) revert OverFree(free);

        b.held += amount;
        held += amount;
        heldOn[voucher][agent] = onAgent + amount;
        id = ++vouchCount;
        openOf[voucher][kind][subject] = id;
        Vouch storage v = vouches_[id];
        v.voucher = voucher;
        v.agent = agent;
        v.kind = kind;
        v.subject = subject;
        v.amount = amount;
        v.fee = feeFor(amount);
        v.offeredAt = uint40(block.timestamp);
        v.state = State.Offered;
        emit Offered(id, voucher, agent, kind, subject, amount, v.fee, block.timestamp + OFFER_WINDOW);
    }

    /// @dev A cover a vouch can stand behind: tied to its job, which is locked, not drawn on and not due yet.
    function _openCover(uint256 coverId) internal view returns (FactorGuarantee.Cover memory c) {
        c = guarantee.cover(coverId);
        if (c.state != FactorGuarantee.State.Bound) revert NotCovered();
        FactorDesk.Job memory j = desk.job(c.job);
        if (j.state != FactorDesk.State.Locked || block.timestamp >= j.dueAt) revert JobNotOpen();
    }

    function _settleLine(uint256 id, Vouch storage v) internal {
        address account = address(uint160(v.subject));
        FactorLine.Line memory l = line.line(account);
        if (!l.defaulted && l.debt > 0 && block.timestamp > uint256(l.dueAt) + lineDefaultAfter) {
            line.recover(account);
            l = line.line(account);
        }
        // the debt open now began while the vouch stood: the draw that took it above zero was by the vouch's end
        bool backed = l.debt > 0 && uint256(l.dueAt) - lineDue <= v.endsAt;
        if (l.defaulted && backed) {
            _fail(id, v, l.debt, address(line));
        } else if (block.timestamp > v.endsAt && !backed) {
            _keep(id, v);
        } else {
            revert NotYet();
        }
    }

    function _settleCover(uint256 id, Vouch storage v) internal {
        FactorGuarantee.Cover memory c = guarantee.cover(v.subject);
        if (c.state == FactorGuarantee.State.Bound) {
            FactorDesk.Job memory j = desk.job(c.job);
            bool open_ = j.state == FactorDesk.State.Locked || j.state == FactorDesk.State.Advanced;
            if (open_ && block.timestamp <= uint256(j.dueAt) + grace) revert NotYet();
            if (j.state == FactorDesk.State.Delivered && block.timestamp < uint256(j.deliveredAt) + review) {
                revert NotYet();
            }
            guarantee.close(c.job);
            c = guarantee.cover(v.subject);
        }
        if (c.state == FactorGuarantee.State.Released) _keep(id, v);
        else if (c.state == FactorGuarantee.State.Paid) _fail(id, v, v.amount, c.customer);
        else if (c.state == FactorGuarantee.State.Declined) _return(id, v);
        else revert NotYet();
    }

    /// @dev Kept: the amount is free again; the voucher's part of the fee goes into its bond, the rest to the burn.
    function _keep(uint256 id, Vouch storage v) internal {
        v.state = State.Kept;
        _release(v);
        Voucher storage b = vouchers_[v.voucher];
        uint256 fee = v.fee;
        uint256 toVoucher = (fee * VOUCHER_BPS) / BPS;
        uint256 burned = fee - toVoucher;
        feesHeld -= fee;
        b.kept += 1;
        b.earned += toVoucher;
        b.bond += toVoucher;
        bonds += toVoucher;
        totalEarned += toVoucher;
        totalBurned += burned;
        emit Settled(id, v.voucher, v.agent, State.Kept, toVoucher, burned, 0, address(0), 0);
        _pay(burnPot, burned);
    }

    /// @dev Failed: whoever bore the loss is paid out of the fee first, then the bond, up to the loss and to the fee
    ///      and the amount together. What the loss leaves of the fee goes to the burn; of the amount, back to the bond.
    function _fail(uint256 id, Vouch storage v, uint256 loss, address to) internal {
        v.state = State.Failed;
        _release(v);
        uint256 fee = v.fee;
        uint256 pay = fee + v.amount;
        if (loss < pay) pay = loss;
        uint256 fromFee = pay < fee ? pay : fee;
        uint256 fromBond = pay - fromFee;
        uint256 burned = fee - fromFee;
        Voucher storage b = vouchers_[v.voucher];
        feesHeld -= fee;
        b.bond -= fromBond;
        bonds -= fromBond;
        b.failed += 1;
        b.lostTotal += fromBond;
        v.paid = pay;
        v.paidTo = to;
        totalPaid += pay;
        totalBurned += burned;
        emit Settled(id, v.voucher, v.agent, State.Failed, 0, burned, pay, to, 0);
        if (pay > 0) {
            if (to == address(line)) line.repay{value: pay}(address(uint160(v.subject)));
            else _pay(to, pay);
        }
        _pay(burnPot, burned);
    }

    /// @dev Returned: nobody lost anything. The amount is free again and the fee goes back to whoever paid it.
    function _return(uint256 id, Vouch storage v) internal {
        v.state = State.Returned;
        _release(v);
        feesHeld -= v.fee;
        vouchers_[v.voucher].returned += 1;
        emit Settled(id, v.voucher, v.agent, State.Returned, 0, 0, 0, address(0), v.fee);
        _pay(v.payer, v.fee);
    }

    /// @dev The vouch no longer holds its amount back, and its line or cover is open to the voucher again.
    function _release(Vouch storage v) internal {
        Voucher storage b = vouchers_[v.voucher];
        b.held -= v.amount;
        held -= v.amount;
        heldOn[v.voucher][v.agent] -= v.amount;
        openOf[v.voucher][v.kind][v.subject] = 0;
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
