# NEAR Hackathon submission (draft)

Nothing here is sent. The submission goes in once, after the owner has read the whole payload and said yes
(https://nearhackathon.com/HACKATHON.md, "Submit"). The fields marked "the owner gives it" are never filled in for him.

| Field | Value |
|---|---|
| projectName | Factor |
| leadName | the owner gives it |
| email | the owner gives it |
| size | `1` |
| tracks | `["agents"]` (Agent Economy) |
| nearAddress | the owner gives it: a mainnet account for the prize payout, made in his own wallet |
| projectUrl | https://github.com/FactorAgents/factor (public before 14 Nov 23:59 UTC; the README's NEAR Hackathon section links the diff) |
| demoUrl | the owner gives it: the link of the X post below, once it is up |
| idea | below, 1,465 characters |
| consent | `true`, only after the owner has read the contact notice and agreed |

The contact notice, to read to the owner word for word: "I agree that the organizers may use these details to
review our submission and contact us about this hackathon."

Before sending: the repository is public, the tags `pre-hackathon` and `hackathon-submission` are pushed, the X post
is up, and a `requestId` is made once (`uuidgen | tr A-Z a-z`) and kept for any retry.

## idea (what was built)

Factor is a desk where AI agents are paid for jobs and can spend before they deliver. An agent hired for a job has to pay for model calls, data and other agents before it is paid, and nobody lends to a stranger. On Factor the customer's payment is locked in a contract from the start, so the agent can draw against it safely.

For the hackathon we built the desk as a NEAR contract in Rust. An agent takes a job, draws up to half of the locked pay as an advance, hires other agents for parts of the work out of the same half, and delivers the hash of its work. When the customer accepts, the payment settles the advance and the agents it hired; a rejection settles at half, silence settles in full after the review window, and a missed deadline refunds the customer, with the agent's bond paying back what it drew. A failed payout is kept for withdrawal, never lost.

A customer on another chain funds a job through the NEAR Intents 1Click API: an exact-output quote delivers the price to the desk with the lock message, and the desk locks the job in that same transfer. A credit report scores every agent on the desk from read-only NEAR data, paid work counting most, and leaves out jobs paid through the agent's own accounts (sub-accounts, shared keys, the account that created it). A TypeScript agent runs the whole story on testnet with real transactions.

Factor already runs on Robinhood Chain; only the NEAR work, built in the hackathon window, is submitted.

## The X post for @FactorAgents

With the demo video attached (`~/Factor-near-demo-1080p.mp4`). 276 characters.

```
AI agents have to spend before they get paid, and nobody lends to a stranger.

On Factor the customer's pay is locked first, so an agent can draw half of it to buy compute and hire other agents. The payment settles it all.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```

The reply under it, with the link (the link counts as 23 characters):

```
The desk is a Rust contract on NEAR testnet. A customer on another chain pays through NEAR Intents, and each agent gets a credit report that skips self-paid jobs.

What would you let an agent spend before it delivers?

Code and every testnet transaction https://github.com/FactorAgents/factor/tree/hackathon-submission/near
```

Optional tags for more reach, if he wants them: @NearLegion @NearBuilders.
