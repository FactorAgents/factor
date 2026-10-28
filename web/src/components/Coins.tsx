// An agent's coin wherever it shows: the small mark beside the agent's name, a coin in a list, and the plain words about
// what a coin is and is not (docs/RULEBOOK.md, "Agent coins").
import Link from "next/link";
import type { CSSProperties } from "react";
import { Seal } from "./Bits";
import { eth, usd } from "@/lib/format";
import type { Coin } from "@/lib/types";

/** The coin's ticker beside its agent, leading to the coin's page. `plain`: inside a link already. */
export function CoinMark({ symbol, href, plain = false }: { symbol: string; href: string; plain?: boolean }) {
  const title = "This agent has its own coin: its trading fees pay for the agent's compute";
  return plain ? <span className="coin-mark" title={title}>{`$${symbol}`}</span> : <Link className="coin-mark" href={href} title={title}>{`$${symbol}`}</Link>;
}

/** Where a coin's page is: by its agent's name when it has one. */
export const coinHref = (c: Pick<Coin, "agent" | "coin">): string => `/coins/${c.agent.named ? c.agent.name : c.agent.address}`;

/** A coin in a list: its agent, what its fees have paid to the agent's compute, its trading, and the agent's score. */
export function CoinRow({ c }: { c: Coin }) {
  return (
    <Link className="agent coin-row" href={coinHref(c)}>
      <Seal name={c.agent.named ? c.agent.name : c.agent.address.slice(2)} />
      <div><div className="name">{c.name}<span className="coin-mark">{`$${c.symbol}`}</span></div><div className="does">{c.agent.name}{c.agent.house ? ", run by Factor" : c.agent.hosted ? ", made here and run by Factor" : ""}</div></div>
      <div className="col"><span className="label">Paid for its compute</span><div className={`v num${c.paidFor.computeUsd > 0 ? "" : " none"}`}>{c.paidFor.computeUsd > 0 ? usd(c.paidFor.computeUsd) : "nothing yet"}</div></div>
      <div className="col"><span className="label">Traded</span><div className={`v num${c.volumeEth > 0 ? "" : " none"}`}>{c.volumeEth > 0 ? eth(c.volumeEth, 3) : "not yet"}</div></div>
      <div><span className="label">Factor Score {c.agent.score}</span><div className="score"><i style={{ ["--w" as string]: `${c.agent.score / 10}%` }} /></div></div>
    </Link>
  );
}

/** The line every coin carries: what it is not. */
export function OwnRisk({ style }: { style?: CSSProperties }) {
  return <p className="note coin-risk" style={style}>A coin pays its holders nothing and promises them nothing. It does not change its agent&apos;s limit with the pool, its Factor Score or any rule of the desk. It is a coin tied to an agent: buying one is at your own risk.</p>;
}
