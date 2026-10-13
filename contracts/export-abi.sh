#!/bin/zsh
# Writes the three contracts' ABIs where the engine reads them: engine/src/abi/<name>.ts, each `as const` so viem knows
# every function and event by type. The desk's is also written where the site reads it (web/src/lib/abi), because
# the site sends the desk's calls from a visitor's wallet. Run it after any change to a contract's interface.
#
#   contracts/export-abi.sh           writes the files
#   contracts/export-abi.sh --check   writes nothing; fails if a file is not what the contracts say today
#
# Nothing here touches a chain or a key.
export PATH="$HOME/.foundry/bin:$PATH"
HERE=$(cd "$(dirname "$0")" && pwd); cd "$HERE"
OUT="$HERE/../engine/src/abi"
WEB="$HERE/../web/src/lib/abi"
mkdir -p "$OUT" "$WEB"
forge build --silent || { echo "the contracts do not build"; exit 1; }
STALE=0
for pair in FactorDesk:factorDeskAbi FactorSplitter:factorSplitterAbi FactorBurnPot:factorBurnPotAbi; do
  NAME=${pair%%:*}; CONST=${pair##*:}
  FILE="$OUT/$NAME.ts"
  NEW=$(python3 - "$HERE/out/$NAME.sol/$NAME.json" "$NAME" "$CONST" <<'PY'
import json, sys
abi = json.load(open(sys.argv[1]))["abi"]
print(f"// {sys.argv[2]}'s ABI, written by contracts/export-abi.sh from the compiled contract. Do not edit by hand.")
print(f"export const {sys.argv[3]} = " + json.dumps(abi, indent=2) + " as const;")
PY
)
  if [ "$1" = "--check" ]; then
    [ "$NEW" = "$(cat "$FILE" 2>/dev/null)" ] || { echo "stale: engine/src/abi/$NAME.ts"; STALE=1; }
    [ "$NAME" != FactorDesk ] || [ "$NEW" = "$(cat "$WEB/$NAME.ts" 2>/dev/null)" ] || { echo "stale: web/src/lib/abi/$NAME.ts"; STALE=1; }
  else
    echo "$NEW" > "$FILE"; echo "wrote engine/src/abi/$NAME.ts"
    [ "$NAME" != FactorDesk ] || { echo "$NEW" > "$WEB/$NAME.ts"; echo "wrote web/src/lib/abi/$NAME.ts"; }
  fi
done
[ $STALE = 0 ] || { echo "run contracts/export-abi.sh"; exit 1; }
[ "$1" = "--check" ] && echo "the exported ABIs are what the contracts say"
exit 0
