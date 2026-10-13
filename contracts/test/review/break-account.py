# Break FactorAccount on purpose, one rule at a time, and see that the tests notice each break.
import pathlib, subprocess, sys, os
src = pathlib.Path("src/FactorAccount.sol")
orig = src.read_text()
M = [
 ("an order's number is never used up", "        nonce = n + 1;\n        emit Executed(n, id, calls.length);\n        return _run(calls);\n    }\n\n    /// The same, sent by one", "        emit Executed(n, id, calls.length);\n        return _run(calls);\n    }\n\n    /// The same, sent by one"),
 ("the deadline is not checked", "        if (block.timestamp > deadline) revert Expired(deadline);\n", ""),
 ("a signature nobody made is taken", "        if (id == bytes32(0)) revert BadSignature();\n", ""),
 ("a passkey need not verify its owner", "WebAuthn.verify(abi.encodePacked(hash), auth, k.a, k.b, true)", "WebAuthn.verify(abi.encodePacked(hash), auth, k.a, k.b, false)"),
 ("the answer's numbers are not held inside its text", "        if (auth.typeIndex >= length || auth.challengeIndex >= length) return bytes32(0);\n", ""),
 ("anyone may give an account its first key", "if (msg.sender != factory || keyCount != 0) revert OnlyFactory();", "if (keyCount != 0) revert OnlyFactory();"),
 ("the factory may give a second first key", "if (msg.sender != factory || keyCount != 0) revert OnlyFactory();", "if (msg.sender != factory) revert OnlyFactory();"),
 ("anyone may add a key", "    function addKey(Key calldata k, bytes calldata credential) external {\n        if (msg.sender != address(this)) revert OnlySelf();\n", "    function addKey(Key calldata k, bytes calldata credential) external {\n"),
 ("anyone may remove a key", "    function removeKey(bytes32 id) external {\n        if (msg.sender != address(this)) revert OnlySelf();\n", "    function removeKey(bytes32 id) external {\n"),
 ("the last key can be removed", "        if (keyCount == 1) revert LastKey();\n", ""),
 ("any wallet's signature is a key's", "return _keys[walletId].kind == Kind.Wallet ? walletId : bytes32(0);", "return walletId;"),
 ("an order is not bound to its account", "block.chainid, address(this)));", "block.chainid, address(0)));"),
 ("an order is not bound to its chain", "VERSION_HASH, block.chainid, address(this)", "VERSION_HASH, uint256(1), address(this)"),
 ("a call that fails does not undo the order", "            if (!ok) {\n", "            if (false && !ok) {\n"),
 ("any wallet may run the account", "        if (_keys[id].kind != Kind.Wallet) revert NotAKey();\n", ""),
 ("the deadline is not part of what is signed", "keccak256(abi.encodePacked(hashes)), nonce_, deadline));", "keccak256(abi.encodePacked(hashes)), nonce_, uint256(0)));"),
 ("the amount of a call is not part of what is signed", "abi.encode(CALL_TYPEHASH, calls[i].to, calls[i].value, keccak256(calls[i].data))", "abi.encode(CALL_TYPEHASH, calls[i].to, uint256(0), keccak256(calls[i].data))"),
 ("the calls' data is not part of what is signed", "abi.encode(CALL_TYPEHASH, calls[i].to, calls[i].value, keccak256(calls[i].data))", "abi.encode(CALL_TYPEHASH, calls[i].to, calls[i].value, bytes32(0))"),
 ("a key that is no point on the curve is taken", "            if (!P256.isValidPublicKey(k.a, k.b)) revert BadKey();\n", ""),
 ("the same key can be added twice", "        if (_keys[id].kind != Kind.None) revert KeyExists();\n", ""),
]
env = dict(os.environ, PATH=os.path.expanduser("~/.foundry/bin") + ":" + os.environ["PATH"], RPC_URL="")
caught = missed = 0
try:
    for name, a, b in M:
        if orig.count(a) != 1:
            print(f"SKIPPED (the code moved): {name}"); missed += 1; continue
        src.write_text(orig.replace(a, b))
        r = subprocess.run(["forge", "test", "--match-contract", "AccountTest", "--fuzz-runs", "150"], capture_output=True, text=True, env=env)
        out = r.stdout + r.stderr
        failed = [l.split("]")[1].strip().split("(")[0] for l in out.split("\n") if l.startswith("[FAIL")]
        if r.returncode != 0 and (failed or "Compiler run failed" not in out):
            caught += 1; print(f"caught: {name}  ({len(failed)} tests, e.g. {failed[0] if failed else 'compile'})")
        else:
            missed += 1; print(f"NOT CAUGHT: {name}" + ("  (did not compile)" if "Compiler run failed" in out else ""))
finally:
    src.write_text(orig)
print(f"{caught} of {len(M)} caught, {missed} not")
