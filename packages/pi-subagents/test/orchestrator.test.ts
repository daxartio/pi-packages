import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type ChildExecutor,
  SubagentOrchestrator,
} from "../src/orchestrator.js";
import { formatRunOutput } from "../src/output.js";
import { parseRequest } from "../src/schema.js";
import type { AgentDefinition } from "../src/types.js";
import { authorizeRequestWorkspaces } from "../src/workspace.js";

const agent: AgentDefinition = {
  name: "scout",
  description: "Scout",
  tools: ["read"],
  systemPrompt: "Inspect carefully.",
  aliases: [],
  fallbackModels: [],
  defaultContext: "fresh",
  inheritProjectContext: false,
  inheritSkills: false,
  source: "builtin",
  filePath: "scout.md",
};

const planner = {
  async plan(): Promise<never> {
    throw new Error("planner should not be called");
  },
};

test("parallel mode runs tasks concurrently and preserves result order", async () => {
  let active = 0;
  let maxActive = 0;
  const executor: ChildExecutor = {
    async run(input) {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return input.task;
    },
  };
  const runtime = new SubagentOrchestrator(
    new Map([[agent.name, agent]]),
    executor,
    planner,
    "/project",
  );

  const result = await runtime.run({
    mode: "parallel",
    tasks: ["first", "second", "third"].map((task) => ({
      agent: "scout",
      task,
    })),
  });

  assert.ok(maxActive > 1);
  assert.deepEqual(
    result.tasks.map((task) => task.text),
    ["first", "second", "third"],
  );
});

test("mixed forms execute only the selected tasks without duplicate agents", async () => {
  const calls: string[] = [];
  const executor: ChildExecutor = {
    async run(input) {
      calls.push(input.task);
      return input.task;
    },
  };
  const runtime = new SubagentOrchestrator(
    new Map([[agent.name, agent]]),
    executor,
    planner,
    "/project",
  );

  const result = await runtime.run(
    parseRequest({
      agent: "unknown-single-agent",
      task: "ignored single task",
      tasks: [{ agent: "scout", task: "selected task" }],
      chain: [{ agent: "unknown-chain-agent", task: "same" }],
    }),
  );

  assert.equal(result.state, "completed");
  assert.equal(result.tasks.length, 1);
  assert.deepEqual(calls, ["selected task"]);
  assert.equal(result.tasks[0]?.text, "selected task");
});

test("orchestrator forwards cwd and fresh context and rejects unsupported fork", async () => {
  const calls: Array<Parameters<ChildExecutor["run"]>[0]> = [];
  const executor: ChildExecutor = {
    async run(input) {
      calls.push(input);
      return "done";
    },
  };
  const runtime = new SubagentOrchestrator(
    new Map([[agent.name, agent]]),
    executor,
    planner,
    "/default",
  );

  const completed = await runtime.run({
    mode: "single",
    task: {
      agent: "scout",
      task: "inspect",
      cwd: "/approved",
      context: "fresh",
    },
  });
  const rejected = await runtime.run({
    mode: "single",
    task: { agent: "scout", task: "inspect", context: "fork" },
  });

  assert.equal(completed.state, "completed");
  assert.equal(calls[0]?.cwd, "/approved");
  assert.equal(calls[0]?.context, "fresh");
  assert.equal(rejected.state, "failed");
  assert.match(
    rejected.tasks[0]?.error ?? "",
    /fork context is not supported/u,
  );
  assert.equal(calls.length, 1);
});

test("run output includes child text and reports truncation", () => {
  const output = formatRunOutput([
    { id: "0", state: "completed", text: "evidence" },
    { id: "1", state: "completed", text: "x".repeat(60_000) },
  ]);

  assert.match(output, /0: completed\n\nevidence/u);
  assert.match(output, /\[Output truncated\]$/u);
  assert.ok(Buffer.byteLength(output, "utf8") <= 50_000);
});

test("workspace authorization canonicalizes descendants and rejects siblings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-workspace-"));
  const parent = join(root, "parent");
  const child = join(parent, "child");
  const sibling = join(root, "sibling");
  await Promise.all([mkdir(child, { recursive: true }), mkdir(sibling)]);

  try {
    const request = await authorizeRequestWorkspaces(
      { mode: "single", task: { agent: "scout", task: "inspect", cwd: child } },
      parent,
    );
    assert.equal(request.mode, "single");
    assert.equal(request.task.cwd, await realpath(child));
    await assert.rejects(
      authorizeRequestWorkspaces(
        {
          mode: "single",
          task: { agent: "scout", task: "inspect", cwd: sibling },
        },
        parent,
      ),
      /explicit approval/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
