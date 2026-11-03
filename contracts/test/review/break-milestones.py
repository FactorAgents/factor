# Break FactorMilestones on purpose, one rule at a time, and see that the tests notice each break.
#   cd contracts && python3 test/review/break-milestones.py
#
# Not on the list: taking the re-entry guard off one function. Every payout here is pushed with 50,000 gas, and every
# function that moves ETH needs 95,000 left before it pushes, so a receiver called back in has too little gas to move
# anything with or without the guard (test_attack5 shows the call back in failing). The one full-gas path is `collect`,
# whose guard is on the list.
import pathlib, subprocess, os
src = pathlib.Path("src/FactorMilestones.sol")
orig = src.read_text()
M = [
 ("one stage is taken", "        if (count < MIN_STAGES || count > MAX_STAGES || times.length != count) revert BadStages();", "        if (count < 1 || count > MAX_STAGES || times.length != count) revert BadStages();"),
 ("seven stages are taken", "    uint256 public constant MAX_STAGES = 6;", "    uint256 public constant MAX_STAGES = 7;"),
 ("a stage with no time", "        if (count < MIN_STAGES || count > MAX_STAGES || times.length != count) revert BadStages();", "        if (count < MIN_STAGES || count > MAX_STAGES) revert BadStages();"),
 ("a plan with no terms", "        if (terms == bytes32(0)) revert NoTerms();\n", ""),
 ("a stage under the smallest", "            if (price < MIN_STAGE || price > type(uint128).max) revert TooSmall(MIN_STAGE);\n", "            if (price > type(uint128).max) revert TooSmall(MIN_STAGE);\n"),
 ("the smallest stage is lower", "    uint256 public constant MIN_STAGE = 0.001 ether;", "    uint256 public constant MIN_STAGE = 0.0009 ether;"),
 ("a time under an hour", "            if (times[i] < MIN_TIME || times[i] > MAX_TIME) revert BadTime();", "            if (times[i] > MAX_TIME) revert BadTime();"),
 ("a time over thirty days", "            if (times[i] < MIN_TIME || times[i] > MAX_TIME) revert BadTime();", "            if (times[i] < MIN_TIME) revert BadTime();"),
 ("the wrong value is taken", "        if (msg.value != total) revert WrongValue(total);\n", ""),
 ("the constructor takes any desk rules", "        if (MIN_STAGE < desk_.MIN_JOB() || MIN_TIME < desk_.MIN_DUE() || MAX_TIME > desk_.MAX_DUE()) {\n            revert DeskRules();\n        }\n", ""),
 ("anyone sends ETH in", "        if (msg.sender != address(desk)) revert OnlyDesk();\n", ""),
 ("the early half is never passed on", "        uint256 job = desk.lock{value: price}(p.agent, dueAt, p.allowEarly);", "        uint256 job = desk.lock{value: price}(p.agent, dueAt, false);"),
 ("the early half is always passed on", "        uint256 job = desk.lock{value: price}(p.agent, dueAt, p.allowEarly);", "        uint256 job = desk.lock{value: price}(p.agent, dueAt, true);"),
 ("a stage is due from the post, not its opening", "        uint256 dueAt = block.timestamp + s.time;", "        uint256 dueAt = block.timestamp + s.time - (i == 0 ? 0 : 1);"),
 ("the job does not point back", "        planOfJob[job] = id;\n", ""),
 ("the stage's job is not kept", "        s.job = uint64(job);\n", ""),
 ("anyone accepts", "        if (msg.sender != p.customer) revert NotCustomer();\n        // the desk refuses", "        // the desk refuses"),
 ("anyone rejects", "        if (msg.sender != p.customer) revert NotCustomer();\n        uint256 job = stages_[id][p.current].job;\n        desk.reject(job);", "        uint256 job = stages_[id][p.current].job;\n        desk.reject(job);"),
 ("an ended plan is accepted", "        if (p.state != State.Running) revert WrongState(p.state);\n        if (msg.sender != p.customer) revert NotCustomer();\n        // the desk", "        if (msg.sender != p.customer) revert NotCustomer();\n        // the desk"),
 ("the next stage never opens", "            _open(id, p, i + 1);\n", "            p.state = State.Done;\n"),
 ("the last stage opens again", "        if (i + 1 < p.count) {", "        if (i < p.count) {"),
 ("a step does not refund a stage that is due", "            desk.refund(job);\n            s = FactorDesk.State.Refunded;\n", "            s = FactorDesk.State.Refunded;\n"),
 ("a step does not settle after the customer's day", "            desk.settle(job);\n            s = FactorDesk.State.Settled;\n", "            s = FactorDesk.State.Settled;\n"),
 ("a decline is a miss", "            _end(id, p, State.Declined, job, _cameBack(id, p, job));", "            _end(id, p, State.Missed, job, _cameBack(id, p, job));"),
 ("a refund sends back the early half too", "        if (j.state == FactorDesk.State.Refunded) back = j.price - j.early;", "        if (j.state == FactorDesk.State.Refunded) back = j.price;"),
 ("a reject sends back all of the stage", "        else if (j.state == FactorDesk.State.SettledAtHalf) back = (j.price * desk.REJECTED_BPS()) / desk.BPS();", "        else if (j.state == FactorDesk.State.SettledAtHalf) back = j.price;"),
 ("the unstarted stages stay here", "        _pay(p.customer, fromDesk + unstarted);", "        _pay(p.customer, fromDesk);"),
 ("what came back from the desk stays here", "        _pay(p.customer, fromDesk + unstarted);", "        _pay(p.customer, unstarted);"),
 ("an ended plan keeps what it held", "        p.left = 0;\n", ""),
 ("held forgets the unstarted", "        held -= unstarted;\n", ""),
 ("the books forget the desk on a miss", "        atDesk -= stages_[id][p.current].price;\n", ""),
 ("the books forget the desk on a pay", "        atDesk -= price;\n        totalPaid += price;", "        totalPaid += price;"),
 ("the books count a stage paid twice", "        totalPaid += price;\n", "        totalPaid += 2 * price;\n"),
 ("held is not counted at the post", "        held += total;\n", "        held += total - 1;\n"),
 ("a refused payout is lost instead of kept", "            owed[to] += amount;\n            owedTotal += amount;\n            emit Owed(to, amount);\n", ""),
 ("collect goes unguarded", "    function collect(address who) external nonReentrant {", "    function collect(address who) external {"),
 ("a collect clears nothing", "        owed[who] = 0;\n", ""),
 ("too little gas lands a payout in owed", "        if (gasleft() < PUSH_GAS_NEEDED) revert GasShort();\n", ""),
 ("the post's log mixes up the stages", "        emit Posted(id, p.customer, p.agent, p.total, p.allowEarly, p.terms, prices, times);", "        emit Posted(id, p.customer, p.agent, p.total, p.allowEarly, p.terms, times, prices);"),
 ("the current job reads the next stage", "        return p.state == State.None ? 0 : stages_[id][p.current].job;", "        return p.state == State.None ? 0 : stages_[id][p.count - 1].job;"),
]
env = dict(os.environ, PATH=os.path.expanduser("~/.foundry/bin") + ":" + os.environ["PATH"], RPC_URL="")
caught = missed = 0
try:
    for name, a, b in M:
        if orig.count(a) != 1:
            print(f"SKIPPED (the code moved): {name}"); missed += 1; continue
        src.write_text(orig.replace(a, b))
        r = subprocess.run(["nice", "forge", "test", "-j", "2", "--match-path", "test/milestones/*", "--fuzz-runs", "60"], capture_output=True, text=True, env=env)
        out = r.stdout + r.stderr
        failed = [l.split("]")[1].strip().split("(")[0] for l in out.split("\n") if l.startswith("[FAIL")]
        if r.returncode != 0 and (failed or "Compiler run failed" not in out):
            caught += 1; print(f"caught: {name}  ({len(failed)} tests, e.g. {failed[0] if failed else 'compile'})", flush=True)
        else:
            missed += 1; print(f"NOT CAUGHT: {name}" + ("  (did not compile)" if "Compiler run failed" in out else ""), flush=True)
finally:
    src.write_text(orig)
print(f"{caught} of {len(M)} caught, {missed} not")
