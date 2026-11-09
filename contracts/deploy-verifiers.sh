#!/bin/zsh
# Deploys the verifier contract, where a customer hires with a verifier, bonded verifier agents check delivered work
# against its brief, and a disputed job goes to a panel of verifiers on different model makers, then reads it back
# from the chain and checks every wire.
#
#   contracts/deploy-verifiers.sh <the deploying wallet's address>
#
# One thing is asked for: that wallet's private key, typed or pasted at forge's own prompt (nothing shows). Any wallet
# can deploy it: the verifier contract has no owner and gives its deployer no power. It is given the desk and the line
# contract (read only to keep a line account's key off its own account's job), and reads the desk's own numbers. On a local fork of the chain (FACTOR_RPC set to it) no key is asked for: the fork's
# own unlocked wallet sends it.
#
# Nothing needs seeding afterwards: every fee is its customer's own and every bond its verifier's. Factor's own
# verifiers join from the engine, once their wallets are funded (docs/RELEASE-verifiers.md).
#
# Steps, each printed as it starts:
#   1/4 the chain, the wallet and Factor           3/4 the deploy (the key)
#   2/4 a dry run, with what the deploy and each   4/4 the check, and the address written to
#       call of a case cost                           contracts/broadcast/factor.env
#
# Nothing is sent before step 3, and a failed step stops the script.
. "$(dirname "$0")/lib.sh"
SENDER=$1
TMP=$(mktemp -t factor-verifiers); trap 'rm -f $TMP' EXIT

is_address "$SENDER" || die "say which wallet deploys it: contracts/deploy-verifiers.sh <the deploying wallet's address>"

step "1/4 the chain, the wallet and Factor"
chain_or_die
load_deployment
BAL=$(cast balance $SENDER --rpc-url "$RPC") || die "could not read the wallet's balance"
echo "  deploying wallet  $SENDER  holds $(eth $BAL) ETH"
echo "  desk $FACTOR_DESK"
# the line contract: from the deployment file, or the live one when this is the live chain
FACTOR_LINE=$(val FACTOR_LINE)
[ -z "$FACTOR_LINE" ] && [ "$RPC" = "$LIVE" ] && FACTOR_LINE=0xc9405ca62eD1e9a4a058F404e5c1C893F7ae67c4
is_address "$FACTOR_LINE" && has_code $FACTOR_LINE || die "no line contract found (FACTOR_LINE in $OUT)"
export FACTOR_LINE
echo "  line $FACTOR_LINE"
OLD=$(val FACTOR_VERIFIERS)
if [ -n "$OLD" ] && has_code $OLD; then
  die "the verifier contract is already deployed on this chain ($OLD, in $OUT). Deploying twice would make a second one."
fi

step "2/4 a dry run: the deploy against the chain as it is now, nothing sent, and what each call of a case costs"
forge script script/DeployVerifiers.s.sol --rpc-url "$RPC" --sender $SENDER > $TMP 2>&1 || { tail -15 $TMP; die "the dry run failed, so nothing was sent"; }
read_estimate $TMP
AT=$(grep "FACTOR_VERIFIERS=" $TMP | tail -1 | sed 's/.*FACTOR_VERIFIERS=//')
is_address "$AT" || { tail -15 $TMP; die "the dry run did not say where the verifier contract would be"; }
echo "  one contract, about $GAS gas at most; forge wants up to $NEED ETH in the wallet (about \$$(usd $NEED_WEI))"
echo "  it would be at $AT"
forge script script/DeployVerifiers.s.sol --sig "costs()" --rpc-url "$RPC" --sender $SENDER > $TMP 2>&1 || { tail -15 $TMP; die "the cost simulation failed, so nothing was sent"; }
sed -n '/gas price used/,/VERIFIERS_DEPLOY_GAS/p' $TMP | grep -v "VERIFIERS_" | sed 's/^ */  /'
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
forge script script/DeployVerifiers.s.sol --rpc-url "$RPC" --broadcast $SIGN --sender $SENDER \
  || die "the deploy did not go through. Read the lines above; if no transaction was sent, it is safe to run this again."

step "4/4 the check: the address forge recorded, and the verifier contract read back from the chain"
CHAINDIR=$(cast chain-id --rpc-url "$RPC")
RECORD="$HERE/broadcast/DeployVerifiers.s.sol/$CHAINDIR/run-latest.json"
[ -f "$RECORD" ] && [ "$RECORD" -nt $TMP ] || die "the deploy was sent, but forge's record of it ($RECORD) is missing. Do NOT deploy again: find the address in the lines above."
G=$(python3 - "$RECORD" "$SENDER" <<'PY'
import json, sys
txs = json.load(open(sys.argv[1]))["transactions"]
if len(txs) != 1 or txs[0].get("contractName") != "FactorVerifiers" or txs[0].get("transactionType") != "CREATE": sys.exit(1)
if str((txs[0].get("transaction") or {}).get("from")).lower() != sys.argv[2].lower(): sys.exit(1)
print(txs[0]["contractAddress"])
PY
) || die "forge's record is not this deploy's. Do NOT deploy again: find the address in the lines above."
G=$(cast to-check-sum-address $G)
has_code $G || die "there is no contract at $G, where forge recorded the verifier contract"
[ "$(low $G)" = "$(low $AT)" ] || echo "  note: it is at $G, not $AT where the dry run put it: the wallet's nonce moved in between. The deployed address is the one used."
export FACTOR_VERIFIERS=$G
forge script script/DeployVerifiers.s.sol --sig "check()" --rpc-url "$RPC" > $TMP 2>&1 \
  || { tail -15 $TMP; die "the verifier contract does not read back as meant at $G. Do not tell the engine about it before this is understood."; }
grep -E "OK:|verifiers|desk|line|cases|bonds|staked|fees" $TMP | sed 's/^ */  /'
grep -v -E "^FACTOR_VERIFIERS(_BLOCK)?=" "$OUT" > $TMP
{ echo "FACTOR_VERIFIERS=$G"; echo "FACTOR_VERIFIERS_BLOCK=$BLOCK"; } >> $TMP
cp $TMP "$OUT"
echo "  written to $OUT (FACTOR_VERIFIERS_BLOCK is the block just before the deploy: the engine reads cases from there)"
echo
echo "DONE. Next: give the engine FACTOR_VERIFIERS and FACTOR_VERIFIERS_BLOCK, and VERIFIERS=on (docs/RELEASE-verifiers.md)."
