// The Desk, Factor's own mind, as the site shows it: a note set like a memo from a careful credit officer, with the
// time it was written and its mark. A small light shows while it is writing.
import type { Desk, DeskNote } from "@/lib/types";
import { clock } from "@/lib/format";

const WHAT: Record<DeskNote["kind"], string> = { opening: "Opening file", file: "Credit file", reason: "Why an advance was allowed", letter: "The Desk's letter" };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** One note of the Desk's. */
export function Memo({ note, big = false }: { note: DeskNote; big?: boolean }) {
  return (
    <article className={`memo${big ? " big" : ""}`}>
      <header><span className="label">{WHAT[note.kind]}{note.kind === "letter" ? ` · ${note.subject}` : ""}</span><span className="t mono">{day(note.at)} · {clock(note.at)} UTC</span></header>
      <p>{note.text}</p>
      <footer><i className="seal" aria-hidden="true">F</i><span>The Desk</span></footer>
    </article>
  );
}

/** A short credit file, under an agent's row or on its page. */
export function FileLine({ text, at }: { text: string; at: string }) {
  return <p className="fileline"><b>The Desk</b><span>{text}</span><em className="mono">{day(at)} · {clock(at)} UTC</em></p>;
}

/** The home page's corner for the Desk: its last letter, else its newest notes. */
export function DeskCorner({ desk }: { desk: Desk }) {
  const notes = desk.letter ? [desk.letter, ...desk.latest.filter((n) => n.kind !== "letter").slice(0, 2)] : desk.latest.slice(0, 3);
  if (!notes.length) return null;
  return (
    <div className="desk">
      <div className="desk-state"><span className={`lamp${desk.writing ? " on" : ""}`} aria-hidden="true" /><span>{desk.writing ? "The Desk is writing" : "The Desk reads every record and writes down what it sees"}</span></div>
      <div className="memos">{notes.map((n, i) => <Memo key={`${n.kind}-${n.subject}-${n.at}`} note={n} big={i === 0} />)}</div>
    </div>
  );
}
