# Break FactorVerifiers on purpose, one rule at a time, and see that the tests notice each break.
#   cd contracts && python3 test/review/break-verifiers.py
#
# Not on the list: taking the re-entry guard off one function. Payouts to customers and agents are pushed with 50,000
# gas, and what a verifier earns is added to its bond, so a receiver called back in has too little gas to move anything
# with or without the guard. The one full-gas paths are `collect` and `withdraw`, whose guards are on the list.
import pathlib, subprocess, os
src = pathlib.Path("src/FactorVerifiers.sol")
orig = src.read_text()
M = [
 ("a hire with no terms", "        if (terms == bytes32(0)) revert NoTerms();\n", ""),
 ("a fee under the smallest", "        if (fee < MIN_FEE || msg.value <= fee) revert BadFee();", "        if (msg.value <= fee) revert BadFee();"),
 ("a fee over the price", "        if (fee > price || price > type(uint128).max) revert BadFee();", "        if (price > type(uint128).max) revert BadFee();"),
 ("the stake is a tenth", "    uint256 public constant STAKE_BPS = 2000;", "    uint256 public constant STAKE_BPS = 1000;"),
 ("no smallest stake", "        if (s < MIN_STAKE) s = MIN_STAKE;\n", ""),
 ("no smallest dispute bond", "        if (b < MIN_DISPUTE) b = MIN_DISPUTE;\n", ""),
 ("a join under the bond", "        if (msg.value < MIN_BOND) revert TooSmall(MIN_BOND);\n", ""),
 ("a join with no maker", "        if (maker == 0) revert BadMaker();\n        if (msg.value < MIN_BOND)", "        if (msg.value < MIN_BOND)"),
 ("a withdraw over the free bond", "        if (amount > v.free) revert OverFree(v.free);\n", ""),
 ("withdraw goes unguarded", "    function withdraw(uint256 amount) external nonReentrant {", "    function withdraw(uint256 amount) external {"),
 ("a standing kept with dust", "        if (v.since != 0 && v.free + v.locked < MIN_BOND) {", "        if (v.since != 0 && v.free + v.locked == 0) {"),
 ("a maker switched with an open seat", "        if (v.open != 0) revert HasOpenSeats();\n", ""),
 ("a maker switch keeps the standing", "        if (v.since != 0) {\n            v.since = uint40(block.timestamp);\n            emit Standing(msg.sender, block.timestamp);\n        }\n", ""),
 ("a check before the delivery", "        if (j.state != FactorDesk.State.Delivered) revert NotDelivered();\n        if (block.timestamp >= uint256(j.deliveredAt) + CHECK_TIME) revert TooLate();", "        if (block.timestamp >= uint256(j.deliveredAt) + CHECK_TIME) revert TooLate();"),
 ("a check after its time", "        if (block.timestamp >= uint256(j.deliveredAt) + CHECK_TIME) revert TooLate();\n", ""),
 ("the customer checks its own job", "        if (who == c.customer || who == c.agent) return true;", "        if (who == c.agent) return true;"),
 ("the agent checks its own job", "        if (who == c.customer || who == c.agent) return true;", "        if (who == c.customer) return true;"),
 ("a line account's key checks it", "        if (line.keyOf(c.agent) == who || line.keyOf(c.customer) == who) return true;\n", ""),
 ("a verifier with no standing checks", "        if (v.since == 0) revert NoStanding();\n", ""),
 ("a check with too little bond", "        if (v.free < c.stake) revert BondShort(c.stake);\n", ""),
 ("the wrong side disputes", "        if (msg.sender != (c.firstAccept ? c.customer : c.agent)) revert NotYourSide();\n", ""),
 ("a dispute for nothing", "        if (msg.value != c.disputeBond) revert WrongValue(c.disputeBond);\n", ""),
 ("a dispute after its time", "        if (block.timestamp >= uint256(c.checkedAt) + DISPUTE_TIME) revert TooLate();\n", ""),
 ("the first verifier sits on its own panel", "        if (msg.sender == c.checker) revert Related();\n", ""),
 ("a struck verifier sits again", "        if (struck[id][msg.sender]) revert StruckOff();\n", ""),
 ("two seats of one maker", "            } else if (p[i].maker == v.maker) {", "            } else if (false) {"),
 ("a newer standing takes a seat", "            if (v.since >= p[newest].since) revert PanelFull();", "            if (v.since > p[newest].since) revert PanelFull();"),
 ("a newer standing takes the same maker's seat", "            if (v.since >= p[at].since) revert MakerTaken();", "            if (v.since > p[at].since + 1 days) revert MakerTaken();"),
 ("seats after seating closes", "        if (block.timestamp >= _delivered(c) + SEAT_END) revert TooLate();\n        if (commit == bytes32(0)) revert NoCommit();", "        if (commit == bytes32(0)) revert NoCommit();"),
 ("a strike every time", "            if (c.customerStruck) revert StrikeUsed();\n", ""),
 ("anyone strikes", "        } else {\n            revert NotYourSide();\n        }\n        Seat[3] storage p = seats_[id];", "        }\n        Seat[3] storage p = seats_[id];"),
 ("a reveal before seating closes", "        if (block.timestamp < d + SEAT_END) revert TooSoon(d + SEAT_END);\n", ""),
 ("a reveal that is not the commit", "        if (commitOf(id, msg.sender, accept_, reason, salt) != s.commit) revert BadReveal();\n", ""),
 ("a commit that does not name the verifier", "        return keccak256(abi.encode(id, who, accept_, reason, salt));", "        return keccak256(abi.encode(id, accept_, reason, salt));"),
 ("a reveal twice", "        if (s.vote != NONE) revert AlreadyRevealed();\n", ""),
 ("a tie goes to reject", "(c.firstAccept ? ACCEPT : REJECT);\n        bool firstRight", "REJECT;\n        bool firstRight"),
 ("a wrong call loses all", "    uint256 public constant WRONG_BPS = 5000;", "    uint256 public constant WRONG_BPS = 10_000;"),
 ("a silent seat loses nothing", "        _slash(id, who, v, stake, stake);", "        _slash(id, who, v, stake, 0);"),
 ("the lost dispute bond is kept back", "        if (firstRight) pot += c.disputeBond;\n", ""),
 ("a won dispute keeps its bond", "        if (!firstRight) _pay(c.disputer, c.disputeBond);\n", ""),
 ("the rounding wei is dropped", "            _credit(id, rightOnes[i], verifiers[rightOnes[i]], i == 0 ? share + rest : share);", "            _credit(id, rightOnes[i], verifiers[rightOnes[i]], share);"),
 ("no panel pays nothing to the first", "        _credit(id, c.checker, f, pot + c.disputeBond);", "        _credit(id, c.checker, f, pot);"),
 ("the first verifier is paid without the fee", "        _credit(id, c.checker, v, fee);", "        _credit(id, c.checker, v, 0);"),
 ("no fee back without a check", "        _pay(c.customer, fee);\n    }\n\n    /// @dev The first verdict stands", "    }\n\n    /// @dev The first verdict stands"),
 ("a verdict carried out before the dispute time", "            if (block.timestamp < at) revert TooSoon(at);\n            _firstStands(id, c);", "            _firstStands(id, c);"),
 ("the customer's choice before the check time", "            if (block.timestamp < d + CHECK_TIME) revert TooSoon(d + CHECK_TIME);\n", ""),
 ("a panel decided early", "        if (block.timestamp < d + REVEAL_END && !(allIn && block.timestamp >= d + SEAT_END)) {", "        if (false) {"),
 ("the agent concedes an accept", "        if (c.state != State.Checked || c.firstAccept) revert WrongState(c.state);", "        if (c.state != State.Checked) revert WrongState(c.state);"),
 ("anyone accepts", "        if (msg.sender != c.customer) revert NotCustomer();\n        State s = c.state;\n        How how = How.Customer;\n        if (s == State.Working)", "        State s = c.state;\n        How how = How.Customer;\n        if (s == State.Working)"),
 ("a customer accepts while the panel sits", "            (uint8 verdict, How decided) = _ripen(id, c, desk.job(c.job).deliveredAt);\n            if (verdict == ACCEPT) how = decided;", "            how = How.Panel;"),
 ("a reject sends back all of it", "        return (uint256(c.price) * desk.REJECTED_BPS()) / desk.BPS();", "        return c.price;"),
 ("a refund sends back the early half too", "            _end(id, c, State.Returned, How.NotDelivered, j.price - j.early);\n        } else if (j.state == FactorDesk.State.Refunded)", "            _end(id, c, State.Returned, How.NotDelivered, j.price);\n        } else if (j.state == FactorDesk.State.Refunded)"),
 ("an ended case forgets its desk price", "        atDesk -= c.price;\n", ""),
 ("a refused payout is lost instead of kept", "            owed[to] += amount;\n            owedTotal += amount;\n            emit Owed(to, amount);\n", ""),
 ("collect goes unguarded", "    function collect(address who) external nonReentrant {", "    function collect(address who) external {"),
 ("too little gas lands a payout in owed", "        if (gasleft() < PUSH_GAS_NEEDED) revert GasShort();\n", ""),
 ("anyone sends ETH in", "        if (msg.sender != address(desk)) revert OnlyDesk();\n", ""),
 ("the constructor takes a short review", "        if (REVEAL_END + CUSTOMER_TIME > r) revert DeskRules();\n", ""),
 ("an unlocked stake is not counted", "        staked -= stake;\n        bonds += stake;\n    }", "        bonds += stake;\n    }"),
]
env = dict(os.environ, PATH=os.path.expanduser("~/.foundry/bin") + ":" + os.environ["PATH"], RPC_URL="")
caught = missed = 0
try:
    for name, a, b in M:
        if orig.count(a) != 1:
            print(f"SKIPPED (the code moved): {name}"); missed += 1; continue
        src.write_text(orig.replace(a, b))
        r = subprocess.run(["nice", "-n", "10", "forge", "test", "-j", "2", "--match-path", "test/verifiers/*", "--fuzz-runs", "60"], capture_output=True, text=True, env=env)
        out = r.stdout + r.stderr
        failed = [l.split("]")[1].strip().split("(")[0] for l in out.split("\n") if l.startswith("[FAIL")]
        if r.returncode != 0 and (failed or "Compiler run failed" not in out):
            caught += 1; print(f"caught: {name}  ({len(failed)} tests, e.g. {failed[0] if failed else 'compile'})", flush=True)
        else:
            missed += 1; print(f"NOT CAUGHT: {name}" + ("  (did not compile)" if "Compiler run failed" in out else ""), flush=True)
finally:
    src.write_text(orig)
print(f"{caught} of {len(M)} caught, {missed} not")
