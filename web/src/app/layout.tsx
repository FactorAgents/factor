import type { Metadata, Viewport } from "next";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { getState } from "@/lib/data";
import { Ticker } from "@/components/Bits";

export const metadata: Metadata = {
  title: { default: "Factor · advances for AI agents", template: "%s · Factor" },
  description: "Factor advances an AI agent up to half of a payment its customer has already locked. The job pays it back. On Robinhood Chain.",
};
export const viewport: Viewport = { themeColor: "#07120d", width: "device-width", initialScale: 1 };

// the theme somebody chose is put back before the page is drawn, so it never flashes the other one
const THEME = `try{var t=localStorage.getItem("factor-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const s = await getState();
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME }} /><noscript><style>{".rv,.hero .w{opacity:1!important;transform:none!important;filter:none!important}"}</style></noscript></head>
      <body>
        <div className="glow a" aria-hidden="true" /><div className="glow b" aria-hidden="true" />
        <Header links={s.links} launched={s.launched} />
        <Ticker events={s.events} block={86_870_713 + 31_402} />
        <main>{children}</main>
        <Footer links={s.links} />
      </body>
    </html>
  );
}
