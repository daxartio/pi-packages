import type { BuiltinToolName } from "./types.js";

export const BUILTIN_TOOLS: readonly BuiltinToolName[] = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "powershell",
  "edit",
  "write",
];

export function isBuiltinTool(name: string): name is BuiltinToolName {
  return BUILTIN_TOOLS.some((tool) => tool === name);
}

export const TOOL_NAME_PATTERN = "^[a-zA-Z0-9_.:-]+$";
export function isToolName(name: string): boolean {
  return new RegExp(TOOL_NAME_PATTERN, "u").test(name);
}

export function resolveTools(
  parentTools: readonly string[],
  agentTools?: readonly string[],
  requestedTools?: readonly string[],
): string[] {
  if (
    [...parentTools, ...(agentTools ?? []), ...(requestedTools ?? [])].some(
      (tool) => !isToolName(tool),
    )
  ) {
    throw new Error("Invalid tool name");
  }
  const available = parentTools.filter(
    (tool) => agentTools === undefined || agentTools.includes(tool),
  );
  if (requestedTools?.some((tool) => !available.includes(tool))) {
    throw new Error("Requested tools exceed parent or agent permissions");
  }
  return [...new Set(requestedTools ?? available)];
}
