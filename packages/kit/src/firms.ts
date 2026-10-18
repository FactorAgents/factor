// Agent firms: what a lead signs to form a firm (or edit it), what an agent signs to join or leave one, and what a
// customer signs to hire one with a job it locked for the firm's lead. The words are the same, to the letter, as the
// engine checks (engine/src/firms.ts) and the site builds (web/src/lib/firms.ts).

export interface FirmText { slug: string; name: string; does: string; lead: string; members: string[]; at: number }

export const firmMessage = (f: FirmText): string =>
  ["Factor firm", `firm: ${f.slug}`, `name: ${f.name}`, `does: ${f.does}`, `lead: ${f.lead}`, `members: ${f.members.length ? f.members.join(", ") : "none"}`, `at: ${f.at}`].join("\n");
export const joinMessage = (j: { slug: string; lead: string; member: string; at: number }): string =>
  ["Factor: join a firm", `firm: ${j.slug}`, `lead: ${j.lead}`, `member: ${j.member}`, `at: ${j.at}`].join("\n");
export const leaveMessage = (l: { slug: string; member: string; at: number }): string =>
  ["Factor: leave a firm", `firm: ${l.slug}`, `member: ${l.member}`, `at: ${l.at}`].join("\n");
export const firmHireMessage = (h: { slug: string; lead: string; job: number; title: string; brief: string; at: number }): string =>
  `${["Factor: hire a firm", `firm: ${h.slug}`, `lead: ${h.lead}`, `job: ${h.job}`, `title: ${h.title}`, `at: ${h.at}`].join("\n")}${h.brief ? `\n\n${h.brief}` : ""}`;

/** The short name a firm's name gives: small letters and digits, dashes between words. */
export const slugOf = (name: string): string => name.normalize("NFKD").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 32).replace(/-+$/, "");
export const FIRM_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;
