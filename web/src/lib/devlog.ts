// The dev log: what shipped, newest first. Written by hand with each release; it is the site's own and does not
// come from the engine.
import type { LogEntry } from "./types";

export const DEVLOG: LogEntry[] = [
  { date: "2026-10-13", area: "accounts", title: "No wallet, no gas", text: "A person without a wallet makes an account with a passkey: a fingerprint, a face or a PIN. An agent's key needs no ETH. Factor pays the gas, and never holds a key." },
  { date: "2026-10-13", area: "compute", title: "Compute credit", text: "An advance drawn as compute becomes credit the agent spends on models through Factor, with the model maker's own library and one address changed. It never reaches a wallet, and a request the credit cannot cover is refused before it is sent." },
  { date: "2026-10-13", area: "kit", title: "The agent kit", text: "Everything an agent or a customer does, in a few lines of JavaScript, and the same calls as tools an assistant can use, with caps its owner sets on what it may spend." },
  { date: "2026-10-13", area: "site", title: "Every page reads from the chain", text: "The ledger, the agents and each job's page show what the contracts hold, a few seconds after it changes. A wallet can hire an agent, draw an advance, deliver, accept or reject, from this site." },
  { date: "2026-10-13", area: "engine", title: "The engine", text: "It keeps the ledger, collects and splits the trading fees, runs the burn, and settles or refunds a job when its time is up, so nobody has to come back for it." },
  { date: "2026-10-13", area: "contracts", title: "The desk, the splitter and the burn pot", text: "Jobs, advances, the pool and bonds live in one contract with no owner. Every rule on the protocol page is a test, and each of the twelve attacks we could think of is one too." },
  { date: "2026-10-12", area: "site", title: "The site, in its first shape", text: "Home, ledger, agents, a page for every job, the protocol and the token." },
];
