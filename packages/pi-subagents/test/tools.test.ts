import assert from "node:assert/strict";
import test from "node:test";
import { resolveLaunchContract } from "../src/launch-contract.js";
import {
  type ChildExecutor,
  SubagentOrchestrator,
} from "../src/orchestrator.js";
import { parseRequest } from "../src/schema.js";
import { BUILTIN_TOOLS, isBuiltinTool, resolveTools } from "../src/tools.js";
import type { AgentDefinition, BuiltinToolName } from "../src/types.js";

const agent: AgentDefinition = {
  name: "default",
  description: "General-purpose",
  systemPrompt: "Do the task.",
  aliases: [],
  fallbackModels: [],
  defaultContext: "fresh",
  inheritProjectContext: false,
  inheritSkills: false,
  source: "builtin",
  filePath: "default.md",
};

test("recognizes all Pi built-in tools without enabling inactive ones", () => {
  const names = [
    "read",
    "bash",
    "powershell",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
  ];
  assert.deepEqual([...BUILTIN_TOOLS].sort(), [...names].sort());
  assert.ok(names.every(isBuiltinTool));
  assert.equal(isBuiltinTool("mcp"), false);
  assert.deepEqual(resolveTools(["read", "bash", "edit", "write"]), [
    "read",
    "bash",
    "edit",
    "write",
  ]);
});

test("powershell is preserved in requests and forwarded when active in the parent", async () => {
  const calls: string[][] = [];
  const runtime = new SubagentOrchestrator(
    new Map([[agent.name, agent]]),
    {
      async run(input) {
        calls.push(input.tools);
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
    ["read", "powershell"],
  );
  assert.equal(
    (await runtime.run(parseRequest({ agent: "default", task: "inherit" })))
      .state,
    "completed",
  );
  assert.equal(
    (
      await runtime.run(
        parseRequest({
          agent: "default",
          task: "restrict",
          tools: ["powershell"],
        }),
      )
    ).state,
    "completed",
  );
  assert.deepEqual(calls, [["read", "powershell"], ["powershell"]]);
});

test("tool resolution inherits, intersects restrictions, and denies escalation", () => {
  const parent: BuiltinToolName[] = ["read", "bash", "edit"];
  assert.deepEqual(resolveTools(parent), parent);
  assert.deepEqual(resolveTools(parent, ["read", "write"]), ["read"]);
  assert.deepEqual(resolveTools(parent, undefined, ["bash"]), ["bash"]);
  assert.deepEqual(resolveTools(parent, undefined, []), []);
  assert.throws(
    () => resolveTools(parent, undefined, ["write"]),
    /permissions/u,
  );
  assert.throws(() => resolveTools(parent, ["read"], ["edit"]), /permissions/u);
});

test("request parsing preserves tool allowlists including empty lists", () => {
  for (const tools of [[], ["read"]] satisfies BuiltinToolName[][]) {
    const task = { agent: "default", task: "inspect", tools };
    assert.deepEqual(parseRequest(task), { mode: "single", task });
    assert.deepEqual(parseRequest({ tasks: [task] }), {
      mode: "parallel",
      tasks: [task],
    });
    assert.deepEqual(parseRequest({ chain: [task] }), {
      mode: "chain",
      tasks: [task],
    });
    assert.deepEqual(parseRequest({ task: "inspect", tools }), {
      mode: "dynamic",
      task: { task: "inspect", tools },
    });
  }
});

test("named tasks inherit parent tools and apply independent per-task restrictions", async () => {
  const calls: string[][] = [];
  const runtime = new SubagentOrchestrator(
    new Map([[agent.name, agent]]),
    {
      async run(input) {
        calls.push(input.tools);
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
    ["read", "bash", "edit"],
  );
  for (const mode of ["parallel", "chain"] as const) {
    const result = await runtime.run({
      mode,
      tasks: [
        { agent: "default", task: "inherit" },
        { agent: "default", task: "restrict", tools: ["read"] },
        { agent: "default", task: "no tools", tools: [] },
      ],
    });
    assert.equal(result.state, "completed");
  }
  assert.deepEqual(calls, [
    ["read", "bash", "edit"],
    ["read"],
    [],
    ["read", "bash", "edit"],
    ["read"],
    [],
  ]);
  const rejected = await runtime.run({
    mode: "single",
    task: {
      agent: "default",
      task: "escalate",
      tools: ["write"],
    },
  });
  assert.equal(rejected.state, "failed");
  assert.match(rejected.tasks[0]?.error ?? "", /permissions/u);
  assert.equal(calls.length, 6);
  assert.equal(agent.tools, undefined);
});

test("dynamic workers inherit parent tools and respect explicit restrictions", async () => {
  const calls: string[][] = [];
  const executor: ChildExecutor = {
    async run(input) {
      calls.push(input.tools);
      return "done";
    },
  };
  const runtime = new SubagentOrchestrator(
    new Map(),
    executor,
    {
      async plan() {
        return {
          version: 1,
          summary: "inspect",
          roles: [{ label: "scout", roleBrief: "inspect" }],
          nodes: [{ role: 0, task: "inspect", dependsOn: [] }],
        };
      },
    },
    "/project",
    undefined,
    ["read", "bash"],
  );
  assert.equal(
    (await runtime.run({ mode: "dynamic", task: { task: "inspect" } })).state,
    "completed",
  );
  assert.equal(
    (
      await runtime.run({
        mode: "dynamic",
        task: { task: "inspect", tools: [] },
      })
    ).state,
    "completed",
  );
  assert.equal(
    (
      await runtime.run({
        mode: "dynamic",
        task: { task: "inspect", tools: ["bash"] },
      })
    ).state,
    "completed",
  );
  assert.equal(
    (
      await runtime.run({
        mode: "dynamic",
        task: { task: "inspect", tools: ["write"] },
      })
    ).state,
    "failed",
  );
  assert.deepEqual(calls, [["read", "bash"], [], ["bash"]]);
});

test("launch contracts resolve inherited tools and honor the capability ceiling", () => {
  const input = {
    taskId: "task",
    agent,
    cwd: "/project",
    sessionDir: "/sessions",
    artifactsDir: "/artifacts",
    parentTools: ["read", "bash"] satisfies BuiltinToolName[],
  };
  assert.deepEqual(resolveLaunchContract(input).effectiveTools, [
    "bash",
    "read",
  ]);
  assert.deepEqual(
    resolveLaunchContract({ ...input, tools: [] }).effectiveTools,
    [],
  );
  assert.throws(
    () => resolveLaunchContract({ ...input, tools: ["write"] }),
    /permissions/u,
  );
  assert.throws(
    () =>
      resolveLaunchContract({ ...input, ceiling: { allowedTools: ["read"] } }),
    /denied/u,
  );
});
