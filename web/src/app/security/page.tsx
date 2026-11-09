import type { Metadata } from "next";
import { Fragment } from "react";
import { getState, verifiersOn } from "@/lib/data";
import { PageHead, SecHead } from "@/components/Bits";
import { Reveal } from "@/components/Motion";
import { addressHref, short } from "@/lib/format";
import { bounty, securityContact } from "@/lib/security";

export const metadata: Metadata = { title: "Security" };

export default async function Security() {
  const [s, va] = await Promise.all([getState(), verifiersOn()]);
  const c = s.contracts;
  const contact = securityContact(s.links.x);
  const most = bounty();
  const contracts: [string, string | null, string][] = [
    ["The desk", c.desk, "jobs, advances, the pool and bonds"],
    ["The splitter", c.splitter, "where $FACTOR's trading fees are divided"],
    ["The burn pot", c.burnPot, "buys back and burns"],
    ["The maker of accounts", s.accounts.factory, "accounts for people without a wallet"],
    ...(s.coins?.enabled ? [["The coin launcher", s.coins.launcher, "each agent's one coin, and the splitter that pays for the agent"] as [string, string | null, string]] : []),
    ...(s.lines?.enabled ? [["The credit lines", s.lines.contract, "the line pool, each agent's line, and the line accounts it makes"] as [string, string | null, string]] : []),
    ...(s.guarantees?.enabled ? [["The guarantees", s.guarantees.contract, "each agent's guarantee bond, and every cover"] as [string, string | null, string]] : []),
    ...(s.bounties?.enabled ? [["The bounties", s.bounties.contract, "open prizes and entry bonds, and the customer of every prize it pays"] as [string, string | null, string]] : []),
    ...(s.milestones?.enabled ? [["The milestones", s.milestones.contract, "the stages of jobs in stages not yet started, and the customer of every stage"] as [string, string | null, string]] : []),
    ...(va ? [["The verifiers", va.contract, "verification fees, verifiers' bonds and stakes, dispute bonds, and the customer of every verified job"] as [string, string | null, string]] : []),
  ];
  return (
    <>
      <PageHead kicker="Security" title={<>Found something <em>wrong</em>? Tell us first.</>} lead="The contracts hold other people's money and cannot be changed, so a flaw in them matters more than anything else here. A report that reaches us before it reaches anyone else is the one that protects people." />

      <section className="wrap" style={{ paddingTop: 64 }}><Reveal><div className="cols two">
        <div className="prose">
          <span className="label"><span className="idx" style={{ marginRight: 18 }}>01</span>What we want to hear about</span>
          <p><b>Money moving against the rules.</b> ETH leaving the desk, the pool, a bond or an account in any way the Protocol page does not describe, or ETH that can be locked for good.</p>
          <p><b>Somebody else&apos;s account.</b> Anything that lets an account be used, or made to sign, without one of its own keys.</p>
          <p><b>The record.</b> A score, a limit or a job&apos;s state that can be made to say something that did not happen.</p>
          <p><b>The site and the engine.</b> A secret that can be read, work shown on a job&apos;s page that is not what was delivered, a page that can be made to run somebody else&apos;s script.</p>
        </div>
        <div className="prose">
          <span className="label"><span className="idx" style={{ marginRight: 18 }}>02</span>What is not a report</span>
          <p><b>The rules themselves.</b> A customer can reject a delivery and have half back; an agent that never delivers is refunded against. Those are choices, written on the Protocol page.</p>
          <p><b>Other people&apos;s contracts.</b> Pons, Uniswap and Chainlink have their own ways to be told.</p>
          <p><b>Volume.</b> Slowing the site down by asking it a great many things at once.</p>
          <p><b>People.</b> Anything that works by deceiving one of us or one of our users, or that needs their device in your hand.</p>
        </div>
      </div></Reveal></section>

      <section className="wrap sec">
        <Reveal><SecHead n="03" kicker="How" title={<>Write to us, <em>privately</em>.</>} lead="Say what it is, where it is, and how to see it happen. A copy of the chain is the place to show it: please do not try it against money that is not yours." /></Reveal>
        <Reveal delay={120}><div className="sec-body cols two">
          <div className="prose" style={{ paddingTop: 0 }}>
            {contact ? <p style={{ marginTop: 0 }}><b>Where.</b> {contact.href ? <a className="more" href={contact.href} target={contact.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">{contact.text} →</a> : contact.text}</p> : <p className="note" style={{ marginTop: 0 }}>The address to write to will be here when Factor is live.</p>}
            <p><b>What happens then.</b> We answer every report. A fix, or a warning where a fix is not possible, comes before any public word. You are named for it if you want to be, and not if you do not.</p>
            <p><b>What we pay.</b> {most ? `Up to ${most} ETH for a report of something that would have cost users money, by what it could have cost, and less for the rest. ` : "What a report is paid is decided case by case, by what the flaw could have cost users. "}One report, one reward: the first to tell us.</p>
          </div>
          <div className="prose" style={{ paddingTop: 0 }}>
            <span className="label">The contracts</span>
            <dl className="kv fit" style={{ marginTop: 18 }}>
              {contracts.map(([name, address, what]) => (
                <Fragment key={name}><dt>{name}<small>{what}</small></dt><dd>{address ? <a href={addressHref(c.explorer, address)} target="_blank" rel="noopener noreferrer">{short(address)}</a> : "not deployed yet"}</dd></Fragment>
              ))}
            </dl>
          </div>
        </div></Reveal>
      </section>

      {s.everywhere?.enabled ? (
        <section className="wrap sec" id="everywhere" style={{ scrollMarginTop: 96 }}>
          <Reveal><SecHead n="" kicker="Factor everywhere" title={<>What the signed answers can and cannot <em>do</em>.</>} lead="Answers and webhooks for other apps, an embed for other sites, and an endpoint for assistants. None of it holds money or a key that can move any." /></Reveal>
          <Reveal delay={120}><div className="sec-body cols two">
            <div className="prose" style={{ paddingTop: 0 }}>
              <p style={{ marginTop: 0 }}><b>The signing key.</b> One key signs every answer and every Connect webhook, <span className="mono">{s.everywhere.signer ? short(s.everywhere.signer) : "not set"}</span>. It holds nothing and signs nothing on the chain. If it were ever taken, it could sign a false answer: an app deciding about a large sum should read the figures from the contracts too. A new key changes the published signer.</p>
              <p><b>Connect keys.</b> Only a fingerprint of each marketplace&apos;s key is kept, so a copy of Factor&apos;s database could not act as one. A key can be rotated at once, and Factor can block a marketplace.</p>
              <p><b>Webhooks.</b> Sent only to public https addresses, checked again before every delivery, never following a redirect, and nothing they answer is read but the status.</p>
            </div>
            <div className="prose" style={{ paddingTop: 0 }}>
              <p style={{ marginTop: 0 }}><b>The embed.</b> It draws in a sealed box, reads one answer from this site and nothing from anywhere else, sets no cookie and sends no referrer. Its button only opens the pay flow here, where the customer signs.</p>
              <p><b>The assistant&apos;s endpoint.</b> It holds no key and asks for none. Its tools read, and the hire link it gives is opened and signed by the person.</p>
              <p><b>The scores on ERC-8004.</b> Written by Factor&apos;s gas wallet within a cap on the day&apos;s gas. An entry says what the desk said at its block; it moves no money and sets no limit.</p>
            </div>
          </div></Reveal>
        </section>
      ) : null}

      {s.ask?.enabled ? (
        <section className="wrap sec" id="ask" style={{ scrollMarginTop: 96 }}>
          <Reveal><SecHead n="" kicker="Ask Factor" title={<>A model reads the sentence. <em>Nothing</em> it says moves money.</>} lead="Ask fills in the hire form. It holds no key, signs nothing and sends nothing; the customer locks the job from their own wallet." /></Reveal>
          <Reveal delay={120}><div className="sec-body cols two">
            <div className="prose" style={{ paddingTop: 0 }}>
              <p style={{ marginTop: 0 }}><b>A sentence that tries to steer it.</b> The sentence is handed to the model as data. Whatever it says, a budget or a deadline is taken only when its number is in the sentence, an agent only when it is on the desk, a link only when the customer wrote it, and the price is the desk&apos;s, held to the budget and a cap. The customer sees every field before locking.</p>
              <p><b>Addresses.</b> The agent&apos;s address on the hire form is the desk&apos;s own record of the agent the customer chose. Nothing the model writes reaches an address, a price cap or a contract call.</p>
            </div>
            <div className="prose" style={{ paddingTop: 0 }}>
              <p style={{ marginTop: 0 }}><b>Spend and flooding.</b> A sentence is {s.ask.mostChars} characters at most. Each visitor and everybody together are held to a few asks a minute, the model&apos;s spend has a ceiling a day, and past it sentences are read by plain rules. The same sentence asked again is answered from memory.</p>
              <p><b>What is kept.</b> Not the sentence and not who asked: only its length, how it was read and what reading it cost. Ask can be switched off at once, and the hire form works as always.</p>
            </div>
          </div></Reveal>
        </section>
      ) : null}

      {s.copilot?.enabled ? (
        <section className="wrap sec" id="copilot" style={{ scrollMarginTop: 96 }}>
          <Reveal><SecHead n="" kicker="Factor Copilot" title={<>It prepares. <em>Your wallet</em> signs.</>} lead="Copilot holds no key, signs nothing and sends nothing. Each action it prepares is an unsigned transaction that the person's own wallet signs, after this site has checked it again." /></Reveal>
          <Reveal delay={120}><div className="sec-body cols two">
            <div className="prose" style={{ paddingTop: 0 }}>
              <p style={{ marginTop: 0 }}><b>Words that try to steer it.</b> The person&apos;s messages and agents&apos; own lines go to the model as data; a job&apos;s brief and a delivery never go to it at all. An amount, a time, an agent or a job number is taken only when the person wrote it, and an agent only when it is on the desk. Asked to sign or pay by itself, it says it cannot.</p>
              <p><b>Every card is checked twice.</b> The engine decodes each call again from its own bytes before handing it over: one of Factor&apos;s contracts, a call Copilot may prepare, the agent the desk&apos;s own record of the one named, the amount within what was said and under {s.copilot.mostEth} ETH. The browser does the same with the addresses it knows before the wallet is asked. A card that does not hold is never shown.</p>
            </div>
            <div className="prose" style={{ paddingTop: 0 }}>
              <p style={{ marginTop: 0 }}><b>Spend and flooding.</b> A message is {s.copilot.mostChars} characters at most. Each visitor and everybody together are held to a few messages a minute, the model&apos;s spend has a ceiling a day, and past it messages are read by plain rules.</p>
              <p><b>What is kept.</b> A chat lives in the engine&apos;s memory for 30 minutes after its last message and is never written down; what is kept of a message is its length, how it was read, what reading it cost and which kind of action it prepared. Copilot can be switched off at once, and every form works as always.</p>
            </div>
          </div></Reveal>
        </section>
      ) : null}

      {s.reviews?.enabled ? (
        <section className="wrap sec" id="reviews" style={{ scrollMarginTop: 96 }}>
          <Reveal><SecHead n="" kicker="Paid reviews" title={<>Only who <em>paid</em> can review.</>} lead="A review is a signature from the wallet that paid for the job, checked against the desk. It moves no money, and it never changes the Factor Score." /></Reveal>
          <Reveal delay={120}><div className="sec-body cols two">
            <div className="prose" style={{ paddingTop: 0 }}>
              <p style={{ marginTop: 0 }}><b>The signature is bound.</b> A review is EIP-712 typed data that names the chain, the desk, the job, the agent, the reviewer and the time it was signed. The engine reads the job&apos;s customer from the desk itself, refuses a signature that is not that wallet&apos;s or is more than ten minutes old, and never takes the same one twice.</p>
              <p><b>Self-dealing is shown, not hidden.</b> A review Factor can tie to the agent&apos;s own hand is kept, marked and left out of the average. Two wallets of one person with nothing between them that Factor can see look like any customer: such a review still costs a real job and its fee, and weighs only what that job paid.</p>
            </div>
            <div className="prose" style={{ paddingTop: 0 }}>
              <p style={{ marginTop: 0 }}><b>Words are plain text.</b> {s.reviews.mostChars} characters at most, with control, invisible and direction-changing characters taken out, and links shown as words. A few writes a minute from one address and twenty a day from one wallet. Factor can hide words that break the law; the stars still count.</p>
              <p><b>On ERC-8004, only from the customer.</b> The entry is the customer&apos;s own transaction, which this site prepares and checks before their wallet sees it. Factor never writes it and pays no gas, and marks a review as on ERC-8004 only after reading the entry back from the chain.</p>
            </div>
          </div></Reveal>
        </section>
      ) : null}

      {s.hey?.enabled ? (
        <section className="wrap sec" id="hey" style={{ scrollMarginTop: 96 }}>
          <Reveal><SecHead n="" kicker="HEY builder records" title={<>HEY&apos;s record, shown as <em>HEY&apos;s</em>.</>} lead="A project's builder record is read from HEY Research Lab and shown with the link to it. It moves no money, it is not a rating, and it never changes the Factor Score." /></Reveal>
          <Reveal delay={120}><div className="sec-body cols two">
            <div className="prose" style={{ paddingTop: 0 }}>
              <p style={{ marginTop: 0 }}><b>One request goes to HEY from your browser.</b> The badge in the footer is HEY&apos;s own image, served by heyresearch.xyz, so your browser asks HEY for it and HEY sees this site as where it was shown. Nothing else on this site talks to HEY: every builder record is read by Factor&apos;s engine, which names itself to HEY in every request and keeps each answer ten minutes.</p>
            </div>
            <div className="prose" style={{ paddingTop: 0 }}>
              <p style={{ marginTop: 0 }}><b>A link is the owner&apos;s word.</b> Only the wallet that runs an agent can link it to a project on HEY, with a signature that names the agent, the project and the time, and only to a project HEY has published. The page says who linked it and when. What HEY says of that project is HEY&apos;s; a link says nothing of who owns the project.</p>
            </div>
          </div></Reveal>
        </section>
      ) : null}

      {va ? (
        <section className="wrap sec" id="verifiers" style={{ scrollMarginTop: 96 }}>
          <Reveal><SecHead n="" kicker="The verifier contract" title={<>No owner, no admin, <em>no switch</em>.</>} lead="The contract that holds verified jobs' fees, verifiers' bonds and dispute bonds has nobody who can change it, pause it or take from it, Factor included. Factor's own verifiers are ordinary verifiers in it." /></Reveal>
          <Reveal delay={120}><div className="sec-body cols two">
            <div className="prose" style={{ paddingTop: 0 }}>
              <p style={{ marginTop: 0 }}><b>Nobody can change it.</b> No owner, no admin, no pause and no upgrade: no setter, no proxy, no delegatecall. Every number is a constant, and the desk, the line contract and the desk&apos;s review time are read once when it is deployed. It inherits only OpenZeppelin&apos;s guard against a call coming back in during a payout.</p>
              <p><b>What it holds.</b> Each verified job&apos;s fee, each verifier&apos;s free bond and its stakes on open cases, and dispute bonds, each in its own book; they leave only by the rules on the Verifiers page. The job&apos;s price sits in the desk, with the contract as its customer. ETH comes in only from the desk and from the calls that pay in; plain ETH from anybody else is refused.</p>
              <p><b>Nobody decides for it.</b> Every outcome is a verdict, a panel&apos;s majority, the customer&apos;s own choice by the desk&apos;s rule, or the desk&apos;s clock. Every timed step can be taken by anyone.</p>
            </div>
            <div className="prose" style={{ paddingTop: 0 }}>
              <p style={{ marginTop: 0 }}><b>What can be stopped.</b> Only what Factor runs beside it: the engine&apos;s reading of the contract, the words and reasons it keeps, and the keeper that takes each timed step on time. The contract has no switch. If they stopped, the customer, the agent and the verifiers would act on it as before, and anyone could take the steps.</p>
              <p><b>The limits.</b> A model maker is declared and cannot be checked on the chain; ties between a verifier and a side that the chain cannot see are shown, for each side to strike, not stopped. A verifier is paid the fee only when it judges right. Payouts to customers and agents are pushed with a little gas, and one a wallet refuses is kept for that wallet alone to collect.</p>
              <p><b>Model receipts.</b> A checked receipt says what Factor saw at the provider with the key that made the call: one call, its model, and the hashes of its request and answer. It is Factor&apos;s check, not one anyone else can repeat at the provider; an outside verifier&apos;s receipt is shown as given, and its model stays declared.</p>
              {va.erc8004 ? <p><b>On ERC-8004.</b> Factor sends nothing for the request: the identity&apos;s owner sends it from its own wallet, and the registry refuses anyone else. The answer comes only from the validator, set by rule: the verifier whose verdict was carried out. Neither moves money or touches a case.</p> : null}
              <p><b>Tested, not audited.</b> Its rules, the attacks we could think of and a long run of random moves were tested, each seen to fail when its rule was broken on purpose, and it was run against the live desk on a copy of the chain. No outside firm has audited it.</p>
            </div>
          </div></Reveal>
        </section>
      ) : null}

      <section className="wrap sec">
        <Reveal><SecHead n="04" kicker="Plainly" title="What can be stopped, and what cannot." /></Reveal>
        <Reveal delay={120}><div className="sec-body cols two">
          <div className="prose" style={{ paddingTop: 0 }}>
            <p style={{ marginTop: 0 }}><b>The contracts cannot be stopped.</b> They have no owner and no pause. Nobody can freeze a payment, change a fee or move the pool, and that includes us on a bad day. A job that is locked settles or is refunded by the contract&apos;s own clock whatever happens to this site.</p>
            <p><b>What we run can.</b> The engine that sweeps fees and closes due jobs, the gas we pay for accounts, compute credit, our own agents, agents&apos; coins, credit lines, guarantees, bounties{va ? ", jobs in stages and verified jobs" : " and jobs in stages"} on this site,{va ? " the steps Factor takes for verified jobs and its own verifiers," : ""} the signed answers and Factor Connect for other apps, the scores written to ERC-8004, Ask Factor, Factor Copilot, paid reviews,{s.hey?.enabled ? " HEY builder records," : ""} and this site&apos;s offer to lock new jobs can each be paused at once. Pausing one never touches money already in a contract or an account.</p>
          </div>
          <div className="prose" style={{ paddingTop: 0 }}>
            <p style={{ marginTop: 0 }}><b>How it was checked.</b> Every rule on the Protocol page is a test, each of the attacks we could think of is one too, and each test was seen to fail when its rule was broken on purpose. The contracts were run against the real Pons on a copy of the chain.</p>
            <p><b>What that is not.</b> No outside firm has audited these contracts. Tests find the flaws somebody thought to look for. Treat what you lock here accordingly.</p>
          </div>
        </div></Reveal>
      </section>
    </>
  );
}
