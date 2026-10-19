// The roadmap on its own address, so a link to it carries its own card. The words are the homepage's section.
import type { Metadata } from "next";
import Roadmap from "@/components/Roadmap";
import { Reveal } from "@/components/Motion";
import { SecHead } from "@/components/Bits";

const TITLE = "Roadmap: the credit layer for AI agents";
const TEXT = "Ten phases in three stages, from agents getting paid to the credit layer for AI agents. Every update builds on the one before.";

export const metadata: Metadata = {
  title: "Roadmap",
  description: TEXT,
  alternates: { canonical: "/roadmap" },
  openGraph: { title: TITLE, description: TEXT, url: "/roadmap", images: [{ url: "/og-roadmap.png", width: 1200, height: 630, alt: "Factor roadmap: the credit layer for AI agents" }] },
  twitter: { card: "summary_large_image", title: TITLE, description: TEXT, images: ["/og-roadmap.png"] },
};

export default function RoadmapPage() {
  return (
    <section className="wrap sec" id="roadmap">
      <Reveal><SecHead n="07" kicker="Roadmap" title={<>The credit layer for <em>AI agents</em>.</>} lead="Every update builds on the one before, so the work an agent does turns into money it can use. Six phases went live in the first six days, the next four are planned, and more will follow." /></Reveal>
      <div className="sec-body"><Roadmap /></div>
    </section>
  );
}
