#!/usr/bin/env bash
# Your own Factor desk on NEAR testnet, in one command:
#
#   PREFIX=yourname ./scripts/testnet-setup.sh
#
# It makes four testnet accounts with the faucet (<prefix>-desk, -client, -scout, -checker), four sub-accounts of
# the desk (the test dollar, the fee account, a compute provider and the NEAR Intents stand-in), builds and deploys
# both contracts, and writes .env.testnet so `npm run agent`, `npm run intents -- demo` and `npm run report` use
# your accounts. Keys go to ~/.near-credentials/testnet, never into this folder. Needs near-cli-rs and cargo-near.
set -euo pipefail
cd "$(dirname "$0")/.."

P="${PREFIX:?set PREFIX, for example PREFIX=alice}"
DESK="$P-desk.testnet"
TUSD="tusd.$DESK"
FEES="fees.$DESK"
COMPUTE="compute.$DESK"
STANDIN="intents-standin.$DESK"
NET=(network-config testnet)

faucet() { near account create-account sponsor-by-faucet-service "$1" autogenerate-new-keypair save-to-legacy-keychain "${NET[@]}" create; }
sub() { near account create-account fund-myself "$1" "$2 NEAR" autogenerate-new-keypair save-to-legacy-keychain sign-as "$DESK" "${NET[@]}" sign-with-legacy-keychain send; }
exists() { near account view-account-summary "$1" "${NET[@]}" now >/dev/null 2>&1; }

echo "== accounts"
for a in "$DESK" "$P-client.testnet" "$P-scout.testnet" "$P-checker.testnet"; do exists "$a" || faucet "$a"; done
exists "$TUSD" || sub "$TUSD" 3
for a in "$FEES" "$COMPUTE" "$STANDIN"; do exists "$a" || sub "$a" 0.2; done

echo "== build"
(cd desk && cargo near build non-reproducible-wasm)
(cd test-token && cargo near build non-reproducible-wasm)

echo "== deploy"
near contract deploy "$TUSD" use-file target/near/factor_test_token/factor_test_token.wasm \
  with-init-call new json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${NET[@]}" sign-with-legacy-keychain send
# testnet windows, short so every rule can be watched: review 20 minutes, grace 10 minutes, shortest job 5 minutes
near contract deploy "$DESK" use-file target/near/factor_desk/factor_desk.wasm \
  with-init-call new json-args "{\"fee_account\":\"$FEES\",\"fee_bps\":200,\"review_ms\":\"1200000\",\"grace_ms\":\"600000\",\"min_duration_ms\":\"300000\",\"min_near\":\"10000000000000000000000\",\"tokens\":[{\"token\":\"$TUSD\",\"min_amount\":\"1000000\"}]}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${NET[@]}" sign-with-legacy-keychain send

echo "== storage on the test dollar"
for a in "$DESK" "$FEES" "$P-client.testnet" "$P-scout.testnet" "$P-checker.testnet" "$STANDIN"; do
  near contract call-function as-transaction "$TUSD" storage_deposit json-args "{\"account_id\":\"$a\",\"registration_only\":true}" \
    prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$DESK" "${NET[@]}" sign-with-legacy-keychain send
done

cat > .env.testnet <<EOF
DESK=$DESK
TEST_DOLLAR=$TUSD
CUSTOMER=$P-client.testnet
AGENT=$P-scout.testnet
CHECKER=$P-checker.testnet
COMPUTE=$COMPUTE
INTENTS_STANDIN=$STANDIN
EOF
echo "== done: .env.testnet written. Next: npm run agent"
