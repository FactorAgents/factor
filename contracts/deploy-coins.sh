#!/bin/zsh
# Deploys the coin launcher, which lets every agent on Factor have one coin of its own, then reads it back from the
# chain and checks every wire.
#
#   contracts/deploy-coins.sh <the deploying wallet's address>
#
# One thing is asked for: that wallet's private key, typed or pasted at forge's own prompt (nothing shows). Any wallet
# can deploy it: the launcher has no owner and gives its deployer no power. It is given the desk and reads everything
# else from the chain (the burn pot, the gateway, the owner, Pons and its fee escrow). On a local fork of the chain
# (FACTOR_RPC set to it) no key is asked for: the fork's own unlocked wallet sends it.
#
# Steps, each printed as it starts:
#   1/4 the chain, the wallet and Factor           3/4 the deploy (the key)
#   2/4 a dry run, with what the deploy and one    4/4 the check, and the address written to
#       coin's launch cost                             contracts/broadcast/factor.env
#
# Nothing is sent before step 3, and a failed step stops the script.
. "$(dirname "$0")/lib.sh"
SENDER=$1
TMP=$(mktemp -t factor-coins); trap 'rm -f $TMP' EXIT
RECORD="$HERE/broadcast/DeployCoins.s.sol/4663/run-latest.json"

is_address "$SENDER" || die "say which wallet deploys it: contracts/deploy-coins.sh <the deploying wallet's address>"

step "1/4 the chain, the wallet and Factor"
chain_or_die
load_deployment
BAL=$(cast balance $SENDER --rpc-url "$RPC") || die "could not read the wallet's balance"
echo "  deploying wallet  $SENDER  holds $(eth $BAL) ETH"
echo "  desk $FACTOR_DESK, burn pot $FACTOR_BURN_POT, gateway $FACTOR_GATEWAY, owner $FACTOR_ADMIN"
OLD=$(val FACTOR_COIN_LAUNCHER)
if [ -n "$OLD" ] && has_code $OLD; then
  die "the coin launcher is already deployed on this chain ($OLD, in $OUT). Deploying twice would make a second one."
fi

step "2/4 a dry run: the deploy against the chain as it is now, nothing sent, and what a coin's launch costs"
forge script script/DeployCoins.s.sol --rpc-url "$RPC" --sender $SENDER > $TMP 2>&1 || { tail -15 $TMP; die "the dry run failed, so nothing was sent"; }
read_estimate $TMP
AT=$(grep "FACTOR_COIN_LAUNCHER=" $TMP | tail -1 | sed 's/.*FACTOR_COIN_LAUNCHER=//')
is_address "$AT" || { tail -15 $TMP; die "the dry run did not say where the launcher would be"; }
echo "  one contract, about $GAS gas at most; forge wants up to $NEED ETH in the wallet (about \$$(usd $NEED_WEI))"
echo "  it would be at $AT"
forge script script/DeployCoins.s.sol --sig "costs()" --rpc-url "$RPC" --sender $SENDER > $TMP 2>&1 || { tail -15 $TMP; die "the cost simulation failed, so nothing was sent"; }
sed -n '/gas price used/,/COIN_DEPLOY_GAS/p' $TMP | grep -v "COIN_" | sed 's/^ */  /'
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
forge script script/DeployCoins.s.sol --rpc-url "$RPC" --broadcast $SIGN --sender $SENDER \
  || die "the deploy did not go through. Read the lines above; if no transaction was sent, it is safe to run this again."

step "4/4 the check: the address forge recorded, and the launcher read back from the chain"
CHAINDIR=$(cast chain-id --rpc-url "$RPC")
RECORD="$HERE/broadcast/DeployCoins.s.sol/$CHAINDIR/run-latest.json"
[ -f "$RECORD" ] && [ "$RECORD" -nt $TMP ] || die "the deploy was sent, but forge's record of it ($RECORD) is missing. Do NOT deploy again: find the address in the lines above."
LAUNCHER=$(python3 - "$RECORD" "$SENDER" <<'PY'
import json, sys
txs = json.load(open(sys.argv[1]))["transactions"]
if len(txs) != 1 or txs[0].get("contractName") != "AgentCoinLauncher" or txs[0].get("transactionType") != "CREATE": sys.exit(1)
if str((txs[0].get("transaction") or {}).get("from")).lower() != sys.argv[2].lower(): sys.exit(1)
print(txs[0]["contractAddress"])
PY
) || die "forge's record is not this deploy's. Do NOT deploy again: find the address in the lines above."
LAUNCHER=$(cast to-check-sum-address $LAUNCHER)
has_code $LAUNCHER || die "there is no contract at $LAUNCHER, where forge recorded the launcher"
[ "$(low $LAUNCHER)" = "$(low $AT)" ] || echo "  note: it is at $LAUNCHER, not $AT where the dry run put it: the wallet's nonce moved in between. The deployed address is the one used."
export FACTOR_COIN_LAUNCHER=$LAUNCHER
forge script script/DeployCoins.s.sol --sig "check()" --rpc-url "$RPC" > $TMP 2>&1 \
  || { tail -15 $TMP; die "the launcher does not read back as meant at $LAUNCHER. Do not tell the engine about it before this is understood."; }
grep -E "OK:|launcher|desk|burn pot|gateway|owner|pons|coins" $TMP | sed 's/^ */  /'
grep -v -E "^FACTOR_COIN_LAUNCHER(_BLOCK)?=" "$OUT" > $TMP
{ echo "FACTOR_COIN_LAUNCHER=$LAUNCHER"; echo "FACTOR_COIN_LAUNCHER_BLOCK=$BLOCK"; } >> $TMP
cp $TMP "$OUT"
echo "  written to $OUT (FACTOR_COIN_LAUNCHER_BLOCK is the block just before the deploy: the engine reads coins from there)"
echo
echo "DONE. Next: give the engine FACTOR_COIN_LAUNCHER and FACTOR_COIN_LAUNCHER_BLOCK, and AGENT_COINS=on when the site is ready."
