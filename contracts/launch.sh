#!/bin/zsh
# Launches $FACTOR on Pons through the burn pot, from the admin wallet, with the opening buy inside the same
# transaction.
#
#   contracts/launch.sh
#
# One thing is asked for: the admin wallet's private key, at forge's own prompt (nothing shows). Everything else is
# read: the contracts from contracts/broadcast/factor.env (written by deploy.sh), the launch fee from Pons, the
# name, ticker, picture link, description and links from contracts/launch.json, and the opening buy as the dollars
# written there (openingBuyUsd, 30 when this was written; 0 for no opening buy) turned into ETH at Chainlink's ETH
# price at that moment. The tokens that buy gets go to the admin wallet. No contract can move them from there.
#
# Run it only once the engine has the three addresses and is running: fees start arriving with the first trade.
#
# Steps, each printed as it starts:
#   1/4 the deployment, the launch file and the opening buy   3/4 the launch (the key)
#   2/4 a dry run, with what it costs                         4/4 $FACTOR read back from the chain
#
# Two things about Pons are pinned. Its launch fee must be the launchFeeWei written in launch.json (0.0005 ETH when
# this was written), or the dry run stops. And the hash of its launch terms that the dry run saw is handed to the
# real run and into the launch itself, so if Pons changes its terms in between, the launch stops or reverts.
#
# Nothing is sent before step 3. What is fixed for good once it runs: everything in launch.json, the 3% tax, and
# where the fees go (the splitter: the admin, the burn pot and the desk's pool).
. "$(dirname "$0")/lib.sh"
# a rehearsal can point at another file; on the day it is contracts/launch.json
JSON=${FACTOR_LAUNCH_FILE:-$HERE/launch.json}
TMP=$(mktemp -t factor-launch); trap 'rm -f $TMP' EXIT

step "1/4 the deployment, the launch file and the opening buy"
chain_or_die
load_deployment
ADMIN=$FACTOR_ADMIN
TOKEN=$(cast call $FACTOR_BURN_POT "token()(address)" --rpc-url "$RPC") || die "could not read the burn pot"
[ "$TOKEN" = "$ZERO" ] || die "\$FACTOR is already launched: $TOKEN. A second launch is not possible."
[ -f "$JSON" ] || die "contracts/launch.json is missing"
python3 - "$JSON" <<'PY' || die "contracts/launch.json is not ready. Nothing was sent."
import json, sys
d = json.load(open(sys.argv[1]))
bad = [k for k in ("name", "symbol", "logo", "description", "website", "twitter") if not isinstance(d.get(k), str) or not d[k].strip()]
if bad: print("  missing:", ", ".join(bad)); sys.exit(1)
if any("REPLACE" in d[k] for k in d): print("  it still holds a REPLACE ME placeholder"); sys.exit(1)
if d["symbol"] != "FACTOR": print("  the ticker is not FACTOR"); sys.exit(1)
if not d["logo"].startswith("https://"): print("  the picture's link is not https://"); sys.exit(1)
if "Robinhood" in d["name"] + d["description"]: print("  the name or description says 'Robinhood' as one word"); sys.exit(1)
if chr(8212) in d["name"] + d["description"]: print("  the description has a long dash in it"); sys.exit(1)
if not isinstance(d.get("openingBuyUsd"), str) or not d["openingBuyUsd"].isdigit(): print("  openingBuyUsd must be the opening buy in whole dollars, as digits in quotes (\"0\" for none)"); sys.exit(1)
if not isinstance(d.get("launchFeeWei"), str) or not d["launchFeeWei"].isdigit(): print("  launchFeeWei must be Pons' launch fee in wei, as digits in quotes"); sys.exit(1)
PY
NAME=$(python3 -c "import json; print(json.load(open('$JSON'))['name'])")
OPENING_BUY_USD=$(python3 -c "import json; print(int(json.load(open('$JSON'))['openingBuyUsd']))")
LOGO=$(python3 -c "import json; print(json.load(open('$JSON'))['logo'])")
# the picture's link is written into the token and can never be changed: it must already answer with a picture
if [ "$RPC" = "$LIVE" ]; then
  KIND=$(curl -s -m 20 -o /dev/null -w '%{http_code} %{content_type}' "$LOGO")
  case "$KIND" in "200 image/"*) ;; *) die "the picture's link does not answer with a picture yet ($LOGO gave: $KIND). Nothing was sent." ;; esac
  PICTURE="its picture's link answers with a picture"
else
  PICTURE="its picture's link is not checked on a fork"
fi
FEE=$(cast call $FACTORY "launchFee()(uint256)" --rpc-url "$RPC" | num) || die "could not read the launch fee"
ROUND=$(cast call $ETH_USD_FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$RPC") || die "could not read the ETH price from Chainlink"
USD=$(echo "$ROUND" | sed -n 2p | num); PRICED=$(echo "$ROUND" | sed -n 4p | num)
python3 -c "import sys; sys.exit(0 if 10000000000 < int('$USD') < 100000000000000 else 1)" || die "the ETH price read from Chainlink does not look right ($USD)"
if [ "$RPC" = "$LIVE" ]; then
  python3 -c "import sys, time; sys.exit(0 if time.time() - int('$PRICED') < 86400 else 1)" || die "Chainlink's ETH price was last updated over a day ago, so the opening buy cannot be sized from it"
fi
# whole numbers only: dollars times 10^26, over the price with its 8 decimals, is wei
OPENING_BUY=$(python3 -c "print($OPENING_BUY_USD * 10**26 // int('$USD'))")
BAL=$(cast balance $ADMIN --rpc-url "$RPC")
echo "  burn pot $FACTOR_BURN_POT, desk $FACTOR_DESK, splitter $FACTOR_SPLITTER"
echo "  admin wallet $ADMIN holds $(eth $BAL) ETH"
echo "  $NAME (\$FACTOR)  $LOGO"
echo "  $PICTURE"
echo "  launch fee $(eth $FEE) ETH; opening buy \$$OPENING_BUY_USD = $(eth $OPENING_BUY) ETH at \$$(python3 -c "p=int('$USD'); print(f'{p // 10**8:,}.{p % 10**8 // 10**6:02d}')") an ETH"

step "2/4 a dry run: the whole launch against the chain as it is now, nothing sent"
export FACTOR_OPENING_BUY_WEI=$OPENING_BUY FACTOR_LAUNCH_JSON="$(cat $JSON)"
forge script script/Launch.s.sol --rpc-url "$RPC" --sender $ADMIN > $TMP 2>&1 || { tail -15 $TMP; die "the dry run failed, so nothing was sent"; }
read_estimate $TMP
# Pons' launch terms as the dry run saw them: the real run must see the same, and the launch carries them
ECON=$(grep "FACTOR_EXPECTED_ECONOMICS=" $TMP | tail -1 | sed 's/.*FACTOR_EXPECTED_ECONOMICS=//')
[[ "$ECON" =~ '^0x[0-9a-fA-F]{64}$' ]] || { tail -15 $TMP; die "the dry run did not say what Pons' launch terms are, so nothing was sent"; }
export FACTOR_EXPECTED_ECONOMICS=$ECON
echo "  Pons' launch terms pinned: $ECON"
ALL=$(python3 -c "print(int('$FEE') + int('$OPENING_BUY') + int('$NEED_WEI'))")
grep -E "Opening buy:" $TMP | sed 's/^ */  /'
echo "  one transaction, about $GAS gas at most; in all the wallet needs $(eth $ALL) ETH (fee + opening buy + up to $NEED ETH of gas)"
if [ -n "$DRY" ]; then
  python3 -c "import sys; sys.exit(0 if int('$BAL') >= int('$ALL') else 1)" || echo "  note: the admin wallet holds $(eth $BAL) ETH; the launch needs $(eth $ALL) ETH"
  echo; echo "DRY RUN ONLY (FACTOR_DRY is set). Nothing was sent and no key was asked for."; exit 0
fi
python3 -c "import sys; sys.exit(0 if int('$BAL') >= int('$ALL') else 1)" || die "the admin wallet holds $(eth $BAL) ETH and the launch needs $(eth $ALL) ETH. Nothing was sent."

step "3/4 the launch: forge now asks for the admin wallet's private key (nothing shows as it is typed or pasted)"
forge script script/Launch.s.sol --rpc-url "$RPC" --broadcast --interactive --sender $ADMIN \
  || die "the launch did not go through. Read the lines above; if no transaction was sent, it is safe to run this again."

step "4/4 \$FACTOR, read back from the chain"
TOKEN=$(cast call $FACTOR_BURN_POT "token()(address)" --rpc-url "$RPC")
[ "$TOKEN" != "$ZERO" ] || die "the burn pot has no token: the launch transaction did not go through"
forge script script/Launch.s.sol --sig "check()" --rpc-url "$RPC" > $TMP 2>&1 || { tail -15 $TMP; die "\$FACTOR is launched ($TOKEN) but it does not read back as meant"; }
grep -E "OK:|opening buy" $TMP | sed 's/^ */  /'
grep -v "^FACTOR_TOKEN=" "$OUT" > $TMP; echo "FACTOR_TOKEN=$TOKEN" >> $TMP; cp $TMP "$OUT"
echo "  written to $OUT"
echo
echo "DONE. \$FACTOR is live: $TOKEN"
