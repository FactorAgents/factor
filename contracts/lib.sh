# Shared by the scripts in this folder. Sourced, never run.
#
# Everything here is public: addresses, the node's address, numbers read from the chain. The one secret any of the
# scripts needs is the wallet's key, and that is typed or pasted at forge's or cast's own prompt, where nothing
# shows. It is never an argument, never in a file, never in the environment and never in the shell's history.
export PATH="$HOME/.foundry/bin:$PATH"
HERE=$(cd "$(dirname "$0")" && pwd); cd "$HERE"
LIVE=https://rpc.mainnet.chain.robinhood.com
# A rehearsal points FACTOR_RPC at a local fork. On the day nobody sets anything.
RPC=${FACTOR_RPC:-$LIVE}
FACTORY=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
ETH_USD_FEED=0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9
ZERO=0x0000000000000000000000000000000000000000
[ "$RPC" = "$LIVE" ] && OUT="$HERE/broadcast/factor.env" || OUT="$HERE/broadcast/factor.fork.env"
# FACTOR_DRY=1 stops every script just before it would ask for the key: everything is read and checked, and the dry
# run is made, but nothing is sent.
DRY=${FACTOR_DRY:-}

step() { echo; echo "== $1"; }
die() { echo; echo "STOPPED: $1"; exit 1; }
num() { cut -d' ' -f1; }
low() { echo "$1" | tr A-Z a-z; }
eth() { python3 -c "w=int('$1'); print(f'{w // 10**18}.{w % 10**18:018d}'.rstrip('0').rstrip('.') or '0')"; }
val() { grep "^$1=" "$OUT" 2>/dev/null | tail -1 | cut -d= -f2; }
is_address() { [[ "$1" =~ '^0x[0-9a-fA-F]{40}$' ]]; }
has_code() { [ "$(cast code "$1" --rpc-url "$RPC")" != "0x" ]; }

chain_or_die() {
  local chain
  chain=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || die "the node at $RPC did not answer"
  [ "$chain" = 4663 ] || die "this is chain $chain, not Robinhood Chain (4663)"
  echo "  Robinhood Chain (4663) at $RPC"
}

# The addresses, from the file deploy.sh wrote, exported under the names the forge scripts read.
load_deployment() {
  [ -f "$OUT" ] || die "no deployment found in $OUT. Run contracts/deploy.sh first."
  local name
  for name in FACTOR_ADMIN FACTOR_GATEWAY FACTOR_BURN_POT FACTOR_DESK FACTOR_SPLITTER FACTOR_ACCOUNTS; do
    local v=$(val $name)
    is_address "$v" || die "$OUT has no $name"
    export $name=$v
  done
  has_code $FACTOR_SPLITTER || die "there is no contract at the splitter's address $FACTOR_SPLITTER on this chain"
}

# Dollars for an amount of wei, at Chainlink's ETH price on this chain. Whole numbers only.
usd() {
  local price
  price=$(cast call $ETH_USD_FEED "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$RPC" 2>/dev/null | sed -n 2p | num) || { echo "?"; return; }
  python3 -c "c=int('$1')*int('$price')//10**24; print(f'{c // 100}.{c % 100:02d}')"
}

# What a dry run printed: the gas it would use and the most ETH forge would want in the wallet for it.
read_estimate() {
  GAS=$(grep "Estimated total gas used for script" "$1" | awk '{print $NF}')
  NEED=$(grep "Estimated amount required" "$1" | awk '{print $(NF-1)}')
  [ -n "$GAS" ] && [ -n "$NEED" ] || { tail -15 "$1"; die "the dry run gave no estimate, so nothing was sent"; }
  NEED_WEI=$(cast to-wei "$NEED" ether)
}
