#!/bin/zsh
# Deploys the bounty contract, where a customer locks a prize and agents enter with finished work, then reads it
# back from the chain and checks every wire.
#
#   contracts/deploy-bounties.sh <the deploying wallet's address>
#
# One thing is asked for: that wallet's private key, typed or pasted at forge's own prompt (nothing shows). Any wallet
# can deploy it: the bounty contract has no owner and gives its deployer no power. It is given the desk and the line
# contract, and reads the burn pot and the desk's own numbers from the desk. On a local fork of the chain (FACTOR_RPC
# set to it) no key is asked for: the fork's own unlocked wallet sends it.
#
# Nothing needs seeding afterwards: every prize and every bond is its sender's own.
#
# Steps, each printed as it starts:
#   1/4 the chain, the wallet and Factor           3/4 the deploy (the key)
#   2/4 a dry run, with what the deploy and each   4/4 the check, and the address written to
#       call of a bounty cost                         contracts/broadcast/factor.env
#
# Nothing is sent before step 3, and a failed step stops the script.
. "$(dirname "$0")/lib.sh"
SENDER=$1
TMP=$(mktemp -t factor-bounties); trap 'rm -f $TMP' EXIT
# The line contract live on Robinhood Chain since 30 Oct 2026, used when factor.env does not name one.
LIVE_LINE=0xc9405ca62ed1e9a4a058f404e5c1c893f7ae67c4

is_address "$SENDER" || die "say which wallet deploys it: contracts/deploy-bounties.sh <the deploying wallet's address>"

step "1/4 the chain, the wallet and Factor"
chain_or_die
load_deployment
LINE=$(val FACTOR_LINE)
[ -n "$LINE" ] || LINE=$LIVE_LINE
is_address "$LINE" && has_code $LINE || die "there is no line contract at $LINE on this chain"
[ "$(low $(cast call $LINE 'desk()(address)' --rpc-url "$RPC"))" = "$(low $FACTOR_DESK)" ] || die "the line contract at $LINE is not the desk's ($FACTOR_DESK)"
export FACTOR_LINE=$LINE
BAL=$(cast balance $SENDER --rpc-url "$RPC") || die "could not read the wallet's balance"
echo "  deploying wallet  $SENDER  holds $(eth $BAL) ETH"
echo "  desk $FACTOR_DESK, burn pot $FACTOR_BURN_POT, line $FACTOR_LINE"
OLD=$(val FACTOR_BOUNTY)
if [ -n "$OLD" ] && has_code $OLD; then
  die "the bounty contract is already deployed on this chain ($OLD, in $OUT). Deploying twice would make a second one."
fi

step "2/4 a dry run: the deploy against the chain as it is now, nothing sent, and what a bounty costs"
forge script script/DeployBounties.s.sol --rpc-url "$RPC" --sender $SENDER > $TMP 2>&1 || { tail -15 $TMP; die "the dry run failed, so nothing was sent"; }
read_estimate $TMP
AT=$(grep "FACTOR_BOUNTY=" $TMP | tail -1 | sed 's/.*FACTOR_BOUNTY=//')
is_address "$AT" || { tail -15 $TMP; die "the dry run did not say where the bounty contract would be"; }
echo "  one contract, about $GAS gas at most; forge wants up to $NEED ETH in the wallet (about \$$(usd $NEED_WEI))"
echo "  it would be at $AT"
forge script script/DeployBounties.s.sol --sig "costs()" --rpc-url "$RPC" --sender $SENDER > $TMP 2>&1 || { tail -15 $TMP; die "the cost simulation failed, so nothing was sent"; }
sed -n '/gas price used/,/BOUNTY_DEPLOY_GAS/p' $TMP | grep -v "BOUNTY_" | sed 's/^ */  /'
if [ -n "$DRY" ]; then
  python3 -c "import sys; sys.exit(0 if int('$BAL') >= int('$NEED_WEI') else 1)" || echo "  note: the wallet holds $(eth $BAL) ETH; the deploy needs up to $NEED ETH"
  echo; echo "DRY RUN ONLY (FACTOR_DRY is set). Nothing was sent and no key was asked for."; exit 0
fi
python3 -c "import sys; sys.exit(0 if int('$BAL') >= int('$NEED_WEI') else 1)" || die "the wallet holds $(eth $BAL) ETH and the deploy needs up to $NEED ETH. Nothing was sent."

if [ "$RPC" = "$LIVE" ]; then
  step "3/4 the deploy: forge now asks for the wallet's private key (nothing shows as it is typed or pasted)"
  SIGN=(--interactive)
else
  step "3/4 the deploy, on the fork: its unlocked wallet sends it, no key"
  SIGN=(--unlocked)
fi
BLOCK=$(cast block-number --rpc-url "$RPC")
forge script script/DeployBounties.s.sol --rpc-url "$RPC" --broadcast $SIGN --sender $SENDER \
  || die "the deploy did not go through. Read the lines above; if no transaction was sent, it is safe to run this again."

step "4/4 the check: the address forge recorded, and the bounty contract read back from the chain"
CHAINDIR=$(cast chain-id --rpc-url "$RPC")
RECORD="$HERE/broadcast/DeployBounties.s.sol/$CHAINDIR/run-latest.json"
[ -f "$RECORD" ] && [ "$RECORD" -nt $TMP ] || die "the deploy was sent, but forge's record of it ($RECORD) is missing. Do NOT deploy again: find the address in the lines above."
G=$(python3 - "$RECORD" "$SENDER" <<'PY'
import json, sys
txs = json.load(open(sys.argv[1]))["transactions"]
if len(txs) != 1 or txs[0].get("contractName") != "FactorBounty" or txs[0].get("transactionType") != "CREATE": sys.exit(1)
if str((txs[0].get("transaction") or {}).get("from")).lower() != sys.argv[2].lower(): sys.exit(1)
print(txs[0]["contractAddress"])
PY
) || die "forge's record is not this deploy's. Do NOT deploy again: find the address in the lines above."
G=$(cast to-check-sum-address $G)
has_code $G || die "there is no contract at $G, where forge recorded the bounty contract"
[ "$(low $G)" = "$(low $AT)" ] || echo "  note: it is at $G, not $AT where the dry run put it: the wallet's nonce moved in between. The deployed address is the one used."
export FACTOR_BOUNTY=$G
forge script script/DeployBounties.s.sol --sig "check()" --rpc-url "$RPC" > $TMP 2>&1 \
  || { tail -15 $TMP; die "the bounty contract does not read back as meant at $G. Do not tell the engine about it before this is understood."; }
grep -E "OK:|bounty|desk|line|burn pot|bounties|held|bonds" $TMP | sed 's/^ */  /'
grep -v -E "^FACTOR_BOUNTY(_BLOCK)?=" "$OUT" > $TMP
{ echo "FACTOR_BOUNTY=$G"; echo "FACTOR_BOUNTY_BLOCK=$BLOCK"; } >> $TMP
cp $TMP "$OUT"
echo "  written to $OUT (FACTOR_BOUNTY_BLOCK is the block just before the deploy: the engine reads bounties from there)"
echo
echo "DONE. Next: give the engine FACTOR_BOUNTY and FACTOR_BOUNTY_BLOCK, and BOUNTIES=on (docs/RELEASE-bounties.md)."
