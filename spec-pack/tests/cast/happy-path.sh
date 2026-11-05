#!/usr/bin/env bash
# The whole life of a job on the live desk's bytecode, on an ANVIL FORK of Robinhood Chain. Nothing is broadcast to
# the real chain: the script refuses to run unless the node it talks to is anvil, forked from chain 4663.
#
#   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8545 &     # in another shell
#   ./happy-path.sh                       # RPC defaults to http://127.0.0.1:8545
#
# Needs only cast. The three wallets are throwaway test keys made from fixed words and funded only on the fork.
# Never put a real key in this file.
set -euo pipefail
RPC="${RPC:-http://127.0.0.1:8545}"
CAST="${CAST:-cast}"
DESK=0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F
BURN_POT=0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79
DESK_CODE_HASH=0x62f56fb1f0e0ebf6371132f36d3b8b134f6ac1913a27697cd064ee51ae90eafc

# Test keys made from fixed words (keccak256 of a label), funded only on the local fork with anvil_setBalance.
# Not anvil's default accounts: on the live chain those carry an EIP-7702 delegation (code 0xef0100...), and the
# desk's bounded payout push to such an address can be refused and land in `owed` (see warnings.md).
AGENT_PK=$("$CAST" keccak "factor-kit-fork-test-agent")
CUSTOMER_PK=$("$CAST" keccak "factor-kit-fork-test-customer")
STRANGER_PK=$("$CAST" keccak "factor-kit-fork-test-stranger")
AGENT=$("$CAST" wallet address --private-key $AGENT_PK)
CUSTOMER=$("$CAST" wallet address --private-key $CUSTOMER_PK)
STRANGER=$("$CAST" wallet address --private-key $STRANGER_PK)

say() { printf "%s\n" "$*"; }
fail() { printf "FAIL: %s\n" "$*"; exit 1; }
# send a transaction on the fork and print its gas
send() { # label pk to sig [args...] [--value v]
  local label=$1 pk=$2; shift 2
  local h; h=$("$CAST" send --async --private-key "$pk" --rpc-url "$RPC" "$@")
  local st; st=$("$CAST" receipt "$h" status --rpc-url "$RPC")
  local gas; gas=$("$CAST" receipt "$h" gasUsed --rpc-url "$RPC")
  [ "$st" = "true" ] || [ "$st" = "1 (success)" ] || [ "$st" = "1" ] || fail "$label reverted ($h)"
  printf "  %-46s gasUsed %7s  tx %s\n" "$label" "$gas" "$h"
}
v() { "$CAST" call "$DESK" "$@" --rpc-url "$RPC" | awk '{print $1}'; }
state_of() { "$CAST" call "$DESK" 'job(uint256)((address,uint40,uint40,uint8,bool,bool,address,uint256,uint256,uint256,bytes32))' "$1" --rpc-url "$RPC" | tr -d '()' | awk -F', ' '{print $4}'; }
bal() { "$CAST" balance "$1" --rpc-url "$RPC"; }
now() { "$CAST" block latest --field timestamp --rpc-url "$RPC"; }

# ---------- refuse anything but an anvil fork of chain 4663 ----------
CLIENT=$("$CAST" rpc web3_clientVersion --rpc-url "$RPC" | tr -d '"')
case "$CLIENT" in anvil*) ;; *) fail "the node at $RPC is \"$CLIENT\", not anvil. This script only runs on a local fork." ;; esac
[ "$("$CAST" chain-id --rpc-url "$RPC")" = "4663" ] || fail "not a fork of Robinhood Chain (4663)"
[ "$("$CAST" keccak "$("$CAST" code $DESK --rpc-url "$RPC")")" = "$DESK_CODE_HASH" ] || fail "the desk's code hash is not the one in deployment.json"
# Measured: on a fresh fork of this chain, anvil refuses eth_call against the forked block ("Excess blob gas not
# set"). One block mined by anvil itself fixes that.
"$CAST" rpc evm_mine --rpc-url "$RPC" >/dev/null
# 1 ETH each on the fork, so every balance fits shell arithmetic (64-bit)
for w in $AGENT $CUSTOMER $STRANGER; do
  [ "$("$CAST" code $w --rpc-url "$RPC")" = "0x" ] || fail "$w has code on this chain: pick other test keys"
  "$CAST" rpc anvil_setBalance $w 0xde0b6b3a7640000 --rpc-url "$RPC" >/dev/null
done
say "anvil fork of chain 4663 at block $("$CAST" block-number --rpc-url "$RPC"), client $CLIENT"
say "agent $AGENT  customer $CUSTOMER  stranger $STRANGER"
say

# ---------- factor_sign_up: the register step (on chain), then the profile signature (engine) ----------
say "1. factor_sign_up"
REG=$("$CAST" call $DESK 'agent(address)((bool,bool,uint40,uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint256,uint256,uint256,uint256))' $AGENT --rpc-url "$RPC" | tr -d '(' | awk -F', ' '{print $1}')
if [ "$REG" = "true" ]; then say "  already registered on the desk: no transaction"; else send "desk.register()" $AGENT_PK $DESK 'register()'; fi
AT=$(now)
ADDR_LC=$(printf %s "$AGENT" | tr 'A-F' 'a-f')
MSG=$(printf 'Factor agent profile\naddress: %s\nname: %s\ndoes: %s\nat: %s' "$ADDR_LC" "kit-test-agent" "Answers test questions on a fork" "$AT")
SIG=$("$CAST" wallet sign --private-key $AGENT_PK "$MSG")
"$CAST" wallet verify --address "$AGENT" "$MSG" "$SIG" >/dev/null && say "  profile signature (EIP-191) recovers to the agent: ok"
say "  the body POST /api/v1/agents/profile would take (NOT sent from this script):"
say "  {\"address\":\"$ADDR_LC\",\"name\":\"kit-test-agent\",\"does\":\"Answers test questions on a fork\",\"at\":$AT,\"signature\":\"${SIG:0:20}...\"}"
say

# ---------- a customer locks a job ----------
say "2. customer locks 0.01 ETH for the agent, due in 24 hours, no early advance"
DUE=$(( $(now) + 86400 ))
send "desk.lock(agent, dueAt, false) value 0.01 ETH" $CUSTOMER_PK $DESK 'lock(address,uint256,bool)' $AGENT $DUE false --value 0.01ether
JOB=$(v 'jobCount()(uint256)')
[ "$(state_of $JOB)" = "1" ] || fail "job $JOB is not Locked"
say "  job $JOB is Locked (state 1)"
say

# ---------- factor_can_draw and factor_draw ----------
say "3. factor_can_draw, then factor_draw from the pool"
send "desk.addBond() value 0.002 ETH" $AGENT_PK $DESK 'addBond()' --value 0.002ether
CAN=$("$CAST" call $DESK 'canDrawOn(uint256)(uint256,uint256)' $JOB --rpc-url "$RPC" | awk '{print $1}' | paste -sd' ' -)
say "  canDrawOn($JOB) = (early, fromPool) = ($CAN) wei"
A0=$(bal $AGENT); P0=$(bal $BURN_POT)
send "desk.draw(job, 0.002 ETH, 1 = Pool)" $AGENT_PK $DESK 'draw(uint256,uint256,uint8)' $JOB 2000000000000000 1
A1=$(bal $AGENT); P1=$(bal $BURN_POT)
say "  burn pot received $(( P1 - P0 )) wei (1% of 0.002 ETH = 20000000000000)"
[ "$(( P1 - P0 ))" = "20000000000000" ] || fail "advance fee"
[ "$(state_of $JOB)" = "2" ] || fail "job is not Advanced"
say "  job $JOB is Advanced (state 2)"
say

# ---------- factor_deliver ----------
say "4. factor_deliver: only the fingerprint goes on chain"
WORK="The finished work, exactly as handed to the customer."
PROOF=$("$CAST" keccak "$WORK")
send "desk.deliver(job, keccak256(work))" $AGENT_PK $DESK 'deliver(uint256,bytes32)' $JOB $PROOF
[ "$(state_of $JOB)" = "3" ] || fail "job is not Delivered"
say "  proof $PROOF, job $JOB is Delivered (state 3)"
say

# ---------- the customer accepts ----------
say "5. customer accepts: pool repaid first, 2% job fee, the agent gets the rest"
A2=$(bal $AGENT)
send "desk.accept(job)" $CUSTOMER_PK $DESK 'accept(uint256)' $JOB
A3=$(bal $AGENT)
say "  agent received $(( A3 - A2 )) wei (0.01 - 0.002 - 0.0002 = 7800000000000000)"
[ "$(( A3 - A2 ))" = "7800000000000000" ] || fail "payout"
[ "$(state_of $JOB)" = "4" ] || fail "job is not Settled"
say "  job $JOB is Settled (state 4)"
say

# ---------- a second job: early advance, no word from the customer, anyone settles ----------
say "6. second job: early advance allowed, delivered, 24 hours pass, a stranger settles"
send "desk.lock(agent, dueAt, true) value 0.004 ETH" $CUSTOMER_PK $DESK 'lock(address,uint256,bool)' $AGENT $(( $(now) + 7200 )) true --value 0.004ether
JOB2=$(v 'jobCount()(uint256)')
send "desk.draw(job2, 0.002 ETH, 0 = Early)" $AGENT_PK $DESK 'draw(uint256,uint256,uint8)' $JOB2 2000000000000000 0
send "desk.deliver(job2, proof)" $AGENT_PK $DESK 'deliver(uint256,bytes32)' $JOB2 $PROOF
"$CAST" rpc evm_increaseTime 86400 --rpc-url "$RPC" >/dev/null
"$CAST" rpc evm_mine --rpc-url "$RPC" >/dev/null
send "desk.settle(job2) by anyone" $STRANGER_PK $DESK 'settle(uint256)' $JOB2
[ "$(state_of $JOB2)" = "4" ] || fail "job2 is not Settled"
say "  job $JOB2 is Settled (state 4)"
say

# ---------- a third job: factor_decline ----------
say "7. third job: factor_decline before drawing"
send "desk.lock(agent, dueAt, false) value 0.002 ETH" $CUSTOMER_PK $DESK 'lock(address,uint256,bool)' $AGENT $(( $(now) + 86400 )) false --value 0.002ether
JOB3=$(v 'jobCount()(uint256)')
C0=$(bal $CUSTOMER)
send "desk.decline(job3)" $AGENT_PK $DESK 'decline(uint256)' $JOB3
C1=$(bal $CUSTOMER)
[ "$(( C1 - C0 ))" = "2000000000000000" ] || fail "decline refund"
[ "$(state_of $JOB3)" = "6" ] || fail "job3 is not Declined"
say "  customer got 2000000000000000 wei back; job $JOB3 is Declined (state 6)"
say

# ---------- the desk's own books ----------
BALANCE=$(bal $DESK)
SUM=$(( $(v 'pool()(uint256)') + $(v 'held()(uint256)') + $(v 'bonds()(uint256)') + $(v 'owedTotal()(uint256)') ))
[ "$BALANCE" -ge "$SUM" ] || fail "books"
say "desk balance $BALANCE >= pool + held + bonds + owedTotal $SUM: ok"
say "ALL STEPS PASSED"
