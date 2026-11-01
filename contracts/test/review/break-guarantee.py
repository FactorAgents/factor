# Break FactorGuarantee on purpose, one rule at a time, and see that the tests notice each break.
#   cd contracts && python3 test/review/break-guarantee.py
#
# Not on the list: taking the re-entry guard off one function. Every payout here is pushed with 50,000 gas, and every
# function that moves ETH needs 95,000 left before it pushes, so a receiver called back in has too little gas to move
# anything with or without the guard (test_attack12 shows the call back in failing). The guard stays as a second wall.
import pathlib, subprocess, os
src = pathlib.Path("src/FactorGuarantee.sol")
orig = src.read_text()
M = [
 ("an agent may cover its own job", "        if (msg.sender == agent || msg.sender == keyOf(agent)) revert SelfCover();\n", ""),
 ("cover for an agent that is not registered", "        if (!desk.agent(agent).registered) revert NotRegistered();\n        if (price < minJob)", "        if (price < minJob)"),
 ("cover for a job under the desk's smallest", "        if (price < minJob) revert JobTooSmall(minJob);\n", ""),
 ("cover for a due time the desk would refuse", "        if (dueAt < block.timestamp + minDue || dueAt > block.timestamp + maxDue) revert BadDueTime();\n", ""),
 ("a cover under the smallest", "        if (amount < MIN_COVER) revert TooSmall(MIN_COVER);\n        uint256 cap", "        uint256 cap"),
 ("a cover over the limit", "        if (amount > cap) revert OverLimit(cap);\n", ""),
 ("a wrong fee is taken", "        if (msg.value != fee) revert WrongFee(fee);\n", ""),
 ("the offer is not a limit", "        if (b.offer < limit) limit = b.offer;\n", ""),
 ("the free bond is not a limit", "        if (free < limit) limit = free;\n", ""),
 ("cover from a score of 100", "        if (score >= 200) return 2500;", "        if (score >= 100) return 2500;"),
 ("the top score covers only three quarters", "        if (score >= 800) return 10_000;", "        if (score >= 800) return 7500;"),
 ("a reservation does not hold the cover back", "        b.reserved += amount;\n        reserved += amount;\n        feesHeld += fee;", "        reserved += amount;\n        feesHeld += fee;"),
 ("bond held back for a cover can be taken out", "        uint256 free = b.bond - b.reserved;\n        if (amount > free) revert OverFree(free);", "        uint256 free = b.bond;\n        if (amount > free) revert OverFree(free);"),
 ("bond taken out goes to the caller", "        _pay(agent, amount);\n    }", "        _pay(msg.sender, amount);\n    }"),
 ("anyone runs an agent's bond and offer", "        if (msg.sender != agent && msg.sender != keyOf(agent)) revert NotAgent();\n", ""),
 ("a job of another customer can be tied", "            j.customer != c.customer || j.agent", "            j.agent"),
 ("a job locked before the reservation can be tied", "        if (job <= c.afterJob) revert NotTheJob();\n", ""),
 ("a reservation can be tied after the hour", "        if (block.timestamp > c.expiresAt) revert Expired(c.expiresAt);\n", ""),
 ("two covers on one job", "        if (coverOf[job] != 0) revert JobCovered(coverOf[job]);\n", ""),
 ("a rejected job pays the cover", "        if (j.state == FactorDesk.State.Refunded) {", "        if (j.state == FactorDesk.State.Refunded || j.state == FactorDesk.State.SettledAtHalf) {"),
 ("a declined job pays the cover", "        } else if (j.state == FactorDesk.State.Declined) {\n            c.state = State.Declined;", "        } else if (j.state == FactorDesk.State.Declined && false) {\n            c.state = State.Declined;"),
 ("close does not refund a job that is due", "            desk.refund(job);\n            j = desk.job(job);\n", ""),
 ("close does not settle a job that is due", "            desk.settle(job);\n            j = desk.job(job);\n", ""),
 ("a paid cover is not taken from the bond", "            b.bond -= c.amount;\n            bonds -= c.amount;\n", ""),
 ("a decline keeps the fee", "            back = fee;\n", ""),
 ("no fee is burned", "        _pay(burnPot, burned);\n", ""),
 ("the whole fee is burned", "            burned = fee / 2;", "            burned = fee;"),
 ("the fee is not let go of", "        feesHeld -= fee;\n", ""),
 ("a reservation lapses inside the hour", "        if (block.timestamp <= c.expiresAt) revert TooSoon(uint256(c.expiresAt) + 1);\n", ""),
 ("a refused payout is lost instead of kept", "            owed[to] += amount;\n            owedTotal += amount;\n            emit Owed(to, amount);\n", ""),
 ("a line account keeps its score when its key is barred or its line defaulted", "        if (desk.agent(k).barred || desk.agent(agent).barred || line.line(agent).defaulted) return 0;\n", ""),
 ("a line account takes its key's score even when its own is better", "        if (ks > s) s = ks;", "        s = ks;"),
 ("the cover is paid to the agent, not the customer", "        _pay(c.customer, paid + back);", "        _pay(c.agent, paid + back);"),
 ("bindLatest ties an older job", "        _bind(latestOf[msg.sender], desk.jobCount());", "        _bind(latestOf[msg.sender], desk.jobCount() - 1);"),
]
env = dict(os.environ, PATH=os.path.expanduser("~/.foundry/bin") + ":" + os.environ["PATH"], RPC_URL="")
caught = missed = 0
try:
    for name, a, b in M:
        if orig.count(a) != 1:
            print(f"SKIPPED (the code moved): {name}"); missed += 1; continue
        src.write_text(orig.replace(a, b))
        r = subprocess.run(["forge", "test", "--match-path", "test/guarantees/*", "--fuzz-runs", "100"], capture_output=True, text=True, env=env)
        out = r.stdout + r.stderr
        failed = [l.split("]")[1].strip().split("(")[0] for l in out.split("\n") if l.startswith("[FAIL")]
        if r.returncode != 0 and (failed or "Compiler run failed" not in out):
            caught += 1; print(f"caught: {name}  ({len(failed)} tests, e.g. {failed[0] if failed else 'compile'})")
        else:
            missed += 1; print(f"NOT CAUGHT: {name}" + ("  (did not compile)" if "Compiler run failed" in out else ""))
finally:
    src.write_text(orig)
print(f"{caught} of {len(M)} caught, {missed} not")
