import type { BuiltinToolName } from "./types.js";
export const DEFAULT_LIMITS = {
  maxNodes: 8,
  maxEdges: 16,
  maxDepth: 4,
  maxActiveChildren: 4,
  maxQueuedJobs: 32,
  maxOutputBytes: 50_000,
  maxOutputLines: 2_000,
} as const;
export interface SubagentConfig {
  dynamicTools?: BuiltinToolName[];
}
export const dynamicTools = (config: SubagentConfig = {}): BuiltinToolName[] =>
  config.dynamicTools ?? ["read", "grep", "find", "ls"];
