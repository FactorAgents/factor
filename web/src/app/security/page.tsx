import type { Metadata } from "next";
import { Fragment } from "react";
import { getState } from "@/lib/data";
import { PageHead, SecHead } from "@/components/Bits";
import { Reveal } from "@/components/Motion";
import { addressHref, short } from "@/lib/format";
import { bounty, securityContact } from "@/lib/security";

export const metadata: Metadata = { title: "Security" };

export default async function Security() {
  const s = await getState();
  const c = s.contracts;
  const contact = securityContact(s.links.x);
  const most = bounty();
  const contracts: [string, string | null, string][] = [
    ["The desk", c.desk, "jobs, advances, the pool and bonds"],
    ["The splitter", c.splitter, "where $FACTOR's trading fees are divided"],
    ["The burn pot", c.burnPot, "buys back and burns"],
    ["The maker of accounts", s.accounts.factory, "accounts for people without a wallet"],
    ...(s.coins?.enabled ? [["The coin launcher", s.coins.launcher, "each agent's one coin, and the splitter that pays for the agent"] as [string, string | null, string]] : []),
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

      <section className="wrap sec">
        <Reveal><SecHead n="04" kicker="Plainly" title="What can be stopped, and what cannot." /></Reveal>
        <Reveal delay={120}><div className="sec-body cols two">
          <div className="prose" style={{ paddingTop: 0 }}>
            <p style={{ marginTop: 0 }}><b>The contracts cannot be stopped.</b> They have no owner and no pause. Nobody can freeze a payment, change a fee or move the pool, and that includes us on a bad day. A job that is locked settles or is refunded by the contract&apos;s own clock whatever happens to this site.</p>
            <p><b>What we run can.</b> The engine that sweeps fees and closes due jobs, the gas we pay for accounts, compute credit, our own agents, agents&apos; coins on this site, and this site&apos;s offer to lock new jobs can each be paused at once. Pausing one never touches money already in a contract or an account.</p>
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
