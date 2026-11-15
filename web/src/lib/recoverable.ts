// The Recoverable mark with Upoch on the site (engine/src/recoverable.ts): the shapes the engine answers in, and the few
// words the pages share. Every figure is the engine's, read from Upoch's Epoch contract: nothing is worked out here.

/** One Upoch workflow linked to an agent, with the four conditions and the evidence for them. */
export interface RecoveryWorkflow {
  id: number;
  name: string;
  recoverable: boolean;
  link: { wallet: string; is: "owner" | "agentWallet"; as: "owner" | "executor" }[];
  active: boolean;
  status: "active" | "paused" | "other";
  recent: boolean;
  lastCheckpointAt: string | null;
  ageDays: number | null;
  checkpoints: number;
  guardian: boolean;
  guardians: number;
  guardianThreshold: number;
  timelockSeconds: number;
  why: string[];
}

/** An agent's mark and its evidence: on its credit report ("recovery") and its desk page ("recoverable"). */
export interface Recovery {
  recoverable: boolean;
  source: "upoch";
  line: string;
  workflow: RecoveryWorkflow;
  workflows: RecoveryWorkflow[];
  rule: { recentDays: number; text: string };
  contract: string;
  contractUrl: string | null;
  readAt: string;
  /** on a desk agent's page: the ERC-8004 identity it is marked by */
  agentId?: string;
}

/** The short line under the mark, the same wherever it shows. */
export const RECOVERABLE_WORDS = "Recent on-chain checkpoints and a guardian who can restore it, on Upoch.";

/** How long ago, in plain words: "40 minutes ago", "5 hours ago", "2 days ago". */
export function agoWords(iso: string | null, now = Date.now()): string {
  if (!iso) return "none yet";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 3600) { const m = Math.max(1, Math.round(s / 60)); return `${m} minute${m === 1 ? "" : "s"} ago`; }
  if (s < 2 * 86_400) { const h = Math.round(s / 3600); return `${h} hour${h === 1 ? "" : "s"} ago`; }
  const d = Math.round(s / 86_400);
  return `${d} days ago`;
}

/** How a workflow is linked to the agent, in words. */
export const linkWords = (w: RecoveryWorkflow): string =>
  w.link.map((l) => `its ${l.is === "agentWallet" ? "agentWallet" : "owner"} is the workflow's ${l.as === "owner" ? "owner" : "executor"}`).join("; ");
