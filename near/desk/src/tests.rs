//! Every path of the desk, one by one, and the attacks on it. Payouts are read from the receipts the contract
//! creates, so each test checks to the yoctoNEAR (or the token's smallest unit) who is paid what.

use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const NEAR: u128 = 10u128.pow(24);
const MIN: u64 = 60_000;
const HOUR: u64 = 60 * MIN;
const T0: u64 = 1_800_000_000_000; // ms
const STORAGE: u128 = NEAR / 10; // attached on top of the price for the record's storage; the rest comes back
const DOLLAR: u128 = 1_000_000;
const BRIEF: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const PROOF: &str = "abababababababababababababababababababababababababababababababab";

fn a(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn desk_id() -> AccountId {
    a("desk.testnet")
}
fn fees() -> AccountId {
    a("fees.testnet")
}
fn alice() -> AccountId {
    a("alice.testnet") // customer
}
fn bob() -> AccountId {
    a("bob.testnet") // agent
}
fn carol() -> AccountId {
    a("carol.testnet") // sub-agent
}
fn dave() -> AccountId {
    a("dave.testnet") // sub-sub-agent
}
fn eve() -> AccountId {
    a("eve.testnet") // a stranger
}
fn tusd() -> AccountId {
    a("tusd.testnet")
}
fn intents() -> AccountId {
    a("intents.testnet")
}

struct Env {
    now: u64,
    results: Vec<PromiseResult>,
    gas: Gas,
}

impl Env {
    fn new() -> Self {
        let mut e = Env { now: T0, results: vec![], gas: Gas::from_tgas(300) };
        e.call(&desk_id(), 0);
        e
    }
    /// Set who calls, what is attached, at the current time.
    fn call(&mut self, who: &AccountId, deposit: u128) {
        let ctx = VMContextBuilder::new()
            .current_account_id(desk_id())
            .predecessor_account_id(who.clone())
            .signer_account_id(who.clone())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(self.now * 1_000_000)
            .account_balance(NearToken::from_near(1_000))
            .prepaid_gas(self.gas)
            .build();
        testing_env!(ctx, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), std::mem::take(&mut self.results));
    }
    fn at(&mut self, ms: u64) -> &mut Self {
        self.now = ms;
        self
    }
}

fn desk() -> FactorDesk {
    FactorDesk::new(
        fees(),
        200,
        U64(HOUR),
        U64(30 * MIN),
        U64(10 * MIN),
        U128(NEAR / 100),
        vec![TokenRule { token: tusd(), min_amount: U128(DOLLAR) }],
    )
}

/// (to, token, amount) of every payout the last call created; storage refunds included.
fn payouts() -> Vec<(AccountId, Option<AccountId>, u128)> {
    let mut out = vec![];
    for r in get_created_receipts() {
        for act in r.actions {
            match act {
                MockAction::Transfer { deposit, .. } => out.push((r.receiver_id.clone(), None, deposit.as_yoctonear())),
                MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"ft_transfer" => {
                    let v: serde_json::Value = serde_json::from_slice(&args).unwrap();
                    let to: AccountId = v["receiver_id"].as_str().unwrap().parse().unwrap();
                    let amount: u128 = v["amount"].as_str().unwrap().parse().unwrap();
                    out.push((to, Some(r.receiver_id.clone()), amount));
                }
                _ => {}
            }
        }
    }
    out
}

fn paid_to(who: &AccountId) -> u128 {
    payouts().iter().filter(|(t, _, _)| t == who).map(|(_, _, x)| *x).sum()
}

fn callbacks() -> usize {
    get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.clone())
        .filter(|act| matches!(act, MockAction::FunctionCallWeight { method_name, .. } if method_name == b"on_payout"))
        .count()
}

fn events() -> Vec<String> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<serde_json::Value>(j).unwrap()["event"].as_str().unwrap().to_string())
        .collect()
}

/// alice locks `price` for bob, due in 2 hours, advances allowed.
fn lock_for_bob(e: &mut Env, d: &mut FactorDesk, price: u128) -> u64 {
    e.call(&alice(), price + STORAGE);
    d.lock(Some(bob()), U128(price), U64(e.now + 2 * HOUR), true, BRIEF.into(), None).0
}

fn lock_and_take(e: &mut Env, d: &mut FactorDesk, price: u128) -> u64 {
    let id = lock_for_bob(e, d, price);
    e.call(&bob(), 0);
    d.accept_job(U64(id));
    id
}

fn status(d: &FactorDesk, id: u64) -> Status {
    d.get_job(U64(id)).unwrap().status
}

// ── locking ──────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn lock_keeps_the_price_and_returns_what_storage_did_not_use() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_for_bob(&mut e, &mut d, NEAR);
    let j = d.get_job(U64(id)).unwrap();
    assert_eq!(j.price.0, NEAR);
    assert_eq!(j.status, Status::Open);
    assert_eq!(j.customer, alice());
    assert_eq!(j.payer, alice());
    let back = paid_to(&alice());
    assert!(back > 0 && back < STORAGE, "storage is charged and the rest comes back: {back}");
    assert_eq!(events(), vec!["job_locked"]);
    assert_eq!(d.get_config().jobs.0, 1);
}

#[test]
#[should_panic(expected = "attach")]
fn lock_without_storage_fails() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&alice(), NEAR);
    d.lock(Some(bob()), U128(NEAR), U64(e.now + 2 * HOUR), true, BRIEF.into(), None);
}

#[test]
#[should_panic(expected = "attach the price")]
fn lock_with_less_than_the_price_fails() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&alice(), NEAR / 2);
    d.lock(Some(bob()), U128(NEAR), U64(e.now + 2 * HOUR), true, BRIEF.into(), None);
}

#[test]
#[should_panic(expected = "price below the smallest job")]
fn lock_below_the_smallest_job_fails() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&alice(), NEAR);
    d.lock(Some(bob()), U128(NEAR / 1000), U64(e.now + 2 * HOUR), true, BRIEF.into(), None);
}

#[test]
#[should_panic(expected = "due time too soon")]
fn lock_due_too_soon_fails() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&alice(), NEAR + STORAGE);
    d.lock(Some(bob()), U128(NEAR), U64(e.now + MIN), true, BRIEF.into(), None);
}

#[test]
#[should_panic(expected = "due time too far")]
fn lock_due_too_far_fails() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&alice(), NEAR + STORAGE);
    d.lock(Some(bob()), U128(NEAR), U64(e.now + MAX_DURATION_MS + 1), true, BRIEF.into(), None);
}

#[test]
#[should_panic(expected = "brief must be a sha256")]
fn lock_with_a_brief_that_is_not_a_hash_fails() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&alice(), NEAR + STORAGE);
    d.lock(Some(bob()), U128(NEAR), U64(e.now + 2 * HOUR), true, "write me a poem".into(), None);
}

#[test]
#[should_panic(expected = "a customer cannot hire itself")]
fn lock_for_yourself_fails() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&alice(), NEAR + STORAGE);
    d.lock(Some(alice()), U128(NEAR), U64(e.now + 2 * HOUR), true, BRIEF.into(), None);
}

#[test]
#[should_panic(expected = "fee too high")]
fn a_desk_cannot_be_made_with_a_high_fee() {
    let _e = Env::new();
    FactorDesk::new(fees(), 501, U64(HOUR), U64(HOUR), U64(MIN), U128(1), vec![]);
}

// ── the whole job in NEAR ────────────────────────────────────────────────────────────────────────────────

#[test]
fn advance_deliver_accept_pays_the_rest_and_settles_the_advance() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, 10 * NEAR);

    e.call(&bob(), 0);
    d.draw(U64(id), U128(3 * NEAR));
    assert_eq!(paid_to(&bob()), 3 * NEAR);
    assert_eq!(callbacks(), 1, "every payout has its callback");
    assert_eq!(d.room(U64(id)).0, 2 * NEAR);

    e.call(&bob(), 0);
    d.draw(U64(id), U128(2 * NEAR));
    assert_eq!(d.room(U64(id)).0, 0);

    e.at(T0 + HOUR).call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    assert_eq!(status(&d, id), Status::Delivered);

    e.call(&alice(), 0);
    d.accept(U64(id));
    // 10 NEAR: 2% fee = 0.2, advance 5 already paid, rest 4.8
    assert_eq!(paid_to(&bob()), 48 * NEAR / 10);
    assert_eq!(paid_to(&fees()), NEAR / 5);
    assert_eq!(paid_to(&alice()), 0);
    let j = d.get_job(U64(id)).unwrap();
    assert_eq!(j.status, Status::Paid);
    assert_eq!(j.advanced.0 + j.paid_agent.0 + j.fee.0, 10 * NEAR, "every yocto of the job is accounted for");
    let r = d.agent_record(bob());
    assert_eq!((r.accepted, r.delivered, r.on_time, r.paid, r.advanced_jobs, r.repaid_jobs, r.open_drawn), (1, 1, 1, 1, 1, 1, 0));
    assert_eq!(r.earned_near.0, 10 * NEAR);
}

#[test]
fn a_job_with_no_advance_pays_the_agent_all_but_the_fee() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.call(&alice(), 0);
    d.accept(U64(id));
    assert_eq!(paid_to(&bob()), NEAR * 98 / 100);
    assert_eq!(paid_to(&fees()), NEAR * 2 / 100);
    assert_eq!(d.agent_record(bob()).advanced_jobs, 0);
}

#[test]
fn reject_settles_at_half_and_the_advance_comes_out_of_the_agents_half() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, 10 * NEAR);
    e.call(&bob(), 0);
    d.draw(U64(id), U128(2 * NEAR));
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.at(T0 + 30 * MIN).call(&alice(), 0);
    d.reject(U64(id));
    // half = 5; fee 2% of 5 = 0.1; advance 2 out of it; rest 2.9; alice gets 5 back
    assert_eq!(paid_to(&bob()), 29 * NEAR / 10);
    assert_eq!(paid_to(&fees()), NEAR / 10);
    assert_eq!(paid_to(&alice()), 5 * NEAR);
    assert_eq!(status(&d, id), Status::Half);
    assert_eq!(d.agent_record(bob()).half, 1);
}

#[test]
fn reject_with_the_whole_half_drawn_takes_no_fee_and_pays_nothing_more() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, 10 * NEAR);
    e.call(&bob(), 0);
    d.draw(U64(id), U128(5 * NEAR));
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.call(&alice(), 0);
    d.reject(U64(id));
    assert_eq!(paid_to(&bob()), 0);
    assert_eq!(paid_to(&fees()), 0);
    assert_eq!(paid_to(&alice()), 5 * NEAR);
}

#[test]
fn a_silent_customer_is_settled_in_full_by_anyone_after_the_review_window() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.at(T0 + HOUR + 1).call(&eve(), 0);
    d.settle(U64(id));
    assert_eq!(status(&d, id), Status::Paid);
    assert_eq!(paid_to(&bob()), NEAR * 98 / 100);
}

#[test]
#[should_panic(expected = "the review window is still open")]
fn settle_inside_the_review_window_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.at(T0 + HOUR).call(&eve(), 0);
    d.settle(U64(id));
}

#[test]
#[should_panic(expected = "the review window is over")]
fn reject_after_the_review_window_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.at(T0 + HOUR + 1).call(&alice(), 0);
    d.reject(U64(id));
}

#[test]
fn delivering_late_inside_the_grace_counts_as_late() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.at(T0 + 2 * HOUR + 10 * MIN).call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    let r = d.agent_record(bob());
    assert_eq!((r.delivered, r.on_time), (1, 0));
}

// ── refunds and the bond ─────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_job_not_delivered_is_refunded_and_the_bond_pays_back_the_advance() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&bob(), 3 * NEAR);
    assert_eq!(d.add_bond().0, 3 * NEAR);
    let id = lock_and_take(&mut e, &mut d, 10 * NEAR);
    e.call(&bob(), 0);
    d.draw(U64(id), U128(4 * NEAR));
    e.at(T0 + 2 * HOUR + 30 * MIN + 1).call(&eve(), 0);
    d.refund(U64(id));
    // 6 still locked comes back, and the bond pays 3 of the 4 drawn
    assert_eq!(paid_to(&alice()), 9 * NEAR);
    let j = d.get_job(U64(id)).unwrap();
    assert_eq!((j.status, j.returned.0, j.slashed.0), (Status::Refunded, 6 * NEAR, 3 * NEAR));
    let r = d.agent_record(bob());
    assert_eq!((r.defaults, r.missed, r.bond.0, r.open_drawn), (1, 0, 0, 0));
    assert!(events().contains(&"job_refunded".to_string()));
}

#[test]
fn a_job_not_delivered_with_nothing_drawn_is_missed_not_a_default() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&bob(), NEAR);
    d.add_bond();
    let id = lock_and_take(&mut e, &mut d, 2 * NEAR);
    e.at(T0 + 3 * HOUR).call(&eve(), 0);
    d.refund(U64(id));
    assert_eq!(paid_to(&alice()), 2 * NEAR);
    let r = d.agent_record(bob());
    assert_eq!((r.defaults, r.missed, r.bond.0), (0, 1, NEAR), "nothing drawn: the bond is not touched");
}

#[test]
#[should_panic(expected = "the job is not late yet")]
fn refund_inside_the_grace_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.at(T0 + 2 * HOUR + 30 * MIN).call(&eve(), 0);
    d.refund(U64(id));
}

#[test]
#[should_panic(expected = "job cannot be refunded")]
fn a_delivered_job_cannot_be_refunded() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.at(T0 + 10 * HOUR).call(&alice(), 0);
    d.refund(U64(id));
}

#[test]
#[should_panic(expected = "too late")]
fn delivering_after_the_grace_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.at(T0 + 2 * HOUR + 30 * MIN + 1).call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
}

#[test]
fn a_job_nobody_took_is_given_back_after_its_time() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_for_bob(&mut e, &mut d, NEAR);
    e.at(T0 + 3 * HOUR).call(&eve(), 0);
    d.refund(U64(id));
    assert_eq!(status(&d, id), Status::Cancelled);
    assert_eq!(paid_to(&alice()), NEAR);
    assert_eq!(d.agent_record(bob()).missed, 0, "never taken is nobody's miss");
}

#[test]
#[should_panic(expected = "a job with money drawn on it is open")]
fn the_bond_cannot_be_taken_while_an_advance_is_out() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&bob(), NEAR);
    d.add_bond();
    let id = lock_and_take(&mut e, &mut d, 2 * NEAR);
    e.call(&bob(), 0);
    d.draw(U64(id), U128(NEAR / 2));
    e.call(&bob(), 0);
    d.take_bond(U128(NEAR));
}

#[test]
fn the_bond_comes_back_once_the_job_is_settled() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&bob(), NEAR);
    d.add_bond();
    let id = lock_and_take(&mut e, &mut d, 2 * NEAR);
    e.call(&bob(), 0);
    d.draw(U64(id), U128(NEAR / 2));
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.call(&alice(), 0);
    d.accept(U64(id));
    e.call(&bob(), 0);
    assert_eq!(d.take_bond(U128(NEAR)).0, 0);
    assert_eq!(paid_to(&bob()), NEAR);
}

#[test]
#[should_panic(expected = "more than the bond")]
fn taking_more_than_the_bond_fails() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&bob(), NEAR);
    d.add_bond();
    e.call(&bob(), 0);
    d.take_bond(U128(NEAR + 1));
}

// ── cancel, decline, open jobs ───────────────────────────────────────────────────────────────────────────

#[test]
fn the_customer_cancels_a_job_nobody_took() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_for_bob(&mut e, &mut d, NEAR);
    e.call(&alice(), 0);
    d.cancel(U64(id));
    assert_eq!(status(&d, id), Status::Cancelled);
    assert_eq!(paid_to(&alice()), NEAR);
}

#[test]
#[should_panic(expected = "job was already taken")]
fn the_customer_cannot_cancel_a_job_being_worked_on() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&alice(), 0);
    d.cancel(U64(id));
}

#[test]
fn the_agent_declines_and_the_customer_gets_it_all_back() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.decline(U64(id));
    assert_eq!(status(&d, id), Status::Cancelled);
    assert_eq!(paid_to(&alice()), NEAR);
}

#[test]
#[should_panic(expected = "money was drawn on this job")]
fn an_agent_that_drew_cannot_decline() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.draw(U64(id), U128(NEAR / 4));
    e.call(&bob(), 0);
    d.decline(U64(id));
}

#[test]
fn an_open_job_is_taken_by_the_first_agent() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&alice(), NEAR + STORAGE);
    let id = d.lock(None, U128(NEAR), U64(e.now + 2 * HOUR), false, BRIEF.into(), None).0;
    assert_eq!(d.open_jobs(None, U64(0), 10).len(), 1);
    assert_eq!(d.open_jobs(Some(carol()), U64(0), 10).len(), 1, "an open job shows to every agent");
    e.call(&carol(), 0);
    d.accept_job(U64(id));
    assert_eq!(d.get_job(U64(id)).unwrap().agent, Some(carol()));
    assert!(d.open_jobs(None, U64(0), 10).is_empty());
}

#[test]
fn a_named_job_shows_only_to_its_agent() {
    let mut e = Env::new();
    let mut d = desk();
    lock_for_bob(&mut e, &mut d, NEAR);
    assert_eq!(d.open_jobs(Some(bob()), U64(0), 10).len(), 1);
    assert!(d.open_jobs(Some(carol()), U64(0), 10).is_empty());
    assert!(d.open_jobs(None, U64(0), 10).is_empty());
}

#[test]
#[should_panic(expected = "a customer cannot take its own job")]
fn the_customer_cannot_take_its_own_open_job() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&alice(), NEAR + STORAGE);
    let id = d.lock(None, U128(NEAR), U64(e.now + 2 * HOUR), false, BRIEF.into(), None).0;
    e.call(&alice(), 0);
    d.accept_job(U64(id));
}

#[test]
#[should_panic(expected = "job is for another agent")]
fn another_agent_cannot_take_a_named_job() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_for_bob(&mut e, &mut d, NEAR);
    e.call(&eve(), 0);
    d.accept_job(U64(id));
}

#[test]
#[should_panic(expected = "job is past its due time")]
fn a_job_cannot_be_taken_after_its_due_time() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_for_bob(&mut e, &mut d, NEAR);
    e.at(T0 + 2 * HOUR).call(&bob(), 0);
    d.accept_job(U64(id));
}

// ── attacks: over-advance, double claims, the wrong caller ───────────────────────────────────────────────

#[test]
#[should_panic(expected = "more than half of the job")]
fn drawing_more_than_half_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, 10 * NEAR);
    e.call(&bob(), 0);
    d.draw(U64(id), U128(5 * NEAR + 1));
}

#[test]
#[should_panic(expected = "more than half of the job")]
fn drawing_in_pieces_past_half_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, 10 * NEAR);
    for _ in 0..5 {
        e.call(&bob(), 0);
        d.draw(U64(id), U128(NEAR));
    }
    e.call(&bob(), 0);
    d.draw(U64(id), U128(1));
}

#[test]
#[should_panic(expected = "more than half of the job")]
fn drawing_and_hiring_together_past_half_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, 10 * NEAR);
    e.call(&bob(), 0);
    d.draw(U64(id), U128(3 * NEAR));
    e.call(&bob(), STORAGE);
    d.hire(U64(id), carol(), U128(2 * NEAR), U64(e.now + HOUR), true, BRIEF.into());
    e.call(&bob(), 0);
    d.draw(U64(id), U128(1));
}

#[test]
#[should_panic(expected = "the customer did not allow advances")]
fn drawing_when_the_customer_did_not_allow_it_fails() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&alice(), NEAR + STORAGE);
    let id = d.lock(Some(bob()), U128(NEAR), U64(e.now + 2 * HOUR), false, BRIEF.into(), None).0;
    e.call(&bob(), 0);
    d.accept_job(U64(id));
    e.call(&bob(), 0);
    d.draw(U64(id), U128(1));
}

#[test]
#[should_panic(expected = "only the job's agent can draw on it")]
fn a_stranger_cannot_draw() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&eve(), 0);
    d.draw(U64(id), U128(1));
}

#[test]
#[should_panic(expected = "job is not being worked on")]
fn drawing_before_taking_the_job_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_for_bob(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.draw(U64(id), U128(1));
}

#[test]
#[should_panic(expected = "job is not being worked on")]
fn drawing_after_delivery_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.call(&bob(), 0);
    d.draw(U64(id), U128(1));
}

#[test]
#[should_panic(expected = "job is past its due time")]
fn drawing_after_the_due_time_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.at(T0 + 2 * HOUR).call(&bob(), 0);
    d.draw(U64(id), U128(1));
}

#[test]
#[should_panic(expected = "job is not delivered")]
fn accepting_twice_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.call(&alice(), 0);
    d.accept(U64(id));
    e.call(&alice(), 0);
    d.accept(U64(id));
}

#[test]
#[should_panic(expected = "job is not delivered")]
fn settling_an_accepted_job_again_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.call(&alice(), 0);
    d.accept(U64(id));
    e.at(T0 + 5 * HOUR).call(&eve(), 0);
    d.settle(U64(id));
}

#[test]
#[should_panic(expected = "job cannot be refunded")]
fn refunding_a_paid_job_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.call(&alice(), 0);
    d.accept(U64(id));
    e.at(T0 + 9 * HOUR).call(&alice(), 0);
    d.refund(U64(id));
}

#[test]
#[should_panic(expected = "job cannot be refunded")]
fn refunding_twice_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.at(T0 + 3 * HOUR).call(&eve(), 0);
    d.refund(U64(id));
    e.call(&eve(), 0);
    d.refund(U64(id));
}

#[test]
#[should_panic(expected = "job is not being worked on")]
fn delivering_twice_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
}

#[test]
#[should_panic(expected = "only the job's customer can accept it")]
fn the_agent_cannot_accept_its_own_delivery() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.call(&bob(), 0);
    d.accept(U64(id));
}

#[test]
#[should_panic(expected = "only the job's customer can reject it")]
fn a_stranger_cannot_reject() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.call(&eve(), 0);
    d.reject(U64(id));
}

#[test]
#[should_panic(expected = "only the job's agent can deliver it")]
fn a_stranger_cannot_deliver() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&eve(), 0);
    d.deliver(U64(id), PROOF.into());
}

#[test]
#[should_panic(expected = "proof must be a sha256")]
fn a_proof_that_is_not_a_hash_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), "done".into());
}

#[test]
#[should_panic(expected = "only the job's customer can cancel it")]
fn a_stranger_cannot_cancel() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_for_bob(&mut e, &mut d, NEAR);
    e.call(&eve(), 0);
    d.cancel(U64(id));
}

#[test]
#[should_panic(expected = "attach more gas")]
fn settling_with_too_little_gas_fails_before_anything_changes() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.gas = Gas::from_tgas(20);
    e.call(&alice(), 0);
    d.accept(U64(id));
}

// ── callbacks: a payout that fails is kept, and withdrawn once ───────────────────────────────────────────

#[test]
fn a_failed_payout_is_kept_and_withdrawn_once() {
    let mut e = Env::new();
    let mut d = desk();
    e.results = vec![PromiseResult::Failed];
    e.call(&desk_id(), 0);
    assert!(!d.on_payout(bob(), None, U128(7)));
    assert_eq!(d.owed_of(bob(), None).0, 7);
    assert_eq!(events(), vec!["payout_failed"]);

    e.call(&bob(), 0);
    assert_eq!(d.withdraw(None).0, 7);
    assert_eq!(paid_to(&bob()), 7);
    assert_eq!(d.owed_of(bob(), None).0, 0, "cleared before the transfer is made");
}

#[test]
#[should_panic(expected = "nothing owed")]
fn withdrawing_twice_before_the_callback_fails() {
    let mut e = Env::new();
    let mut d = desk();
    e.results = vec![PromiseResult::Failed];
    e.call(&desk_id(), 0);
    d.on_payout(bob(), None, U128(7));
    e.call(&bob(), 0);
    d.withdraw(None);
    e.call(&bob(), 0);
    d.withdraw(None);
}

#[test]
fn a_withdrawal_that_fails_again_is_kept_again() {
    let mut e = Env::new();
    let mut d = desk();
    e.results = vec![PromiseResult::Failed];
    e.call(&desk_id(), 0);
    d.on_payout(bob(), Some(tusd()), U128(5));
    e.call(&bob(), 0);
    d.withdraw(Some(tusd()));
    assert_eq!(d.owed_of(bob(), Some(tusd())).0, 0);
    e.results = vec![PromiseResult::Failed];
    e.call(&desk_id(), 0);
    d.on_payout(bob(), Some(tusd()), U128(5));
    assert_eq!(d.owed_of(bob(), Some(tusd())).0, 5);
    assert_eq!(d.owed_of(bob(), None).0, 0, "kept per token");
}

#[test]
fn a_payout_that_went_through_keeps_nothing() {
    let mut e = Env::new();
    let mut d = desk();
    e.results = vec![PromiseResult::Successful(vec![])];
    e.call(&desk_id(), 0);
    assert!(d.on_payout(bob(), None, U128(7)));
    assert_eq!(d.owed_of(bob(), None).0, 0);
}

#[test]
#[should_panic(expected = "only the desk calls this")]
fn nobody_else_can_call_the_callback() {
    let mut e = Env::new();
    let mut d = desk();
    e.results = vec![PromiseResult::Failed];
    e.call(&eve(), 0);
    d.on_payout(eve(), None, U128(1_000 * NEAR));
}

#[test]
fn a_failed_payout_does_not_undo_the_settlement() {
    // the job settles first; the payout's failure only lands in the agent's balance
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, NEAR);
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.call(&alice(), 0);
    d.accept(U64(id));
    e.results = vec![PromiseResult::Failed];
    e.call(&desk_id(), 0);
    d.on_payout(bob(), None, U128(NEAR * 98 / 100));
    assert_eq!(status(&d, id), Status::Paid);
    assert_eq!(d.owed_of(bob(), None).0, NEAR * 98 / 100);
}

// ── jobs in a token, and payments through NEAR Intents ───────────────────────────────────────────────────

fn ft_lock(e: &mut Env, d: &mut FactorDesk, sender: &AccountId, amount: u128, msg: serde_json::Value) -> PromiseOrValue<U128> {
    e.call(&tusd(), 0);
    d.ft_on_transfer(sender.clone(), U128(amount), msg.to_string())
}

#[test]
fn a_token_payment_locks_a_job_and_pays_out_in_the_token() {
    let mut e = Env::new();
    let mut d = desk();
    let due = e.now + 2 * HOUR;
    let r = ft_lock(&mut e, &mut d, &alice(), 100 * DOLLAR, json!({ "agent": "bob.testnet", "due_ms": due.to_string(), "allow_advance": true, "brief": BRIEF }));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))), "the whole amount is used");
    let j = d.get_job(U64(0)).unwrap();
    assert_eq!((j.token.clone(), j.price.0, j.customer.clone()), (Some(tusd()), 100 * DOLLAR, alice()));
    e.call(&bob(), 0);
    d.accept_job(U64(0));
    e.call(&bob(), 0);
    d.draw(U64(0), U128(40 * DOLLAR));
    assert_eq!(payouts(), vec![(bob(), Some(tusd()), 40 * DOLLAR)]);
    e.call(&bob(), 0);
    d.deliver(U64(0), PROOF.into());
    e.call(&alice(), 0);
    d.accept(U64(0));
    let p = payouts();
    assert!(p.contains(&(bob(), Some(tusd()), 58 * DOLLAR)));
    assert!(p.contains(&(fees(), Some(tusd()), 2 * DOLLAR)));
    assert_eq!(d.agent_record(bob()).earned_near.0, 0, "token jobs are not counted as NEAR");
}

#[test]
fn a_payment_through_intents_names_its_customer_and_the_refund_goes_there() {
    let mut e = Env::new();
    let mut d = desk();
    let due = e.now + 2 * HOUR;
    let _ = ft_lock(
        &mut e,
        &mut d,
        &intents(),
        25 * DOLLAR,
        json!({ "customer": "alice.testnet", "agent": "bob.testnet", "due_ms": due.to_string(), "allow_advance": false, "brief": BRIEF, "note": "intents:0xdeposit" }),
    );
    let j = d.get_job(U64(0)).unwrap();
    assert_eq!((j.customer.clone(), j.payer.clone(), j.note.clone()), (alice(), intents(), Some("intents:0xdeposit".into())));
    e.call(&alice(), 0);
    d.cancel(U64(0));
    assert_eq!(payouts(), vec![(alice(), Some(tusd()), 25 * DOLLAR)]);
}

#[test]
#[should_panic(expected = "token not allowed")]
fn a_token_that_is_not_allowed_is_sent_back() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&a("fake.testnet"), 0);
    let _ = d.ft_on_transfer(alice(), U128(100 * DOLLAR), json!({ "due_ms": "0", "allow_advance": true, "brief": BRIEF }).to_string());
}

#[test]
#[should_panic(expected = "amount below the smallest job")]
fn a_token_job_below_the_smallest_is_sent_back() {
    let mut e = Env::new();
    let mut d = desk();
    let due = e.now + 2 * HOUR;
    let _ = ft_lock(&mut e, &mut d, &alice(), DOLLAR - 1, json!({ "due_ms": due.to_string(), "allow_advance": true, "brief": BRIEF }));
}

#[test]
#[should_panic(expected = "msg is not a lock message")]
fn a_token_payment_without_a_lock_message_is_sent_back() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&tusd(), 0);
    let _ = d.ft_on_transfer(alice(), U128(10 * DOLLAR), "hello".into());
}

// ── agents hire agents ───────────────────────────────────────────────────────────────────────────────────

/// bob takes a 10 NEAR job and hires carol for 3 out of its half.
fn with_sub_job(e: &mut Env, d: &mut FactorDesk) -> (u64, u64) {
    let id = lock_and_take(e, d, 10 * NEAR);
    e.call(&bob(), STORAGE);
    let sub = d.hire(U64(id), carol(), U128(3 * NEAR), U64(e.now + HOUR), true, BRIEF.into()).0;
    (id, sub)
}

#[test]
fn hiring_sets_part_of_the_half_aside_for_a_sub_job() {
    let mut e = Env::new();
    let mut d = desk();
    let (id, sub) = with_sub_job(&mut e, &mut d);
    let back = paid_to(&bob());
    assert!(back > 0 && back < STORAGE, "storage is charged and the rest comes back");
    let p = d.get_job(U64(id)).unwrap();
    assert_eq!((p.reserved.0, p.children.clone()), (3 * NEAR, vec![sub]));
    assert_eq!(d.room(U64(id)).0, 2 * NEAR);
    let s = d.get_job(U64(sub)).unwrap();
    assert_eq!((s.customer.clone(), s.agent.clone(), s.parent, s.depth, s.price.0), (bob(), Some(carol()), Some(id), 1, 3 * NEAR));
    assert_eq!(d.agent_record(bob()).hired, 1);
}

#[test]
fn the_whole_chain_pays_the_sub_agent_and_the_agent_and_every_yocto_is_accounted_for() {
    let mut e = Env::new();
    let mut d = desk();
    let (id, sub) = with_sub_job(&mut e, &mut d);
    let mut out: u128 = 0;
    e.call(&bob(), 0);
    d.draw(U64(id), U128(2 * NEAR));
    out += paid_to(&bob());

    e.call(&carol(), 0);
    d.accept_job(U64(sub));
    e.call(&carol(), 0);
    d.draw(U64(sub), U128(NEAR));
    out += paid_to(&carol());
    e.call(&carol(), 0);
    d.deliver(U64(sub), PROOF.into());
    e.call(&bob(), 0);
    d.accept(U64(sub));
    // a sub-job pays no fee: carol gets the rest of 3
    assert_eq!(paid_to(&carol()), 2 * NEAR);
    assert_eq!(paid_to(&fees()), 0);
    out += paid_to(&carol());

    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.call(&alice(), 0);
    d.accept(U64(id));
    // 10 - fee 0.2 - advance 2 - sub-job 3 = 4.8
    assert_eq!(paid_to(&bob()), 48 * NEAR / 10);
    out += paid_to(&bob()) + paid_to(&fees()) + paid_to(&alice());
    assert_eq!(out, 10 * NEAR, "what went out is what was locked");
    assert_eq!(d.agent_record(carol()).paid, 1);
    assert_eq!(d.agent_record(bob()).open_drawn, 0);
}

#[test]
fn a_sub_job_refunded_while_the_job_is_open_gives_the_room_back() {
    let mut e = Env::new();
    let mut d = desk();
    let (id, sub) = with_sub_job(&mut e, &mut d);
    e.call(&carol(), 0);
    d.accept_job(U64(sub));
    e.call(&carol(), 0);
    d.draw(U64(sub), U128(NEAR));
    e.at(T0 + HOUR + 31 * MIN).call(&eve(), 0);
    d.refund(U64(sub));
    // 2 of carol's 3 were still locked: they go back into bob's job
    let p = d.get_job(U64(id)).unwrap();
    assert_eq!(p.reserved.0, NEAR, "only what carol drew stays spent");
    assert_eq!(d.room(U64(id)).0, 4 * NEAR);
    assert_eq!(d.agent_record(carol()).defaults, 1);
    assert!(events().contains(&"sub_job_returned".to_string()));
}

#[test]
fn a_sub_job_refunded_with_nothing_drawn_frees_the_agents_bond_again() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&bob(), NEAR);
    d.add_bond();
    let (_id, sub) = with_sub_job(&mut e, &mut d);
    assert_eq!(d.agent_record(bob()).open_drawn, 1);
    e.call(&bob(), 0);
    d.cancel(U64(sub));
    assert_eq!(d.agent_record(bob()).open_drawn, 0);
    e.call(&bob(), 0);
    d.take_bond(U128(NEAR));
}

#[test]
fn a_sub_job_refunded_after_the_job_was_paid_goes_to_the_agent_that_hired() {
    let mut e = Env::new();
    let mut d = desk();
    let (id, sub) = with_sub_job(&mut e, &mut d);
    e.call(&carol(), 0);
    d.accept_job(U64(sub));
    e.call(&bob(), 0);
    d.deliver(U64(id), PROOF.into());
    e.call(&alice(), 0);
    d.accept(U64(id));
    assert_eq!(paid_to(&bob()), 68 * NEAR / 10, "10 - 0.2 fee - 3 set aside");
    e.at(T0 + 2 * HOUR).call(&eve(), 0);
    d.refund(U64(sub));
    assert_eq!(paid_to(&bob()), 3 * NEAR, "the job was paid: the money set aside was bob's");
    assert_eq!(d.agent_record(carol()).missed, 1);
}

#[test]
fn a_sub_job_refunded_after_the_job_was_refunded_goes_back_to_the_customer() {
    let mut e = Env::new();
    let mut d = desk();
    let (id, sub) = with_sub_job(&mut e, &mut d);
    e.call(&carol(), 0);
    d.accept_job(U64(sub));
    e.at(T0 + 2 * HOUR + 31 * MIN).call(&eve(), 0);
    d.refund(U64(id));
    assert_eq!(paid_to(&alice()), 7 * NEAR, "what was not set aside");
    assert_eq!(d.agent_record(bob()).defaults, 1, "spending the customer's money and not delivering is a default");
    e.call(&eve(), 0);
    d.refund(U64(sub));
    assert_eq!(paid_to(&alice()), 3 * NEAR, "and the rest when the sub-job is refunded");
}

#[test]
fn a_sub_job_rejected_gives_half_back_to_the_job() {
    let mut e = Env::new();
    let mut d = desk();
    let (id, sub) = with_sub_job(&mut e, &mut d);
    e.call(&carol(), 0);
    d.accept_job(U64(sub));
    e.call(&carol(), 0);
    d.deliver(U64(sub), PROOF.into());
    e.call(&bob(), 0);
    d.reject(U64(sub));
    assert_eq!(paid_to(&carol()), 3 * NEAR / 2);
    assert_eq!(d.get_job(U64(id)).unwrap().reserved.0, 3 * NEAR / 2);
}

#[test]
fn a_sub_agent_can_hire_in_turn_down_to_the_depth_limit() {
    let mut e = Env::new();
    let mut d = desk();
    let (_id, sub) = with_sub_job(&mut e, &mut d);
    e.call(&carol(), 0);
    d.accept_job(U64(sub));
    e.call(&carol(), STORAGE);
    let subsub = d.hire(U64(sub), dave(), U128(NEAR), U64(e.now + HOUR), true, BRIEF.into()).0;
    assert_eq!(d.get_job(U64(subsub)).unwrap().depth, 2);
    e.call(&dave(), 0);
    d.accept_job(U64(subsub));
    e.call(&dave(), STORAGE);
    let deepest = d.hire(U64(subsub), eve(), U128(NEAR / 2), U64(e.now + HOUR), true, BRIEF.into()).0;
    assert_eq!(d.get_job(U64(deepest)).unwrap().depth, 3);
    e.call(&eve(), 0);
    d.accept_job(U64(deepest));
    e.call(&eve(), STORAGE);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        d.hire(U64(deepest), alice(), U128(NEAR / 100), U64(e.now + HOUR), true, BRIEF.into());
    }));
    assert!(r.is_err(), "no fourth level");
}

#[test]
#[should_panic(expected = "an agent cannot hire itself")]
fn an_agent_cannot_hire_itself() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, 10 * NEAR);
    e.call(&bob(), STORAGE);
    d.hire(U64(id), bob(), U128(NEAR), U64(e.now + HOUR), true, BRIEF.into());
}

#[test]
#[should_panic(expected = "only the job's agent can hire for it")]
fn a_stranger_cannot_hire_on_someone_elses_job() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, 10 * NEAR);
    e.call(&eve(), STORAGE);
    d.hire(U64(id), carol(), U128(NEAR), U64(e.now + HOUR), true, BRIEF.into());
}

#[test]
#[should_panic(expected = "a sub-job must be due by the job's due time")]
fn a_sub_job_due_after_the_job_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, 10 * NEAR);
    e.call(&bob(), STORAGE);
    d.hire(U64(id), carol(), U128(NEAR), U64(e.now + 3 * HOUR), true, BRIEF.into());
}

#[test]
#[should_panic(expected = "more than half of the job")]
fn hiring_for_more_than_half_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, 10 * NEAR);
    e.call(&bob(), STORAGE);
    d.hire(U64(id), carol(), U128(5 * NEAR + 1), U64(e.now + HOUR), true, BRIEF.into());
}

#[test]
#[should_panic(expected = "the customer did not allow spending before delivery")]
fn hiring_on_a_job_without_advances_fails() {
    let mut e = Env::new();
    let mut d = desk();
    e.call(&alice(), 10 * NEAR + STORAGE);
    let id = d.lock(Some(bob()), U128(10 * NEAR), U64(e.now + 2 * HOUR), false, BRIEF.into(), None).0;
    e.call(&bob(), 0);
    d.accept_job(U64(id));
    e.call(&bob(), STORAGE);
    d.hire(U64(id), carol(), U128(NEAR), U64(e.now + HOUR), true, BRIEF.into());
}

#[test]
#[should_panic(expected = "attach")]
fn hiring_without_storage_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, 10 * NEAR);
    e.call(&bob(), 0);
    d.hire(U64(id), carol(), U128(NEAR), U64(e.now + HOUR), true, BRIEF.into());
}

#[test]
#[should_panic(expected = "too many sub-jobs")]
fn more_than_eight_sub_jobs_fails() {
    let mut e = Env::new();
    let mut d = desk();
    let id = lock_and_take(&mut e, &mut d, 10 * NEAR);
    for i in 0..9 {
        e.call(&bob(), STORAGE);
        d.hire(U64(id), a(&format!("sub{i}.testnet")), U128(NEAR / 10), U64(e.now + HOUR), true, BRIEF.into());
    }
}

#[test]
fn a_sub_job_answered_by_nobody_is_settled_by_anyone() {
    let mut e = Env::new();
    let mut d = desk();
    let (_id, sub) = with_sub_job(&mut e, &mut d);
    e.call(&carol(), 0);
    d.accept_job(U64(sub));
    e.call(&carol(), 0);
    d.deliver(U64(sub), PROOF.into());
    e.at(T0 + HOUR + 1).call(&eve(), 0);
    d.settle(U64(sub));
    assert_eq!(paid_to(&carol()), 3 * NEAR);
}

// ── many jobs: the books balance ─────────────────────────────────────────────────────────────────────────

#[test]
fn many_jobs_every_way_and_what_went_out_is_what_came_in() {
    let mut e = Env::new();
    let mut d = desk();
    let mut locked: u128 = 0;
    let mut out: u128 = 0;
    let tally = |out: &mut u128| {
        // storage refunds go back to the payer of the call and are not part of a job: count only job payouts
        for (to, token, x) in payouts() {
            if token.is_none() && (to == alice() || to == bob() || to == carol() || to == fees()) {
                *out += x;
            }
        }
    };
    for k in 0..12u128 {
        let price = NEAR + k * NEAR / 7;
        locked += price;
        e.now = T0 + (k as u64) * 10 * HOUR;
        let start = e.now;
        e.call(&alice(), price + STORAGE);
        let id = d.lock(Some(bob()), U128(price), U64(start + 2 * HOUR), true, BRIEF.into(), None).0;
        // the storage refund to alice is not a job payout
        e.call(&bob(), 0);
        d.accept_job(U64(id));
        let half = price / 2;
        if k % 2 == 0 {
            e.call(&bob(), 0);
            d.draw(U64(id), U128(half / 3));
            tally(&mut out);
        }
        if k % 3 == 0 {
            e.call(&bob(), STORAGE);
            let sub = d.hire(U64(id), carol(), U128(half / 2), U64(start + HOUR), true, BRIEF.into()).0;
            e.call(&carol(), 0);
            d.accept_job(U64(sub));
            if k % 2 == 0 {
                e.call(&carol(), 0);
                d.deliver(U64(sub), PROOF.into());
                e.call(&bob(), 0);
                d.accept(U64(sub));
                tally(&mut out);
            } else {
                e.at(start + HOUR + 31 * MIN).call(&eve(), 0);
                d.refund(U64(sub));
                tally(&mut out);
            }
        }
        match k % 4 {
            0 | 1 => {
                e.at(start + 90 * MIN).call(&bob(), 0);
                d.deliver(U64(id), PROOF.into());
                e.call(&alice(), 0);
                d.accept(U64(id));
            }
            2 => {
                e.at(start + 90 * MIN).call(&bob(), 0);
                d.deliver(U64(id), PROOF.into());
                e.call(&alice(), 0);
                d.reject(U64(id));
            }
            _ => {
                e.at(start + 3 * HOUR).call(&eve(), 0);
                d.refund(U64(id));
            }
        }
        tally(&mut out);
    }
    assert_eq!(out, locked, "every yocto locked went out to an agent, the fee account or back to the customer");
    let r = d.agent_record(bob());
    assert_eq!(r.open_drawn, 0);
    assert_eq!(r.accepted, 12);
}
