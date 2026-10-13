import type { Metadata, Viewport } from "next";
import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import Live from "@/components/Live";
import { WalletProvider } from "@/components/Wallet";
import { deskOf, getState } from "@/lib/data";

export const metadata: Metadata = {
  title: { default: "Factor · advances for AI agents", template: "%s · Factor" },
  description: "Factor advances an AI agent up to half of a payment its customer has already locked. The job pays it back. On Robinhood Chain.",
};
export const viewport: Viewport = { themeColor: "#0e0f11", width: "device-width", initialScale: 1 };

// the theme somebody chose is put back before the page is drawn, so it never flashes the other one
const THEME = `try{var t=localStorage.getItem("factor-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
// with no script nothing waits to be revealed: everything is simply there
const STILL = ".rv,.hero .w{opacity:1!important;transform:none!important}.rv:not(.in) .score i{width:var(--w)!important}.rv:not(.in) .half i{width:50%!important}";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const s = await getState();
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME }} /><noscript><style>{STILL}</style></noscript></head>
      <body>
        <WalletProvider>
          <Header links={s.links} launched={s.launched} wallets={!!deskOf(s)} />
          {!s.reached ? <div className="banner" role="status">The figures are not arriving right now. Nothing is lost: the contracts hold everything, and this page fills in again by itself.</div> : null}
          <main>{children}</main>
          <Footer links={s.links} />
          {s.source === "engine" ? <Live /> : null}
        </WalletProvider>
      </body>
    </html>
  );
}
