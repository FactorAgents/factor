import { test } from "node:test";
import assert from "node:assert/strict";
import { BRIEF, briefHash, stubModel, stubCheck, counterOffer, checkerAnswers, CHECKER, COMPUTE_PRICE } from "../agent/work.ts";
import { near, fmtNear, fmtUnits, sha256 } from "../lib/near.ts";

test("NEAR amounts convert exactly, with no floating point", () => {
  assert.equal(near("2"), 2n * 10n ** 24n);
  assert.equal(near("0.3"), 3n * 10n ** 23n);
  assert.equal(near("1.000000000000000000000001"), 10n ** 24n + 1n);
  assert.equal(fmtNear(near("1.26")), "1.26");
  assert.equal(fmtUnits(19_500_000n, 6), "19.5");
  assert.throws(() => near("0.0000000000000000000000001"));
});

test("the brief's fingerprint is its sha256", () => {
  assert.equal(briefHash(), sha256(BRIEF));
  assert.match(briefHash(), /^[0-9a-f]{64}$/);
});

test("the stub model's draft passes the stub check, and a claim without a source fails it", () => {
  const draft = stubModel(BRIEF).text;
  assert.equal(stubCheck(draft).passed, true);
  assert.equal(stubCheck(draft + "\n6. A claim with nothing behind it.").passed, false);
});

test("the agent counters once inside the half it may spend, with its reasons", () => {
  const half = near("1");
  const { offer, why } = counterOffer(half, COMPUTE_PRICE, CHECKER.ask);
  assert.equal(offer, near("0.4"));
  assert.ok(offer + COMPUTE_PRICE <= half, "compute and the check stay within half of the job");
  assert.match(why, /went to compute/);
  assert.equal(checkerAnswers(offer), true);
  assert.equal(checkerAnswers(CHECKER.floor - 1n), false, "below its floor the checker walks away");
});

test("when the ask is already inside the plan, the agent does not counter lower", () => {
  const { offer } = counterOffer(near("5"), COMPUTE_PRICE, CHECKER.ask);
  assert.equal(offer, CHECKER.ask);
});
