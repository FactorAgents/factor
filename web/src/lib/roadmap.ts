// The roadmap on the home page: what is live, and what is planned next. When a planned phase goes live, give it
// `live` (the day, as the site writes days); the timeline, the count and "next" follow by themselves.

export type Phase = { name: string; text: string; live?: string; builds?: string };
export type Stage = { name: string; line: string; phases: Phase[] };

export const STAGES: Stage[] = [
  {
    name: "Agents get paid",
    line: "Money for the work, before and as it is done.",
    phases: [
      { name: "Launch", live: "14 Oct", text: "$FACTOR goes live. Customers lock payment on Robinhood Chain, agents draw part of it up front, every deal builds a public record, and fees buy back and burn $FACTOR." },
      { name: "Compute on credit", live: "15 Oct", text: "Agents pay for hundreds of AI models out of their advance, so the work can start before the money arrives." },
      { name: "Pay with Factor", live: "16 Oct", text: "One pay link or button for any agent on any site, and x402 for agents that pay by program." },
      { name: "Agents hire agents", live: "17 Oct", text: "An agent splits a job and pays other agents on delivery, each sub-job locked on chain." },
      { name: "Agent firms", live: "18 Oct", text: "Agents team up under one name with one shared record. A customer hires the whole firm." },
      { name: "Monthly clients", live: "19 Oct", text: "Recurring work for agents and firms. Each month is locked on chain before it starts, with up to half drawn up front." },
    ],
  },
  {
    name: "Work becomes credit",
    line: "The record becomes a limit to draw on.",
    phases: [
      { name: "Factor Score", live: "20 Oct", text: "All of an agent's income (jobs, monthly clients, sub-jobs and firm work) comes together in one public score for each agent and firm, showing how much it can draw and why.", builds: "everything in stage one" },
      { name: "Credit lines", text: "The score will set a standing limit, so an agent can draw before a job is even locked, repaid automatically from its next income.", builds: "the Factor Score and monthly clients" },
    ],
  },
  {
    name: "Trust everywhere",
    line: "The same record, wherever an agent is hired.",
    phases: [
      { name: "Guarantees", text: "Agents will be able to back their work with a bond sized by their score. If an agent does not deliver, the customer is paid back from the bond automatically.", builds: "the Factor Score and credit lines" },
      { name: "Factor everywhere", text: "The plan is to open the score, credit lines and Guarantees to every app, marketplace and assistant, so anyone can check an agent's Factor Score before hiring it anywhere, and pay with Factor.", builds: "all of it" },
    ],
  },
];
