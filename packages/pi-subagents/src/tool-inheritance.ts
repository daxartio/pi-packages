import { resolve } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { isBuiltinTool, isToolName } from "./tools.js";

export interface InheritedTool {
  name: string;
  sourcePath: string;
  exposure?: string;
}

export interface ChildToolsManifest {
  version: 1;
  taskId: string;
  tools: InheritedTool[];
  activeTools: string[];
}

function normalizeBuiltinToolSource(path: string): string {
  const name = path.startsWith("builtin:")
    ? path.slice("builtin:".length)
    : undefined;
  return name !== undefined && isBuiltinTool(name) ? `<builtin:${name}>` : path;
}

export function normalizeToolSource(path: string, cwd: string): string {
  return path.startsWith("<") || path.startsWith("builtin:")
    ? normalizeBuiltinToolSource(path)
    : resolve(cwd, path);
}

export function captureToolSources(
  tools: readonly (ToolInfo & { exposure?: string })[],
  cwd = process.cwd(),
): InheritedTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    sourcePath: normalizeToolSource(tool.sourceInfo.path, cwd),
    ...(tool.exposure ? { exposure: tool.exposure } : {}),
  }));
}

export function resolveChildTools(
  names: readonly string[],
  active: readonly string[],
  sources: readonly InheritedTool[],
): {
  activeTools: string[];
  toolSources: InheritedTool[];
  extensionPaths: string[];
} {
  const toolSources = [...new Set(names)].map((name) => {
    if (!isToolName(name)) throw new Error(`Invalid tool name: ${name}`);
    const source = sources.find((tool) => tool.name === name);
    if (source)
      return {
        ...source,
        sourcePath: normalizeBuiltinToolSource(source.sourcePath),
      };
    if (isBuiltinTool(name)) return { name, sourcePath: `<builtin:${name}>` };
    throw new Error(`No parent source metadata for tool: ${name}`);
  });
  const extensionPaths = new Set<string>();
  for (const tool of toolSources) {
    if (
      tool.sourcePath === `<builtin:${tool.name}>` &&
      isBuiltinTool(tool.name)
    )
      continue;
    if (tool.sourcePath.startsWith("<")) {
      throw new Error(
        `Cannot reload tool ${tool.name} from synthetic source ${tool.sourcePath}`,
      );
    }
    extensionPaths.add(tool.sourcePath);
  }
  return {
    activeTools: [...new Set(active)].filter((name) => names.includes(name)),
    toolSources,
    extensionPaths: [...extensionPaths],
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseChildToolsManifest(value: unknown): ChildToolsManifest {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.taskId !== "string" ||
    !Array.isArray(value.tools) ||
    !Array.isArray(value.activeTools)
  ) {
    throw new Error("Invalid child tool manifest");
  }
  const tools: InheritedTool[] = value.tools.map((tool: unknown) => {
    if (
      !record(tool) ||
      typeof tool.name !== "string" ||
      !isToolName(tool.name) ||
      typeof tool.sourcePath !== "string" ||
      !tool.sourcePath ||
      (tool.exposure !== undefined && typeof tool.exposure !== "string")
    ) {
      throw new Error("Invalid child tool source");
    }
    return {
      name: tool.name,
      sourcePath: tool.sourcePath,
      ...(typeof tool.exposure === "string" ? { exposure: tool.exposure } : {}),
    };
  });
  const activeTools = value.activeTools.map((name: unknown) => {
    if (typeof name !== "string" || !tools.some((tool) => tool.name === name)) {
      throw new Error("Invalid child active tool");
    }
    return name;
  });
  return { version: 1, taskId: value.taskId, tools, activeTools };
}

export function assertInheritedTools(
  expected: readonly InheritedTool[],
  actual: readonly InheritedTool[],
): void {
  for (const tool of expected) {
    const loaded = actual.find((candidate) => candidate.name === tool.name);
    if (!loaded)
      throw new Error(
        `Inherited tool failed to load: ${tool.name} (${tool.sourcePath})`,
      );
    if (
      normalizeBuiltinToolSource(loaded.sourcePath) !==
      normalizeBuiltinToolSource(tool.sourcePath)
    ) {
      throw new Error(
        `Inherited tool source changed: ${tool.name} (${loaded.sourcePath} instead of ${tool.sourcePath})`,
      );
    }
    if (tool.exposure !== undefined && loaded.exposure !== tool.exposure) {
      throw new Error(`Inherited tool exposure changed: ${tool.name}`);
    }
  }
}
