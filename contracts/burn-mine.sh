#!/bin/zsh
# Burns $FACTOR that the admin wallet itself holds, with the token's own burn(): the tokens are destroyed and the
# total supply falls by exactly that many. No Factor contract is involved and none can do this for the wallet:
# it is a holder burning their own tokens, and it happens only when the owner runs this.
#
#   contracts/burn-mine.sh all        every $FACTOR the admin wallet holds
#   contracts/burn-mine.sh 1000000    that many $FACTOR (a plain decimal, up to 18 places)
#
# One thing is asked for: the admin wallet's private key, at cast's own prompt (nothing shows). A burn cannot be
# undone.
#
# Steps, each printed as it starts:
#   1/3 the admin wallet's $FACTOR   2/3 the burn (the key)   3/3 the balance and the total supply read back
. "$(dirname "$0")/lib.sh"
WHAT=$1

[ -n "$WHAT" ] || die "say how much: contracts/burn-mine.sh all, or contracts/burn-mine.sh <an amount of \$FACTOR>"
step "1/3 the admin wallet's \$FACTOR"
chain_or_die
load_deployment
TOKEN=$(cast call $FACTOR_BURN_POT "token()(address)" --rpc-url "$RPC") || die "could not read the burn pot"
[ "$TOKEN" != "$ZERO" ] || die "\$FACTOR is not launched yet"
HELD=$(cast call $TOKEN "balanceOf(address)(uint256)" $FACTOR_ADMIN --rpc-url "$RPC" | num)
SUPPLY=$(cast call $TOKEN "totalSupply()(uint256)" --rpc-url "$RPC" | num)
BOUGHT=$(cast call $FACTOR_BURN_POT "openingBuyTokens()(uint256)" --rpc-url "$RPC" | num)
[ -n "$HELD" ] && [ -n "$SUPPLY" ] && [ -n "$BOUGHT" ] || die "could not read the token"
echo "  \$FACTOR $TOKEN"
echo "  the admin wallet $FACTOR_ADMIN holds $(eth $HELD) \$FACTOR (the opening buy bought $(eth $BOUGHT))"
echo "  the total supply is $(eth $SUPPLY)"
# The amount becomes wei on its digits, never through a floating point number.
if [ "$WHAT" = all ]; then
  AMOUNT=$HELD
else
  AMOUNT=$(python3 - "$WHAT" <<'PY'
import re, sys
a = sys.argv[1]
if not re.fullmatch(r"\d+(\.\d{1,18})?", a): sys.exit(1)
whole, _, frac = a.partition(".")
print(int(whole) * 10**18 + int((frac + "0" * 18)[:18]))
PY
  ) || die "not an amount: $WHAT. Say all, or a plain decimal like 1000000 or 2500.5"
fi
[ "$AMOUNT" != 0 ] || die "there is nothing to burn"
python3 -c "import sys; sys.exit(0 if int('$AMOUNT') <= int('$HELD') else 1)" \
  || die "the admin wallet holds $(eth $HELD) \$FACTOR, which is less than $(eth $AMOUNT). Nothing was sent."

step "2/3 the burn: $(eth $AMOUNT) \$FACTOR from the admin wallet, destroyed for good"
cast call $TOKEN "burn(uint256)" $AMOUNT --from $FACTOR_ADMIN --rpc-url "$RPC" > /dev/null 2>&1 \
  || die "the token would refuse this burn: $(cast call $TOKEN "burn(uint256)" $AMOUNT --from $FACTOR_ADMIN --rpc-url "$RPC" 2>&1 | tail -1 | cut -c1-160). Nothing was sent."
echo "  after it the admin wallet would hold $(eth $(python3 -c "print(int('$HELD') - int('$AMOUNT'))")) \$FACTOR and the total supply would be $(eth $(python3 -c "print(int('$SUPPLY') - int('$AMOUNT'))"))"
if [ -n "$DRY" ]; then echo; echo "DRY RUN ONLY (FACTOR_DRY is set). Nothing was sent and no key was asked for."; exit 0; fi
echo "  cast now asks for the admin wallet's private key (nothing shows as it is typed or pasted)"
# --from makes cast refuse a key that is not the admin wallet's, so no other wallet's tokens can be burned by mistake
cast send $TOKEN "burn(uint256)" $AMOUNT --from $FACTOR_ADMIN --rpc-url "$RPC" --interactive > /dev/null \
  || die "the burn did not go through. If no transaction was sent, it is safe to run this again."

step "3/3 read back from the chain"
HELD_NOW=$(cast call $TOKEN "balanceOf(address)(uint256)" $FACTOR_ADMIN --rpc-url "$RPC" | num)
SUPPLY_NOW=$(cast call $TOKEN "totalSupply()(uint256)" --rpc-url "$RPC" | num)
echo "  the admin wallet holds $(eth $HELD_NOW) \$FACTOR (it held $(eth $HELD))"
echo "  the total supply is $(eth $SUPPLY_NOW) (it was $(eth $SUPPLY))"
python3 -c "import sys; sys.exit(0 if int('$SUPPLY') - int('$SUPPLY_NOW') == int('$AMOUNT') and int('$HELD') - int('$HELD_NOW') == int('$AMOUNT') else 1)" \
  || die "the balance and the supply did not both fall by $(eth $AMOUNT). Look at the transaction before doing anything else."
echo
echo "DONE. $(eth $AMOUNT) \$FACTOR burned: the total supply fell by exactly that."
