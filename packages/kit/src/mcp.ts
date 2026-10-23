#!/usr/bin/env node
// Factor's tools for an assistant, over the Model Context Protocol (stdio). An assistant that is given this can
// read Factor and, when its owner has set a wallet's key, hire agents and work as one.
//
//   FACTOR_PRIVATE_KEY   the key of the wallet to act as. Not set: the tools only read.
//   FACTOR_GASLESS       1: act through a Factor account, so the key needs no ETH for gas (Factor pays it)
//   FACTOR_MAX_JOB_ETH   the most one job may cost (0.05 when not set)
//   FACTOR_MAX_DAY_ETH   the most that may leave the wallet in a day (0.2 when not set)
//   FACTOR_API           Factor's site, when it is not the usual one
//   FACTOR_RPC_URL       a node of Robinhood Chain, when not the public one
//
// The key is read here, on its owner's own machine, and is never sent to Factor or to the assistant: the
// assistant only ever sees what the tools answer.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Factor } from "./index.js";
import { limitsFrom, runTool, Spending, TOOLS } from "./tools.js";

const env = process.env;
// stdout carries the protocol and nothing else: everything said to a person goes to stderr
const say = (line: string) => process.stderr.write(`[factor] ${line}\n`);

async function main(): Promise<void> {
  const limits = limitsFrom(env);
  let factor: Factor | null = null;
  // connected at the first call, so that a site that is slow to answer does not keep the assistant from starting
  const connect = async (): Promise<Factor> => (factor ??= await Factor.connect({ privateKey: env.FACTOR_PRIVATE_KEY?.trim() || undefined, gasless: !!env.FACTOR_PRIVATE_KEY?.trim() && /^(1|true|on|yes)$/i.test(env.FACTOR_GASLESS?.trim() ?? ""), api: env.FACTOR_API?.trim() || undefined, rpcUrl: env.FACTOR_RPC_URL?.trim() || undefined, desk: env.FACTOR_DESK?.trim() || undefined }));

  const server = new McpServer({ name: "factor", version: "0.9.0" });
  const answer = async (name: string, args: Record<string, unknown>) => {
    let text: string, isError: boolean;
    try {
      const f = await connect();
      ({ text, isError } = await runTool(f, name, args, f.address ? new Spending(limits, f.address) : null));
    } catch (e) {
      text = e instanceof Error ? e.message : String(e);
      isError = true;
    }
    return { content: [{ type: "text" as const, text }], isError };
  };
  for (const tool of TOOLS) {
    const about = { description: tool.description, annotations: { readOnlyHint: tool.readOnly } };
    // a tool that takes nothing is registered with no input at all, and is then called with none
    if (Object.keys(tool.input).length === 0) server.registerTool(tool.name, about, () => answer(tool.name, {}));
    else server.registerTool(tool.name, { ...about, inputSchema: tool.input }, (args: Record<string, unknown>) => answer(tool.name, args ?? {}));
  }
  await server.connect(new StdioServerTransport());
  say(env.FACTOR_PRIVATE_KEY?.trim() ? "ready: reading, and acting as the wallet whose key was given" : "ready: reading only (no FACTOR_PRIVATE_KEY)");
}

main().catch((e) => {
  say(`could not start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
