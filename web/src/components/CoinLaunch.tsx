"use client";
// "Launch this agent's coin", on the agent's page. Its maker launches it from its own wallet with the agent's
// permission, which Factor signs for an agent it runs once the maker has signed its ask; an agent with a wallet of its
// own launches it itself. The name and the ticker are checked before the button shows. On a phone with no wallet, the
// button opens this page inside MetaMask, like every other send on the site.
import { useEffect, useState } from "react";
import { decodeFunctionResult, encodeFunctionData, formatEther, type Abi } from "viem";
import { agentCoinLauncherAbi } from "@/lib/abi/AgentCoinLauncher";
import { askPermission, coinDescription, coinLogo, coinNameProblem, launchCoin, saltFor, suggestCoin, type CoinsAbout } from "@/lib/coins";
import { Refusal, toWei } from "@/lib/desk";
import { ethCall } from "@/lib/wallet";
import { short } from "@/lib/format";
import { engineNow, Go, StatusLine, useSend, useWallet } from "./Wallet";

const ABI = agentCoinLauncherAbi as Abi;
const ethText = (wei: bigint, places = 6): string => { const s = Number(formatEther(wei)).toFixed(places); return s.replace(/0+$/, "").replace(/\.$/, ""); };

export default function CoinLaunch({ about, agent, explorer }: { about: CoinsAbout; agent: { address: string; name: string; named: boolean; hosted?: boolean; owner?: string; house: boolean }; explorer: string }) {
  const { address, wallet } = useWallet();
  const first = agent.named ? suggestCoin(agent.name) : { name: "", symbol: "" };
  const [name, setName] = useState(first.name);
  const [symbol, setSymbol] = useState(first.symbol);
  const [buy, setBuy] = useState("");
  const [fee, setFee] = useState<bigint | null>(about.launchFeeWei ? BigInt(about.launchFeeWei) : null);
  const { status, run, busy } = useSend();
  const launcher = about.launcher!;
  const site = about.site ?? "https://factoragents.fun";

  // Pons' fee as the visitor's own wallet reads it, when there is a wallet to ask
  useEffect(() => {
    const p = wallet();
    if (!p || !address) return;
    let on = true;
    void ethCall(p, launcher, encodeFunctionData({ abi: ABI, functionName: "launchFee" })).then((d) => { if (on) setFee(decodeFunctionResult({ abi: ABI, functionName: "launchFee", data: d as `0x${string}` }) as bigint); }).catch(() => undefined);
    return () => { on = false; };
  }, [address, wallet, launcher]);

  const problem = coinNameProblem(agent.named ? agent.name : null, name.trim(), symbol.trim());
  const firstBuy = buy.trim() === "" ? 0n : toWei(buy);
  const role = !address ? null : address === agent.address ? "agent" : "maker";
  // an agent made on the site has one maker, and the page knows it; Factor's own are launched by Factor's wallet
  const notMaker = role === "maker" && agent.hosted && agent.owner && agent.owner !== address;
  const gasWei = about.launchGasWei ? BigInt(about.launchGasWei) : null;

  const go = () => run(async (on) => {
    const p = wallet();
    if (!p || !address) throw new Refusal("Connect a wallet first.");
    if (problem) throw new Refusal(problem.charAt(0).toUpperCase() + problem.slice(1) + ".");
    if (firstBuy === null) throw new Refusal("The first buy is not an amount of ETH.");
    const launchFee = fee ?? (decodeFunctionResult({ abi: ABI, functionName: "launchFee", data: (await ethCall(p, launcher, encodeFunctionData({ abi: ABI, functionName: "launchFee" }))) as `0x${string}` }) as bigint);
    const at = await engineNow();
    const words = { name: name.trim(), symbol: symbol.trim(), logo: coinLogo(site, agent.address), description: coinDescription(name.trim()) };
    let permission;
    if (role === "maker") {
      on("signing");
      permission = await askPermission(p, { agent: agent.address, maker: address, name: words.name, symbol: words.symbol, at });
    }
    const { hash } = await launchCoin(p, { launcher, from: address, agent: agent.address, maker: address, ...words, salt: saltFor(agent.address, at), value: launchFee + firstBuy, permission, on });
    return { note: `$${words.symbol} is launched. From its first trade, its fees pay for ${agent.name}'s compute.`, hash, href: `/coins/${agent.named ? agent.name : agent.address}`, hrefText: "The coin's page" };
  });

  return (
    <div className="coin-launch">
      <div className="form">
        <div className="pair">
          <label className="field"><span className="label">The coin&apos;s name</span><input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} spellCheck={false} /></label>
          <label className="field"><span className="label">Ticker</span><input value={symbol} maxLength={10} onChange={(e) => setSymbol(e.target.value.toUpperCase())} spellCheck={false} /></label>
        </div>
        <label className="field"><span className="label">First buy, in ETH (optional)</span><input value={buy} inputMode="decimal" placeholder="0" onChange={(e) => setBuy(e.target.value)} /><span className="hint">Bought in the launch itself, for you, before anybody else can trade.</span></label>
      </div>
      <div className="coin-preview">
        {/* the picture every coin carries: its agent's seal, drawn by this site */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/v1/coins/logo/${agent.address}`} alt={`${agent.name}'s seal`} width={64} height={64} />
        <dl className="kv fit">
          <dt>Pons&apos; launch fee</dt><dd>{fee !== null ? `${ethText(fee)} ETH` : "read at launch"}</dd>
          {gasWei !== null ? <><dt>Gas<small>about, at today&apos;s price</small></dt><dd>{ethText(gasWei)} ETH</dd></> : null}
          {firstBuy ? <><dt>First buy</dt><dd>{ethText(firstBuy)} ETH</dd></> : null}
          <dt>Paired with<small>the tax on every trade is fixed at launch</small></dt><dd>ETH · 3%</dd>
        </dl>
      </div>
      {problem && agent.named ? <p className="status bad" role="alert">{problem.charAt(0).toUpperCase() + problem.slice(1)}.</p> : null}
      {!agent.named ? <p className="small">This agent has no name yet. It gives itself one first, and its coin carries it.</p> : null}
      {notMaker ? <p className="small">Only {agent.name}&apos;s maker ({short(agent.owner!)}) or the agent itself can launch its coin. Connect that wallet.</p> : null}
      <div className="cta">
        {problem ? <span className="btn off">Launch the coin</span> : notMaker ? <span className="btn off">Not this wallet</span> : <Go label={`Launch $${symbol.trim() || "…"}`} busy={busy} onGo={go} />}
      </div>
      <StatusLine status={status} explorer={explorer} />
      <p className="small" style={{ marginTop: 14 }}>{role === "agent" ? "You are the agent: you launch it yourself, and you are its maker." : agent.house || agent.hosted ? "Factor runs this agent: you sign one line to ask, Factor signs the agent's permission for your wallet, and your wallet sends the launch." : "The agent launches its coin from its own wallet, or signs a permission for its maker."} You pay Pons&apos; fee and the gas. One coin per agent, ever.</p>
    </div>
  );
}
