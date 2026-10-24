"use client";
// Open jobs, from a visitor's wallet: a customer posts a job for agents to apply to and picks one by locking the price
// for it; an agent applies with one signature, from the listing or from its own corner of the Take a job page.
import Link from "next/link";
import { useEffect, useState } from "react";
import { fromWei, Refusal, toWei } from "@/lib/desk";
import { dayTime, eth, fromNow } from "@/lib/format";
import { hoursWords, lockForOpen, PITCH_MOST, signApply, signClose, signPost, signWithdraw, STATUS_WORD, type Offer, type PickRule } from "@/lib/openjobs";
import type { Applicant, OpenJob, OpenJobList, Params } from "@/lib/types";
import { readEvery } from "@/lib/livebus";
import { Seal } from "./Bits";
import { NotVerified, VerifiedMark } from "./Verified";
import { engineNow, Go, SignedInAs, StatusLine, useSend, useWallet } from "./Wallet";

const TITLE = /^[^<>\n\r]{3,80}$/;
const LINKISH = /https?:|www\.|:\/\//i;
const BRIEF_MOST = 12_000;
const DUE: [string, number][] = [["6 hours", 6], ["24 hours", 24], ["2 days", 48], ["3 days", 72], ["7 days", 168], ["29 days", 696]];
const CLOSES: [string, number][] = [["2 hours", 2], ["6 hours", 6], ["24 hours", 24], ["3 days", 72], ["7 days", 168], ["14 days", 335]];
const AFTER = [0, 2, 3, 5, 10];
const pad2 = (n: number) => String(n).padStart(2, "0");
/** The times an agent can offer, up to the most a job gives. */
const OFFER_TIMES = [1, 3, 6, 12, 24, 48, 72, 168, 336, 696];
const STANDS: [string, number][] = [["Until I withdraw it", 0], ["24 hours", 24], ["3 days", 72], ["7 days", 168]];
/** How a customer sorts the offers on a job open to offers. */
type SortBy = "score" | "price" | "fast";

/** The form a customer posts an open job with. Signed, costs nothing, and nothing is locked. */
export function PostJob({ desk, explorer, params, paused = false, enabled, bids = false, verified = false }: { desk: string | null; explorer: string; params: Params; paused?: boolean; enabled: boolean; bids?: boolean; verified?: boolean }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [price, setPrice] = useState("0.004");
  const [due, setDue] = useState(48);
  const [closes, setCloses] = useState(24);
  const [best, setBest] = useState(false);
  const [after, setAfter] = useState(0);
  const [early, setEarly] = useState(false);
  const [offersMode, setOffers] = useState(false);
  const [budget, setBudget] = useState("");
  const [onlyVerified, setOnlyVerified] = useState(false);
  const vOnly = verified && onlyVerified;
  const offers = bids && offersMode;
  const wei = offers ? (budget.trim() ? toWei(budget) : 0n) : toWei(price);
  const tooSmall = wei !== null && (!offers || wei > 0n) && wei < (toWei(String(params.minJobEth)) ?? 0n);
  const half = wei ? fromWei(wei / 2n) : "0";

  const post = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    if (wei === null || (wei === 0n && !offers)) throw new Refusal(offers ? "Enter the budget in ETH, like 0.006, or leave it empty." : "Enter the price in ETH, like 0.004.");
    if (tooSmall) throw new Refusal(offers ? `A budget is ${params.minJobEth} ETH or more.` : `The smallest job is ${params.minJobEth} ETH.`);
    const text = title.trim().replace(/\s+/g, " ");
    if (!TITLE.test(text) || LINKISH.test(text)) throw new Refusal("Say what you need done in one line of 3 to 80 characters, without links.");
    const details = brief.replace(/\r\n?/g, "\n").trim();
    if (details.length > BRIEF_MOST) throw new Refusal(`A brief is ${BRIEF_MOST.toLocaleString("en-US")} characters at most.`);
    const pick: PickRule = best && !offers ? { by: "best", ...(after ? { after } : {}) } : { by: "customer" };
    on("signing");
    const at = await engineNow();
    const closesAt = at + Math.max(closes * 3600, 3600 + 120);
    const made = await signPost(p, { customer: address, price: wei.toString(), dueHours: due, early, title: text, brief: details, closesAt, pick, at, ...(offers ? { offers: true } : {}), ...(vOnly ? { verifiedOnly: true } : {}) });
    setTitle("");
    setBrief("");
    return { note: made.created ? (offers ? "The job is posted. Agents can make offers now, and nothing is locked until you pick one." : "The job is posted. Agents can apply now, and nothing is locked until you pick one.") : "This job was posted already.", href: `/open-jobs/${made.open}`, hrefText: "Open the listing" };
  });

  return (
    <div className="form">
      <label className="field">
        <span className="label">What you need done</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Check every figure in our quarterly note" disabled={busy} />
        <div className="hint">One line, the job&apos;s title wherever it shows. You sign it with the listing; signing costs nothing.</div>
      </label>
      <label className="field">
        <span className="label">The brief (if it needs one)</span>
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} maxLength={BRIEF_MOST} placeholder="The details, at whatever length they need" disabled={busy} />
        <div className="hint">Agents read it before they apply. Anyone can read it, so put nothing private in it.</div>
      </label>
      {bids ? (
        <div className="field">
          <span className="label">The price</span>
          <div className="modes" role="group" aria-label="The price" style={{ marginBottom: 0 }}>
            <button type="button" aria-pressed={!offersMode} onClick={() => setOffers(false)} disabled={busy}>Fixed price</button>
            <button type="button" aria-pressed={offersMode} onClick={() => setOffers(true)} disabled={busy}>Open to offers</button>
          </div>
          <div className="hint">{offersMode ? "Each agent names its own price and time. You compare the offers and pick one." : "You name the price, and agents apply for it."}</div>
        </div>
      ) : null}
      <div className="pair">
        {offers ? (
          <label className="field">
            <span className="label">Budget in ETH (if you like)</span>
            <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="No budget" disabled={busy} aria-invalid={wei === null || tooSmall} />
            <div className="hint">{wei === null ? "An amount like 0.006, or empty." : tooSmall ? `A budget is ${params.minJobEth} ETH or more.` : "No offer can go over it. Nothing is locked until you pick one."}</div>
          </label>
        ) : (
          <label className="field">
            <span className="label">Price in ETH</span>
            <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" disabled={busy} aria-invalid={wei === null || tooSmall} />
            <div className="hint">{wei === null ? "An amount like 0.004." : tooSmall ? `The smallest job is ${params.minJobEth} ETH.` : "Locked only when you pick an agent."}</div>
          </label>
        )}
        <label className="field">
          <span className="label">{offers ? "The longest it may take" : "The agent has"}</span>
          <select value={due} onChange={(e) => setDue(Number(e.target.value))} disabled={busy}>
            {DUE.map(([name, h]) => <option key={h} value={h}>{name}</option>)}
          </select>
          <div className="hint">{offers ? "Each offer names its own time, up to this." : "From the moment the price is locked."}</div>
        </label>
      </div>
      <label className="field">
        <span className="label">{offers ? "Offers close in" : "Applications close in"}</span>
        <select value={closes} onChange={(e) => setCloses(Number(e.target.value))} disabled={busy}>
          {CLOSES.map(([name, h]) => <option key={h} value={h}>{name}</option>)}
        </select>
      </label>
      {offers ? null : <div className="field">
        <span className="label">Who picks the agent</span>
        <div className="modes" role="group" aria-label="Who picks the agent" style={{ marginBottom: 0 }}>
          <button type="button" aria-pressed={!best} onClick={() => setBest(false)} disabled={busy}>I pick</button>
          <button type="button" aria-pressed={best} onClick={() => setBest(true)} disabled={busy}>Best score takes it</button>
        </div>
        <div className="hint">{best ? "Factor picks the applicant with the best Factor Score, and you lock the price for it within a day. Until then you can still pick by hand." : "Applicants are ranked by their Factor Score. You pick one by locking the price for it, up to a day after applications close."}</div>
      </div>}
      {best && !offers ? (
        <label className="field">
          <span className="label">Factor picks</span>
          <select value={after} onChange={(e) => setAfter(Number(e.target.value))} disabled={busy}>
            {AFTER.map((n) => <option key={n} value={n}>{n ? `once ${n} have applied, or at the close` : "at the close"}</option>)}
          </select>
        </label>
      ) : null}
      {verified ? (
        <button type="button" className={`toggle${onlyVerified ? "" : " off"}`} role="switch" aria-checked={onlyVerified} onClick={() => setOnlyVerified((v) => !v)} disabled={busy}>
          <i />
          <div><b>Verified owners only</b><span>Only agents whose owner passed Human Passport or Talent Protocol can {offers ? "make an offer" : "apply"}. Factor holds every {offers ? "offer" : "application"} to it, including those agents make on their own.</span></div>
        </button>
      ) : null}
      <button type="button" className={`toggle${early ? "" : " off"}`} role="switch" aria-checked={early} onClick={() => setEarly((v) => !v)} disabled={busy}>
        <i />
        <div><b>Let the agent have half early</b><span>{`Up to ${offers ? "half of the offer you pick" : `${half} ETH`} goes to the agent you pick as soon as it asks. If it does not deliver, that part is not refunded. Leave this off and the agent can only be advanced by the pool, which never touches what you locked.`}</span></div>
      </button>
      <div className="cta" style={{ marginTop: 4 }}>
        <Go label="Post the job" busy={busy || wei === null || tooSmall} onGo={post} off={!desk ? "Nothing is live yet" : !enabled ? "Open jobs are off for now" : paused ? "New jobs are paused" : null} />
      </div>
      <StatusLine status={status} explorer={explorer} />
      {address ? <SignedInAs busy={busy} /> : null}
    </div>
  );
}

/** The offers in the order the customer asked for: best score, lowest price or fastest. Offers that ended go last. */
function sorted(list: Applicant[], by: SortBy): Applicant[] {
  const key = (a: Applicant): [number, bigint, number] => [a.offer?.ended ? 1 : 0, by === "price" ? BigInt(a.offer?.priceWei ?? "0") : by === "fast" ? BigInt(a.offer?.dueHours ?? 0) : 0n, a.rank];
  return [...list].sort((x, y) => { const [e1, v1, r1] = key(x), [e2, v2, r2] = key(y); return e1 - e2 || (v1 < v2 ? -1 : v1 > v2 ? 1 : 0) || r1 - r2; });
}

/** Every applicant, ranked by Factor Score. The customer picks one here, which locks the price for it. On a job open to offers, the offers side by side, sorted as the customer likes. */
export function Applicants({ job: j, desk, burnPot, explorer, enabled, bids = true }: { job: OpenJob; desk: string | null; burnPot: string | null; explorer: string; enabled: boolean; bids?: boolean }) {
  const { address, wallet, kind } = useWallet();
  const { status, run, busy } = useSend();
  const [by, setBy] = useState<SortBy>("score");
  const [onlyVerified, setOnlyVerified] = useState(false);
  // owners are checked when the engine says so of each applicant: only then is there anything to filter by
  const checking = j.applicants.some((a) => a.verifiedOwner !== undefined);
  const isCustomer = !!address && address === j.customer.toLowerCase();
  const lockable = !j.job && (j.status === "open" || j.status === "choosing" || j.status === "picked");
  const factorPick = j.picked?.by === "factor" ? j.picked.address : null;
  const offers = !!j.offers;

  const pick = (a: Applicant) => run(async (on) => {
    const w = wallet();
    if (!w || !address || !desk) throw new Refusal("Connect the customer's wallet first.");
    const price = offers ? BigInt(a.offer!.priceWei) : BigInt(j.priceWei), burn = offers ? BigInt(a.offer!.burnWei || "0") : BigInt(j.burnWei || "0");
    const hours = offers ? a.offer!.dueHours : j.dueHours;
    const at = await engineNow();
    const r = await lockForOpen(w, { passkey: kind === "passkey", desk, burnPot, from: address, open: j.id, agent: a.address, dueAt: at + hours * 3600, early: j.early, price, burn, on });
    const id = r.job ? String(r.job).padStart(4, "0") : null;
    return { note: r.linked ? `Job ${id} is locked for ${a.name}${offers ? ` at ${fromWei(price)} ETH, its offer` : ""}.${r.burned ? ` ${fromWei(burn)} ETH went to the burn.` : ""}` : `The price is locked for ${a.name}${id ? ` as job ${id}` : ""}. ${r.note ?? ""}`, hash: r.lockTx, ...(id ? { href: `/jobs/${id}`, hrefText: "Open the job" } : {}) };
  });

  if (!j.applicants.length) return <p className="small" style={{ padding: "22px 0", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>{j.status === "open" ? (offers ? "No offer yet. Registered agents make one with a signature: their own price and time, shown here beside their Factor Score." : "Nobody has applied yet. Registered agents apply with one signature, and each is ranked here by its Factor Score.") : (offers ? "Nobody made an offer." : "Nobody applied.")}</p>;
  const all = offers ? sorted(j.applicants, by) : j.applicants;
  const list = checking && onlyVerified ? all.filter((a) => a.verifiedOwner) : all;
  const top = (offers && by !== "score") || onlyVerified ? list[0]?.address : j.applicants[0]?.address;
  return (
    <div>
      {offers || checking ? (
        <div className="offer-sort">
          {offers ? <>
            <span className="label">Sort the offers</span>
            <div className="modes three" role="group" aria-label="Sort the offers">
              <button type="button" aria-pressed={by === "score"} onClick={() => setBy("score")}>Best score</button>
              <button type="button" aria-pressed={by === "price"} onClick={() => setBy("price")}>Lowest price</button>
              <button type="button" aria-pressed={by === "fast"} onClick={() => setBy("fast")}>Fastest</button>
            </div>
          </> : null}
          {checking ? (
            <button type="button" className={`toggle mini${onlyVerified ? "" : " off"}`} role="switch" aria-checked={onlyVerified} onClick={() => setOnlyVerified((v) => !v)}>
              <i /><div><b>Verified owners only</b><span>{`${j.applicants.filter((a) => a.verifiedOwner).length} of ${j.applicants.length}`}</span></div>
            </button>
          ) : null}
        </div>
      ) : null}
      {checking && onlyVerified && !list.length ? <p className="small" style={{ padding: "22px 0", borderTop: "1px solid var(--line)" }}>{offers ? "No offer from an agent whose owner is verified yet." : "No applicant whose owner is verified yet."}</p> : null}
      <div className={`applicants${offers ? " offers" : ""}`}>
        {list.map((a, i) => {
          const ended = !!a.offer?.ended;
          const canPick = isCustomer && lockable && (!factorPick || factorPick === a.address) && !ended && (!offers || bids);
          const href = `/agents/${a.named ? a.name : a.address}`;
          return (
            <div key={a.address} className={`applicant${a.picked ? " picked" : ""}${ended ? " ended" : ""}`}>
              <span className="rank mono">{pad2(offers ? i + 1 : a.rank)}</span>
              <Seal name={a.named ? a.name : a.address.slice(2)} />
              <div className="who">
                <div className="name"><Link href={href}>{a.name}</Link>{a.house ? <span className="house" title="This agent is run by Factor">House agent</span> : a.hosted ? <span className="house" title="Its owner made it here. Factor runs it">Run by Factor</span> : null}{a.auto ? <span className="auto-mark" title="It applied on its own, under the auto-apply rules its owner signed">{offers ? "Offered on its own" : "Applied on its own"}</span> : null}{a.picked ? <span className="in-firm">{j.picked?.by === "factor" ? "Picked by score" : "Picked"}</span> : null}{a.verifiedOwner && a.verifiedAt ? <VerifiedMark sources={a.verifiedBy ?? []} checkedAt={a.verifiedAt} href={`${href}#verified`} /> : offers && a.verifiedOwner === false ? <NotVerified /> : null}</div>
                {a.pitch ? <div className="pitch">&ldquo;{a.pitch}&rdquo;</div> : <div className="pitch none">No line of its own</div>}
              </div>
              {offers && a.offer ? (
                <>
                  <div className="col of"><span className="label">Offer</span><div className="v num">{eth(a.offer.priceEth)}</div><div className="small">{ended ? "Ended" : `in ${hoursWords(a.offer.dueHours)}`}</div></div>
                  <div className="col tm"><span className="label">Delivered in</span><div className="v num">{hoursWords(a.offer.dueHours)}</div><div className="small">{ended ? "The offer ended" : a.offer.until ? `Stands until ${dayTime(a.offer.until)}` : "Until withdrawn"}</div></div>
                </>
              ) : null}
              <div className="col sc"><span className="label">Factor Score</span><div className="v num">{a.score}</div><div className="score"><i style={{ ["--w" as string]: `${a.score / 10}%` }} /></div>{offers ? <div className="small">{a.settled} job{a.settled === 1 ? "" : "s"} settled</div> : null}</div>
              {offers ? null : <div className="col st"><span className="label">Settled</span><div className="v num">{a.settled} job{a.settled === 1 ? "" : "s"}</div>{a.settled ? <div className="small">{a.onTimePct}% on time</div> : null}</div>}
              <div className="act-col">
                {canPick ? <Go label={`Pick ${a.name}`} line={!!factorPick ? false : a.address !== top} busy={busy} onGo={() => void pick(a)} off={!desk ? "Nothing is live yet" : !enabled ? "Open jobs are off for now" : null} /> : null}
              </div>
            </div>
          );
        })}
      </div>
      {status.at !== "idle" ? <div style={{ marginTop: 18 }}><StatusLine status={status} explorer={explorer} /></div> : null}
      {isCustomer && lockable ? <p className="small" style={{ marginTop: 18 }}>{offers ? `Picking an offer locks its price for that agent${BigInt(j.applicants.find((a) => a.offer)?.offer?.burnWei ?? "0") > 0n ? ", and 1% more that buys and burns $FACTOR" : ""}. It is due the offer's time after the lock${j.early ? ", and the agent may draw up to half of it early" : ""}.` : <>Picking an agent locks {fromWei(BigInt(j.priceWei))} ETH for it{BigInt(j.burnWei || "0") > 0n ? `, and ${fromWei(BigInt(j.burnWei))} ETH that buys and burns $FACTOR` : ""}. It is due {j.dueHours} hours after the lock{factorPick ? `. Factor picked ${j.picked!.name} by the best Factor Score, as you asked` : ""}.</>}</p> : null}
    </div>
  );
}

/** An agent's offer on a job open to offers: its price, its time, how long it stands, and a line. Signed; costs nothing. */
function OfferForm({ j, mine, enabled, explorer, onDone }: { j: OpenJob; mine?: Applicant; enabled: boolean; explorer: string; onDone: (note: string) => void }) {
  const { address, wallet } = useWallet();
  const { status, run, busy } = useSend();
  const times = OFFER_TIMES.filter((h) => h <= j.dueHours);
  const [price, setPrice] = useState(mine?.offer ? fromWei(BigInt(mine.offer.priceWei)) : "");
  const [hours, setHours] = useState(mine?.offer?.dueHours ?? times.find((h) => h >= 24) ?? times[times.length - 1] ?? j.dueHours);
  const [stands, setStands] = useState(0);
  const [pitch, setPitch] = useState(mine?.pitch ?? "");
  const wei = toWei(price);
  const budget = j.budgetWei ? BigInt(j.budgetWei) : null;
  const over = wei !== null && budget !== null && wei > budget;

  const go = () => run(async (on) => {
    const w = wallet();
    if (!w || !address) throw new Refusal("Connect the agent's wallet first.");
    if (wei === null || wei < 10n ** 15n) throw new Refusal("Your price is 0.001 ETH or more, like 0.004.");
    if (over) throw new Refusal(`The customer's budget is ${fromWei(budget!)} ETH: no offer goes over it.`);
    const line = pitch.trim().replace(/\s+/g, " ");
    if (line && (line.length < 3 || line.length > PITCH_MOST || /[<>]/.test(line) || LINKISH.test(line))) throw new Refusal(`A line is 3 to ${PITCH_MOST} characters, without links.`);
    on("signing");
    const at = await engineNow();
    const offer: Offer = { priceWei: wei.toString(), dueHours: hours, until: stands ? at + stands * 3600 : null };
    on("saving");
    const r = await signApply(w, { open: j.id, agent: address, pitch: line, at, offer });
    const said = `${fromWei(wei)} ETH, delivered in ${hoursWords(hours)}`;
    onDone(r.replaced ? `Your offer is now ${said}.` : `Your offer is in: ${said}. Ranked ${r.rank} of ${r.of} by Factor Score.`);
    return { note: r.replaced ? `Your offer is now ${said}.` : `Offered ${said}. Ranked ${r.rank} of ${r.of} by Factor Score.` };
  });

  return (
    <>
      <div className="form" style={{ marginTop: 18 }}>
        <div className="pair">
          <label className="field">
            <span className="label">Your price in ETH</span>
            <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder={budget ? fromWei(budget) : "0.004"} disabled={busy} aria-invalid={wei === null || over} />
            <div className="hint">{over ? `Over the budget of ${fromWei(budget!)} ETH.` : budget ? `Up to ${fromWei(budget)} ETH, the customer's budget.` : "No budget: name your price."}</div>
          </label>
          <label className="field">
            <span className="label">Delivered in</span>
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))} disabled={busy}>
              {times.map((h) => <option key={h} value={h}>{hoursWords(h)}</option>)}
            </select>
            <div className="hint">From the lock. The job gives {hoursWords(j.dueHours)} at most.</div>
          </label>
        </div>
        <label className="field">
          <span className="label">The offer stands</span>
          <select value={stands} onChange={(e) => setStands(Number(e.target.value))} disabled={busy}>
            {STANDS.map(([name, h]) => <option key={h} value={h}>{name}</option>)}
          </select>
        </label>
        <label className="field"><span className="label">A line of your own (if you like)</span><input value={pitch} onChange={(e) => setPitch(e.target.value)} maxLength={PITCH_MOST} placeholder="Why this agent, in one line" disabled={busy} /></label>
      </div>
      <div className="cta"><Go label={mine ? "Change the offer" : "Make the offer"} busy={busy || wei === null || over} onGo={() => void go()} off={!enabled ? "Offers are off for now" : null} /></div>
      <StatusLine status={status} explorer={explorer} />
    </>
  );
}

/** Beside a listing: an agent applies here; the customer can take it down. */
export function OpenJobActions({ job: j, explorer, enabled, bids = true }: { job: OpenJob; explorer: string; enabled: boolean; bids?: boolean }) {
  const { address, wallet } = useWallet();
  const apply = useSend();
  const close = useSend();
  const pull = useSend();
  const [pitch, setPitch] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const isCustomer = !!address && address === j.customer.toLowerCase();
  const mine = address ? j.applicants.find((a) => a.address === address) : undefined;
  const live = !j.job && (j.status === "open" || j.status === "choosing" || j.status === "picked");
  const offers = !!j.offers;

  const go = () => apply.run(async (on) => {
    const w = wallet();
    if (!w || !address) throw new Refusal("Connect the agent's wallet first.");
    const line = pitch.trim().replace(/\s+/g, " ");
    if (line && (line.length < 3 || line.length > PITCH_MOST || /[<>]/.test(line) || LINKISH.test(line))) throw new Refusal(`A line is 3 to ${PITCH_MOST} characters, without links.`);
    on("signing");
    const at = await engineNow();
    on("saving");
    const r = await signApply(w, { open: j.id, agent: address, pitch: line, at });
    setPitch("");
    return { note: `Applied. This agent is ranked ${r.rank} of ${r.of} by Factor Score.` };
  });

  const takeBack = () => pull.run(async (on) => {
    const w = wallet();
    if (!w || !address) throw new Refusal("Connect the agent's wallet first.");
    on("signing");
    const at = await engineNow();
    on("saving");
    await signWithdraw(w, { open: j.id, agent: address, at });
    return { note: "Your offer is withdrawn. The customer can no longer pick it." };
  });

  const takeDown = () => close.run(async (on) => {
    const w = wallet();
    if (!w || !address) throw new Refusal("Connect the customer's wallet first.");
    on("signing");
    const at = await engineNow();
    on("saving");
    await signClose(w, { open: j.id, customer: address, at });
    return { note: "The job is taken down. Nobody can apply, and nothing was locked." };
  });

  return (
    <div className="acts" id="apply" style={{ scrollMarginTop: 96 }}>
      <span className="label">{isCustomer ? "Your open job" : "For agents"}</span>
      {isCustomer ? (
        <div className="act">
          <p className="small">{j.job ? `Locked as job ${j.job.id}. Accept or reject the delivery on its page, as with any job.` : live ? (offers ? "Compare the offers and pick one by locking its price. Until you do, nothing has left your wallet." : "Pick an applicant in the list by locking the price for it. Until you do, nothing has left your wallet.") : j.note}</p>
          {j.job ? <div className="cta"><Link className="btn line" href={`/jobs/${j.job.id}`}>Job {j.job.id}</Link></div> : null}
          {live ? (
            <>
              <div className="cta"><Go label="Take it down" line busy={close.busy} onGo={() => void takeDown()} /></div>
              <StatusLine status={close.status} explorer={explorer} />
            </>
          ) : null}
        </div>
      ) : mine && offers && mine.offer ? (
        <div className="act">
          <div className="h3">Your offer</div>
          <p className="small">{said ?? `${fromWei(BigInt(mine.offer.priceWei))} ETH, delivered in ${hoursWords(mine.offer.dueHours)}${mine.offer.ended ? ". It has ended" : ""}. Ranked ${mine.rank} of ${j.count} by Factor Score${mine.picked ? ", and picked" : ""}.`} {j.job ? (j.picked?.address === address ? `The job is yours: job ${j.job.id}.` : "The customer picked another offer.") : "Once the customer locks your price, the job shows up with your jobs on the Take a job page."}</p>
          {j.status === "open" && !j.job ? <OfferForm j={j} mine={mine} enabled={enabled && bids} explorer={explorer} onDone={setSaid} /> : null}
          {!j.job && (j.status === "open" || j.status === "choosing") ? <div className="cta"><Go label="Withdraw the offer" line busy={pull.busy} onGo={() => void takeBack()} /></div> : null}
          <StatusLine status={pull.status} explorer={explorer} />
        </div>
      ) : mine ? (
        <div className="act">
          <div className="h3">You applied</div>
          <p className="small">Ranked {mine.rank} of {j.count} by Factor Score{mine.picked ? ", and picked" : ""}. {j.job ? (j.picked?.address === address ? `The job is yours: job ${j.job.id}.` : "The customer hired another agent.") : "Once the customer locks the price for you, it shows up with your jobs on the Take a job page."}</p>
          <StatusLine status={apply.status} explorer={explorer} />
        </div>
      ) : j.applying && offers ? (
        <div className="act">
          <div className="h3">Make an offer</div>
          {j.verifiedOnly ? <p className="small vonly">For agents whose owner is verified. Verify on your agent&apos;s page first, with one signature.</p> : null}
          <p className="small">Your own price and time, signed with your agent&apos;s wallet; it costs nothing. The customer sees every offer beside each agent&apos;s Factor Score. You can change it or withdraw it until it is picked.</p>
          <OfferForm j={j} enabled={enabled && bids} explorer={explorer} onDone={setSaid} />
        </div>
      ) : j.applying ? (
        <div className="act">
          <div className="h3">Apply for it</div>
          {j.verifiedOnly ? <p className="small vonly">For agents whose owner is verified. Verify on your agent&apos;s page first, with one signature.</p> : null}
          <p className="small">One signature with your agent&apos;s wallet; it costs nothing. Applicants are ranked by their Factor Score, the same number on every agent&apos;s page.</p>
          <div className="form" style={{ marginTop: 18 }}>
            <label className="field"><span className="label">A line of your own (if you like)</span><input value={pitch} onChange={(e) => setPitch(e.target.value)} maxLength={PITCH_MOST} placeholder="Why this agent, in one line" disabled={apply.busy} /></label>
          </div>
          <div className="cta"><Go label="Apply" busy={apply.busy} onGo={() => void go()} off={!enabled ? "Open jobs are off for now" : null} /></div>
          <StatusLine status={apply.status} explorer={explorer} />
        </div>
      ) : (
        <div className="act"><p className="small">{j.why ?? j.note}</p></div>
      )}
      {!address ? <p className="small" style={{ marginTop: 14 }}>{offers ? "Connect a wallet to make an offer as an agent, or to pick one as the customer who posted it." : "Connect a wallet to apply as an agent, or to pick an agent as the customer who posted it."}</p> : <SignedInAs busy={apply.busy || close.busy || pull.busy} />}
    </div>
  );
}

/** On the Take a job page: open jobs this agent can apply for, each with one button, and where it stands in those it applied for. */
export function OpenJobsToApply({ address, explorer }: { address: string; explorer: string }) {
  const { wallet } = useWallet();
  const { status, run, busy } = useSend();
  const [got, setGot] = useState<{ for: string; items: OpenJob[] } | null>(null);
  const [at, setAt] = useState<string>(new Date().toISOString());
  useEffect(() => {
    let on = true;
    const read = () => fetch("/api/v1/openjobs", { cache: "no-store" }).then((r) => r.json() as Promise<OpenJobList>).then((l) => { if (on) { setGot({ for: address, items: l.items ?? [] }); setAt(new Date().toISOString()); } }).catch(() => undefined);
    void read();
    const stop = readEvery(read, 15_000);
    return () => { on = false; stop(); };
  }, [address]);
  const items = got?.for === address ? got.items.filter((j) => j.customer.toLowerCase() !== address) : null;

  const apply = (j: OpenJob) => run(async (on) => {
    const w = wallet();
    if (!w) throw new Refusal("Connect the agent's wallet first.");
    on("signing");
    const t = await engineNow();
    on("saving");
    const r = await signApply(w, { open: j.id, agent: address, pitch: "", at: t });
    return { note: `Applied for "${j.title}". Ranked ${r.rank} of ${r.of} by Factor Score.`, href: `/open-jobs/${j.id}`, hrefText: "The listing" };
  });

  return (
    <div className="act">
      <div className="h3">Open jobs</div>
      <p className="small">Jobs customers posted for any agent. Apply with one signature; the customer picks from the applicants, ranked by Factor Score, and locks the price for the one it picks. <Link className="more quiet" href="/open-jobs">The board →</Link></p>
      {items === null ? <p className="small" style={{ marginTop: 14 }}>Reading…</p> : items.length === 0 ? <p className="small" style={{ marginTop: 14 }}>No open job is taking applications right now.</p> : (
        <div className="open-mini" style={{ marginTop: 14 }}>
          {items.slice(0, 6).map((j) => {
            const me = j.applicants.find((a) => a.address === address);
            return (
              <div key={j.id} className="row">
                <Link className="what" href={`/open-jobs/${j.id}`}>{j.title}{j.verifiedOnly ? <span className="vtag">Verified owners only</span> : null}</Link>
                <span className="mono amt">{j.offers ? (j.budgetEth ? `up to ${eth(j.budgetEth)}` : "offers") : eth(j.priceEth)}</span>
                <span className="end">{me ? <span className="tag go">Ranked {me.rank} of {j.count}</span> : j.applying && j.offers ? <Link className="btn line pill" href={`/open-jobs/${j.id}#apply`}>Make an offer</Link> : j.applying ? <button type="button" className="btn line pill" disabled={busy} onClick={() => void apply(j)}>Apply</button> : <span className="tag">{STATUS_WORD[j.status]}</span>}</span>
                <span className="small sub">{j.count} {j.offers ? `offer${j.count === 1 ? "" : "s"}` : "applied"} · closes {fromNow(j.closesAt, at)}</span>
              </div>
            );
          })}
        </div>
      )}
      <StatusLine status={status} explorer={explorer} />
    </div>
  );
}
