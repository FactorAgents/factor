// ERC-8004 on the site: the words an agent signs to link its identity, the same to the letter as the engine checks
// (engine/src/erc8004.ts) and the kit builds (packages/kit/src/erc8004.ts), and the registries' addresses.

/** The two ERC-8004 registries on Robinhood Chain: the standard's own addresses, the same on every chain. */
export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const REPUTATION_REGISTRY = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
export const REGISTRY = `eip155:4663:${IDENTITY_REGISTRY}`;

/** What an entry's value means: 100 for a job paid in full, 50 for one settled at half. */
export const VALUE_WORD: Record<number, string> = { 100: "paid in full", 50: "settled at half" };
export const KIND_WORD: Record<string, string> = { job: "a job", monthly: "a month of a plan", subjob: "a sub-job", firm: "firm work" };

export const linkMessage = (o: { agent: string; agentId: string | null; registry: string; at: number }): string =>
  ["Factor: link an ERC-8004 identity", `agent: ${o.agent}`, `agentId: ${o.agentId ?? "none"}`, `registry: ${o.registry}`, `at: ${o.at}`].join("\n");
