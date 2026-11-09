import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getReceipt, getState, getVerifierCase } from "@/lib/data";
import { Reveal } from "@/components/Motion";
import { ModelMark } from "@/components/Verifiers";
import { dayTime, short } from "@/lib/format";
import { RECEIPT_NOT, RECEIPT_SHOWS } from "@/lib/verifiers";
import type { VerdictModel } from "@/lib/types";

export const metadata: Metadata = { title: "A model receipt" };

/** A text as it was sent or answered: a string as it is, anything else as indented JSON. */
const asText = (x: unknown): string => (typeof x === "string" ? x : JSON.stringify(x, null, 2));

export default async function ReceiptPage({ params }: { params: Promise<{ case: string; verifier: string }> }) {
  const { case: id, verifier } = await params;
  const [s, got, c] = await Promise.all([getState(), getReceipt(id, verifier), getVerifierCase(id)]);
  if (got === "down" || c === "down") return <section className="wrap page-head"><Link className="more quiet back" href="/verifiers">← Verifiers</Link><h1 className="h1">This receipt is not arriving right now.</h1><p className="lead">Nothing is lost. Try again in a moment.</p></section>;
  if (!got || !c) notFound();
  const r = got.receipt;
  const who = verifier.toLowerCase();
  const v = c.first?.verifier.address.toLowerCase() === who ? c.first.verifier : c.seats?.find((x) => x.verifier.address.toLowerCase() === who)?.verifier;
  const model: VerdictModel = (c.first?.verifier.address.toLowerCase() === who ? c.first.model : c.seats?.find((x) => x.verifier.address.toLowerCase() === who)?.model) ?? { mark: r.by === "factor" && r.matches ? "checked" : "declared", maker: v?.maker ?? 0, makerName: v?.makerName ?? "Another maker", receipt: r };
  const checked = model.mark === "checked";
  const ex = s.contracts.explorer;
  const name = v?.name ?? short(who);
  return (
    <>
      <section className="wrap page-head">
        <Link className="more quiet back" href={`/jobs/${c.job.id}#verifiers`}>← Job {c.job.id}</Link>
        <h1 className="h1">A model <em>receipt</em>.</h1>
        <p className="small mono" style={{ marginTop: 12, color: "var(--dim)", overflowWrap: "anywhere" }}>case {c.id} · job {c.job.id} · <Link href={`/verifiers/${who}`}>{name}</Link>, on {model.makerName}</p>
        <p className="lead">{checked ? `The verdict ${name} gave on ${c.title ?? `job ${c.job.id}`}, and the one model call its reasons name. Factor checked it at the provider.` : `The verdict ${name} gave on ${c.title ?? `job ${c.job.id}`}, and the receipt it gave. Factor did not check this one, so its model stays declared.`}</p>
        <div style={{ marginTop: 22, maxWidth: 720 }}><ModelMark m={model} caseId={c.id} verifier={who} bare /></div>
      </section>

      <section className="wrap" style={{ paddingTop: 48 }}>
        <Reveal><div className="cols two">
          <div>
            <span className="label">The call</span>
            <dl className="kv fit" style={{ marginTop: 18 }}>
              <dt>At<small>the provider the call was made at</small></dt><dd>{r.provider}</dd>
              <dt>Its id<small>the provider&apos;s own id for the call</small></dt><dd className="vwrap">{r.generationId}</dd>
              <dt>The model asked for</dt><dd className="vwrap">{r.modelAsked}</dd>
              <dt>The model that answered<small>as the provider reports it</small></dt><dd className="vwrap">{r.modelReported}</dd>
              {r.providerName ? <><dt>Served by</dt><dd>{r.providerName}</dd></> : null}
              {r.tokensIn !== null && r.tokensOut !== null ? <><dt>Tokens<small>in, out</small></dt><dd>{r.tokensIn} · {r.tokensOut}</dd></> : null}
              {r.createdAt ? <><dt>Made</dt><dd>{dayTime(r.createdAt)}</dd></> : null}
              <dt>Given by</dt><dd>{r.by === "factor" ? "Factor's own verifier" : "the verifier itself"}</dd>
              <dt>Checked by Factor<small>{r.checkedAt ? "looked up at the provider with the key that made the call" : "not looked up"}</small></dt><dd className={checked ? "sum" : undefined}>{r.checkedAt ? `${dayTime(r.checkedAt)}${r.matches === false ? ", it did not match" : ""}` : "no"}</dd>
            </dl>
            {r.why ? <p className="small" style={{ marginTop: 14 }}>{r.why.charAt(0).toUpperCase() + r.why.slice(1)}{/[.!?]$/.test(r.why) ? "" : "."}</p> : null}
          </div>
          <div>
            <span className="label">What it shows, and what it does not</span>
            <p className="small" style={{ marginTop: 18 }}>{RECEIPT_SHOWS}</p>
            <p className="small" style={{ marginTop: 12 }}>{RECEIPT_NOT}</p>
            <span className="label" style={{ display: "block", marginTop: 26 }}>The hashes</span>
            <p className="small mono vhash" style={{ marginTop: 12 }}>request {r.requestHash}</p>
            <p className="small mono vhash">answer {r.outputHash}</p>
            <p className="small" style={{ marginTop: 14 }}>Work them out again from the texts below. <a className="more quiet" href={`/api/v1/verifiers/receipt/${c.id}/${who}`}>As JSON →</a>{c.first?.tx && c.first.verifier.address.toLowerCase() === who ? <> <a className="more quiet" href={`${ex}/tx/${c.first.tx}`} target="_blank" rel="noopener noreferrer">The verdict on the chain →</a></> : null}</p>
          </div>
        </div></Reveal>
      </section>

      <section className="wrap sec" style={{ paddingTop: 64 }}>
        <div className="words">
          <Reveal>
            <span className="label">The request</span>
            <p className="small" style={{ marginTop: 8 }}>Exactly as it was sent to the model.</p>
            <div className="worktext mono">{asText(got.request)}</div>
          </Reveal>
          <Reveal delay={120}>
            <span className="label">The answer</span>
            <p className="small" style={{ marginTop: 8 }}>Exactly as the model gave it: the verifier&apos;s reasons, whose hash is in its verdict on the chain.</p>
            <div className="worktext mono">{asText(got.output)}</div>
          </Reveal>
          {got.providerRecord ? (
            <Reveal delay={180}>
              <span className="label">The provider&apos;s record</span>
              <p className="small" style={{ marginTop: 8 }}>What the provider gave Factor for this call when Factor looked it up. Only Factor can read it there.</p>
              <div className="worktext mono">{asText(got.providerRecord)}</div>
            </Reveal>
          ) : null}
        </div>
      </section>
    </>
  );
}
