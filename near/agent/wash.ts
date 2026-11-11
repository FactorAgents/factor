// A wash job, on purpose: the agent pays itself through an account it controls, to see the credit report leave
// it out. The "customer" is a sub-account the agent made (client.<agent>), funded by the agent. The desk lets it
// through (it cannot know who runs an account); the report does not count it.
//
//   node agent/wash.ts      (creates client.<agent> on first run, with the agent's key)

import { call, near, signer, sha256, accessKeys, DESK, loadKey } from "../lib/near.ts";
import { step, link } from "./say.ts";
import { KeyPair } from "near-api-js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT = process.env.AGENT || "factor-scout.testnet";
const SELF = `client.${AGENT}`;

async function ensureSubAccount() {
  if ((await accessKeys(SELF)).length) return;
  const kp = KeyPair.fromRandom("ed25519");
  const agent = signer(AGENT);
  await agent.createSubAccount({ accountOrPrefix: SELF, publicKey: kp.getPublicKey().toString(), nearToTransfer: near("0.6") });
  const dir = join(homedir(), ".near-credentials", "testnet");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${SELF}.json`);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ account_id: SELF, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  step(AGENT, `made ${SELF} and funded it`);
}

async function main() {
  await ensureSubAccount();
  loadKey(SELF);
  const self = signer(SELF);
  const agent = signer(AGENT);
  const price = near("0.3");
  const locked = await call(self, DESK, "lock", { agent: AGENT, price: price.toString(), due_ms: String(Date.now() + 30 * 60_000), allow_advance: false, brief: sha256("wash"), note: null }, { deposit: price + near("0.05") });
  const id = String(locked.value);
  step(SELF, `locks job #${id} for ${AGENT}, its own maker`);
  link(locked);
  const t1 = await call(agent, DESK, "accept_job", { id });
  const t2 = await call(agent, DESK, "deliver", { id, proof: sha256("nothing") });
  const t3 = await call(self, DESK, "accept", { id });
  step(AGENT, `takes, delivers and is paid for job #${id}: the desk pays it, the report will not count it`);
  for (const t of [t1, t2, t3]) link(t);
}

main().catch((e) => {
  console.error(`stopped: ${e?.message ?? e}`);
  process.exit(1);
});
