// The desk's other rules, run for real on testnet so each has a transaction to look at: a payout that fails and
// is withdrawn later, a rejection that settles at half, a silent customer settled by anyone after the review
// window, a default refunded with the agent's bond paying the customer back, and a job nobody took given back.
//
//   node scripts/rules.ts a      sets the jobs up (writes demo/runs/rules-state.json)
//   node scripts/rules.ts b      at least 21 minutes later: settles, refunds, withdraws (testnet windows: review
//                                20 minutes, grace 10 minutes, shortest job 5 minutes)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { DESK, TEST_DOLLAR, call, near, sha256, signer, view, fmtNear, txLink } from "../lib/near.ts";
import { step, say, link } from "../agent/say.ts";

const CUSTOMER = process.env.CUSTOMER || "factor-client.testnet";
const CHECKER = process.env.CHECKER || "factor-checker.testnet";
// an agent of its own for the default and the rejection, so they do not land on the demo agents' records
const IDLE = process.env.IDLE || "factor-idle.testnet";
// made by agent/wash.ts; it has no storage on the test dollar, so a token payout to it fails
const UNREGISTERED = `client.${process.env.AGENT || "factor-scout.testnet"}`;
const STATE = new URL("../demo/runs/rules-state.json", import.meta.url);
const MIN = 60_000;

const log: { rule: string; hash: string; link: string }[] = [];
const keep = (rule: string, s: { hash: string }) => (log.push({ rule, hash: s.hash, link: txLink(s.hash) }), link(s as any));

async function phaseA() {
  const customer = signer(CUSTOMER);
  const checker = signer(CHECKER);
  const idle = signer(IDLE);
  const unreg = signer(UNREGISTERED);
  const state: any = { started: new Date().toISOString() };

  // a token payout that fails: the agent has no storage on the token
  step(CUSTOMER, `locks 5 tUSD for ${UNREGISTERED}, an account with no storage on the token`);
  await call(customer, TEST_DOLLAR, "mint", { amount: "5000000" }, { tgas: 30 });
  const msg = JSON.stringify({ agent: UNREGISTERED, due_ms: String(Date.now() + 30 * MIN), allow_advance: false, brief: sha256("unregistered payout"), note: null });
  const l1 = await call(customer, TEST_DOLLAR, "ft_transfer_call", { receiver_id: DESK, amount: "5000000", memo: null, msg }, { deposit: 1n, tgas: 120 });
  keep("token job locked", l1);
  const ftJob = String(l1.events.find((e) => e.event === "job_locked")!.data.id);
  keep("agent takes it", await call(unreg, DESK, "accept_job", { id: ftJob }));
  keep("agent delivers", await call(unreg, DESK, "deliver", { id: ftJob, proof: sha256("work") }));
  const paid = await call(customer, DESK, "accept", { id: ftJob });
  keep("customer accepts: the payout fails, the desk keeps it", paid);
  const owed = await view(DESK, "owed_of", { account: UNREGISTERED, token: TEST_DOLLAR });
  say(`the transfer failed; the desk keeps ${Number(owed) / 1e6} tUSD for ${UNREGISTERED} to withdraw`);
  state.ftJob = ftJob;

  // a rejection settles at half
  step(CUSTOMER, `locks 0.5 NEAR for ${IDLE}; it delivers; the customer rejects within the window`);
  const l2 = await call(customer, DESK, "lock", { agent: IDLE, price: near("0.5").toString(), due_ms: String(Date.now() + 30 * MIN), allow_advance: false, brief: sha256("half"), note: null }, { deposit: near("0.55") });
  keep("job locked", l2);
  const halfJob = String(l2.value);
  keep("agent takes it", await call(idle, DESK, "accept_job", { id: halfJob }));
  keep("agent delivers", await call(idle, DESK, "deliver", { id: halfJob, proof: sha256("thin work") }));
  const rej = await call(customer, DESK, "reject", { id: halfJob });
  keep("customer rejects: settled at half", rej);
  const h = rej.events.find((e) => e.event === "job_half")!.data;
  say(`half: ${fmtNear(h.gross)} NEAR to the agent's side (fee ${fmtNear(h.fee)}), ${fmtNear(h.returned)} back to the customer`);

  // a silent customer: anyone settles after the review window
  step(CUSTOMER, `locks 0.5 NEAR for ${CHECKER}; it delivers; the customer says nothing`);
  const l3 = await call(customer, DESK, "lock", { agent: CHECKER, price: near("0.5").toString(), due_ms: String(Date.now() + 30 * MIN), allow_advance: false, brief: sha256("silent"), note: null }, { deposit: near("0.55") });
  keep("job locked", l3);
  state.silentJob = String(l3.value);
  keep("agent takes it", await call(checker, DESK, "accept_job", { id: state.silentJob }));
  keep("agent delivers", await call(checker, DESK, "deliver", { id: state.silentJob, proof: sha256("good work") }));

  // a default: the agent bonds, draws, and never delivers
  step(IDLE, "puts up a 0.3 NEAR bond, takes a 1 NEAR job, draws 0.4 and never delivers");
  keep("agent bonds", await call(idle, DESK, "add_bond", {}, { deposit: near("0.3") }));
  const l4 = await call(customer, DESK, "lock", { agent: IDLE, price: near("1").toString(), due_ms: String(Date.now() + 6 * MIN), allow_advance: true, brief: sha256("default"), note: null }, { deposit: near("1.05") });
  keep("job locked", l4);
  state.defaultJob = String(l4.value);
  keep("agent takes it", await call(idle, DESK, "accept_job", { id: state.defaultJob }));
  keep("agent draws 0.4", await call(idle, DESK, "draw", { id: state.defaultJob, amount: near("0.4").toString() }));
  try {
    await call(idle, DESK, "take_bond", { amount: near("0.3").toString() });
    say("UNEXPECTED: the bond came back while an advance was out");
  } catch {
    say("it tries to take its bond back while the advance is out: the desk refuses");
  }

  state.log = log;
  mkdirSync(new URL("../demo/runs/", import.meta.url), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
  say(`run 'node scripts/rules.ts b' after ${new Date(Date.now() + 21 * MIN).toISOString().slice(11, 16)} UTC`);
}

async function phaseB() {
  if (!existsSync(STATE)) throw new Error("run phase a first");
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  log.push(...state.log);
  const anyone = signer(CUSTOMER);
  const unreg = signer(UNREGISTERED);

  step("anyone", `settles job #${state.silentJob}: delivered, the review window passed with no answer`);
  const s = await call(anyone, DESK, "settle", { id: state.silentJob });
  keep("settled in full after the review window", s);

  step("anyone", `refunds job #${state.defaultJob}: not delivered by its due time plus the grace`);
  const r = await call(anyone, DESK, "refund", { id: state.defaultJob });
  keep("refunded: a default, the bond pays back", r);
  const ev = r.events.find((e) => e.event === "job_refunded")!.data;
  say(`back to the customer: ${fmtNear(ev.returned)} still locked, plus ${fmtNear(ev.slashed)} from the agent's bond`);

  const zero = await view(DESK, "get_job", { id: "0" });
  if (zero?.status === "Open") {
    step("anyone", "gives back job #0: open, nobody took it before its time");
    keep("never taken: given back", await call(anyone, DESK, "refund", { id: "0" }));
  }

  step(UNREGISTERED, "registers on the token and withdraws the payout the desk kept");
  await call(unreg, TEST_DOLLAR, "storage_deposit", { account_id: UNREGISTERED, registration_only: true }, { deposit: near("0.00125"), tgas: 30 });
  const w = await call(unreg, DESK, "withdraw", { token: TEST_DOLLAR });
  keep("failed payout withdrawn", w);
  const bal = await view(TEST_DOLLAR, "ft_balance_of", { account_id: UNREGISTERED });
  say(`${UNREGISTERED} now holds ${Number(bal) / 1e6} tUSD`);

  state.log = log;
  state.finished = new Date().toISOString();
  writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
}

const phase = process.argv[2];
(phase === "a" ? phaseA() : phase === "b" ? phaseB() : Promise.reject(new Error("usage: node scripts/rules.ts a|b"))).catch((e) => {
  console.error(`stopped: ${e?.message ?? e}`);
  process.exit(1);
});
