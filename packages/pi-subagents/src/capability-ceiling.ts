import type { CapabilityCeiling } from "./types.js";
function intersect(values: Array<string[] | undefined>): string[] | undefined {
  const present = values.filter((v): v is string[] => v !== undefined);
  return present.length
    ? [
        ...new Set(
          present[0]!.filter((value) =>
            present.every((set) => set.includes(value)),
          ),
        ),
      ]
    : undefined;
}
export function intersectCeilings(
  ...ceilings: Array<CapabilityCeiling | undefined>
): CapabilityCeiling {
  const allowedAgents = intersect(ceilings.map((c) => c?.allowedAgents));
  const allowedTools = intersect(ceilings.map((c) => c?.allowedTools));
  return {
    ...(allowedAgents ? { allowedAgents } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(ceilings.some((c) => c?.denyExtensions)
      ? { denyExtensions: true }
      : {}),
  };
}
export function assertCapability(
  ceiling: CapabilityCeiling,
  agent: string,
  tools: readonly string[],
): void {
  if (ceiling.allowedAgents && !ceiling.allowedAgents.includes(agent))
    throw new Error(`Agent is denied: ${agent}`);
  if (
    ceiling.allowedTools &&
    tools.some((tool) => !ceiling.allowedTools!.includes(tool))
  )
    throw new Error("One or more tools are denied");
}
