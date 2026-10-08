import assert from "node:assert/strict";
import test from "node:test";
import {
  type ChildExecutor,
  SubagentOrchestrator,
} from "../src/orchestrator.js";
import { parseRequest } from "../src/schema.js";
import type { InheritedTool } from "../src/tool-inheritance.js";
import type { AgentDefinition } from "../src/types.js";

const agent: AgentDefinition = {
  name: "default",
  description: "General-purpose",
  aliases: [],
  systemPrompt: "Do the task.",
  fallbackModels: [],
  defaultContext: "fresh",
  inheritProjectContext: false,
  inheritSkills: false,
  source: "builtin",
  filePath: "default.md",
};
const sources: InheritedTool[] = [
  { name: "read", sourcePath: "<builtin:read>" },
  { name: "mcp", sourcePath: "/extensions/mcp.ts" },
  { name: "mcp__server", sourcePath: "/extensions/mcp.ts" },
  { name: "codemode", sourcePath: "builtin:codemode" },
  {
    name: "mcp__server__query",
    sourcePath: "/extensions/mcp.ts",
    exposure: "deferred",
  },
  {
    name: "script-helper",
    sourcePath: "/extensions/helper.ts",
    exposure: "codemode",
  },
  { name: "inactive", sourcePath: "/extensions/other.ts" },
];

function runtime(
  calls: Array<Parameters<ChildExecutor["run"]>[0]>,
  definition = agent,
) {
  return new SubagentOrchestrator(
    new Map([[definition.name, definition]]),
    {
      async run(input) {
        calls.push(input);
        return "done";
      },
    },
    {
      async plan(): Promise<never> {
        throw new Error("unexpected planning");
      },
    },
    "/project",
    undefined,
    ["read", "mcp", "mcp__server", "codemode"],
    sources,
  );
}

test("default named task inherits extensions and callable tools without declaring deferred tools", async () => {
  const calls: Array<Parameters<ChildExecutor["run"]>[0]> = [];
  const result = await runtime(calls).run(
    parseRequest({ agent: "default", task: "research" }),
  );
  assert.equal(result.state, "completed");
  assert.deepEqual(calls[0]?.tools, [
    "read",
    "mcp",
    "mcp__server",
    "codemode",
    "mcp__server__query",
    "script-helper",
  ]);
  assert.deepEqual(calls[0]?.activeTools, [
    "read",
    "mcp",
    "mcp__server",
    "codemode",
  ]);
  assert.deepEqual(calls[0]?.toolSources, sources.slice(0, 6));
});

test("per-task extension allowlists work in parallel and chain and omit nested helpers", async () => {
  const calls: Array<Parameters<ChildExecutor["run"]>[0]> = [];
  const runner = runtime(calls);
  for (const mode of ["parallel", "chain"] as const) {
    const result = await runner.run({
      mode,
      tasks: [
        { agent: "default", task: "gateway", tools: ["mcp"] },
        {
          agent: "default",
          task: "direct deferred tool",
          tools: ["mcp__server__query"],
        },
        { agent: "default", task: "nothing", tools: [] },
      ],
    });
    assert.equal(result.state, "completed");
  }
  assert.deepEqual(
    calls.map((call) => call.tools),
    [["mcp"], ["mcp__server__query"], [], ["mcp"], ["mcp__server__query"], []],
  );
  assert.deepEqual(
    calls.map((call) => call.activeTools),
    calls.map((call) => call.tools),
  );
  const denied = await runner.run({
    mode: "single",
    task: { agent: "default", task: "denied", tools: ["inactive"] },
  });
  assert.equal(denied.state, "failed");
  assert.equal(calls.length, 6);
});

test("generated workers inherit MCP tools and obey the workflow allowlist", async () => {
  const calls: string[][] = [];
  const runner = new SubagentOrchestrator(
    new Map(),
    {
      async run(input) {
        calls.push(input.tools);
        return "done";
      },
    },
    {
      async plan() {
        return {
          version: 1,
          summary: "research",
          roles: [{ label: "worker", roleBrief: "research" }],
          nodes: [{ role: 0, task: "research", dependsOn: [] }],
        };
      },
    },
    "/project",
    undefined,
    ["read", "mcp"],
    sources,
  );
  assert.equal(
    (await runner.run(parseRequest({ task: "research" }))).state,
    "completed",
  );
  assert.equal(
    (await runner.run(parseRequest({ task: "research", tools: ["mcp"] })))
      .state,
    "completed",
  );
  assert.deepEqual(calls, [
    ["read", "mcp", "mcp__server__query", "script-helper"],
    ["mcp"],
  ]);
});

test("custom agent restrictions also limit extension and codemode tools", async () => {
  const calls: Array<Parameters<ChildExecutor["run"]>[0]> = [];
  const runner = runtime(calls, { ...agent, tools: ["read", "mcp"] });
  assert.equal(
    (await runner.run(parseRequest({ agent: "default", task: "inspect" })))
      .state,
    "completed",
  );
  assert.deepEqual(calls[0]?.tools, ["read", "mcp"]);
  const denied = await runner.run(
    parseRequest({ agent: "default", task: "escalate", tools: ["codemode"] }),
  );
  assert.equal(denied.state, "failed");
  assert.equal(calls.length, 1);
});

test("tool names cannot inject CLI allowlist separators or wildcard permissions", async () => {
  for (const tool of ["read,bash", "*", "", "read\nwrite"]) {
    const calls: Array<Parameters<ChildExecutor["run"]>[0]> = [];
    const result = await runtime(calls).run(
      parseRequest({ agent: "default", task: "inspect", tools: [tool] }),
    );
    assert.equal(result.state, "failed");
    assert.match(result.tasks[0]?.error ?? "", /Invalid tool name/u);
    assert.equal(calls.length, 0);
  }
});
