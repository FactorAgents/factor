#!/bin/zsh
# Deploys the three contracts of Factor from the admin wallet, and with them the maker of accounts for people
# without a wallet, then reads the deployment back from the chain and checks every wire.
#
#   contracts/deploy.sh <the admin wallet's address> <the gateway wallet's address>
#
# One thing is asked for: the admin wallet's private key, typed or pasted at forge's own prompt (nothing shows).
# The arguments are addresses, which are public.
#   the admin wallet  deploys; receives 70% of the fees; launches $FACTOR. It is fixed in the contracts for good,
#                     and it has no other power: it cannot change the split, stop a burn or move the burn's ETH.
#
# Steps, each printed as it starts:
#   1/4 the chain and the wallets        3/4 the deploy (the key)
#   2/4 a dry run, with what it costs    4/4 the check, and the addresses written to contracts/broadcast/factor.env
#
# The addresses written down are the ones forge recorded when it sent the deploy, read back from the chain. The dry
# run's addresses are only compared with them: if the admin wallet's nonce moved in between they differ, which is
# said and is not a failure.
#
# Nothing is sent before step 3, and a failed step stops the script. Nothing is launched by this: the token comes
# from contracts/launch.sh, and only after the engine has been given these addresses.
. "$(dirname "$0")/lib.sh"
ADMIN=$1
GATEWAY=$2
TMP=$(mktemp -t factor-deploy); trap 'rm -f $TMP' EXIT
NAMES=(FACTOR_BURN_POT FACTOR_DESK FACTOR_SPLITTER FACTOR_ACCOUNTS)
# where forge writes down what it sent (a dry run goes to a folder of its own beside it)
RECORD="$HERE/broadcast/Deploy.s.sol/4663/run-latest.json"

# The four addresses out of forge's record of the deploy, as NAME=address lines. Fails unless the record is exactly
# the four contracts, each created once, all from the admin wallet.
read_record() {
  python3 - "$RECORD" "$ADMIN" <<'PY'
import json, sys
want = {"FactorBurnPot": "FACTOR_BURN_POT", "FactorDesk": "FACTOR_DESK", "FactorSplitter": "FACTOR_SPLITTER", "FactorAccounts": "FACTOR_ACCOUNTS"}
try: txs = json.load(open(sys.argv[1]))["transactions"]
except Exception: sys.exit(1)
if len(txs) != len(want) or sorted(str(t.get("contractName")) for t in txs) != sorted(want): sys.exit(1)
for t in txs:
    if t.get("transactionType") != "CREATE" or str((t.get("transaction") or {}).get("from")).lower() != sys.argv[2].lower(): sys.exit(1)
    print(f'{want[t["contractName"]]}={t.get("contractAddress")}')
PY
}

is_address "$ADMIN" && is_address "$GATEWAY" || die "say which wallets: contracts/deploy.sh <the admin wallet's address> <the gateway wallet's address>"
[ "$(low $ADMIN)" != "$(low $GATEWAY)" ] || die "the gateway wallet must not be the admin wallet"

step "1/4 the chain and the wallets"
chain_or_die
BAL=$(cast balance $ADMIN --rpc-url "$RPC") || die "could not read the admin wallet's balance"
has_code $ADMIN && die "the admin wallet $ADMIN has code on it: the 70% pushed to it could be refused. Use a plain wallet."
echo "  admin wallet  $ADMIN  holds $(eth $BAL) ETH"
OLD=$(val FACTOR_SPLITTER)
if [ -n "$OLD" ] && has_code $OLD; then
  die "Factor is already deployed on this chain (splitter $OLD, in $OUT). Deploying twice would make a second set."
fi

step "2/4 a dry run: the whole deploy against the chain as it is now, nothing sent"
FACTOR_ADMIN=$ADMIN FACTOR_GATEWAY=$GATEWAY forge script script/Deploy.s.sol --rpc-url "$RPC" --sender $ADMIN > $TMP 2>&1 || { tail -15 $TMP; die "the dry run failed, so nothing was sent"; }
read_estimate $TMP
for name in $NAMES; do
  v=$(grep "$name=" $TMP | tail -1 | sed "s/.*$name=//")
  is_address "$v" || { tail -15 $TMP; die "the dry run did not say where $name would be"; }
  eval "$name=$v"
done
echo "  four contracts, about $GAS gas at most; forge wants up to $NEED ETH in the wallet (about \$$(usd $NEED_WEI))"
echo "  they would be at:"
echo "    burn pot   $FACTOR_BURN_POT"
echo "    desk       $FACTOR_DESK"
echo "    splitter   $FACTOR_SPLITTER"
echo "    accounts   $FACTOR_ACCOUNTS"
if [ -n "$DRY" ]; then
  python3 -c "import sys; sys.exit(0 if int('$BAL') >= int('$NEED_WEI') else 1)" || echo "  note: the admin wallet holds $(eth $BAL) ETH; the deploy needs up to $NEED ETH"
  echo; echo "DRY RUN ONLY (FACTOR_DRY is set). Nothing was sent and no key was asked for."; exit 0
fi
python3 -c "import sys; sys.exit(0 if int('$BAL') >= int('$NEED_WEI') else 1)" || die "the admin wallet holds $(eth $BAL) ETH and the deploy needs up to $NEED ETH. Nothing was sent."

step "3/4 the deploy: forge now asks for the admin wallet's private key (nothing shows as it is typed or pasted)"
BLOCK=$(cast block-number --rpc-url "$RPC")
FACTOR_ADMIN=$ADMIN FACTOR_GATEWAY=$GATEWAY forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --interactive --sender $ADMIN \
  || die "the deploy did not go through. Read the lines above. If some of the four were sent and not the others, do not launch: say so and start again with a fresh admin wallet nonce in mind."

step "4/4 the check: the addresses forge recorded, and everything read back from the chain"
# forge's record must be this deploy's: written after the dry run of this very run
[ -f "$RECORD" ] && [ "$RECORD" -nt $TMP ] && SENT=$(read_record) \
  || die "the deploy was sent, but forge's record of it ($RECORD) is missing or is not this deploy's. The contracts are on the chain: do NOT deploy again. Find the four addresses in the lines above or in the admin wallet's transactions."
echo "  deployed at:"
echo "$SENT" | sed 's/^/    /'
for name in $NAMES; do
  v=$(echo "$SENT" | grep "^$name=" | cut -d= -f2)
  is_address "$v" || die "forge's record does not say where $name is. The contracts are on the chain: do NOT deploy again."
  v=$(cast to-check-sum-address $v)
  [ "$(low $v)" = "$(low ${(P)name})" ] \
    || echo "  note: $name is at $v, not at ${(P)name} where the dry run put it: the admin wallet's nonce moved between the dry run and the deploy. The deployed address is the one used."
  has_code $v || die "there is no contract at $v, where forge recorded $name. Do not launch, and do not deploy again before looking at the admin wallet's transactions."
  eval "$name=$v"
done
export FACTOR_ADMIN=$ADMIN FACTOR_GATEWAY=$GATEWAY FACTOR_BURN_POT FACTOR_DESK FACTOR_SPLITTER FACTOR_ACCOUNTS
forge script script/Deploy.s.sol --sig "check()" --rpc-url "$RPC" > $TMP 2>&1 \
  || { tail -15 $TMP; die "the contracts do not read back as meant at the addresses above. Do not launch, and do not deploy again before this is understood."; }
grep -E "OK:|burn pot|splitter|accounts|admin|token" $TMP | sed 's/^ */  /'
mkdir -p "$HERE/broadcast"
{
  echo "FACTOR_ADMIN=$ADMIN"
  echo "FACTOR_GATEWAY=$GATEWAY"
  echo "FACTOR_BURN_POT=$FACTOR_BURN_POT"; echo "FACTOR_DESK=$FACTOR_DESK"; echo "FACTOR_SPLITTER=$FACTOR_SPLITTER"; echo "FACTOR_ACCOUNTS=$FACTOR_ACCOUNTS"; echo "FACTOR_DEPLOY_BLOCK=$BLOCK"
} > "$OUT"
echo "  written to $OUT (FACTOR_DEPLOY_BLOCK is the block just before the deploy: start reading logs there)"
echo "  the admin wallet now holds $(eth $(cast balance $ADMIN --rpc-url "$RPC")) ETH"
echo
echo "DONE. Nothing is launched. Next: give the engine these addresses and restart it, BEFORE the token exists."
echo "Then: contracts/launch.sh"
