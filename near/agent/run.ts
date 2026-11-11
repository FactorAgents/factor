// The demo, end to end on the real desk: a customer locks a job open to any agent; the agent finds it, takes it,
// draws an advance and pays for compute with it, hires a checker for part of the work after one counter-offer,
// checks what the checker delivered and pays it, delivers, and is paid; the advance and the checker are settled out
// of the payment. Every step is a real transaction; the run is saved with its hashes in demo/runs/.
//
//   node agent/run.ts            (testnet; the three accounts need keys in ~/.near-credentials/testnet)

import { mkdirSync, writeFileSync } from "node:fs";
import { DESK, call, fmtNear, near, sha256, signer, transfer, view, txLink, NETWORK } from "../lib/near.ts";
import { BRIEF, briefHash, stubModel, stubCheck, COMPUTE_PRICE, CHECKER, counterOffer, checkerAnswers } from "./work.ts";
import { say, step, link, receiptsTable, pause } from "./say.ts";

const CUSTOMER = process.env.CUSTOMER || "factor-client.testnet";
const AGENT = process.env.AGENT || "factor-scout.testnet";
const CHECKER_ID = process.env.CHECKER || "factor-checker.testnet";
const COMPUTE = process.env.COMPUTE || "compute.factor-desk.testnet";
const PRICE = near(process.env.PRICE || "2");
const MIN = 60_000;

interface Receipt {
  what: string;
  from: string;
  price: string;
  check: string;
  tx: string;
}

async function main() {
  const run: any = { network: NETWORK, desk: DESK, customer: CUSTOMER, agent: AGENT, checker: CHECKER_ID, compute: COMPUTE, started: new Date().toISOString(), steps: [] };
  const record = (name: string, s: { hash: string }, extra: object = {}) => run.steps.push({ name, hash: s.hash, link: txLink(s.hash), ...extra });
  const receipts: Receipt[] = [];
  const customer = signer(CUSTOMER);
  const agent = signer(AGENT);
  const checker = signer(CHECKER_ID);

  // 1. the customer locks a job, open to any agent
  step(CUSTOMER, `locks a job on the desk: ${fmtNear(PRICE)} NEAR, open to any agent, due in 40 minutes, advances allowed`);
  const due = Date.now() + 40 * MIN;
  const locked = await call(customer, DESK, "lock", { agent: null, price: PRICE.toString(), due_ms: String(due), allow_advance: true, brief: briefHash(), note: null }, { deposit: PRICE + near("0.05") });
  const jobId = String(locked.value);
  link(locked);
  record("customer locks job", locked, { job: jobId });
  await pause();

  // 2. the agent looks for work and checks the brief against its fingerprint
  step(AGENT, "looks for open jobs on the desk");
  const open: any[] = await view(DESK, "open_jobs", { agent: AGENT, from: String(Math.max(0, Number(jobId) - 20)), limit: 50 });
  const job = open.find((j) => String(j.id) === jobId);
  if (!job) throw new Error(`job ${jobId} is not in the open list`);
  say(`found job #${job.id}: ${fmtNear(job.price)} NEAR from ${job.customer}`);
  say(`the brief it was sent matches the fingerprint on the desk: ${sha256(BRIEF) === job.brief ? "yes" : "NO"}`);
  if (sha256(BRIEF) !== job.brief) throw new Error("brief does not match");
  const taken = await call(agent, DESK, "accept_job", { id: jobId });
  step(AGENT, `takes job #${jobId}`);
  link(taken);
  record("agent takes job", taken);
  await pause();

  // 3. an advance pays for compute before any work is delivered
  const half = PRICE / 2n;
  step(AGENT, `draws an advance of ${fmtNear(COMPUTE_PRICE)} NEAR (it may draw up to ${fmtNear(half)}, half of the job)`);
  const drawn = await call(agent, DESK, "draw", { id: jobId, amount: COMPUTE_PRICE.toString() });
  link(drawn);
  record("agent draws advance", drawn, { amount: COMPUTE_PRICE.toString() });
  step(AGENT, `pays ${COMPUTE} ${fmtNear(COMPUTE_PRICE)} NEAR for compute`);
  const paidCompute = await transfer(agent, COMPUTE, COMPUTE_PRICE);
  link(paidCompute);
  record("agent pays for compute", paidCompute, { amount: COMPUTE_PRICE.toString() });
  const draft = stubModel(BRIEF);
  say(`the model wrote a draft of ${draft.text.split("\n").length} lines (a stub model: no paid API is called in this demo)`);
  receipts.push({ what: "compute for the draft", from: COMPUTE, price: fmtNear(COMPUTE_PRICE), check: "draft returned", tx: paidCompute.hash });
  await pause();

  // 4. it hires a checker for part of the job, after one counter-offer
  step(CHECKER_ID, `quotes ${fmtNear(CHECKER.ask)} NEAR to check every claim in the draft`);
  const { offer, why } = counterOffer(half, COMPUTE_PRICE, CHECKER.ask);
  step(AGENT, `counters once at ${fmtNear(offer)} NEAR: ${why}`);
  const yes = checkerAnswers(offer);
  step(CHECKER_ID, yes ? `accepts ${fmtNear(offer)} NEAR` : "walks away");
  run.negotiation = { ask: CHECKER.ask.toString(), counter: offer.toString(), why, accepted: yes };
  if (!yes) throw new Error("no deal with the checker");
  const subBrief = `Check every numbered claim in this draft names its source.\n\n${draft.text}`;
  const hired = await call(agent, DESK, "hire", { parent: jobId, agent: CHECKER_ID, amount: offer.toString(), due_ms: String(due - 10 * MIN), allow_advance: false, brief: sha256(subBrief) }, { deposit: near("0.05") });
  const subId = String(hired.value);
  step(AGENT, `hires ${CHECKER_ID} with sub-job #${subId}, paid out of job #${jobId}'s half`);
  link(hired);
  record("agent hires checker", hired, { job: subId, amount: offer.toString() });
  await pause();

  // 5. the checker takes the sub-job and delivers
  const subTaken = await call(checker, DESK, "accept_job", { id: subId });
  step(CHECKER_ID, `takes sub-job #${subId}`);
  link(subTaken);
  record("checker takes sub-job", subTaken);
  const check = stubCheck(draft.text);
  const subDelivered = await call(checker, DESK, "deliver", { id: subId, proof: sha256(check.text) });
  step(CHECKER_ID, `delivers its check (${check.passed ? "every claim sourced" : "claims missing sources"}), fingerprint on the desk`);
  link(subDelivered);
  record("checker delivers", subDelivered);
  await pause();

  // 6. the agent checks the checker's work against the fingerprint, and pays it by accepting
  const sub = await view(DESK, "get_job", { id: subId });
  const matches = sub.proof === sha256(check.text);
  step(AGENT, `the check it received matches the fingerprint on the desk: ${matches ? "yes" : "NO"}; verdict: ${check.passed ? "pass" : "fail"}`);
  if (!matches || !check.passed) throw new Error("the check does not hold");
  const subPaid = await call(agent, DESK, "accept", { id: subId });
  const subEvent = subPaid.events.find((e) => e.event === "job_paid");
  step(AGENT, `accepts sub-job #${subId}: ${CHECKER_ID} is paid ${fmtNear(subEvent?.data?.to_agent ?? offer)} NEAR`);
  link(subPaid);
  record("agent pays checker", subPaid);
  receipts.push({ what: "claim check (sub-job)", from: CHECKER_ID, price: fmtNear(offer), check: "matches fingerprint, all sourced", tx: subPaid.hash });
  await pause();

  // 7. the agent delivers the job
  const deliverable = `${draft.text}\n\n${check.text}`;
  const delivered = await call(agent, DESK, "deliver", { id: jobId, proof: sha256(deliverable) });
  step(AGENT, `delivers job #${jobId}: the note and its check, fingerprint on the desk`);
  link(delivered);
  record("agent delivers", delivered);
  await pause();

  // 8. the customer checks and accepts; the payment settles the advance and the sub-job
  const j = await view(DESK, "get_job", { id: jobId });
  step(CUSTOMER, `the work it received matches the fingerprint on the desk: ${j.proof === sha256(deliverable) ? "yes" : "NO"}`);
  const accepted = await call(customer, DESK, "accept", { id: jobId });
  const paid = accepted.events.find((e) => e.event === "job_paid")?.data;
  step(CUSTOMER, `accepts job #${jobId}`);
  link(accepted);
  record("customer accepts", accepted, { settlement: paid });
  say(`settled: ${fmtNear(paid.gross)} NEAR. Advance ${fmtNear(paid.advance_settled)} and sub-job ${fmtNear(paid.sub_jobs)} settled out of it, desk fee ${fmtNear(paid.fee)}, ${AGENT} is paid the rest: ${fmtNear(paid.to_agent)} NEAR`);

  receiptsTable(receipts);
  run.receipts = receipts;
  run.finished = new Date().toISOString();
  mkdirSync(new URL("../demo/runs/", import.meta.url), { recursive: true });
  const file = new URL(`../demo/runs/${run.started.replace(/[:.]/g, "-")}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
  say(`saved the run with every transaction: ${file.pathname.split("/near/")[1]}`);
}

main().catch((e) => {
  console.error(`\nstopped: ${e?.message ?? e}`);
  process.exit(1);
});
