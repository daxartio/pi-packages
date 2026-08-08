import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RpcChildExecutor,
  type RpcChildExecutorOptions,
} from "../src/child-executor.js";
import type { AgentDefinition } from "../src/types.js";

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

async function withRpcScript<T>(
  source: string,
  run: (executor: RpcChildExecutor, cwd: string) => Promise<T>,
  options: RpcChildExecutorOptions = {},
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagents-rpc-"));
  const script = join(directory, "child.mjs");
  await writeFile(script, source, "utf8");
  const executor = new RpcChildExecutor(process.execPath, {
    prefixArgs: [script],
    startupTimeoutMs: 1_000,
    runTimeoutMs: 1_000,
    terminationGraceMs: 20,
    ...options,
  });
  try {
    return await run(executor, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function run(executor: RpcChildExecutor, cwd: string): Promise<string> {
  return executor.run({
    runId: "run-1",
    taskId: "task-1",
    task: "inspect",
    agent,
    cwd,
    context: "fresh",
  });
}

const readPrompt = `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  const command = JSON.parse(buffer.slice(0, newline));
  globalThis.onPrompt(command);
});
`;

test("RPC executor returns output only after an accepted successful run", async () => {
  await withRpcScript(
    `${readPrompt}
globalThis.onPrompt = command => {
  console.log(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: process.cwd() }], stopReason: "stop" } }));
  console.log(JSON.stringify({ type: "agent_settled" }));
};`,
    async (executor, cwd) => {
      assert.equal(await run(executor, cwd), await realpath(cwd));
    },
  );
});

test("RPC executor rejects prompt failures without hanging", async () => {
  await withRpcScript(
    `${readPrompt}
globalThis.onPrompt = command => {
  console.log(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: false, error: "no model" }));
};`,
    async (executor, cwd) => {
      await assert.rejects(
        run(executor, cwd),
        /Child rejected prompt: no model/u,
      );
    },
  );
});

test("RPC executor propagates the final assistant error", async () => {
  await withRpcScript(
    `${readPrompt}
globalThis.onPrompt = command => {
  console.log(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" } }));
  console.log(JSON.stringify({ type: "agent_settled" }));
};`,
    async (executor, cwd) => {
      await assert.rejects(run(executor, cwd), /provider failed/u);
    },
  );
});

test("RPC executor times out when prompt acceptance never arrives", async () => {
  await withRpcScript(
    "setInterval(() => {}, 1000);",
    async (executor, cwd) => {
      await assert.rejects(run(executor, cwd), /Child prompt timed out/u);
    },
    { startupTimeoutMs: 30 },
  );
});
