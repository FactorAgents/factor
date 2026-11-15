// The Recoverable mark against the real Robinhood Chain: read only, no key, no gas. Skipped unless it is asked for, so
// `npm test` never needs the network:
//
//   FACTOR_LIVE_UPOCH=1 npx vitest run test/recoverable.live.test.ts
//
// It reads Upoch's Epoch contract as the engine does, and the ERC-8004 identity Upoch registered for its spend demo,
// agent #25946, from the identity registry; that agent must be Recoverable by Upoch workflow #5, whose executor is its
// agentWallet. Should workflow 5 ever go a week without a checkpoint, this says so, as the mark itself would.

import { describe, expect, it } from "vitest";
import { erc8004IdentityAbi } from "../src/abi/index.js";
import { viemChain } from "../src/chain/chain.js";
import { EngineDb, open } from "../src/chain/db.js";
import { IDENTITY_REGISTRY } from "../src/erc8004.js";
import { readRecoverable, Recoverable } from "../src/recoverable.js";

const LIVE = process.env.FACTOR_LIVE_UPOCH === "1";
const RPC = process.env.RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com";

describe.skipIf(!LIVE)("the Recoverable mark, on the real chain", () => {
  it("reads Upoch's workflow 5 as Recoverable, and agent #25946 Recoverable by it", { timeout: 120_000 }, async () => {
    const chain = viemChain([RPC], 4663);
    try {
      const lines: string[] = [];
      const rc = new Recoverable(readRecoverable({ RECOVERABLE: "on" }), { db: new EngineDb(open(":memory:")), chain, explorer: "https://robinhoodchain.blockscout.com", now: Date.now, log: (l) => lines.push(l) });
      console.log(`[live] ${await rc.refresh()}`);
      expect((rc.about().recoverableWorkflows as number[])).toContain(5);
      const [owner, agentWallet] = await Promise.all([
        chain.read<string>({ to: IDENTITY_REGISTRY, abi: erc8004IdentityAbi, functionName: "ownerOf", args: [25946n] }),
        chain.read<string>({ to: IDENTITY_REGISTRY, abi: erc8004IdentityAbi, functionName: "getAgentWallet", args: [25946n] }),
      ]);
      const m = rc.of({ owner: owner.toLowerCase(), agentWallet: agentWallet.toLowerCase() })!;
      console.log(`[live] #25946: ${m.line}; ${m.workflow.name}, last checkpoint ${m.workflow.lastCheckpointAt} (${m.workflow.ageDays} days), ${m.workflow.checkpoints} checkpoints, ${m.workflow.guardians} guardian(s), threshold ${m.workflow.guardianThreshold}`);
      expect(m.recoverable).toBe(true);
      expect(m.workflow.id).toBe(5);
      expect(m.workflow.link).toContainEqual({ wallet: agentWallet.toLowerCase(), is: "agentWallet", as: "executor" });
      expect(lines).toEqual([]);
    } finally {
      chain.stop();
    }
  });
});
