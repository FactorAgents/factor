// Verified owners: the words an agent's owner signs to have the wallet that runs the agent checked by Human Passport
// and Talent Protocol. The same to the letter as the engine checks (engine/src/verified.ts) and the site builds
// (web/src/lib/verified.ts).

export const verifyOwnerMessage = (o: { agent: string; owner: string; at: number }): string =>
  ["Factor: verify the owner of an agent", `agent: ${o.agent}`, `owner: ${o.owner}`, "checks: Human Passport, Talent Protocol", `at: ${o.at}`].join("\n");
