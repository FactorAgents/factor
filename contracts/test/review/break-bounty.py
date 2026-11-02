# Break FactorBounty on purpose, one rule at a time, and see that the tests notice each break.
#   cd contracts && python3 test/review/break-bounty.py
#
# Not on the list: taking the re-entry guard off one function. Every payout here is pushed with 50,000 gas, and every
# function that moves ETH needs 95,000 left before it pushes, so a receiver called back in has too little gas to move
# anything with or without the guard (test_attack8 shows the call back in failing). The one full-gas path is `collect`,
# whose guard is on the list.
import pathlib, subprocess, os
src = pathlib.Path("src/FactorBounty.sol")
orig = src.read_text()
M = [
 ("a prize under the smallest", "        if (prize < MIN_PRIZE) revert TooSmall(MIN_PRIZE);\n", ""),
 ("a deadline too soon or too far", "        if (deadline < block.timestamp + MIN_OPEN || deadline > block.timestamp + MAX_OPEN) revert BadDeadline();\n", ""),
 ("a minimum score over the top", "        if (minScore > MAX_SCORE) revert BadScore();\n", ""),
 ("a bounty with no task", "        if (task == bytes32(0)) revert NoTask();\n", ""),
 ("the wrong value is taken at a post", "        if (msg.value != prize + fee) revert WrongValue(prize + fee);\n", ""),
 ("the fee is not held", "        held += msg.value;\n", "        held += prize;\n"),
 ("the fee is 2%", "    uint256 public constant BURN_BPS = 100;", "    uint256 public constant BURN_BPS = 200;"),
 ("the bond is 2%", "    uint256 public constant BOND_BPS = 100;", "    uint256 public constant BOND_BPS = 200;"),
 ("the smallest prize is lower", "    uint256 public constant MIN_PRIZE = 0.005 ether;", "    uint256 public constant MIN_PRIZE = 0.004 ether;"),
 ("26 entries", "    uint256 public constant MAX_ENTRIES = 25;", "    uint256 public constant MAX_ENTRIES = 26;"),
 ("two days to pick", "    uint256 public constant PICK_TIME = 3 days;", "    uint256 public constant PICK_TIME = 2 days;"),
 ("two days to deliver", "    uint256 public constant DELIVER_TIME = 3 days;", "    uint256 public constant DELIVER_TIME = 2 days;"),
 ("anyone sends ETH in", "        if (msg.sender != address(desk)) revert OnlyDesk();\n", ""),
 ("the constructor takes any desk rules", "        if (MIN_PRIZE < desk_.MIN_JOB() || DELIVER_TIME < desk_.MIN_DUE() || DELIVER_TIME > desk_.MAX_DUE()) {\n            revert DeskRules();\n        }\n", ""),
 ("anyone picks", "        if (msg.sender != b.poster) revert NotPoster();\n", ""),
 ("a pick before the deadline", "        if (block.timestamp < b.deadline) revert TooSoon(b.deadline);\n        uint256 end", "        uint256 end"),
 ("a pick after the three days", "        if (block.timestamp >= end) revert TooLate(end);\n", ""),
 ("anyone can be picked", "        if (entries[id][winner].at == 0) revert NotAnEntrant();\n", ""),
 ("a pick burns nothing", "        emit Picked(id, winner, job, fee, dueAt);\n        _pay(burnPot, fee);\n", "        emit Picked(id, winner, job, fee, dueAt);\n"),
 ("a pick allows the early half", "        job = desk.lock{value: prize}(winner, dueAt, false);", "        job = desk.lock{value: prize}(winner, dueAt, true);"),
 ("the job does not point back", "        bountyOfJob[job] = id;\n", ""),
 ("an entry after the deadline", "        if (block.timestamp >= b.deadline) revert TooLate(b.deadline);\n", ""),
 ("anyone enters for an agent", "        if (msg.sender != agent && msg.sender != key) revert NotAgent();\n", ""),
 ("an entry with no hash", "        if (hash == bytes32(0)) revert NoHash();\n", ""),
 ("an unregistered agent enters", "        if (!a.registered) revert NotRegistered();\n", ""),
 ("a barred agent enters", "        if (a.barred || (key != address(0) && _lineBarred(agent, key))) revert Barred();\n", ""),
 ("the poster enters", "        if (agent == b.poster || key == b.poster) revert OwnBounty();\n", ""),
 ("the poster's line account enters", "        if (agent == b.poster || key == b.poster) revert OwnBounty();\n", "        if (agent == b.poster) revert OwnBounty();\n"),
 ("double entry", "        if (entries[id][agent].at != 0) revert AlreadyIn();\n", ""),
 ("a line account and its key both enter", "        if (sameHand != address(0) && entries[id][sameHand].at != 0) revert AlreadyIn();\n", ""),
 ("more than the most entries", "        if (count >= MAX_ENTRIES) revert Full();\n", ""),
 ("the minimum score is not held", "        if (s < b.minScore) revert ScoreTooLow(s, b.minScore);\n", ""),
 ("the wrong bond is taken", "        if (msg.value != b.bond) revert WrongValue(b.bond);\n", ""),
 ("the bond is not counted", "        bonds += msg.value;\n", ""),
 ("returnBonds before a pick", "        if (b.state != State.Picked) revert WrongState(b.state);\n        if (b.bondsBack)", "        if (b.bondsBack)"),
 ("bonds go back twice", "        if (b.bondsBack) revert BondsAlreadyBack();\n", ""),
 ("no bounty is ended with entries before three days", "        if (block.timestamp < at) revert TooSoon(at);\n        b.state = State.Unpicked;", "        b.state = State.Unpicked;"),
 ("an empty bounty returns before the deadline", "        if (block.timestamp < b.deadline) revert TooSoon(b.deadline);\n        uint256 count = entrants_", "        uint256 count = entrants_"),
 ("an empty bounty keeps the 1%", "            _pay(b.poster, prize + fee);\n", "            _pay(b.poster, prize);\n"),
 ("an unpicked split keeps the fee", "        _pay(burnPot, fee + dust);\n", "        _pay(burnPot, dust);\n"),
 ("the dust stays in the contract", "        uint256 dust = prize - share * count;\n", "        uint256 dust = 0;\n"),
 ("a split shares nothing", "        _payEntrants(id, b, address(0), share);\n", "        _payEntrants(id, b, address(0), 0);\n"),
 ("a refund before the grace is over", "            if (block.timestamp <= at) revert TooSoon(at + 1);\n", ""),
 ("a proof of any hash is accepted", "            if (j.proof == entries[id][b.winner].hash) {\n", "            if (true) {\n"),
 ("no proof is accepted", "            if (j.proof == entries[id][b.winner].hash) {\n", "            if (false) {\n"),
 ("a wrong proof settles before its time", "                if (block.timestamp < at) revert TooSoon(at);\n                desk.settle(job);", "                desk.settle(job);"),
 ("the winner's bond stays in a win", "            _pay(b.winner, bond);\n", ""),
 ("the others' bonds stay in a win", "            if (!b.bondsBack) _payEntrants(id, b, b.winner, 0);\n", ""),
 ("an undelivered prize goes back to the poster with others in", "            if (others == 0) {", "            if (others < 100) {"),
 ("the winner keeps its bond when it does not deliver", "                uint256 pot = prize + forfeited;\n", "                uint256 pot = prize;\n"),
 ("the sole winner's bond is not burned", "                _pay(burnPot, forfeited);\n", ""),
 ("a sole winner's prize stays in the contract", "                _pay(b.poster, prize);\n", ""),
 ("an undelivered split keeps its dust", "                _pay(burnPot, dust);\n", ""),
 ("the winner shares in an undelivered split", "                _payEntrants(id, b, b.winner, share);\n", "                _payEntrants(id, b, address(0), share);\n"),
 ("a decline does not end it", "        } else if (j.state == FactorDesk.State.Refunded || j.state == FactorDesk.State.Declined) {", "        } else if (j.state == FactorDesk.State.Refunded) {"),
 ("bonds counted wrong in a pay", "            bonds -= bond * count;\n", "            bonds -= bond;\n"),
 ("bonds paid to the skipped one too", "            if (who == skip) continue;\n", ""),
 ("a refused payout is lost instead of kept", "            owed[to] += amount;\n            owedTotal += amount;\n            emit Owed(to, amount);\n", ""),
 ("collect goes unguarded", "    function collect(address who) external nonReentrant {", "    function collect(address who) external {"),
 ("a collect clears nothing", "        owed[who] = 0;\n", ""),
 ("too little gas lands a payout in owed", "        if (gasleft() < PUSH_GAS_NEEDED) revert GasShort();\n", ""),
 ("a line account keeps its score when barred", "        if (_lineBarred(agent, k)) return 0;\n", ""),
 ("a line account takes its key's score even when its own is better", "        if (ks > s) s = ks;", "        s = ks;"),
 ("the entry hash leaves out the agent", "        return keccak256(abi.encode(address(this), id, agent, workHash));", "        return keccak256(abi.encode(address(this), id, workHash));"),
 ("the books count a win twice", "            totalWon += prize;\n", "            totalWon += 2 * prize;\n"),
 ("the books forget the desk", "        atDesk -= prize;\n", ""),
]
env = dict(os.environ, PATH=os.path.expanduser("~/.foundry/bin") + ":" + os.environ["PATH"], RPC_URL="")
caught = missed = 0
try:
    for name, a, b in M:
        if orig.count(a) != 1:
            print(f"SKIPPED (the code moved): {name}"); missed += 1; continue
        src.write_text(orig.replace(a, b))
        r = subprocess.run(["forge", "test", "--match-path", "test/bounties/*", "--fuzz-runs", "60"], capture_output=True, text=True, env=env)
        out = r.stdout + r.stderr
        failed = [l.split("]")[1].strip().split("(")[0] for l in out.split("\n") if l.startswith("[FAIL")]
        if r.returncode != 0 and (failed or "Compiler run failed" not in out):
            caught += 1; print(f"caught: {name}  ({len(failed)} tests, e.g. {failed[0] if failed else 'compile'})", flush=True)
        else:
            missed += 1; print(f"NOT CAUGHT: {name}" + ("  (did not compile)" if "Compiler run failed" in out else ""), flush=True)
finally:
    src.write_text(orig)
print(f"{caught} of {len(M)} caught, {missed} not")
