#!/bin/zsh
# Deploys the treasury contract (agent treasury), where an agent's idle earnings work on their own inside rules the
# agent sets once, then reads it back from the chain and checks every wire.
#
#   contracts/deploy-treasury.sh <the deploying wallet's address>
#
# One thing is asked for: that wallet's private key, typed or pasted at forge's own prompt (nothing shows). Any wallet
# can deploy it: the treasury contract has no owner and gives its deployer no power. It is given the vouching contract
# and the claims contract, and reads the desk, the line contract, the guarantee contract and the compute gateway from
# them. On a local fork of the chain (FACTOR_RPC set to it) no key is asked for: the fork's own unlocked wallet sends it.
#
# Nothing needs seeding afterwards: every treasury holds only what was put in for its agent.
#
# Steps, each printed as it starts:
#   1/4 the chain, the wallet and Factor     3/4 the deploy (the key)
#   2/4 a dry run                            4/4 the check, and the address written to contracts/broadcast/factor.env
#
# Nothing is sent before step 3, and a failed step stops the script.
. "$(dirname "$0")/lib.sh"
SENDER=$1
TMP=$(mktemp -t factor-treasury); trap 'rm -f $TMP' EXIT
# The vouching contract (live since 12 Nov 2026) and the claims contract (live since 13 Nov 2026) on Robinhood Chain,
# used when factor.env does not name them.
LIVE_VOUCH=0x23ee52Fd61D3FbcBD1746BD2931554152AaFC248
LIVE_CLAIMS=0xd2a678430BaDBB738789DA8e88Fd1c5F476A52Ba

is_address "$SENDER" || die "say which wallet deploys it: contracts/deploy-treasury.sh <the deploying wallet's address>"

step "1/4 the chain, the wallet and Factor"
chain_or_die
load_deployment
BAL=$(cast balance $SENDER --rpc-url "$RPC") || die "could not read the wallet's balance"
echo "  deploying wallet  $SENDER  holds $(eth $BAL) ETH"
echo "  desk $FACTOR_DESK"
FACTOR_VOUCH=$(val FACTOR_VOUCH)
[ -z "$FACTOR_VOUCH" ] && [ "$RPC" = "$LIVE" ] && FACTOR_VOUCH=$LIVE_VOUCH
is_address "$FACTOR_VOUCH" && has_code $FACTOR_VOUCH || die "no vouching contract found (FACTOR_VOUCH in $OUT)"
FACTOR_CLAIMS=$(val FACTOR_CLAIMS)
[ -z "$FACTOR_CLAIMS" ] && [ "$RPC" = "$LIVE" ] && FACTOR_CLAIMS=$LIVE_CLAIMS
is_address "$FACTOR_CLAIMS" && has_code $FACTOR_CLAIMS || die "no claims contract found (FACTOR_CLAIMS in $OUT)"
[ "$(low $(cast call $FACTOR_VOUCH 'desk()(address)' --rpc-url "$RPC"))" = "$(low $FACTOR_DESK)" ] || die "the vouching contract at $FACTOR_VOUCH is not the desk's ($FACTOR_DESK)"
[ "$(low $(cast call $FACTOR_CLAIMS 'desk()(address)' --rpc-url "$RPC"))" = "$(low $FACTOR_DESK)" ] || die "the claims contract at $FACTOR_CLAIMS is not the desk's ($FACTOR_DESK)"
export FACTOR_VOUCH FACTOR_CLAIMS
echo "  vouching $FACTOR_VOUCH, claims $FACTOR_CLAIMS"
echo "  line $(cast call $FACTOR_VOUCH 'line()(address)' --rpc-url "$RPC"), guarantee $(cast call $FACTOR_VOUCH 'guarantee()(address)' --rpc-url "$RPC")"
OLD=$(val FACTOR_TREASURY)
if [ -n "$OLD" ] && has_code $OLD; then
  die "the treasury contract is already deployed on this chain ($OLD, in $OUT). Deploying twice would make a second one."
fi

step "2/4 a dry run: the deploy against the chain as it is now, nothing sent"
forge script script/DeployTreasury.s.sol --rpc-url "$RPC" --sender $SENDER > $TMP 2>&1 || { tail -15 $TMP; die "the dry run failed, so nothing was sent"; }
read_estimate $TMP
AT=$(grep "FACTOR_TREASURY=" $TMP | tail -1 | sed 's/.*FACTOR_TREASURY=//')
is_address "$AT" || { tail -15 $TMP; die "the dry run did not say where the treasury contract would be"; }
echo "  one contract, about $GAS gas at most; forge wants up to $NEED ETH in the wallet (about \$$(usd $NEED_WEI))"
echo "  it would be at $AT"
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
forge script script/DeployTreasury.s.sol --rpc-url "$RPC" --broadcast $SIGN --sender $SENDER \
  || die "the deploy did not go through. Read the lines above; if no transaction was sent, it is safe to run this again."

step "4/4 the check: the address forge recorded, and the treasury contract read back from the chain"
CHAINDIR=$(cast chain-id --rpc-url "$RPC")
RECORD="$HERE/broadcast/DeployTreasury.s.sol/$CHAINDIR/run-latest.json"
[ -f "$RECORD" ] && [ "$RECORD" -nt $TMP ] || die "the deploy was sent, but forge's record of it ($RECORD) is missing. Do NOT deploy again: find the address in the lines above."
G=$(python3 - "$RECORD" "$SENDER" <<'PY'
import json, sys
txs = json.load(open(sys.argv[1]))["transactions"]
if len(txs) != 1 or txs[0].get("contractName") != "FactorTreasury" or txs[0].get("transactionType") != "CREATE": sys.exit(1)
if str((txs[0].get("transaction") or {}).get("from")).lower() != sys.argv[2].lower(): sys.exit(1)
print(txs[0]["contractAddress"])
PY
) || die "forge's record is not this deploy's. Do NOT deploy again: find the address in the lines above."
G=$(cast to-check-sum-address $G)
has_code $G || die "there is no contract at $G, where forge recorded the treasury contract"
[ "$(low $G)" = "$(low $AT)" ] || echo "  note: it is at $G, not $AT where the dry run put it: the wallet's nonce moved in between. The deployed address is the one used."
export FACTOR_TREASURY=$G
forge script script/DeployTreasury.s.sol --sig "check()" --rpc-url "$RPC" > $TMP 2>&1 \
  || { tail -15 $TMP; die "the treasury contract does not read back as meant at $G. Do not tell the engine about it before this is understood."; }
grep -E "OK:|treasury |desk |line |guarantee |vouching |claims |gateway |held " $TMP | sed 's/^ */  /'
grep -v -E "^FACTOR_TREASURY(_BLOCK)?=" "$OUT" > $TMP
{ echo "FACTOR_TREASURY=$G"; echo "FACTOR_TREASURY_BLOCK=$BLOCK"; } >> $TMP
cp $TMP "$OUT"
echo "  written to $OUT (FACTOR_TREASURY_BLOCK is the block just before the deploy: the engine reads treasuries from there)"
echo
echo "DONE. Next: give the engine FACTOR_TREASURY and FACTOR_TREASURY_BLOCK, and TREASURY=on (docs/RELEASE-treasury.md)."
