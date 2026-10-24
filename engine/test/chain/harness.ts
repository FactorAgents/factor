// What the engine's tests share: an engine on the made-up chain (fake.ts), on an in-memory database, with no loops
// running (a test runs each pass itself) and a clock that follows the chain's.

import type Database from "better-sqlite3";
import type { EngineMode, Env } from "../../src/chain/config.js";
import { EngineDb, open } from "../../src/chain/db.js";
import { Engine } from "../../src/engine.js";
import type { HouseSigner } from "../../src/house/house.js";
import type { Provider } from "../../src/verified.js";
import { A, FakeChain } from "./fake.js";

// anvil's first built-in test key: public, printed by anvil itself, worth nothing anywhere. Live mode will not
// start without a key in the environment; the tests' sends go through the made-up chain's own wallet all the same.
export const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export function env(mode: EngineMode, more: Env = {}): Env {
  return {
    ...(mode === "live" ? { BOT_PRIVATE_KEY: TEST_KEY } : {}),
    ENGINE_MODE: mode,
    FACTOR_SPLITTER: A.splitter,
    FACTOR_BURN_POT: A.burnPot,
    FACTOR_DESK: A.desk,
    FACTOR_DEPLOY_BLOCK: "5000",
    FACTOR_RPC_URLS: "http://node.invalid",
    ENGINE_CONFIRMATIONS: "0",
    ENGINE_RECEIPT_WAIT_MS: "50",
    ENGINE_API_CACHE_MS: "0",
    ...more,
  };
}

export interface Rig {
  engine: Engine;
  chain: FakeChain;
  sqlite: Database.Database;
  db: EngineDb;
  lines: string[];
  wall: { extra: number }; // ms the wall clock runs ahead of the chain's
  // a watch pass, then an act pass: what one turn of the engine's two chain loops does
  turn(): Promise<void>;
}

export async function rig(mode: EngineMode, o: { chain?: FakeChain; more?: Env; sqlite?: Database.Database; signer?: boolean; houseSigners?: (name: string) => HouseSigner; verifiedProviders?: Provider[] } = {}): Promise<Rig> {
  const chain = o.chain ?? new FakeChain();
  const wall = { extra: 0 };
  const now = () => chain.time * 1000 + wall.extra;
  const sqlite = o.sqlite ?? open(":memory:");
  const lines: string[] = [];
  const engine = new Engine(sqlite, {
    env: env(mode, o.more),
    chain,
    signer: o.signer === false ? null : chain.signer(),
    log: (l) => lines.push(l),
    now,
    pollMs: 5,
    manual: true,
    ...(o.houseSigners ? { houseSigners: o.houseSigners } : {}),
    ...(o.verifiedProviders ? { verifiedProviders: o.verifiedProviders } : {}),
  });
  engine.start();
  await engine.ready();
  return {
    engine,
    chain,
    sqlite,
    db: new EngineDb(sqlite, now),
    lines,
    wall,
    async turn() {
      await engine.watchOnce();
      await engine.actOnce();
    },
  };
}

export const wallet = (n: number): string => `0x${n.toString(16).padStart(40, "0")}`;
