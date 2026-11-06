// Factor Copilot on the site (engine/src/copilot.ts): the shape of a reply, the browser's own check of a prepared action
// before any wallet sees it, and signing it with the site's existing wallet code. Copilot prepares; the visitor's own
// wallet or passkey account signs every step, here, through the same calls the hire form, a job's page, the bounty form
// and the stage form use.
//
// The check is the browser's, not the engine's word for it: each call is decoded from its own bytes with the contracts'
// ABIs, its address must be one of Factor's contracts as this page knows them, its function one Copilot may prepare,
// the agent the one the card names, the values together the card's total and under the most one action may move, and
// the words sent after (a bounty's task, the stages' terms) must hash to what the call posts.
import { decodeFunctionData, keccak256, toHex, type Abi, type Hex } from "viem";
import { factorBountyAbi } from "./abi/FactorBounty";
import { factorDeskAbi } from "./abi/FactorDesk";
import { factorGuaranteeAbi } from "./abi/FactorGuarantee";
import { factorMilestonesAbi } from "./abi/FactorMilestones";
import { CHAIN } from "./chain";
import { briefMessage, lockedJob, Refusal, send } from "./desk";
import { hireWithCover, sendGuarantee } from "./guarantees";
import { postedBounty, sendBounty, sendTask } from "./bounties";
import { postedPlan, sendMilestones, sendTerms } from "./milestones";
import { signText, type Provider } from "./wallet";

export interface PreparedCall { to: string; contract: "desk" | "guarantee" | "bounty" | "milestones"; fn: string; data: Hex; value: string; does: string }
export interface Prepared {
  id: string;
  kind: "hire" | "hire_cover" | "accept" | "accept_stage" | "bounty" | "milestones" | "back";
  title: string;
  lines: [string, string][];
  calls: PreparedCall[];
  after: { brief?: { title: string; brief: string }; task?: string; terms?: string; bind?: boolean } | null;
  totalWei: string;
  agent: { name: string; address: string } | null;
  job: number | null;
  chainId: number;
  expiresAt: string;
  checked: string[];
}
export interface Reply {
  text: string;
  kind: "question" | "answer" | "action" | "refusal";
  facts: string[];
  agents: { name: string; score: number; settled: number; priceEth: string; reasons: string[] }[];
  action: Prepared | null;
  follow: number | null;
  choices: string[];
}
export interface Answer { v: 1; conversation: string; written: "model" | "plain"; model: string | null; intent: string | null; reply: Reply }

/** Factor's contracts as this page knows them, and the most one action may move: from the server, never from a reply. */
export interface Known { desk: string | null; guarantee: string | null; bounty: string | null; milestones: string | null; mostEth: string }

const ABIS: Record<PreparedCall["contract"], Abi> = { desk: factorDeskAbi as Abi, guarantee: factorGuaranteeAbi as Abi, bounty: factorBountyAbi as Abi, milestones: factorMilestonesAbi as Abi };
const ALLOWED: Record<PreparedCall["contract"], string[]> = { desk: ["lock", "accept"], guarantee: ["reserve", "addBond"], bounty: ["post"], milestones: ["post", "accept"] };
const KIND_CALLS: Record<Prepared["kind"], string[]> = {
  hire: ["desk.lock"], hire_cover: ["guarantee.reserve", "desk.lock"], accept: ["desk.accept"], accept_stage: ["milestones.accept"],
  bounty: ["bounty.post"], milestones: ["milestones.post"], back: ["guarantee.addBond"],
};
const weiOf = (eth: string): bigint => { const [w, f = ""] = eth.split("."); return BigInt(w || "0") * 10n ** 18n + BigInt(f.padEnd(18, "0").slice(0, 18)); };
export const ethFull = (wei: bigint): string => { const w = wei / 10n ** 18n; const f = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 8).replace(/0+$/, ""); return f ? `${w}.${f}` : `${w}`; };

export interface Checked { calls: { contract: PreparedCall["contract"]; fn: string; args: readonly unknown[]; value: bigint }[]; total: bigint; said: string }

/** The browser's own check of a prepared action. Throws, in words, when anything does not hold; nothing is then signed. */
export function check(p: Prepared, known: Known, now = Date.now()): Checked {
  const no = (why: string): never => { throw new Refusal(`Not signed: ${why}. Ask Copilot to prepare it again.`); };
  if (Date.parse(p.expiresAt) < now) no("the card is older than 15 minutes");
  if (p.chainId !== CHAIN.id) no("it is not for Robinhood Chain");
  const shape = p.calls.map((c) => `${c.contract}.${c.fn}`).join(",");
  if (shape !== KIND_CALLS[p.kind]?.join(",")) no("its calls are not the ones this kind of card makes");
  let total = 0n;
  const calls: Checked["calls"] = [];
  for (const c of p.calls) {
    const to = known[c.contract];
    if (!to || c.to.toLowerCase() !== to.toLowerCase()) no(`a call goes to ${c.to}, which is not Factor's ${c.contract}`);
    let d: { functionName: string; args?: readonly unknown[] };
    try { d = decodeFunctionData({ abi: ABIS[c.contract], data: c.data }); } catch { return no("a call's bytes are not a call of Factor's contract"); }
    if (d.functionName !== c.fn || !ALLOWED[c.contract].includes(d.functionName)) no(`${d.functionName} is not a call Copilot prepares`);
    if (!/^\d{1,30}$/.test(c.value)) no("a value is not an amount");
    const value = BigInt(c.value);
    const a = d.args ?? [];
    const agentArg = d.functionName === "lock" || d.functionName === "reserve" || d.functionName === "addBond" || (c.contract === "milestones" && d.functionName === "post") ? String(a[0]).toLowerCase() : null;
    if (agentArg && (!p.agent || agentArg !== p.agent.address.toLowerCase())) no("the agent in the call is not the one on the card");
    if ((d.functionName === "lock" && a[2] !== false) || (d.functionName === "reserve" && a[3] !== false) || (c.contract === "milestones" && d.functionName === "post" && a[3] !== false)) no("an early advance is turned on");
    if (d.functionName === "accept" && value !== 0n) no("accepting sends no ETH");
    if (c.contract === "bounty" && (!p.after?.task || keccak256(toHex(p.after.task)) !== a[3])) no("the task's words do not hash to what is posted");
    if (c.contract === "milestones" && d.functionName === "post" && (!p.after?.terms || keccak256(toHex(p.after.terms)) !== a[4])) no("the stages' words do not hash to what is locked");
    total += value;
    calls.push({ contract: c.contract, fn: d.functionName, args: a, value });
  }
  if (BigInt(p.totalWei) !== total) no("the card's total is not what its calls send");
  if (total > weiOf(known.mostEth)) no(`it sends more than the ${known.mostEth} ETH one action may move`);
  return { calls, total, said: `Checked in your browser: ${calls.map((c) => `${c.fn} on Factor's ${c.contract === "desk" ? "desk" : `${c.contract} contract`}`).join(", then ")}${total ? `, ${ethFull(total)} ETH in all` : ", no ETH"}${p.agent ? `, for ${p.agent.name}` : ""}.` };
}

export type Step = "checking" | "wallet" | "mining" | "signing" | "saving" | "reserving" | "locking" | "tying";
export interface Signed { note: string; hash: string; job: number | null; href?: string }

/** Signs a checked action with the visitor's own wallet or passkey account, through the site's existing calls. */
export async function sign(p: Prepared, known: Known, w: { provider: Provider; address: string; passkey: boolean; engineNow: () => Promise<number>; save: (path: "jobs/brief", body: Record<string, unknown>, patient: boolean) => Promise<void> }, on: (s: Step) => void): Promise<Signed> {
  const c = check(p, known);
  const from = w.address;
  const first = c.calls[0]!;
  const brief = async (job: number): Promise<string> => {
    if (!p.after?.brief) return "";
    try {
      on("signing");
      const at = await w.engineNow();
      const signature = await signText(w.provider, briefMessage(job, p.after.brief.title, p.after.brief.brief, at), from);
      on("saving");
      await w.save("jobs/brief", { job, title: p.after.brief.title, brief: p.after.brief.brief, at, signature }, true);
      return " Its brief is signed, so the agent has it.";
    } catch {
      return " Its brief was not signed: add it on the job's page.";
    }
  };
  if (p.kind === "hire") {
    const s = await send(w.provider, known.desk!, from, "lock", first.args, { value: first.value, on });
    const job = lockedJob(s.receipt, known.desk!);
    const more = job !== null ? await brief(job) : "";
    return { note: job !== null ? `Locked as job ${String(job).padStart(4, "0")}.${more}` : "The payment is locked.", hash: s.hash, job, ...(job !== null ? { href: `/jobs/${String(job).padStart(4, "0")}` } : {}) };
  }
  if (p.kind === "hire_cover") {
    const [agent, price, dueAt, , cover] = first.args as [string, bigint, bigint, boolean, bigint];
    const r = await hireWithCover(w.provider, { passkey: w.passkey, guarantee: known.guarantee!, desk: known.desk!, from, agent, price, dueAt: Number(dueAt), early: false, cover, on });
    const more = r.job !== null ? await brief(r.job) : "";
    return { note: `${r.job !== null ? `Locked as job ${String(r.job).padStart(4, "0")}, with ${ethFull(cover)} ETH of cover.` : "Locked, with cover."}${r.note ? ` ${r.note}` : ""}${more}`, hash: r.lockTx, job: r.job, ...(r.job !== null ? { href: `/jobs/${String(r.job).padStart(4, "0")}` } : {}) };
  }
  if (p.kind === "accept") {
    const s = await send(w.provider, known.desk!, from, "accept", first.args, { on });
    return { note: `Accepted. The desk paid ${p.agent?.name ?? "the agent"}.`, hash: s.hash, job: p.job };
  }
  if (p.kind === "accept_stage") {
    const s = await sendMilestones(w.provider, { contract: known.milestones!, from, fn: "accept", args: first.args, on });
    return { note: `Accepted. The desk paid ${p.agent?.name ?? "the agent"}, and the next stage, if there is one, is locked for it.`, hash: s.hash, job: p.job };
  }
  if (p.kind === "bounty") {
    const s = await sendBounty(w.provider, { bounty: known.bounty!, from, fn: "post", args: first.args, value: first.value, on });
    const id = postedBounty(s.receipt, known.bounty!);
    let more = "";
    if (id !== null) { try { on("saving"); await sendTask(id, p.after!.task!); more = " Its words are on its page."; } catch { more = " Its words did not reach Factor: add them on its page."; } }
    return { note: `Bounty ${id ?? ""} is posted.${more}`.replace("  ", " "), hash: s.hash, job: null, ...(id !== null ? { href: `/bounties/${id}` } : {}) };
  }
  if (p.kind === "milestones") {
    const s = await sendMilestones(w.provider, { contract: known.milestones!, from, fn: "post", args: first.args, value: first.value, on });
    const posted = postedPlan(s.receipt, known.milestones!);
    let more = "";
    if (posted) { try { on("saving"); await sendTerms(posted.id, p.after!.terms!); more = " The stages' words are on its page."; } catch { more = " The stages' words did not reach Factor: add them on the job's page."; } }
    const job = posted?.job ?? null;
    return { note: `Locked in stages${job !== null ? `: stage 1 is job ${String(job).padStart(4, "0")}` : ""}.${more}`, hash: s.hash, job, ...(job !== null ? { href: `/jobs/${String(job).padStart(4, "0")}` } : {}) };
  }
  const s = await sendGuarantee(w.provider, { guarantee: known.guarantee!, from, fn: "addBond", args: first.args, value: first.value, on });
  return { note: `Added ${ethFull(first.value)} ETH to ${p.agent?.name ?? "the agent"}'s guarantee bond.`, hash: s.hash, job: null };
}

/** Where a job stands, in the chat's words: one line for each step it reached. */
export const STEP_WORD: Record<string, string> = {
  locked: "Locked: the payment is held by the desk, and the agent is at work.",
  advanced: "Locked, and the agent drew an advance on it: it is at work.",
  delivered: "Delivered: it waits for you to accept. Say \"accept it\" to release the payment.",
  settled: "Paid: the desk paid the agent. Done.",
  half: "Settled at half.",
  declined: "Declined by the agent: you have it all back.",
  refunded: "Refunded: it was not delivered in time.",
};

/** Messages a visitor can try with one press. */
export const TRIES = ["I need a price sheet of ETH, NVDA and TSLA by tomorrow", "Where is my latest job?", "What is report-lead's score?", "Post a bounty for a logo"];
