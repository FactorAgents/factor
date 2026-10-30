# Break FactorLine and FactorLineAccount on purpose, one rule at a time, and see that the tests notice each break.
#   cd contracts && python3 test/review/break-line.py
import pathlib, subprocess, os
src = pathlib.Path("src/FactorLine.sol")
orig = src.read_text()
M = [
 ("a barred agent may open a line", "        if (a.barred) revert Barred();\n", ""),
 ("an agent that is not registered may open a line", "        if (!a.registered) revert NotRegistered();\n", ""),
 ("a key may open two lines", "        if (accountOf[msg.sender] != address(0)) revert HasLine(accountOf[msg.sender]);\n", ""),
 ("the desk's advance is not subtracted", "        uint256 can = desk.canDraw(account);", "        uint256 can = desk.limit(account);"),
 ("the line's debt is not subtracted", "        return can > l.debt ? can - l.debt : 0;\n    }\n\n    /// @dev A repayment", "        return can;\n    }\n\n    /// @dev A repayment"),
 ("a key barred on the desk still draws", "        if (l.defaulted || _late(l) || desk.agent(l.key).barred) return 0;", "        if (l.defaulted || _late(l)) return 0;"),
 ("a late line still draws", "        if (_late(l)) revert IsLate(l.dueAt);\n", ""),
 ("a defaulted line still draws", "        if (l.defaulted) revert IsDefaulted();\n", ""),
 ("the pool's 80% rule is not kept", "        if (amount > poolRoom_) revert PoolShort(poolRoom_);\n", ""),
 ("a draw over the room is paid", "        if (amount > room_) revert OverLimit(room_);\n", ""),
 ("the smallest draw is not kept", "        if (amount < MIN_DRAW) revert TooSmall(MIN_DRAW);\n", ""),
 ("a second draw moves the due time", "        if (l.debt == 0) l.dueAt = uint40(block.timestamp + TERM);", "        l.dueAt = uint40(block.timestamp + TERM);"),
 ("no fee is burned", "        _pay(burnPot, burned);\n", ""),
 ("the fee does not go back into the pool", "        pool += toPool;\n", ""),
 ("compute is paid to the agent", "        _pay(asCompute ? gateway : msg.sender, amount - fee);", "        _pay(msg.sender, amount - fee);"),
 ("a repayment may be more than the debt", "        if (amount > l.debt) revert OverDebt(l.debt);\n", ""),
 ("a late repayment counts as on time", "                if (late_) l.late += 1;\n                else l.onTime += 1;", "                l.onTime += 1;"),
 ("recover does not wait for the default time", "            if (block.timestamp <= at) revert TooSoon(at + 1);\n", ""),
 ("recover leaves the bond on the desk", "        if (l.debt > have) acct.releaseBond(l.debt - have);\n", ""),
 ("a line still owed after recovery does not default", "        if (l.debt > 0 && !l.defaulted) {", "        if (false) {"),
 ("a refused payout is lost instead of kept", "            owed[to] += amount;\n            owedTotal += amount;\n            emit Owed(to, amount);\n", ""),
 ("the account lets its bond go while the line owes", "        uint256 d = owes();\n        if (d != 0) revert Owes(d);\n        desk.takeBond(amount);", "        desk.takeBond(amount);"),
 ("a withdrawal does not sweep first", "        if (to == address(0)) revert ZeroAddress();\n        _sweep();\n", "        if (to == address(0)) revert ZeroAddress();\n"),
 ("a withdrawal goes out while the line owes", "        uint256 d = owes();\n        if (d != 0) revert Owes(d);\n        if (amount > address(this).balance)", "        if (amount > address(this).balance)"),
 ("the account may spend what the line is owed", "        if (fromBalance > f) revert NotFree(f);\n", ""),
 ("a desk pool advance is not held to the line's room", "            if (amount > r) revert OverLineRoom(r);\n", ""),
 ("anyone runs the account", "        if (msg.sender != key) revert NotKey();\n", ""),
 ("anyone releases the bond", "        if (msg.sender != address(line)) revert OnlyLine();\n        FactorDesk.Agent memory a", "        FactorDesk.Agent memory a"),
 ("the bond is released while the desk has an advance out", "        if (a.advancedNow != 0 || a.bond == 0 || want == 0) return;", "        if (a.bond == 0 || want == 0) return;"),
 ("a signature by anyone is the account's", "SignatureChecker.isValidSignatureNow(key, hash, signature) ? ERC1271_VALID", "signature.length > 0 ? ERC1271_VALID"),
]
env = dict(os.environ, PATH=os.path.expanduser("~/.foundry/bin") + ":" + os.environ["PATH"], RPC_URL="")
caught = missed = 0
try:
    for name, a, b in M:
        if orig.count(a) != 1:
            print(f"SKIPPED (the code moved): {name}"); missed += 1; continue
        src.write_text(orig.replace(a, b))
        r = subprocess.run(["forge", "test", "--match-path", "test/lines/*", "--fuzz-runs", "100"], capture_output=True, text=True, env=env)
        out = r.stdout + r.stderr
        failed = [l.split("]")[1].strip().split("(")[0] for l in out.split("\n") if l.startswith("[FAIL")]
        if r.returncode != 0 and (failed or "Compiler run failed" not in out):
            caught += 1; print(f"caught: {name}  ({len(failed)} tests, e.g. {failed[0] if failed else 'compile'})")
        else:
            missed += 1; print(f"NOT CAUGHT: {name}" + ("  (did not compile)" if "Compiler run failed" in out else ""))
finally:
    src.write_text(orig)
print(f"{caught} of {len(M)} caught, {missed} not")
