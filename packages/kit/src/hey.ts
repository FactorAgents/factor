// HEY builder records, for an app, an agent or an assistant (docs/HEY.md): what HEY Research Lab (heyresearch.xyz), the
// public record of building on Robinhood Chain, has recorded of a project's builders, read through Factor's site. Factor's
// engine is what asks HEY, with "x-hey-integration: factor/<version>" on every request; the kit never calls HEY itself.
// HEY's facts come as HEY gives them, under HEY's own names, with the page on HEY they are from. They are not a rating,
// and they never change the Factor Score.
//
//   const r = await builderRecord("$FACTOR");            // by name, $TICKER, HEY page or 0x contract
//   const a = await agentBuilder("report-lead");          // the project the agent's owner linked it to, and its record
//   builderRecordText(r);                                 // in words, with the source
//   await factor.linkHey("factor");                       // an agent's owner links it to its maker's project ("none" unlinks)
import { DEFAULT_API } from "./defaults.js";
import { Refusal } from "./words.js";

/** HEY's facts in a builder record, under HEY's own names and as HEY gives them. */
export interface HeyFacts {
  verified_builder: boolean | null;
  research_level: string | null;
  hey_status: string | null;
  hey_status_label: string | null;
  hey_status_help: string | null;
  last_activity_at: string | null;
  meaningful_ships_30d: number | null;
  latest_meaningful_ship: { title: string | null; url: string | null; timestamp: string | null; kind: string | null; evidence_id: string | null; evidence_link: string | null } | null;
  latest_change: { summary: string | null; occurred_at: string | null; precision: string | null; evidence_id: string | null; url: string | null } | null;
  latest_release: unknown;
  latest_deployment: unknown;
  repo_url: string | null;
  token_verification: string | null;
  as_of: string | null;
}

/** A project's builder record on HEY, with where it is from. */
export interface BuilderRecord {
  found: true;
  source: "HEY Research Lab";
  /** the project's page on HEY: cite this */
  sourceUrl: string;
  badgeUrl: string;
  project: { slug: string; name: string; symbol: string | null; contract: string | null };
  facts: HeyFacts;
  disclaimer: string | null;
  read: string[];
  readAt: string;
  stale: boolean;
  from: "builder card" | "snapshot";
  integration: string;
}

/** Not on HEY, and why: HEY does not have it, has several by that name (the candidates), or could not be reached. */
export interface NotOnHey {
  found: false;
  why: string;
  away?: boolean;
  candidates?: { slug: string; name: string; symbol: string | null; contract: string | null; status: string | null; sourceUrl: string }[];
  source: "HEY Research Lab";
  sourceUrl: string;
}

export type HeyLookup = BuilderRecord | NotOnHey;

/** An agent's link to its maker's project on HEY, as its owner signed it, and that project's record. */
export interface AgentBuilder {
  enabled: true;
  agent: string;
  link: { slug: string; name: string | null; contract: string | null; sourceUrl: string; by: string; at: string } | null;
  record: HeyLookup | null;
  /** the wallets that may change the link: the agent's own, and whoever runs it on Factor */
  owners: string[];
}

/** The words an agent's owner signs to link it to a project on HEY, or to unlink it ("none"). The same as the engine checks. */
export const heyLinkMessage = (o: { agent: string; project: string; at: number }): string =>
  ["Factor: link an agent to its maker's project on HEY", `agent: ${o.agent}`, `project: ${o.project}`, `at: ${o.at}`].join("\n");

const siteOf = (api?: string): string => (api ?? DEFAULT_API).trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "").replace(/\/v1$/, "");

async function get<T>(api: string | undefined, path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${siteOf(api)}/api/v1${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Refusal("Factor's site could not be reached.", "no_site");
  }
  const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  const said = typeof b.error === "string" ? `${b.error.charAt(0).toUpperCase()}${b.error.slice(1)}${/[.!?]$/.test(b.error) ? "" : "."}` : null;
  if (r.status === 404) throw new Refusal(said ?? "Not found.", "not_found");
  if (r.status === 400) throw new Refusal(said ?? "Factor could not read that.", "bad_project");
  if (r.status === 429) throw new Refusal(said ?? "Too many in a minute: try again in a minute.", "rate");
  if (r.status !== 200) throw new Refusal(`Factor's site answered ${r.status}.`, "no_site");
  if (b.enabled === false) throw new Refusal("HEY builder records are switched off on Factor just now.", "hey_off");
  return b as T;
}

/** A project's builder record on HEY, by its name, its $TICKER, its HEY page or a 0x contract on Robinhood Chain. */
export function builderRecord(project: string, o: { api?: string } = {}): Promise<HeyLookup> {
  const q = String(project ?? "").replace(/[\u0000-\u001f]/g, "").trim();
  if (!q || q.length > 120) throw new Refusal("Name the project by its name, its $TICKER, its HEY page or its contract (up to 120 characters).", "bad_project");
  return get<HeyLookup & { enabled?: boolean }>(o.api, `/hey/record?q=${encodeURIComponent(q)}`);
}

/** The project on HEY an agent's owner linked it to, and that project's builder record. */
export function agentBuilder(agent: string, o: { api?: string } = {}): Promise<AgentBuilder> {
  const id = String(agent ?? "").trim();
  if (!/^(0x[0-9a-fA-F]{40}|[0-9a-z-]{3,42})$/.test(id)) throw new Refusal("Name the agent by its name on Factor or its address.", "bad_agent");
  return get<AgentBuilder>(o.api, `/hey/agent/${id}`);
}

/** A builder record in words, for a person or an assistant: HEY's facts as HEY's, with the link to the source. */
export function builderRecordText(r: HeyLookup, o: { agent?: string } = {}): string {
  if (!r.found) {
    const lines = [`Not on HEY: ${r.why}.`];
    for (const c of r.candidates ?? []) lines.push(`- ${c.name}${c.symbol ? ` ($${c.symbol})` : ""}${c.status ? `: ${c.status}` : ""}. ${c.sourceUrl}`);
    if (!r.away) lines.push(`HEY's search: ${r.sourceUrl}`);
    return lines.join("\n");
  }
  const f = r.facts;
  const lines = [`${o.agent ? `${o.agent} is linked by its owner to ${r.project.name} on HEY. ` : ""}${r.project.name}${r.project.symbol ? ` ($${r.project.symbol})` : ""}: its builder record on HEY Research Lab, the public record of building on Robinhood Chain.`];
  if (f.verified_builder) lines.push("HEY marks it a Verified Builder: this team ships.");
  if (f.hey_status_label || f.hey_status) lines.push(`HEY's status: ${f.hey_status_label ?? f.hey_status}${f.hey_status_help ? ` (${f.hey_status_help.replace(/\.$/, "")})` : ""}.`);
  if (f.meaningful_ships_30d !== null) lines.push(`Meaningful ships HEY counted in 30 days: ${f.meaningful_ships_30d}.`);
  if (f.latest_meaningful_ship?.title) lines.push(`Latest ship HEY recorded: ${f.latest_meaningful_ship.title}${f.latest_meaningful_ship.timestamp ? `, ${f.latest_meaningful_ship.timestamp.slice(0, 10)}` : ""}${f.latest_meaningful_ship.evidence_link ? ` (evidence: ${f.latest_meaningful_ship.evidence_link})` : ""}.`);
  if (f.repo_url) lines.push(`Its code, as HEY has it: ${f.repo_url}`);
  lines.push(`Source: ${r.sourceUrl} (read ${r.readAt.slice(0, 16).replace("T", " ")} UTC${r.stale ? ", an earlier reading: HEY could not be reached just now" : ""}).`);
  if (r.disclaimer) lines.push(`HEY: "${r.disclaimer}"`);
  lines.push("This is HEY's record of what the team shipped, not a rating, and it never changes the Factor Score.");
  return lines.join("\n");
}

/** Hand an owner's signed link to the site. */
export async function sendHeyLink(body: Record<string, unknown>, o: { api?: string } = {}): Promise<AgentBuilder["link"]> {
  let r: Response;
  try {
    r = await fetch(`${siteOf(o.api)}/api/v1/hey/link`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Refusal("Factor's site could not be reached.", "no_site");
  }
  const b = (await r.json().catch(() => ({}))) as { error?: string; link?: AgentBuilder["link"] };
  const said = typeof b.error === "string" ? `${b.error.charAt(0).toUpperCase()}${b.error.slice(1)}${/[.!?]$/.test(b.error) ? "" : "."}` : null;
  if (r.status === 200) return b.link ?? null;
  if (r.status === 503) throw new Refusal(said ?? "HEY builder records are switched off on Factor just now.", "hey_off");
  if (r.status === 429) throw new Refusal(said ?? "Too many in a minute: try again in a minute.", "rate");
  if (r.status === 401) throw new Refusal(said ?? "The signature was not taken.", "bad_signature");
  throw new Refusal(said ?? `Factor's site answered ${r.status}.`, r.status === 403 ? "not_yours" : r.status === 404 ? "not_found" : "refused");
}
