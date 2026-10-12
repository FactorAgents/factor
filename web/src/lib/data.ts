// Where the pages get their figures. For now that is the sample; in phase 6 this asks the engine, with the sample's
// place taken by an honest empty state when no engine answers.
import "server-only";
import { cache } from "react";
import { sampleState } from "./sample";
import type { Agent, FactorState, Job } from "./types";

export const getState = cache(async (): Promise<FactorState> => sampleState());
export const agentOf = (s: FactorState, id: string): Agent | undefined => s.agents.find((a) => a.id === id);
export const jobOf = (s: FactorState, id: string): Job | undefined => s.jobs.find((j) => j.id === id);
