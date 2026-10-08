import { writeFile } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  assertInheritedTools,
  captureToolSources,
  parseChildToolsManifest,
} from "./tool-inheritance.js";

export default async function register(pi: ExtensionAPI): Promise<void> {
  const path = process.env.PI_SUBAGENTS_TOOL_MANIFEST;
  if (!path) throw new Error("Child tool manifest is required");
  const manifest = parseChildToolsManifest(
    JSON.parse(await readFile(path, "utf8")),
  );
  const allowed = new Set(manifest.tools.map((tool) => tool.name));
  const apply = (cwd: string) => {
    assertInheritedTools(
      manifest.tools,
      captureToolSources(pi.getAllTools(), cwd),
    );
    pi.setActiveTools(manifest.activeTools);
  };

  pi.on("session_start", async (_event, ctx) => {
    let error: string | undefined;
    try {
      apply(ctx.cwd);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const frame = `${JSON.stringify({
      type: "subagent_tools_ready",
      taskId: manifest.taskId,
      tools: manifest.tools.map((tool) => tool.name),
      ...(error ? { error } : {}),
    })}\n`;
    await new Promise<void>((resolve, reject) => {
      writeFile(3, frame, (cause) => (cause ? reject(cause) : resolve()));
    });
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    apply(ctx.cwd);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!allowed.has(event.toolName)) {
      return {
        block: true,
        reason: `Tool denied by parent: ${event.toolName}`,
      };
    }
    const expected = manifest.tools.filter(
      (tool) => tool.name === event.toolName,
    );
    assertInheritedTools(
      expected,
      captureToolSources(pi.getAllTools(), ctx.cwd),
    );
    return undefined;
  });
}
