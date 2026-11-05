#!/usr/bin/env bash
# Re-checks, on the live chain, every address, code hash, immutable and constant this pack states.
# Needs only `cast` (Foundry) and an RPC of Robinhood Chain. Reads only: it sends nothing and signs nothing.
#
#   ./verify.sh                                   # the public node
#   RPC_URL=https://your-node ./verify.sh         # any other node of chain 4663
set -u
RPC="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
CAST="${CAST:-cast}"
command -v "$CAST" >/dev/null 2>&1 || { echo "cast not found (install Foundry, or set CAST=/path/to/cast)"; exit 2; }

FAIL=0
ok()   { printf "  ok    %s\n" "$1"; }
bad()  { printf "  FAIL  %s\n        want %s\n        got  %s\n" "$1" "$2" "$3"; FAIL=1; }
lc()   { tr 'A-F' 'a-f'; }
same() { # label want got
  local w g; w=$(printf %s "$2" | lc); g=$(printf %s "$3" | lc)
  if [ "$w" = "$g" ]; then ok "$1 = $2"; else bad "$1" "$2" "$3"; fi
}
call() { "$CAST" call "$1" "$2" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}'; }
codehash() { "$CAST" keccak "$("$CAST" code "$1" --rpc-url "$RPC")"; }

DESK=0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F
BURN_POT=0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79
GATEWAY=0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0
LINE=0xc9405ca62ed1e9a4a058f404e5c1c893f7ae67c4
LINE_ACCOUNT_IMPL=0x8f63D64ACafC6a3c956a9f3B0eFFbc438DB9a869
ACCOUNTS=0x3417A303DcB62A84965a641f894ff5803502F8FA
ACCOUNT_IMPL=0x34a6b7A9885E57E28ec868d73652660d5e176358
EMPTY=0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470   # keccak256 of no code

echo "Node: $RPC"
same "chain id" 4663 "$("$CAST" chain-id --rpc-url "$RPC")"
echo "  block  $("$CAST" block-number --rpc-url "$RPC")"

echo "Runtime code hashes (keccak256 of eth_getCode)"
same "FactorDesk         $DESK" 0x62f56fb1f0e0ebf6371132f36d3b8b134f6ac1913a27697cd064ee51ae90eafc "$(codehash $DESK)"
same "FactorBurnPot      $BURN_POT" 0xb186b2d260e86cd1b200eaf2843bc61a00c42a650458ec7325278fd35ba3ab60 "$(codehash $BURN_POT)"
same "FactorLine         $LINE" 0x83926b11b8c0522bb06955b943bb2f9272edf6636495024cc21e6b396114b231 "$(codehash $LINE)"
same "FactorLineAccount  $LINE_ACCOUNT_IMPL (implementation)" 0x7086ac2f1b2af935c98c6140d9fb3eebd24d5e5dd698cd9a9dba3328e6a7ace3 "$(codehash $LINE_ACCOUNT_IMPL)"
same "FactorAccounts     $ACCOUNTS" 0x560df7e0b37e4551c4d3047a5c2284a22e6fb9eccd0fced5c5918fd111a265b2 "$(codehash $ACCOUNTS)"
same "FactorAccount      $ACCOUNT_IMPL (implementation)" 0xb957ce9c0530ebfe458eafb7b2cd4a00bb9572c4c922ecbd9466cdea924da133 "$(codehash $ACCOUNT_IMPL)"
same "gateway has no code (a plain address) $GATEWAY" $EMPTY "$(codehash $GATEWAY)"

echo "Immutables"
same "desk.burnPot()" $BURN_POT "$(call $DESK 'burnPot()(address)')"
same "desk.gateway()" $GATEWAY "$(call $DESK 'gateway()(address)')"
same "line.desk()" $DESK "$(call $LINE 'desk()(address)')"
same "line.burnPot()" $BURN_POT "$(call $LINE 'burnPot()(address)')"
same "line.gateway()" $GATEWAY "$(call $LINE 'gateway()(address)')"
same "line.accountImplementation()" $LINE_ACCOUNT_IMPL "$(call $LINE 'accountImplementation()(address)')"
same "lineAccountImpl.line()" $LINE "$(call $LINE_ACCOUNT_IMPL 'line()(address)')"
same "lineAccountImpl.desk()" $DESK "$(call $LINE_ACCOUNT_IMPL 'desk()(address)')"
same "accounts.implementation()" $ACCOUNT_IMPL "$(call $ACCOUNTS 'implementation()(address)')"
same "accountImpl.factory()" $ACCOUNTS "$(call $ACCOUNT_IMPL 'factory()(address)')"

echo "Desk constants"
same "ADVANCE_MAX_BPS"  5000    "$(call $DESK 'ADVANCE_MAX_BPS()(uint256)')"
same "ADVANCE_FEE_BPS"  100     "$(call $DESK 'ADVANCE_FEE_BPS()(uint256)')"
same "JOB_FEE_BPS"      200     "$(call $DESK 'JOB_FEE_BPS()(uint256)')"
same "REJECTED_BPS"     5000    "$(call $DESK 'REJECTED_BPS()(uint256)')"
same "POOL_OUT_MAX_BPS" 8000    "$(call $DESK 'POOL_OUT_MAX_BPS()(uint256)')"
same "MIN_JOB (wei)"    1000000000000000 "$(call $DESK 'MIN_JOB()(uint256)')"
same "MIN_DUE (s)"      3600    "$(call $DESK 'MIN_DUE()(uint256)')"
same "MAX_DUE (s)"      2592000 "$(call $DESK 'MAX_DUE()(uint256)')"
same "GRACE (s)"        43200   "$(call $DESK 'GRACE()(uint256)')"
same "REVIEW (s)"       86400   "$(call $DESK 'REVIEW()(uint256)')"

echo "Deploy transactions (the receipt's created address and block)"
deploy() { # label tx address block
  local got blk
  got=$("$CAST" receipt "$2" contractAddress --rpc-url "$RPC" 2>/dev/null)
  blk=$("$CAST" receipt "$2" blockNumber --rpc-url "$RPC" 2>/dev/null)
  same "$1 created by $2" "$3" "$got"
  same "$1 block" "$4" "$blk"
}
deploy FactorDesk     0x36e53bc2c196bccc8ed4d9fa255bc1f80500b4ea6c6a2a30824b136dfe270448 $DESK 88409808
deploy FactorBurnPot  0x145014074b176df9a17b41e972704db4ba8b1f388981b02d504db80aefff07ea $BURN_POT 88409783
deploy FactorAccounts 0x147e692420dc5b03352828eaad44dacc4bb4f2dd0b682db3ede62c841c20d5c3 $ACCOUNTS 88409859
deploy FactorLine     0x4210f983bc73edf0b870542097623488b61e42c007280cef77f98116374f400d $LINE 101683292

echo "The desk's constructor arguments, read from the end of its deploy transaction's input"
IN=$("$CAST" tx 0x36e53bc2c196bccc8ed4d9fa255bc1f80500b4ea6c6a2a30824b136dfe270448 input --rpc-url "$RPC" | lc)
TAIL=${IN: -128}
same "constructor arg 1 (burnPot_)" "000000000000000000000000ff54ebc9c6871fb1c5c9e03ac45250488d923f79" "${TAIL:0:64}"
same "constructor arg 2 (gateway_)" "000000000000000000000000e4314ba4dae5f31582ec23812d5f40287f1efde0" "${TAIL:64:64}"

echo
if [ $FAIL -eq 0 ]; then echo "All checks passed."; else echo "Some checks FAILED (see above)."; fi
exit $FAIL
