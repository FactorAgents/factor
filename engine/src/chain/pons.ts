// The two questions the engine asks Pons itself, written by hand because these are Pons' contracts and not ours
// (the shapes are the ones in contracts/src/interfaces/IPons.sol, checked against the live chain by the fork
// tests): which phase the token is in, and what Pons' fee escrow holds for the splitter.

export const ponsFactoryAbi = [
  {
    type: "function",
    name: "getLaunchedToken",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "curve", type: "address" },
          { name: "deployer", type: "address" },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "pairToken", type: "address" },
          { name: "graduationThreshold", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "phase", type: "uint8" },
          { name: "sweptQuote", type: "uint256" },
          { name: "sweptTokens", type: "uint256" },
          { name: "sweptAt", type: "uint256" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const;

export const ponsEscrowAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "recipient", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "balanceOfToken",
    stateMutability: "view",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Pons' own names for where a launch stands. poolFee is 0 on a live pool, so the phase is the only signal.
export const PHASES = ["curve", "graduating", "pool", "rescued"] as const;
export type Phase = (typeof PHASES)[number];
export const phaseName = (n: number): Phase | "unknown" => PHASES[n] ?? "unknown";
