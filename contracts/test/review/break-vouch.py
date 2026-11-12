# Break FactorVouch on purpose, one rule at a time, and see that the tests notice each break.
#   cd contracts && python3 test/review/break-vouch.py
#
# Not on the list: taking the re-entry guard off one function. Every payout here is pushed with 50,000 gas, and every
# function that moves ETH needs 95,000 left before it pushes, so a receiver called back in has too little gas to move
# anything with or without the guard (test_attack6 shows the call back in failing). The guard stays as a second wall.
# Nor dropping the first line of agentOf (a line account is its own desk address): the line contract never lets a line
# account open a line, so accountOf of an account is always zero and the next line returns the account anyway.
import pathlib, subprocess, os
src = pathlib.Path("src/FactorVouch.sol")
orig = src.read_text()
M = [
 ("an agent may vouch for itself", "        if (related(voucher, agent)) revert Related();\n        if (!desk.agent(agent).registered)", "        if (!desk.agent(agent).registered)"),
 ("a key and its line account are two agents", "        return account == address(0) ? who : account;", "        return who;"),
 ("a voucher may co-sign a cover it bought", "        if (related(voucher, c.customer)) revert Related();\n", ""),
 ("a weak score may vouch", "        if (score < MIN_SCORE) revert ScoreTooLow(score, MIN_SCORE);\n", ""),
 ("the least score is 200", "    uint256 public constant MIN_SCORE = 300;", "    uint256 public constant MIN_SCORE = 200;"),
 ("the score is the desk's raw score, not the guarantee contract's reading", "        uint256 score = guarantee.scoreOf(voucher);", "        uint256 score = desk.score(voucher);"),
 ("a vouch under the smallest", "        if (amount < MIN_VOUCH) revert TooSmall(MIN_VOUCH);\n", ""),
 ("a whole bond on one agent", "        if (onAgent + amount > share) revert OverShare(share > onAgent ? share - onAgent : 0);\n", ""),
 ("the share is half the bond", "    uint256 public constant MAX_SHARE_BPS = 2500;", "    uint256 public constant MAX_SHARE_BPS = 5000;"),
 ("a vouch past the free bond", "        if (amount > free) revert OverFree(free);\n\n        b.held += amount;", "\n        b.held += amount;"),
 ("two open vouches on one line", "        if (open_ != 0) revert AlreadyVouched(open_);\n", ""),
 ("an offer does not hold the amount back", "        b.held += amount;\n        held += amount;\n        heldOn", "        held += amount;\n        heldOn"),
 ("anyone offers for a voucher", "        voucher = _onlyRunner(voucher, false);\n        if (line.keyOf(account)", "        voucher = agentOf(voucher);\n        if (line.keyOf(account)"),
 ("a fake line can be vouched", "        if (line.keyOf(account) == address(0)) revert NoLine();\n", ""),
 ("a defaulted line can be vouched", "        if (l.defaulted) revert LineDefaulted();\n        if (line.isLate(account)) revert LineLate(l.dueAt);\n        id = _offer", "        id = _offer"),
 ("a cover not tied can be vouched", "        if (c.state != FactorGuarantee.State.Bound) revert NotCovered();\n", ""),
 ("a drawn or due job can be vouched", "        if (j.state != FactorDesk.State.Locked || block.timestamp >= j.dueAt) revert JobNotOpen();\n", ""),
 ("anyone accepts for the agent", "        _onlyRunner(v.agent, true);\n        uint256 lapsesAt", "        uint256 lapsesAt"),
 ("an offer never lapses", "        if (block.timestamp > lapsesAt) revert Expired(lapsesAt);\n", ""),
 ("a wrong fee is taken", "        if (msg.value != v.fee) revert WrongFee(v.fee);\n", ""),
 ("a line that owes more can accept", "            if (l.debt > v.debtAtOffer) revert DebtGrew(l.debt);\n", ""),
 ("a late line can accept", "            if (l.defaulted) revert LineDefaulted();\n            if (line.isLate(account)) revert LineLate(l.dueAt);\n            if (l.debt", "            if (l.debt"),
 ("a line vouch stands 60 days", "    uint256 public constant LINE_TERM = 30 days;", "    uint256 public constant LINE_TERM = 60 days;"),
 ("the fee is 1%", "    uint256 public constant FEE_BPS = 200;", "    uint256 public constant FEE_BPS = 100;"),
 ("the fee is not held", "        feesHeld += v.fee;\n", ""),
 ("anyone withdraws an offer at once", "            if (block.timestamp <= lapsesAt) revert TooSoon(lapsesAt + 1);\n", ""),
 ("a line vouch kept before its end", "        } else if (block.timestamp > v.endsAt && !backed) {", "        } else if (!backed) {"),
 ("a later debt is the voucher's", "        bool backed = l.debt > 0 && uint256(l.dueAt) - lineDue <= v.endsAt;", "        bool backed = l.debt > 0;"),
 ("settle does not recover a line due to be recovered", "            line.recover(account);\n            l = line.line(account);\n", ""),
 ("a line vouch fails before the default", "        if (l.defaulted && backed) {", "        if (backed && block.timestamp > v.endsAt) {"),
 ("the agent releases while it owes", "        if (l.debt != 0) revert StillOwes(l.debt);\n", ""),
 ("the voucher releases", "        if (v.kind != Kind.Line) revert WrongKind();\n        _onlyRunner(v.agent, true);", "        if (v.kind != Kind.Line) revert WrongKind();"),
 ("a cover vouch can be released", "        if (v.kind != Kind.Line) revert WrongKind();\n", ""),
 ("a cover settles while the job works", "            if (open_ && block.timestamp <= uint256(j.dueAt) + grace) revert NotYet();\n", ""),
 ("a cover settles during the review", "            if (j.state == FactorDesk.State.Delivered && block.timestamp < uint256(j.deliveredAt) + review) {\n                revert NotYet();\n            }\n", ""),
 ("a declined job fails the vouch", "        else if (c.state == FactorGuarantee.State.Declined) _return(id, v);", "        else if (c.state == FactorGuarantee.State.Declined) _fail(id, v, v.amount, c.customer);"),
 ("a refunded job keeps the vouch", "        else if (c.state == FactorGuarantee.State.Paid) _fail(id, v, v.amount, c.customer);", "        else if (c.state == FactorGuarantee.State.Paid) _keep(id, v);"),
 ("a cover's loss is paid to the agent", "        else if (c.state == FactorGuarantee.State.Paid) _fail(id, v, v.amount, c.customer);", "        else if (c.state == FactorGuarantee.State.Paid) _fail(id, v, v.amount, c.agent);"),
 ("a kept vouch pays the voucher the whole fee", "        uint256 toVoucher = (fee * VOUCHER_BPS) / BPS;", "        uint256 toVoucher = fee;"),
 ("a kept vouch's earnings are not added to the bond", "        b.bond += toVoucher;\n        bonds += toVoucher;\n", ""),
 ("nothing burned when kept", "        emit Settled(id, v.voucher, v.agent, State.Kept, toVoucher, burned, 0, address(0), 0);\n        _pay(burnPot, burned);", "        emit Settled(id, v.voucher, v.agent, State.Kept, toVoucher, burned, 0, address(0), 0);"),
 ("a failure pays the whole amount whatever the loss", "        if (loss < pay) pay = loss;\n", ""),
 ("a failure takes nothing from the bond", "        b.bond -= fromBond;\n        bonds -= fromBond;\n", ""),
 ("a failure pays from the bond first", "        uint256 fromFee = pay < fee ? pay : fee;", "        uint256 fromFee = pay > v.amount ? pay - v.amount : 0;"),
 ("a failure keeps the rest of the fee", "        emit Settled(id, v.voucher, v.agent, State.Failed, 0, burned, pay, to, 0);", "        burned = 0;\n        emit Settled(id, v.voucher, v.agent, State.Failed, 0, burned, pay, to, 0);"),
 ("a line's loss is pushed to the line, not repaid", "            if (to == address(line)) line.repay{value: pay}(address(uint160(v.subject)));\n            else _pay(to, pay);", "            _pay(to, pay);"),
 ("a returned fee is kept", "        _pay(v.payer, v.fee);\n", ""),
 ("a returned fee goes to the voucher", "        _pay(v.payer, v.fee);", "        _pay(v.voucher, v.fee);"),
 ("an ended vouch keeps its amount held", "        b.held -= v.amount;\n        held -= v.amount;\n", ""),
 ("an ended vouch keeps its line closed to the voucher", "        openOf[v.voucher][v.kind][v.subject] = 0;\n", ""),
 ("bond held back can be taken out", "        uint256 free = b.bond - b.held;\n        if (amount > free) revert OverFree(free);\n        b.bond -= amount;", "        uint256 free = b.bond;\n        if (amount > free) revert OverFree(free);\n        b.bond -= amount;"),
 ("bond taken out goes to the caller", "        _pay(voucher, amount);\n    }", "        _pay(msg.sender, amount);\n    }"),
 ("anyone runs a voucher's bond", "        if (!_runs(agent, msg.sender)) {", "        if (false) {"),
 ("a bond for an unregistered agent", "        if (!desk.agent(voucher).registered) revert NotRegistered();\n", ""),
 ("a refused payout is lost instead of kept", "            owed[to] += amount;\n            owedTotal += amount;\n            emit Owed(to, amount);\n", ""),
 ("a push with too little gas", "        if (gasleft() < PUSH_GAS_NEEDED) revert GasShort();\n", ""),
 ("a settled vouch settles again", "        if (v.state != State.Active) revert WrongState(v.state);\n        if (v.kind == Kind.Line) _settleLine", "        if (v.kind == Kind.Line) _settleLine"),
]
env = dict(os.environ, PATH=os.path.expanduser("~/.foundry/bin") + ":" + os.environ["PATH"], RPC_URL="")
caught = missed = 0
try:
    for name, a, b in M:
        if orig.count(a) != 1:
            print(f"SKIPPED (the code moved): {name}"); missed += 1; continue
        src.write_text(orig.replace(a, b))
        r = subprocess.run(["nice", "forge", "test", "--match-path", "test/vouching/*", "--fuzz-runs", "100"], capture_output=True, text=True, env=env)
        out = r.stdout + r.stderr
        failed = [l.split("]")[1].strip().split("(")[0] for l in out.split("\n") if l.startswith("[FAIL")]
        if r.returncode != 0 and (failed or "Compiler run failed" not in out):
            caught += 1; print(f"caught: {name}  ({len(failed)} tests, e.g. {failed[0] if failed else 'compile'})")
        else:
            missed += 1; print(f"NOT CAUGHT: {name}" + ("  (did not compile)" if "Compiler run failed" in out else ""))
finally:
    src.write_text(orig)
print(f"{caught} of {len(M)} caught, {missed} not")
