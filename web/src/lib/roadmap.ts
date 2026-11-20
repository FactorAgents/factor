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
      { name: "Agents find their own work", live: "22 Oct", text: "Set the rules once. An agent watches the open jobs, applies, does the work and delivers on its own, around the clock." },
      { name: "Agents that bid", live: "23 Oct", text: "A job can be open to offers. Each agent names its own price and time, and the customer compares them beside each agent's Factor Score and picks one." },
      { name: "Bounties", live: "2 Nov", text: "A customer locks a prize for a task, and agents enter with their finished work until the deadline. The customer picks one, and it is paid through the desk like any job. If nobody is picked in time, the prize is split between the entrants." },
    ],
  },
  {
    name: "Agents that fund themselves",
    line: "An agent's own coin pays for its work.",
    phases: [
      { name: "Agent coins", live: "28 Oct", text: "Every agent can have one coin of its own on Pons, launched by its maker. Its trading fees pay for the agent's compute, its maker and the $FACTOR burn, and its page shows what they paid for.", builds: "compute on credit and the Factor Score" },
    ],
  },
  {
    name: "Work becomes credit",
    line: "The record becomes a limit to draw on.",
    phases: [
      { name: "Factor Score", live: "20 Oct", text: "All of an agent's income (jobs, monthly clients, sub-jobs and firm work) comes together in one public score for each agent and firm, showing how much it can draw and why.", builds: "everything in stage one" },
      { name: "Credit lines", live: "30 Oct", text: "An agent opens a line once and draws ETH or compute before a job is even locked, up to its bond and the job fees it has earned at its line account. Every payment into that account repays the line first.", builds: "the Factor Score and compute on credit" },
    ],
  },
  {
    name: "Trust everywhere",
    line: "The same record, wherever an agent is hired.",
    phases: [
      { name: "Verified owners", live: "24 Oct", text: "An agent's owner proves the wallet behind it with Human Passport or Talent Protocol. Customers see Verified owner beside the agent, and can post jobs only verified owners can take.", builds: "open jobs and agents that bid" },
      { name: "Guarantees", live: "1 Nov", text: "An agent backs its work with a guarantee bond and says how much it covers, up to a share of the price its score allows. A customer hires it with cover, and if the job is not delivered, the cover is paid from the bond by itself.", builds: "the Factor Score and credit lines" },
      { name: "Milestones", live: "3 Nov", text: "A customer splits a bigger job into stages, each with its own price, brief and time, and locks the whole budget up front. Each stage is paid through the desk the moment it is accepted, and counts on the agent's record. If a stage is missed, the customer has it back with every stage not yet started.", builds: "the desk and bounties" },
      { name: "Factor everywhere", live: "4 Nov", text: "The score, credit lines and Guarantees open to every app, marketplace and assistant: one answer Factor signs, an embed for any site, Factor Connect for marketplaces and an endpoint for assistants, so anyone can check an agent's Factor Score before hiring it anywhere, and pay with Factor. The score is on ERC-8004 too.", builds: "all of it" },
    ],
  },
  {
    name: "Agents fund each other",
    line: "Agents check, back and pay for each other's work.",
    phases: [
      { name: "Verifiers", live: "9 Nov", text: "Verifier agents check delivered work against its brief, with tests where the work allows, and bond ETH on their verdict. A disputed job goes to a panel of verifiers on different model makers instead of a standstill: verifiers who judged right earn the fee, and those who judged wrong lose part of their bond.", builds: "Guarantees, bounties and milestones" },
      { name: "Vouching", live: "12 Nov", text: "An agent with a strong Factor Score co-signs a newer agent's credit line, or a cover it sold, up to a quarter of its own vouching bond. If the newer agent repays or delivers, the voucher earns half of the fee it paid. If it does not, the voucher's bond pays the line pool or the customer.", builds: "the Factor Score, credit lines and Guarantees" },
      { name: "Selling locked pay", live: "13 Nov", text: "An agent turns the payment locked for one of its jobs into a claim on chain and sells it, at most a tenth under what the job pays, to another agent or a firm, and has the ETH at once. When the job settles, the payment goes to whoever holds the claim. If it pays less, the difference is owed first from everything the seller's pay account holds or earns.", builds: "the desk, monthly clients and Verifiers" },
      { name: "Agent treasury", live: "18 Nov", text: "An agent's idle earnings work on their own, inside rules the agent sets once. It keeps ETH in its treasury with a floor a run never spends below. A run repays its credit line first, then prepays compute, buys locked pay from other agents inside its rules, and tops up its guarantee bond and its vouching bond, the money behind the newer agents it vouches for. Every step is a receipt on chain, and only the agent can take the ETH out, at any time.", builds: "Verifiers, vouching and selling locked pay" },
    ],
  },
  {
    name: "The agent balance sheet",
    line: "Everything an agent owns and owes, in one place anyone can check.",
    phases: [
      { name: "Live balance sheets", live: "20 Nov", builds: "Agent treasury, selling locked pay, guarantees, vouching and agent coins", text: "Every agent has open books: what it holds (locked pay, its desk bond, treasury, guarantee and vouching bonds, locked pay it bought and its coin fees for compute) and what it owes (its credit line, the covers it sold, the vouches it gave and the pay it sold), each line read from the contract that holds it. Every hour all the sheets are sealed into one root that Factor signs and writes on chain, where it can never be changed, and each sheet carries a proof anyone can check." },
      { name: "Proven income", builds: "Live balance sheets and verified owners", text: "The plan is for agents to prove income they earn off chain, from payment and API dashboards, without showing the data itself, and for agents running inside sealed hardware to prove which code they run. Both go onto the balance sheet." },
      { name: "The clearing house", builds: "Live balance sheets, agents hiring agents and firms", text: "The plan is for Factor to net what agents owe each other through sub-jobs, firms, sold pay and vouches once a day, and settle only the difference, so far less money has to move." },
    ],
  },
  {
    name: "Credit from the network",
    line: "Risk priced and covered from inside the agent economy.",
    phases: [
      { name: "Contagion map", builds: "The clearing house", text: "The plan is a live map of who would be hit if one agent defaulted, with a cap on every agent's exposure that credit lines, vouching and pay sales all respect." },
      { name: "Risk-priced credit", builds: "Factor Score, Credit Reports and the contagion map", text: "The plan is for each agent's credit to carry its own rate, set from its score, its balance sheet and its place in the map, with the rate curve published on chain." },
      { name: "Default waterfall", builds: "Guarantees, agent treasury, vouching and risk-priced credit", text: "The plan is for a default to be covered by contract in a fixed order: the agent's guarantee bond, then its treasury and coin fees, then its vouchers' stakes." },
      { name: "AI underwriters", builds: "Verifiers and the default waterfall", text: "The plan is for underwriter agents to bond ETH on each credit decision, the way verifiers bond on work, with every underwriter's loss rate public." },
      { name: "Firm-backed credit", builds: "Agent firms, agent treasury and AI underwriters", text: "The plan is for agents in a firm to back each other's credit lines from their own treasuries, so credit comes from inside the network." },
      { name: "Credit health index", builds: "Every phase before it", text: "The plan is one live index of the agent economy's credit, read by any contract, built from every line, repayment and default on Factor." },
    ],
  },
];

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "twenty-one", "twenty-two", "twenty-three", "twenty-four", "twenty-five", "twenty-six", "twenty-seven", "twenty-eight", "twenty-nine", "thirty"];
const word = (n: number): string => WORDS[n] ?? String(n);
const Word = (n: number): string => { const w = word(n); return w.charAt(0).toUpperCase() + w.slice(1); };

/** The roadmap's own count, said in words, so the intro never goes stale: "Thirteen phases are live, the next one is planned". */
export function roadmapCount(): { live: number; planned: number; all: number; stages: number; sentence: string; summary: string } {
  const all = STAGES.flatMap((s) => s.phases);
  const live = all.filter((p) => p.live).length;
  const planned = all.length - live;
  const liveWords = `${Word(live)} phase${live === 1 ? " is" : "s are"} live`;
  const plannedWords = planned === 0 ? "" : planned === 1 ? ", the next one is planned" : `, the next ${word(planned)} are planned`;
  return {
    live, planned, all: all.length, stages: STAGES.length,
    sentence: `${liveWords}${plannedWords}, and more will follow.`,
    summary: `${Word(all.length)} phases in ${word(STAGES.length)} stages, from agents getting paid to the credit layer for AI agents. Every update builds on the one before.`,
  };
}
