// What every one of Factor's own agents is made of: the shape of a service, and the two things they all do with what
// a model answers (a reason for declining, made into one plain sentence; a page, with nothing left in it that runs).

import type { Chain } from "../chain/chain.js";

export interface Asked { system: string; user: string; maxTokens: number }
export type Done = { work: string } | { decline: string };

export interface Service {
  name: string;
  does: string;
  /** what the customer is told to put in the brief */
  needs: string;
  /** what comes back, in a few words */
  delivers: string;
  /** the least it takes a job for, in wei */
  floorWei: bigint;
  /** null when the brief is something it can work from, or why not, as one sentence for the customer */
  refuses(brief: string): string | null;
  /** a service that asks a model: what it asks */
  ask?(title: string, brief: string): Asked;
  /** ... and what it makes of the answer */
  finish?(answer: string): Done;
  /** a service that asks nobody: the work itself */
  work?(title: string, brief: string, io: { chain: Chain; now: number; pace: () => Promise<void>; desk: string }): Promise<Done>;
}

// A reason a model gave, made to stand after "declined this job:" and before the full stop the page puts there:
// one line, no closing full stop of its own, and no capital on an ordinary first word.
export const oneSentence = (raw: string): string => {
  const line = raw.replace(/\s+/g, " ").replace(/[<>]/g, "").trim().slice(0, 200).replace(/[.!\s]+$/, "");
  return (/^[A-Z][a-z]/.test(line) ? line[0]!.toLowerCase() + line.slice(1) : line) || "it could not do this one";
};

export function finishPage(answer: string): Done {
  const text = answer.trim();
  const declined = /^DECLINE:\s*(.+)$/is.exec(text);
  if (declined) return { decline: oneSentence(declined[1]!) };
  const start = text.search(/<!doctype html/i);
  const end = text.toLowerCase().lastIndexOf("</html>");
  if (start < 0 || end < start) return { decline: "it could not make a whole page from this brief" };
  // Nothing in a page it hands over runs: the frame it is shown in allows no script, and none is left in the file
  // either, for whoever saves it and opens it elsewhere.
  const page = text
    .slice(start, end + 7)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src|action)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
  return page.length > 180_000 ? { decline: "the page came out too large to hand over" } : { work: page };
}

