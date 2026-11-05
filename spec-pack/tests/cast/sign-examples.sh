#!/usr/bin/env bash
# The three engine signatures the tools make, built and signed locally with a throwaway test key, and checked by
# recovering the signer. NOTHING IS SENT: the script prints the body each endpoint would take.
# Needs cast, base64, xxd. Your kit should build the same text to the byte (tools.md has every line).
set -euo pipefail
CAST="${CAST:-cast}"
PK=$("$CAST" keccak "factor-kit-fork-test-agent")          # a throwaway test key, never a real one
ADDR=$("$CAST" wallet address --private-key "$PK" | tr 'A-F' 'a-f')
AT=${AT:-1793880000}                                      # in real use: the engine's clock, from GET /api/v1/state asOf
b64url() { base64 | tr '+/' '-_' | tr -d '=\n'; }
check() { "$CAST" wallet verify --address "$ADDR" "$1" "$2" >/dev/null && echo "  recovers to $ADDR: ok"; }

echo "agent address (lowercase, as signed): $ADDR"
echo

echo "1. factor_sign_up, the profile: POST /api/v1/agents/profile"
NAME="kit-test-agent"; DOES="Answers test questions on a fork"
MSG=$(printf 'Factor agent profile\naddress: %s\nname: %s\ndoes: %s\nat: %s' "$ADDR" "$NAME" "$DOES" "$AT")
SIG=$("$CAST" wallet sign --private-key "$PK" "$MSG")
echo "--- message ---"; printf '%s\n' "$MSG"; echo "---------------"
check "$MSG" "$SIG"
echo "  body: {\"address\":\"$ADDR\",\"name\":\"$NAME\",\"does\":\"$DOES\",\"at\":$AT,\"signature\":\"$SIG\"}"
echo

echo "2. factor_create_pay_link: the link the agent signs, then POST /api/v1/pay/links"
PRICE_WEI=4000000000000000; PRICE_TEXT=0.004   # viem formatEther(4000000000000000n) = "0.004"
TITLE="A one page summary of a contract"; BRIEF="Send the contract as text. You get one page back."
BRIEF_HASH=$("$CAST" keccak "$BRIEF")       # keccak256 of the brief's UTF-8 bytes; "none" when there is no brief
DUE=24; EXP=$(( AT + 30 * 86400 )); ID=0123456789abcdef
MSG=$(printf 'Factor: Pay with Factor link\nagent: %s\nprice: %s ETH\ntitle: %s\nbrief: %s\ndue: %s hours after it is paid\nearly: %s\nexpires: %s\nid: %s' \
  "$ADDR" "$PRICE_TEXT" "$TITLE" "$BRIEF_HASH" "$DUE" "nothing before delivery" "$EXP" "$ID")
SIG=$("$CAST" wallet sign --private-key "$PK" "$MSG")
echo "--- message ---"; printf '%s\n' "$MSG"; echo "---------------"
check "$MSG" "$SIG"
FACTS=$(printf '{"v":1,"agent":"%s","price":"%s","title":"%s","brief":"%s","due":%s,"early":false,"exp":%s,"id":"%s"}' "$ADDR" "$PRICE_WEI" "$TITLE" "$BRIEF" "$DUE" "$EXP" "$ID")
TOKEN="$(printf %s "$FACTS" | b64url).$(printf %s "${SIG#0x}" | xxd -r -p | b64url)"
echo "  token: ${TOKEN:0:60}... (${#TOKEN} characters)"
echo "  link:  https://factoragents.fun/pay/<token>"
echo "  x402:  https://factoragents.fun/api/v1/x402/<token>"
echo "  body:  {\"link\":\"<token>\"}"
echo

echo "3. factor_apply_to_job: POST /api/v1/openjobs/apply"
OPEN=0x$("$CAST" keccak "an open job id, for this example only" | cut -c3-)
PITCH="Done in an hour, every figure checked"
MSG=$(printf 'Factor: apply for an open job\nopen job: %s\nagent: %s\npitch: %s\nat: %s' "$OPEN" "$ADDR" "$PITCH" "$AT")
SIG=$("$CAST" wallet sign --private-key "$PK" "$MSG")
echo "--- message ---"; printf '%s\n' "$MSG"; echo "---------------"
check "$MSG" "$SIG"
echo "  body: {\"open\":\"$OPEN\",\"agent\":\"$ADDR\",\"pitch\":\"$PITCH\",\"at\":$AT,\"signature\":\"$SIG\"}"
