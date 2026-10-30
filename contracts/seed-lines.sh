#!/bin/zsh
# Seeds the credit line pool: plain ETH sent to the line contract, which is its pool for good.
#
#   contracts/seed-lines.sh <amount in ETH> <the sending wallet's address>
#
# One thing is asked for: that wallet's private key, typed or pasted at cast's own prompt (nothing shows).
#
# ETH sent to the line contract CAN NEVER BE TAKEN BACK OUT, by anyone, the sender included: it only ever leaves the
# pool as a draw and comes back as a repayment. The script says so again and waits for "yes" before it sends.
#
# Steps: 1/3 the chain, the line contract and the wallet; 2/3 the pool before, and the question; 3/3 the send, and the
# pool after.
. "$(dirname "$0")/lib.sh"
AMOUNT=$1
SENDER=$2
[[ "$AMOUNT" =~ '^[0-9]+(\.[0-9]{1,18})?$' ]] || die "say how much ETH: contracts/seed-lines.sh 0.05 <the sending wallet's address>"
is_address "$SENDER" || die "say which wallet sends it: contracts/seed-lines.sh $AMOUNT <the sending wallet's address>"
WEI=$(cast to-wei "$AMOUNT" ether)

step "1/3 the chain, the line contract and the wallet"
chain_or_die
LINE=$(val FACTOR_LINE)
is_address "$LINE" || die "$OUT has no FACTOR_LINE: deploy it first with contracts/deploy-lines.sh"
has_code $LINE || die "there is no contract at $LINE on this chain"
FEE=$(cast call $LINE "DRAW_FEE_BPS()(uint256)" --rpc-url "$RPC" 2>/dev/null | num) || die "$LINE does not answer as the line contract"
[ "$FEE" = 200 ] || die "$LINE does not answer as the line contract (its draw fee is not 2%)"
BAL=$(cast balance $SENDER --rpc-url "$RPC") || die "could not read the wallet's balance"
echo "  line contract $LINE"
echo "  sending wallet $SENDER holds $(eth $BAL) ETH"
python3 -c "import sys; sys.exit(0 if int('$BAL') > int('$WEI') else 1)" || die "the wallet holds $(eth $BAL) ETH: not enough to send $AMOUNT and the gas"

step "2/3 the pool before, and the question"
POOL=$(cast call $LINE "pool()(uint256)" --rpc-url "$RPC" | num)
echo "  the line pool holds $(eth $POOL) ETH now"
echo
echo "  $AMOUNT ETH will go into the line pool FOR GOOD. Nobody can take it back out, the sender included."
if [ -n "$DRY" ]; then echo; echo "DRY RUN ONLY (FACTOR_DRY is set). Nothing was sent and no key was asked for."; exit 0; fi
printf "  Type yes to send it: "
read ANSWER
[ "$ANSWER" = yes ] || die "nothing was sent"

step "3/3 the send: cast now asks for the wallet's private key (nothing shows as it is typed or pasted)"
if [ "$RPC" = "$LIVE" ]; then SIGN=(--interactive); else SIGN=(--unlocked --from $SENDER); fi
cast send $LINE --value $WEI --rpc-url "$RPC" $SIGN || die "the send did not go through. Read the lines above."
AFTER=$(cast call $LINE "pool()(uint256)" --rpc-url "$RPC" | num)
echo "  the line pool holds $(eth $AFTER) ETH now"
echo
echo "DONE."
