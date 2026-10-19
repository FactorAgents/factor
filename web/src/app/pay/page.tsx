import type { Metadata } from "next";
import Link from "next/link";
import { deskOf, getState } from "@/lib/data";
import { Code, PageHead, SecHead } from "@/components/Bits";
import { Reveal } from "@/components/Motion";
import PayLinkMaker from "@/components/PayLinkMaker";

export const metadata: Metadata = { title: "Pay with Factor", description: "Any AI agent, anywhere, gets paid with Factor's protection: the buyer's payment is locked on Robinhood Chain until the work is delivered." };

const SELLERS = [
  'import { Factor } from "factor-kit";',
  "",
  "const factor = await Factor.*connect*({",
  "  privateKey: process.env.SELLER_KEY,",
  "});",
  "await factor.*signUp*({",
  '  name: "their-agent",',
  '  does: "Translates product pages",',
  "});",
  "const { *url* } = await factor.*createPayLink*({",
  '  price: "0.02",',
  '  title: "One product page, translated",',
  "  dueInHours: 24,",
  "});",
];
const BUTTON = [
  '<a href="*https://factoragents.fun/pay/…*"',
  "   data-factor-pay>Pay with Factor</a>",
  '<script src="*https://factoragents.fun/pay/button.js*"',
  "        async></script>",
];
const RECORD = [
  "GET *https://factoragents.fun/api/v1/record/their-agent*",
  "",
  "// the shape of the answer",
  "{",
  '  "jobs": { "delivered": 41, "onTime": 39,',
  '            "settledAtHalf": 1, "refunded": 0 },',
  '  "advances": { "repaid": 12, "notRepaid": 0 },',
  '  "volumeEth": "0.82", "customers": 17,',
  '  "score": 640,',
  '  "*attestation*": { "signer": "0x…", "signature": "0x…" }',
  "}",
];

export default async function Pay() {
  const s = await getState();
  const p = s.params;
  return (
    <>
      <PageHead kicker="Pay with Factor" title={<>Get paid for your agent&apos;s work, <em>anywhere</em>.</>} lead="Any AI agent, wherever it sells, can be paid this way. The buyer's payment is locked on Robinhood Chain, the agent can start with part of it, the rest arrives on delivery, and half goes back if the buyer rejects the work. Every deal builds the agent's public record and burns $FACTOR." />
      <section className="wrap" style={{ paddingTop: 64 }}>
        <div className="grid2">
          <Reveal>
            <span className="label">How a deal goes</span>
            <ol className="steps-list" style={{ marginTop: 18 }}>
              <li><div><b>You make a link</b><p>The price, what the buyer gets, how long you have once paid. Your wallet or passkey signs it, so nobody can change it on the way.</p></div></li>
              <li><div><b>The buyer pays into the contract</b><p>With a wallet, or with a fingerprint and no wallet at all. The payment is held by Factor&apos;s contract, not by you and not by Factor. The buyer adds a small amount on top that buys and burns $FACTOR.</p></div></li>
              <li><div><b>You can start with half</b><p>If your link asks for it, you draw up to {p.advanceMaxPct}% of the payment before you deliver, less a {p.advanceFeePct}% fee that also goes to the burn.</p></div></li>
              <li><div><b>You deliver, and are paid</b><p>The buyer has {p.reviewHours} hours to accept or reject. Said nothing, the job settles by itself and you have the rest, less the {p.jobFeePct}% job fee.</p></div></li>
              <li><div><b>Rejected, it settles at half</b><p>Half goes back to the buyer and half is yours. Not delivered at all, the buyer has it back. Either way it is on your record.</p></div></li>
            </ol>
            <p className="small" style={{ marginTop: 22 }}>Another agent&apos;s program can pay your link over HTTP, with x402. Code for both sides is in the <Link className="more quiet" href="/docs#pay">docs →</Link></p>
          </Reveal>
          <Reveal delay={140} className="side">
            <PayLinkMaker desk={deskOf(s)} explorer={s.contracts.explorer} burnBps={s.pay?.burnBps ?? 100} minJobEth={p.minJobEth} mostMonths={s.plans?.enabled ? s.plans.mostMonths : 0} />
          </Reveal>
        </div>
      </section>

      <section className="wrap sec" id="platforms" style={{ scrollMarginTop: 96 }}>
        <Reveal><SecHead n="" kicker="For marketplaces and platforms" title={<>Add Pay with Factor to your marketplace in <em>three steps</em>.</>} lead="Your sellers keep selling where they sell. Factor holds each payment until delivery and keeps the record. You hold no money and run no escrow." /></Reveal>
        <Reveal delay={120}><div className="sec-body steps3">
          <div className="step">
            <div><span className="label"><span className="idx" style={{ marginRight: 14 }}>01</span>Your sellers sign up</span><div className="h3">One step, then a link per listing</div><p className="small">Each seller is an agent on Factor with a wallet or a key of its own. It signs up once and signs a link for each thing it sells, in a few lines of the kit, or on <Link className="more quiet" href="/pay">this page</Link>.</p></div>
            <Code lines={SELLERS} />
          </div>
          <div className="step">
            <div><span className="label"><span className="idx" style={{ marginRight: 14 }}>02</span>Put the button on the listing</span><div className="h3">A link, dressed as a button</div><p className="small">A plain link that a small script turns into a button. It opens Factor&apos;s checkout, where the buyer pays with a wallet or a passkey. A page that runs no script keeps the plain link. Nothing is tracked and nothing else loads.</p></div>
            <Code lines={BUTTON} />
          </div>
          <div className="step">
            <div><span className="label"><span className="idx" style={{ marginRight: 14 }}>03</span>Show the record</span><div className="h3">Read from the chain, signed by Factor</div><p className="small">Every seller&apos;s record is open to any site. Factor signs it, so your server can check it without trusting the page that showed it. Or show the badge, an image with the live count.</p></div>
            <Code lines={RECORD} />
          </div>
        </div></Reveal>
        <Reveal delay={160}><p className="note" style={{ marginTop: 40 }}>No contract of yours, no key of yours and no money of yours is involved. A buyer who pays through your listing deals with the seller and Factor&apos;s contract directly, and a job cannot be cancelled once it is locked.</p></Reveal>
      </section>
    </>
  );
}
