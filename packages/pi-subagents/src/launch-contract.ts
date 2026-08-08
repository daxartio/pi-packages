import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { assertCapability } from "./capability-ceiling.js";
import type {
  AgentDefinition,
  CapabilityCeiling,
  ContextMode,
  SubagentLaunchContractV1,
} from "./types.js";
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function resolveLaunchContract(input: {
  runId?: string;
  taskId: string;
  agent: AgentDefinition;
  context?: ContextMode;
  cwd: string;
  sessionDir: string;
  artifactsDir: string;
  ceiling?: CapabilityCeiling;
}): SubagentLaunchContractV1 {
  const context = input.context ?? input.agent.defaultContext;
  const effectiveTools = [...new Set(input.agent.tools)].sort();
  assertCapability(input.ceiling ?? {}, input.agent.name, effectiveTools);
  if (context === "fork" && !input.sessionDir)
    throw new Error("fork context requires a persisted parent session");
  const contract = {
    version: 1 as const,
    runId: input.runId ?? randomUUID(),
    taskId: input.taskId,
    agent: {
      name: input.agent.name,
      source: input.agent.source,
      definitionDigest: digest(input.agent),
    },
    context,
    modelCandidates: [input.agent.model, ...input.agent.fallbackModels].filter(
      (v): v is string => Boolean(v),
    ),
    ...(input.agent.thinking ? { thinking: input.agent.thinking } : {}),
    effectiveTools,
    extensionsDenied: true,
    roots: {
      cwd: resolve(input.cwd),
      sessionDir: resolve(input.sessionDir),
      artifactsDir: resolve(input.artifactsDir),
    },
  };
  return { ...contract, launchContractDigest: digest(contract) };
}
