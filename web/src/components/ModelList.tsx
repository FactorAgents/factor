"use client";
// Every model compute credit buys through the second door, with what a million tokens costs through Factor, read
// from the gateway as it is now. A search box finds one by name or maker. Shows nothing while no model is served.
import { Fragment, useEffect, useState } from "react";

interface Model { id: string; name?: string; owned_by?: string; pricing?: { inUsd: number; outUsd: number } }

const MOST = 24;
// the makers people know come first; the rest after them, in order
const FIRST = ["openai", "anthropic", "google", "x-ai", "deepseek", "meta-llama", "mistralai", "qwen", "moonshotai"];
const rank = (id: string): number => { const i = FIRST.indexOf(id.split("/")[0]!); return i < 0 ? FIRST.length : i; };
const usd = (n: number): string => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;

export default function ModelList() {
  const [models, setModels] = useState<Model[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    let on = true;
    fetch("/api/v1/compute/v1/models", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { data?: Model[] }).data ?? [] : []))
      .then((d) => { if (on) setModels(d); })
      .catch(() => { if (on) setModels([]); });
    return () => { on = false; };
  }, []);
  if (!models?.length) return null;
  const words = q.trim().toLowerCase();
  const found = models.filter((m) => !words || `${m.id} ${m.name ?? ""}`.toLowerCase().includes(words)).sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  const makers = new Set(models.map((m) => m.owned_by ?? m.id.split("/")[0])).size;
  return (
    <div style={{ marginTop: 36 }}>
      <span className="label">{models.length} models from {makers} makers</span>
      <label className="field" style={{ marginTop: 14 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="gpt, claude, gemini, grok, deepseek, llama…" autoCapitalize="none" spellCheck={false} aria-label="Find a model" />
      </label>
      <dl className="kv" style={{ marginTop: 18 }}>
        {found.slice(0, MOST).map((m) => (
          <Fragment key={m.id}>
            <dt>{m.id}{m.name && m.name !== m.id ? <small>{m.name}</small> : null}</dt>
            <dd>{m.pricing ? `${usd(m.pricing.inUsd)} / ${usd(m.pricing.outUsd)}` : ""}</dd>
          </Fragment>
        ))}
      </dl>
      <p className="small" style={{ marginTop: 12 }}>
        {found.length === 0 ? "No model has that in its name." : found.length > MOST ? `In / out, per million tokens. ${found.length - MOST} more: type to find one.` : "In / out, per million tokens."}
      </p>
    </div>
  );
}
