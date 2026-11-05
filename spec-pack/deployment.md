# Deployment

Everything here was read from the live chain on 2026-11-05 (around block 106,730,000) and is re-checked by
`verify.sh`. The machine-readable copy is `deployment.json`.

- Chain: Robinhood Chain, chain id **4663**
- Public RPC: `https://rpc.mainnet.chain.robinhood.com`
- Explorer: `https://robinhoodchain.blockscout.com`
- Source: Factor's repository at commit `713df4eca1f41ef27434a7eb8edf484a4c7cdc83`, `contracts/src`

## Which contracts the 11 tools touch

| Contract | Address | When the tools touch it |
|---|---|---|
| **FactorDesk** | `0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F` | Always. Every on-chain step ends here. |
| FactorLine | `0xc9405ca62ed1e9a4a058f404e5c1c893f7ae67c4` | Only when a job's agent is the caller's credit-line account (the kit reads `keyOf`). |
| FactorLineAccount (implementation) | `0x8f63D64ACafC6a3c956a9f3B0eFFbc438DB9a869` | Same case: draw, deliver and decline go through the agent's line account clone. |
| FactorAccounts (factory) | `0x3417A303DcB62A84965a641f894ff5803502F8FA` | Only in gasless mode (`FACTOR_GASLESS=1`). |
| FactorAccount (implementation) | `0x34a6b7A9885E57E28ec868d73652660d5e176358` | Same case: the account clone is the agent's desk address and runs the call. |

Two more addresses are fixed inside the desk. The tools never call them, but your kit should know them:

| Address | What it is |
|---|---|
| `0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79` | **FactorBurnPot**, the desk's `burnPot`. The desk pushes the 1% advance fee here on every draw. |
| `0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0` | The **compute gateway**, the desk's `gateway`. A plain address with no code. It receives a draw of kind Compute and nothing else from the desk. |

If your kit wraps only a plain wallet (no credit line, no gasless account), the desk is the only contract it sends
transactions to.

## FactorDesk

| | |
|---|---|
| Address | `0x487Eb282E9Aa56aE871c15A16C5B061b9d2faA6F` |
| Deploy transaction | `0x36e53bc2c196bccc8ed4d9fa255bc1f80500b4ea6c6a2a30824b136dfe270448` |
| Block | 88,409,808 (2026-10-14 13:40:47 UTC) |
| Deployer | `0xafA96B2F796968dA543B77E9d1a04f80321acD04` |
| Runtime code | 11,969 bytes, keccak256 `0x62f56fb1f0e0ebf6371132f36d3b8b134f6ac1913a27697cd064ee51ae90eafc` |
| Constructor `burnPot_` | `0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79` |
| Constructor `gateway_` | `0xe4314Ba4DAe5f31582ec23812d5f40287f1eFdE0` |
| Source file | `contracts/src/FactorDesk.sol`, keccak256 `0x021562f9c24222dac3a4d69d41dec28e211079ecd7e9765e99fba8057dbbcaf8` |

The constructor arguments were read from the last 64 bytes of the deploy transaction's input, and they match
`burnPot()` and `gateway()` read live.

Constants, read live (all `constant` in the source, so they cannot change):

| Name | Value | Meaning |
|---|---|---|
| `ADVANCE_MAX_BPS` | 5000 | At most half of a job's price can be advanced, all kinds together |
| `ADVANCE_FEE_BPS` | 100 | 1% of every advance, taken out of it, sent to the burn pot |
| `JOB_FEE_BPS` | 200 | 2% of the price, taken from the agent's payout when a job settles, into the pool |
| `REJECTED_BPS` | 5000 | A rejected job sends half of the price back to the customer |
| `POOL_OUT_MAX_BPS` | 8000 | At most 80% of the pool is out with agents at any time |
| `MIN_JOB` | 1000000000000000 wei | The smallest job, 0.001 ETH |
| `MIN_DUE` / `MAX_DUE` | 3600 s / 2592000 s | A due time is 1 hour to 30 days after the lock |
| `GRACE` | 43200 s | 12 hours after the due time in which a delivery still counts (marked late) |
| `REVIEW` | 86400 s | 24 hours after a delivery for the customer to accept or reject |

Live state at the time of reading (for orientation only, it moves): `jobCount` 32, `pool` 1.0994 ETH, `out` 0,
`held` 0, `poolRoom` 0.8795 ETH.

## FactorLine and FactorLineAccount (optional path)

| | FactorLine | FactorLineAccount (implementation) |
|---|---|---|
| Address | `0xc9405ca62ed1e9a4a058f404e5c1c893f7ae67c4` | `0x8f63D64ACafC6a3c956a9f3B0eFFbc438DB9a869` |
| Deploy transaction | `0x4210f983bc73edf0b870542097623488b61e42c007280cef77f98116374f400d` | made in the same transaction, by the FactorLine constructor |
| Block | 101,683,292 (2026-10-30 11:13:16 UTC) | same |
| Runtime code hash | `0x83926b11b8c0522bb06955b943bb2f9272edf6636495024cc21e6b396114b231` (8,471 bytes) | `0x7086ac2f1b2af935c98c6140d9fb3eebd24d5e5dd698cd9a9dba3328e6a7ace3` (5,974 bytes) |
| Constructor | `desk_` = the desk | none (immutables `line`, `desk` set by its creator) |
| Immutables | `desk` = the desk, `burnPot` = the burn pot, `gateway` = the gateway, `accountImplementation` = `0x8f63…a869` | `line` = `0xc940…67c4`, `desk` = the desk |

Each agent's line account is an EIP-1167 clone of the implementation, at `FactorLine.accountAddress(key)`.
Checked on a live one: `0x4Af5cbd7BaAD4AE2F09d45fd9b55bD49214b2c5F` has the 45-byte clone code pointing at
`0x8f63…a869`, and `keyOf` returns its key. This FactorLine is the address the live API names at
`GET /api/v1/lines/about`.

## FactorAccounts and FactorAccount (optional path, gasless mode)

| | FactorAccounts (factory) | FactorAccount (implementation) |
|---|---|---|
| Address | `0x3417A303DcB62A84965a641f894ff5803502F8FA` | `0x34a6b7A9885E57E28ec868d73652660d5e176358` |
| Deploy transaction | `0x147e692420dc5b03352828eaad44dacc4bb4f2dd0b682db3ede62c841c20d5c3` | made in the same transaction, by the factory constructor |
| Block | 88,409,859 (2026-10-14 13:40:53 UTC) | same |
| Runtime code hash | `0x560df7e0b37e4551c4d3047a5c2284a22e6fb9eccd0fced5c5918fd111a265b2` (1,371 bytes) | `0xb957ce9c0530ebfe458eafb7b2cd4a00bb9572c4c922ecbd9466cdea924da133` (10,012 bytes) |
| Constructor | none | none (immutable `factory` = its creator) |
| Immutables | `implementation` = `0x34a6…6358` | `factory` = `0x3417…F8FA` |

The live API names the factory at `GET /api/v1/state` as `accounts.factory`.

## FactorBurnPot

| | |
|---|---|
| Address | `0xff54EbC9c6871Fb1c5C9e03ac45250488d923F79` |
| Deploy transaction | `0x145014074b176df9a17b41e972704db4ba8b1f388981b02d504db80aefff07ea` |
| Block | 88,409,783 (2026-10-14 13:40:45 UTC) |
| Runtime code hash | `0xb186b2d260e86cd1b200eaf2843bc61a00c42a650458ec7325278fd35ba3ab60` (10,884 bytes) |

Its ABI is not in this pack: none of the 11 tools calls it. It only receives ETH from the desk.

## Compiler and build

Read from the build metadata of a clean build of the source above:

| Setting | Value |
|---|---|
| solc | `0.8.28+commit.7893614a` |
| Optimizer | enabled, 200 runs |
| EVM version | `cancun` |
| via-IR | off |
| Metadata hash | `ipfs` |
| OpenZeppelin | 5.7.0, vendored in `contracts/lib` |

**The live code is this source.** For each of the six contracts above, the locally built runtime code is
identical to `eth_getCode` byte for byte, except the immutable slots, which hold exactly the values in the tables.
The CBOR metadata at the end of the code (an IPFS hash of the compiler input, source files included) is part of
what matched, so the deployed code was built from these exact files.

## verify.sh

```
./verify.sh                          # public RPC
RPC_URL=https://your-node ./verify.sh
```

It needs only `cast` and an RPC. It checks the chain id, the six runtime code hashes, that the gateway has no
code, every immutable above, the desk's ten constants, each deploy transaction's created address and block, and the
desk's two constructor arguments. It reads only and exits non-zero on any mismatch. Its output from 2026-11-05 is
in `tests/output/verify.txt`.
