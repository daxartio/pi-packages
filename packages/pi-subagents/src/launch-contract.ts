import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { assertCapability } from "./capability-ceiling.js";
import { BUILTIN_TOOLS, isBuiltinTool, resolveTools } from "./tools.js";
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
  parentTools?: readonly string[];
  tools?: string[];
}): SubagentLaunchContractV1 {
  const context = input.context ?? input.agent.defaultContext;
  const effectiveTools = resolveTools(
    input.parentTools ?? BUILTIN_TOOLS,
    input.agent.tools,
    input.tools,
  ).sort();
  assertCapability(input.ceiling ?? {}, input.agent.name, effectiveTools);
  if (
    input.ceiling?.denyExtensions &&
    effectiveTools.some((tool) => !isBuiltinTool(tool))
  ) {
    throw new Error("Extension tools are denied");
  }
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
    extensionsDenied: input.ceiling?.denyExtensions ?? false,
    roots: {
      cwd: resolve(input.cwd),
      sessionDir: resolve(input.sessionDir),
      artifactsDir: resolve(input.artifactsDir),
    },
  };
  return { ...contract, launchContractDigest: digest(contract) };
}
