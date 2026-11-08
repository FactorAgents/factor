// HEY builder records on the site (engine/src/hey.ts): the words an agent's owner signs to link it to its maker's project
// on HEY Research Lab, the same to the letter as the engine checks and the kit signs (packages/kit/src/hey.ts), and how
// HEY's facts are said on a page. Every fact is HEY's, read by Factor's engine: nothing is worked out here, and nothing
// here is a score.
import { Refusal } from "./desk";
import { signText, type Provider } from "./wallet";

export const HEY_SITE = "https://heyresearch.xyz";
/** Factor's own project on HEY, and HEY's badge for it, as HEY's badge page gives them. */
export const HEY_FACTOR = { page: `${HEY_SITE}/project/factor`, link: `${HEY_SITE}/project/factor?utm_source=badge&utm_medium=html`, badge: `${HEY_SITE}/api/badge/factor` };

export const heyLinkMessage = (o: { agent: string; project: string; at: number }): string =>
  ["Factor: link an agent to its maker's project on HEY", `agent: ${o.agent}`, `project: ${o.project}`, `at: ${o.at}`].join("\n");

/** What the owner typed, as the engine takes it: a HEY slug, a HEY project link, a 0x contract, or "none". Null: none of these. */
export function projectOf(raw: string): string | null {
  const t = raw.trim();
  if (t === "none") return "none";
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return t.toLowerCase();
  const link = /^(?:https?:\/\/)?(?:www\.)?heyresearch\.xyz\/project\/([a-z0-9-]{1,100})\/?(?:[?#].*)?$/i.exec(t);
  const slug = (link ? link[1]! : t).toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug) ? slug : null;
}

export interface LinkAnswer { link: { slug: string; name: string | null; contract: string | null; sourceUrl: string; by: string; at: string } | null }

/** The owner signs which project on HEY is its maker's, with the wallet that runs the agent; Factor checks HEY has it. */
export async function signHeyLink(p: Provider, o: { agent: string; by: string; project: string; at: number }): Promise<LinkAnswer> {
  const signature = await signText(p, heyLinkMessage(o), o.by);
  const r = await fetch("/api/v1/hey/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...o, signature }) });
  const b = (await r.json().catch(() => ({}))) as LinkAnswer & { error?: string };
  if (!r.ok) { const t = b.error ?? "Factor could not take the link"; throw new Refusal(t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".")); }
  return b;
}

/** A day as HEY's record dates it: "7 Nov 2026". */
export const heyDay = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
