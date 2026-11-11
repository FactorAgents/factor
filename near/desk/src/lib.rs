//! Factor desk on NEAR.
//!
//! A customer locks the pay of a job in this contract, in NEAR or in an allowed NEP-141 token. An agent accepts it,
//! may draw an advance of up to half of the locked pay before it delivers, and may hire other agents for part of
//! the work out of the same half (a sub-job). The agent delivers the fingerprint of the work; the customer accepts,
//! or rejects within the review window and the job settles at half, or says nothing and anyone settles it in full
//! when the window ends. The advance is settled out of the payment. A job that is not delivered by its due time
//! plus the grace is refunded to the customer, less what the agent already drew, and the agent's bond pays the
//! customer back first.
//!
//! The contract has no owner, no pause and no upgrade method. Every amount is paid out by a promise whose callback
//! keeps a failed payout as a balance its owner can withdraw, so a failed transfer never loses money and never
//! blocks a job.

#![allow(clippy::too_many_arguments)] // the contract's own methods take each field of a job by name

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

#[cfg(test)]
mod tests;

/// The most a job's agent may spend before it delivers, advances and sub-jobs together: half of the job.
pub const ADVANCE_DIVISOR: u128 = 2;
/// The highest job fee the contract can be made with: 5%.
pub const MAX_FEE_BPS: u16 = 500;
/// The longest a job may run.
pub const MAX_DURATION_MS: u64 = 90 * 24 * 3600 * 1000;
/// Sub-jobs under one job, and how deep sub-jobs may nest.
pub const MAX_CHILDREN: usize = 8;
pub const MAX_DEPTH: u8 = 3;
/// A fingerprint is a sha256 in hex; a note (for example a NEAR Intents deposit address) is short.
pub const HASH_LEN: usize = 64;
pub const MAX_NOTE_LEN: usize = 160;

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_PAYOUT: Gas = Gas::from_tgas(5);
/// What a method that may pay up to three parties needs attached.
const GAS_FOR_PAYOUTS: Gas = Gas::from_tgas(60);
const EVENT_STANDARD: &str = "factor-desk";
const EVENT_VERSION: &str = "1.0.0";

#[ext_contract(ext_ft)]
pub trait FungibleTokenCore {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_self)]
pub trait DeskCallbacks {
    fn on_payout(&mut self, to: AccountId, token: Option<AccountId>, amount: U128);
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Jobs,
    Agents,
    Owed,
    Tokens,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Locked, waiting for its agent to accept it.
    Open,
    /// Accepted; the agent may draw, hire and deliver.
    Working,
    /// The fingerprint of the work is on the desk; the review window runs.
    Delivered,
    /// Paid in full: accepted, or not answered within the review window.
    Paid,
    /// Rejected within the review window: settled at half.
    Half,
    /// Not delivered by its due time plus the grace: the customer was refunded.
    Refunded,
    /// Cancelled before work started, or declined by its agent with nothing drawn.
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Job {
    pub id: u64,
    /// Who accepts or rejects the delivery and is refunded. For a sub-job: the agent that hired.
    pub customer: AccountId,
    /// Who sent the money (for a NEAR Intents payment, the account that delivered the tokens).
    pub payer: AccountId,
    /// None: an open job any agent may take.
    pub agent: Option<AccountId>,
    /// None: NEAR. Otherwise the NEP-141 token account.
    pub token: Option<AccountId>,
    pub price: U128,
    /// Paid to the agent before delivery.
    pub advanced: U128,
    /// Set aside for sub-jobs out of this job's half, and not given back.
    pub reserved: U128,
    pub allow_advance: bool,
    pub parent: Option<u64>,
    pub depth: u8,
    pub children: Vec<u64>,
    /// sha256 of the brief, in hex.
    pub brief: String,
    /// sha256 of the delivered work, in hex.
    pub proof: Option<String>,
    /// Where the money came from, for example `intents:<deposit address>`.
    pub note: Option<String>,
    pub status: Status,
    pub created_ms: U64,
    pub due_ms: U64,
    pub accepted_ms: Option<U64>,
    pub delivered_ms: Option<U64>,
    pub closed_ms: Option<U64>,
    /// What the settlement paid: the agent's rest, the fee, and what went back to the customer's side.
    pub paid_agent: U128,
    pub fee: U128,
    pub returned: U128,
    /// What the agent's bond paid the customer when the job was refunded.
    pub slashed: U128,
}

/// An agent's public record on this desk. The credit report reads the jobs themselves; this is the short form.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct AgentRecord {
    pub accepted: u32,
    pub delivered: u32,
    pub on_time: u32,
    pub paid: u32,
    pub half: u32,
    /// Refunded with something drawn on it.
    pub defaults: u32,
    /// Refunded with nothing drawn on it.
    pub missed: u32,
    /// Jobs it drew an advance on, and of those the ones settled out of the payment.
    pub advanced_jobs: u32,
    pub repaid_jobs: u32,
    /// Sub-jobs it gave to other agents.
    pub hired: u32,
    /// NEAR it earned on NEAR jobs (the gross of each settlement), and its bond.
    pub earned_near: U128,
    pub bond: U128,
    /// Jobs with money drawn on them that are not settled: the bond cannot be taken while this is above 0.
    pub open_drawn: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct TokenRule {
    pub token: AccountId,
    /// The smallest job in this token, in its smallest unit.
    pub min_amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub fee_account: AccountId,
    pub fee_bps: u16,
    pub review_ms: U64,
    pub grace_ms: U64,
    pub min_duration_ms: U64,
    pub min_near: U128,
    pub tokens: Vec<TokenRule>,
    pub jobs: U64,
}

/// The `msg` of `ft_transfer_call` that locks a job.
#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct LockMsg {
    /// Defaults to the sender. A payment through NEAR Intents names the customer here.
    pub customer: Option<AccountId>,
    pub agent: Option<AccountId>,
    pub due_ms: U64,
    pub allow_advance: bool,
    pub brief: String,
    pub note: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct FactorDesk {
    fee_account: AccountId,
    fee_bps: u16,
    review_ms: u64,
    grace_ms: u64,
    min_duration_ms: u64,
    min_near: u128,
    tokens: LookupMap<AccountId, u128>,
    token_list: Vec<TokenRule>,
    jobs: LookupMap<u64, Job>,
    next_id: u64,
    agents: LookupMap<AccountId, AgentRecord>,
    /// Payouts that failed, by "account|token" (token empty for NEAR), waiting to be withdrawn.
    owed: LookupMap<String, u128>,
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn is_hex_hash(s: &str) -> bool {
    s.len() == HASH_LEN && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn owed_key(who: &AccountId, token: &Option<AccountId>) -> String {
    format!("{}|{}", who, token.as_ref().map(|t| t.as_str()).unwrap_or(""))
}

fn event(name: &str, data: serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": name, "data": [data] })));
}

#[near]
impl FactorDesk {
    /// Every number is fixed here, for good: there is no method that changes them.
    #[init]
    pub fn new(
        fee_account: AccountId,
        fee_bps: u16,
        review_ms: U64,
        grace_ms: U64,
        min_duration_ms: U64,
        min_near: U128,
        tokens: Vec<TokenRule>,
    ) -> Self {
        require!(fee_bps <= MAX_FEE_BPS, "fee too high");
        require!(review_ms.0 > 0 && grace_ms.0 > 0 && min_duration_ms.0 > 0, "windows must be above zero");
        require!(min_near.0 > 0, "min_near must be above zero");
        require!(tokens.len() <= 8, "at most 8 tokens");
        let mut map = LookupMap::new(Key::Tokens);
        for t in &tokens {
            require!(t.min_amount.0 > 0, "a token's min_amount must be above zero");
            map.insert(t.token.clone(), t.min_amount.0);
        }
        Self {
            fee_account,
            fee_bps,
            review_ms: review_ms.0,
            grace_ms: grace_ms.0,
            min_duration_ms: min_duration_ms.0,
            min_near: min_near.0,
            tokens: map,
            token_list: tokens,
            jobs: LookupMap::new(Key::Jobs),
            next_id: 0,
            agents: LookupMap::new(Key::Agents),
            owed: LookupMap::new(Key::Owed),
        }
    }

    // ── locking a job ──────────────────────────────────────────────────────────────────────────────────

    /// Lock a job in NEAR. Attach the price plus the storage of the job's record; the rest comes back.
    #[payable]
    pub fn lock(
        &mut self,
        agent: Option<AccountId>,
        price: U128,
        due_ms: U64,
        allow_advance: bool,
        brief: String,
        note: Option<String>,
    ) -> U64 {
        let payer = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        require!(price.0 >= self.min_near, "price below the smallest job");
        require!(attached >= price.0, "attach the price of the job");
        let before = env::storage_usage();
        let id = self.create_job(payer.clone(), payer.clone(), agent, None, price.0, due_ms.0, allow_advance, brief, note, None);
        self.charge_storage(&payer, before, attached - price.0);
        U64(id)
    }

    /// NEP-141 receiver: a token payment with a `LockMsg` as `msg` locks a job. A malformed message or a token
    /// that is not allowed panics, and the token contract gives the whole amount back to the sender.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let min = *self.tokens.get(&token).unwrap_or_else(|| env::panic_str("token not allowed on this desk"));
        require!(amount.0 >= min, "amount below the smallest job in this token");
        let m: LockMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("msg is not a lock message"));
        let customer = m.customer.unwrap_or_else(|| sender_id.clone());
        // The contract pays the storage of a token job: tokens are allowed one by one, each with a smallest job.
        self.create_job(customer, sender_id, m.agent, Some(token), amount.0, m.due_ms.0, m.allow_advance, m.brief, m.note, None);
        PromiseOrValue::Value(U128(0))
    }

    // ── the agent ──────────────────────────────────────────────────────────────────────────────────────

    /// Take a job: the named agent, or for an open job any account that is not its customer or payer.
    pub fn accept_job(&mut self, id: U64) {
        let who = env::predecessor_account_id();
        let mut j = self.job_or_panic(id.0);
        require!(j.status == Status::Open, "job is not open");
        require!(now_ms() < j.due_ms.0, "job is past its due time");
        match &j.agent {
            Some(a) => require!(*a == who, "job is for another agent"),
            None => require!(who != j.customer && who != j.payer, "a customer cannot take its own job"),
        }
        j.agent = Some(who.clone());
        j.status = Status::Working;
        j.accepted_ms = Some(U64(now_ms()));
        self.jobs.insert(j.id, j.clone());
        self.record_mut(&who).accepted += 1;
        event("job_accepted", json!({ "id": U64(j.id), "agent": who }));
    }

    /// Give a job back: before it is taken, or after it is taken with nothing drawn or set aside on it.
    pub fn decline(&mut self, id: U64) {
        let who = env::predecessor_account_id();
        let mut j = self.job_or_panic(id.0);
        require!(j.agent.as_ref() == Some(&who), "only the job's agent can decline it");
        require!(matches!(j.status, Status::Open | Status::Working), "job cannot be declined now");
        require!(j.advanced.0 == 0 && j.reserved.0 == 0, "money was drawn on this job: deliver it");
        self.close_unworked(&mut j);
        event("job_declined", json!({ "id": U64(j.id), "agent": who }));
    }

    /// Draw an advance: up to half of the job, less what was already drawn or set aside for sub-jobs.
    pub fn draw(&mut self, id: U64, amount: U128) {
        self.require_payout_gas(1);
        let who = env::predecessor_account_id();
        let mut j = self.job_or_panic(id.0);
        require!(j.agent.as_ref() == Some(&who), "only the job's agent can draw on it");
        require!(j.status == Status::Working, "job is not being worked on");
        require!(j.allow_advance, "the customer did not allow advances on this job");
        require!(now_ms() < j.due_ms.0, "job is past its due time");
        require!(amount.0 > 0, "nothing to draw");
        require!(amount.0 <= Self::room_of(&j), "more than half of the job");
        let first = j.advanced.0 == 0 && j.reserved.0 == 0;
        j.advanced = U128(j.advanced.0 + amount.0);
        self.jobs.insert(j.id, j.clone());
        let r = self.record_mut(&who);
        if j.advanced.0 == amount.0 {
            r.advanced_jobs += 1;
        }
        if first {
            r.open_drawn += 1;
        }
        event("advance_drawn", json!({ "id": U64(j.id), "agent": who, "amount": amount, "token": j.token }));
        self.pay(&who, &j.token, amount.0);
    }

    /// Hire another agent for part of this job, paid out of this job's half. Attach the storage of the sub-job's
    /// record; the rest comes back. The sub-job is an ordinary job whose customer is the hiring agent.
    #[payable]
    pub fn hire(&mut self, parent: U64, agent: AccountId, amount: U128, due_ms: U64, allow_advance: bool, brief: String) -> U64 {
        let who = env::predecessor_account_id();
        let mut p = self.job_or_panic(parent.0);
        require!(p.agent.as_ref() == Some(&who), "only the job's agent can hire for it");
        require!(p.status == Status::Working, "job is not being worked on");
        require!(p.allow_advance, "the customer did not allow spending before delivery on this job");
        require!(agent != who, "an agent cannot hire itself");
        require!(now_ms() < p.due_ms.0, "job is past its due time");
        require!(due_ms.0 <= p.due_ms.0, "a sub-job must be due by the job's due time");
        require!(p.depth < MAX_DEPTH, "sub-jobs nest too deep");
        require!(p.children.len() < MAX_CHILDREN, "too many sub-jobs");
        require!(amount.0 >= self.min_for(&p.token), "sub-job below the smallest job");
        require!(amount.0 <= Self::room_of(&p), "more than half of the job");
        let first = p.advanced.0 == 0 && p.reserved.0 == 0;
        let before = env::storage_usage();
        p.reserved = U128(p.reserved.0 + amount.0);
        let child = self.next_id;
        p.children.push(child);
        self.jobs.insert(p.id, p.clone());
        let id = self.create_job(
            who.clone(),
            who.clone(),
            Some(agent),
            p.token.clone(),
            amount.0,
            due_ms.0,
            allow_advance,
            brief,
            None,
            Some(&p),
        );
        let r = self.record_mut(&who);
        r.hired += 1;
        if first {
            r.open_drawn += 1;
        }
        self.charge_storage(&who, before, env::attached_deposit().as_yoctonear());
        U64(id)
    }

    /// Deliver: the sha256 of the work, in hex. Possible until the due time plus the grace.
    pub fn deliver(&mut self, id: U64, proof: String) {
        let who = env::predecessor_account_id();
        let mut j = self.job_or_panic(id.0);
        require!(j.agent.as_ref() == Some(&who), "only the job's agent can deliver it");
        require!(j.status == Status::Working, "job is not being worked on");
        require!(is_hex_hash(&proof), "proof must be a sha256 in hex");
        let now = now_ms();
        require!(now <= j.due_ms.0 + self.grace_ms, "too late: the job can be refunded");
        j.status = Status::Delivered;
        j.proof = Some(proof.clone());
        j.delivered_ms = Some(U64(now));
        self.jobs.insert(j.id, j.clone());
        let r = self.record_mut(&who);
        r.delivered += 1;
        if now <= j.due_ms.0 {
            r.on_time += 1;
        }
        event("job_delivered", json!({ "id": U64(j.id), "agent": who, "proof": proof, "on_time": now <= j.due_ms.0 }));
    }

    /// Put up a NEAR bond. If a job with money drawn on it is refunded, the bond pays the customer back first.
    #[payable]
    pub fn add_bond(&mut self) -> U128 {
        let who = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach the bond");
        let r = self.record_mut(&who);
        r.bond = U128(r.bond.0 + amount);
        let bond = r.bond;
        event("bond_added", json!({ "agent": who, "amount": U128(amount), "bond": bond }));
        bond
    }

    /// Take bond back, only while no job with money drawn on it is open.
    pub fn take_bond(&mut self, amount: U128) -> U128 {
        self.require_payout_gas(1);
        let who = env::predecessor_account_id();
        let r = self.record_mut(&who);
        require!(r.open_drawn == 0, "a job with money drawn on it is open");
        require!(amount.0 > 0 && amount.0 <= r.bond.0, "more than the bond");
        r.bond = U128(r.bond.0 - amount.0);
        let bond = r.bond;
        event("bond_taken", json!({ "agent": who, "amount": amount, "bond": bond }));
        self.pay(&who, &None, amount.0);
        bond
    }

    // ── the customer ───────────────────────────────────────────────────────────────────────────────────

    /// Cancel a job no agent has taken yet: the whole price comes back.
    pub fn cancel(&mut self, id: U64) {
        let who = env::predecessor_account_id();
        let mut j = self.job_or_panic(id.0);
        require!(j.customer == who, "only the job's customer can cancel it");
        require!(j.status == Status::Open, "job was already taken");
        self.close_unworked(&mut j);
        event("job_cancelled", json!({ "id": U64(j.id), "customer": who }));
    }

    /// Accept the delivery: the job is paid in full.
    pub fn accept(&mut self, id: U64) {
        let who = env::predecessor_account_id();
        let mut j = self.job_or_panic(id.0);
        require!(j.customer == who, "only the job's customer can accept it");
        require!(j.status == Status::Delivered, "job is not delivered");
        self.settle_job(&mut j, true);
    }

    /// Reject the delivery within the review window: the job settles at half.
    pub fn reject(&mut self, id: U64) {
        let who = env::predecessor_account_id();
        let mut j = self.job_or_panic(id.0);
        require!(j.customer == who, "only the job's customer can reject it");
        require!(j.status == Status::Delivered, "job is not delivered");
        require!(now_ms() <= j.delivered_ms.unwrap().0 + self.review_ms, "the review window is over");
        self.settle_job(&mut j, false);
    }

    // ── anyone, on time ────────────────────────────────────────────────────────────────────────────────

    /// A delivery the customer did not answer within the review window is paid in full.
    pub fn settle(&mut self, id: U64) {
        let mut j = self.job_or_panic(id.0);
        require!(j.status == Status::Delivered, "job is not delivered");
        require!(now_ms() > j.delivered_ms.unwrap().0 + self.review_ms, "the review window is still open");
        self.settle_job(&mut j, true);
    }

    /// A job not delivered by its due time plus the grace is refunded: the customer gets back what is still
    /// locked, and the agent's bond pays back what the agent drew, as far as it goes.
    pub fn refund(&mut self, id: U64) {
        self.require_payout_gas(2);
        let mut j = self.job_or_panic(id.0);
        require!(matches!(j.status, Status::Open | Status::Working), "job cannot be refunded");
        require!(now_ms() > j.due_ms.0 + self.grace_ms, "the job is not late yet");
        if j.status == Status::Open {
            self.close_unworked(&mut j);
            event("job_cancelled", json!({ "id": U64(j.id), "reason": "never taken" }));
            return;
        }
        let agent = j.agent.clone().unwrap();
        let spent = j.advanced.0 + j.reserved.0;
        let back = j.price.0 - spent;
        let r = self.record_mut(&agent);
        let slash = spent.min(r.bond.0);
        r.bond = U128(r.bond.0 - slash);
        if spent > 0 {
            r.defaults += 1;
            r.open_drawn -= 1;
        } else {
            r.missed += 1;
        }
        j.status = Status::Refunded;
        j.closed_ms = Some(U64(now_ms()));
        j.returned = U128(back);
        j.slashed = U128(slash);
        self.jobs.insert(j.id, j.clone());
        event(
            "job_refunded",
            json!({ "id": U64(j.id), "agent": agent, "returned": U128(back), "slashed": U128(slash), "default": spent > 0 }),
        );
        self.give_back(&j, back);
        // The bond is NEAR whatever the job's token: it goes to the job's customer.
        self.pay(&j.customer.clone(), &None, slash);
    }

    /// Take a payout that failed (an account without storage on a token, for example).
    pub fn withdraw(&mut self, token: Option<AccountId>) -> U128 {
        self.require_payout_gas(1);
        let who = env::predecessor_account_id();
        let key = owed_key(&who, &token);
        let amount = self.owed.get(&key).copied().unwrap_or(0);
        require!(amount > 0, "nothing owed");
        self.owed.remove(&key);
        event("withdrawn", json!({ "account": who, "token": token, "amount": U128(amount) }));
        self.pay(&who, &token, amount);
        U128(amount)
    }

    /// Callback of every payout: a failed one is kept for its owner to withdraw.
    #[private]
    pub fn on_payout(&mut self, to: AccountId, token: Option<AccountId>, amount: U128) -> bool {
        // #[private] says the same; said here too so the rule holds and is tested in the contract's own code
        require!(env::predecessor_account_id() == env::current_account_id(), "only the desk calls this");
        match env::promise_result_checked(0, 64) {
            Err(PromiseError::Failed) => {
                let key = owed_key(&to, &token);
                let had = self.owed.get(&key).copied().unwrap_or(0);
                self.owed.insert(key, had + amount.0);
                event("payout_failed", json!({ "account": to, "token": token, "amount": amount }));
                false
            }
            _ => true,
        }
    }

    // ── reading ────────────────────────────────────────────────────────────────────────────────────────

    pub fn get_config(&self) -> Config {
        Config {
            fee_account: self.fee_account.clone(),
            fee_bps: self.fee_bps,
            review_ms: U64(self.review_ms),
            grace_ms: U64(self.grace_ms),
            min_duration_ms: U64(self.min_duration_ms),
            min_near: U128(self.min_near),
            tokens: self.token_list.clone(),
            jobs: U64(self.next_id),
        }
    }

    pub fn get_job(&self, id: U64) -> Option<Job> {
        self.jobs.get(&id.0).cloned()
    }

    /// Jobs by number, from `from`, at most 100 at a time.
    pub fn get_jobs(&self, from: U64, limit: u64) -> Vec<Job> {
        let end = self.next_id.min(from.0.saturating_add(limit.min(100)));
        (from.0..end).filter_map(|i| self.jobs.get(&i).cloned()).collect()
    }

    /// Jobs waiting for an agent: open to anyone, or named for `agent` when it is given. Scans from `from`.
    pub fn open_jobs(&self, agent: Option<AccountId>, from: U64, limit: u64) -> Vec<Job> {
        let end = self.next_id.min(from.0.saturating_add(200));
        let now = now_ms();
        (from.0..end)
            .filter_map(|i| self.jobs.get(&i))
            .filter(|j| j.status == Status::Open && j.due_ms.0 > now)
            .filter(|j| match (&j.agent, &agent) {
                (None, _) => true,
                (Some(a), Some(b)) => a == b,
                (Some(_), None) => false,
            })
            .take(limit.min(50) as usize)
            .cloned()
            .collect()
    }

    pub fn agent_record(&self, account: AccountId) -> AgentRecord {
        self.agents.get(&account).cloned().unwrap_or_default()
    }

    /// How much more the job's agent may draw or set aside for sub-jobs right now.
    pub fn room(&self, id: U64) -> U128 {
        U128(Self::room_of(&self.job_or_panic(id.0)))
    }

    pub fn owed_of(&self, account: AccountId, token: Option<AccountId>) -> U128 {
        U128(self.owed.get(&owed_key(&account, &token)).copied().unwrap_or(0))
    }

    // ── inside ─────────────────────────────────────────────────────────────────────────────────────────

    fn room_of(j: &Job) -> u128 {
        (j.price.0 / ADVANCE_DIVISOR).saturating_sub(j.advanced.0 + j.reserved.0)
    }

    fn min_for(&self, token: &Option<AccountId>) -> u128 {
        match token {
            None => self.min_near,
            Some(t) => *self.tokens.get(t).unwrap_or_else(|| env::panic_str("token not allowed on this desk")),
        }
    }

    fn job_or_panic(&self, id: u64) -> Job {
        self.jobs.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such job"))
    }

    fn record_mut(&mut self, who: &AccountId) -> &mut AgentRecord {
        if !self.agents.contains_key(who) {
            self.agents.insert(who.clone(), AgentRecord::default());
        }
        self.agents.get_mut(who).unwrap()
    }

    fn require_payout_gas(&self, payouts: u64) {
        let need = Gas::from_gas(GAS_FOR_PAYOUTS.as_gas() / 3 * payouts.max(1));
        require!(env::prepaid_gas() >= need, "attach more gas: payouts are made in the same call");
    }

    #[allow(clippy::too_many_arguments)]
    fn create_job(
        &mut self,
        customer: AccountId,
        payer: AccountId,
        agent: Option<AccountId>,
        token: Option<AccountId>,
        price: u128,
        due_ms: u64,
        allow_advance: bool,
        brief: String,
        note: Option<String>,
        parent: Option<&Job>,
    ) -> u64 {
        let now = now_ms();
        require!(due_ms >= now + self.min_duration_ms, "due time too soon");
        require!(due_ms <= now + MAX_DURATION_MS, "due time too far");
        require!(is_hex_hash(&brief), "brief must be a sha256 in hex");
        if let Some(n) = &note {
            require!(n.len() <= MAX_NOTE_LEN, "note too long");
        }
        if let Some(a) = &agent {
            require!(*a != customer && *a != payer, "a customer cannot hire itself");
        }
        let id = self.next_id;
        self.next_id += 1;
        let j = Job {
            id,
            customer,
            payer,
            agent,
            token,
            price: U128(price),
            advanced: U128(0),
            reserved: U128(0),
            allow_advance,
            parent: parent.map(|p| p.id),
            depth: parent.map(|p| p.depth + 1).unwrap_or(0),
            children: vec![],
            brief,
            proof: None,
            note,
            status: Status::Open,
            created_ms: U64(now),
            due_ms: U64(due_ms),
            accepted_ms: None,
            delivered_ms: None,
            closed_ms: None,
            paid_agent: U128(0),
            fee: U128(0),
            returned: U128(0),
            slashed: U128(0),
        };
        event(
            "job_locked",
            json!({
                "id": U64(id), "customer": j.customer, "payer": j.payer, "agent": j.agent, "token": j.token,
                "price": j.price, "due_ms": j.due_ms, "parent": j.parent.map(U64), "note": j.note,
            }),
        );
        self.jobs.insert(id, j);
        id
    }

    /// The caller pays the storage its call added, out of `available`; what is left comes back to it.
    fn charge_storage(&mut self, who: &AccountId, before: u64, available: u128) {
        // the maps keep their writes until the call ends: write them now so the storage they take can be measured
        self.jobs.flush();
        self.agents.flush();
        let used = env::storage_usage().saturating_sub(before) as u128;
        let cost = used * env::storage_byte_cost().as_yoctonear();
        if available < cost {
            env::panic_str(&format!("attach {} yoctoNEAR more for storage ({} bytes)", cost - available, used));
        }
        let rest = available - cost;
        if rest > 0 {
            Promise::new(who.clone()).transfer(NearToken::from_yoctonear(rest)).detach();
        }
    }

    /// A job closed before any work was paid for: everything goes back to its customer's side.
    fn close_unworked(&mut self, j: &mut Job) {
        j.status = Status::Cancelled;
        j.closed_ms = Some(U64(now_ms()));
        j.returned = j.price;
        self.jobs.insert(j.id, j.clone());
        self.give_back(j, j.price.0);
    }

    /// Settle a delivered job in full or at half. The agent's side is the full price or half of it; out of it
    /// come the advance already paid, what was set aside for sub-jobs, and the fee (a top job only).
    fn settle_job(&mut self, j: &mut Job, full: bool) {
        self.require_payout_gas(3);
        let agent = j.agent.clone().unwrap();
        let price = j.price.0;
        let gross = if full { price } else { price / 2 };
        let back = price - gross;
        let spent = j.advanced.0 + j.reserved.0;
        let mut fee = if j.parent.is_none() { gross * self.fee_bps as u128 / 10_000 } else { 0 };
        fee = fee.min(gross - spent);
        let to_agent = gross - spent - fee;
        j.status = if full { Status::Paid } else { Status::Half };
        j.closed_ms = Some(U64(now_ms()));
        j.paid_agent = U128(to_agent);
        j.fee = U128(fee);
        j.returned = U128(back);
        self.jobs.insert(j.id, j.clone());
        let is_near = j.token.is_none();
        let r = self.record_mut(&agent);
        if full {
            r.paid += 1;
        } else {
            r.half += 1;
        }
        if j.advanced.0 > 0 {
            r.repaid_jobs += 1;
        }
        if spent > 0 {
            r.open_drawn -= 1;
        }
        if is_near {
            r.earned_near = U128(r.earned_near.0 + gross);
        }
        event(
            if full { "job_paid" } else { "job_half" },
            json!({
                "id": U64(j.id), "agent": agent, "gross": U128(gross), "advance_settled": j.advanced,
                "sub_jobs": j.reserved, "fee": U128(fee), "to_agent": U128(to_agent), "returned": U128(back),
            }),
        );
        let token = j.token.clone();
        self.pay(&agent, &token, to_agent);
        let fee_account = self.fee_account.clone();
        self.pay(&fee_account, &token, fee);
        self.give_back(j, back);
    }

    /// Money that goes back to a job's customer side. For a top job that is its customer. For a sub-job it goes
    /// back into the job that hired it: still open, it is room again; paid, it is that agent's; refunded or
    /// cancelled, it goes on back to that job's customer side.
    fn give_back(&mut self, j: &Job, amount: u128) {
        if amount == 0 {
            return;
        }
        match j.parent {
            None => self.pay(&j.customer.clone(), &j.token.clone(), amount),
            Some(pid) => {
                let mut p = self.job_or_panic(pid);
                match p.status {
                    Status::Working | Status::Delivered | Status::Open => {
                        p.reserved = U128(p.reserved.0 - amount);
                        self.jobs.insert(p.id, p.clone());
                        if p.advanced.0 == 0 && p.reserved.0 == 0 {
                            // nothing is drawn on the job any more: it no longer holds the agent's bond
                            let a = p.agent.clone().unwrap();
                            self.record_mut(&a).open_drawn -= 1;
                        }
                        event("sub_job_returned", json!({ "id": U64(p.id), "from": U64(j.id), "amount": U128(amount) }));
                    }
                    Status::Paid | Status::Half => {
                        let a = p.agent.clone().unwrap();
                        self.pay(&a, &p.token.clone(), amount);
                    }
                    Status::Refunded | Status::Cancelled => self.give_back(&p, amount),
                }
            }
        }
    }

    /// Pay out, with a callback that keeps a failed payout for its owner.
    fn pay(&mut self, to: &AccountId, token: &Option<AccountId>, amount: u128) {
        if amount == 0 {
            return;
        }
        let callback =
            ext_self::ext(env::current_account_id()).with_static_gas(GAS_ON_PAYOUT).on_payout(to.clone(), token.clone(), U128(amount));
        match token {
            None => Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount)).then(callback).detach(),
            Some(t) => ext_ft::ext(t.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(to.clone(), U128(amount), Some("factor-desk".into()))
                .then(callback)
                .detach(),
        }
    }
}
