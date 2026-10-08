import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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

function killDescendant(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
}

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

function run(
  executor: RpcChildExecutor,
  cwd: string,
  tools: Parameters<RpcChildExecutor["run"]>[0]["tools"] = ["read"],
): Promise<string> {
  return executor.run({
    runId: "run-1",
    taskId: "task-1",
    task: "inspect",
    agent,
    tools,
    cwd,
    context: "fresh",
  });
}

const readPrompt = `
import { readFileSync, writeFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.env.PI_SUBAGENTS_TOOL_MANIFEST, "utf8"));
writeFileSync(3, JSON.stringify({ type: "subagent_tools_ready", taskId: manifest.taskId, tools: manifest.tools.map(tool => tool.name) }) + "\\n");
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const command = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    globalThis.onPrompt(command);
  }
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

test("RPC executor passes resolved permissions and explicitly disables empty tool sets", async () => {
  await withRpcScript(
    `${readPrompt}
globalThis.onPrompt = command => {
  console.log(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }], stopReason: "stop" } }));
  console.log(JSON.stringify({ type: "agent_settled" }));
};`,
    async (executor, cwd) => {
      const allowed: string[] = JSON.parse(
        await run(executor, cwd, ["read", "bash"]),
      );
      assert.equal(allowed[allowed.indexOf("--tools") + 1], "read,bash");
      assert.ok(allowed.includes("--no-extensions"));
      const denied: string[] = JSON.parse(await run(executor, cwd, []));
      assert.ok(denied.includes("--no-tools"));
      assert.ok(!denied.includes("--tools"));
    },
  );
});

test("RPC executor loads exact extension owners and cleans its private manifest", async () => {
  let manifestPath = "";
  await withRpcScript(
    `${readPrompt}
globalThis.onPrompt = command => {
  console.log(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true }));
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ args: process.argv.slice(2), manifestPath: process.env.PI_SUBAGENTS_TOOL_MANIFEST, depth: process.env.PI_SUBAGENTS_DEPTH, manifest }) }], stopReason: "stop" } }));
  console.log(JSON.stringify({ type: "agent_settled" }));
};`,
    async (executor, cwd) => {
      const result = JSON.parse(
        await executor.run({
          runId: "run",
          taskId: "task-1",
          task: "inspect",
          agent,
          cwd,
          context: "fresh",
          tools: ["read", "mcp", "mcp__server"],
          activeTools: ["read", "mcp"],
          toolSources: [
            { name: "read", sourcePath: "builtin:read" },
            { name: "mcp", sourcePath: "/extensions/mcp.ts" },
            {
              name: "mcp__server",
              sourcePath: "/extensions/mcp.ts",
              exposure: "deferred",
            },
          ],
        }),
      );
      const paths: string[] = result.args.filter(
        (_arg: string, index: number) =>
          result.args[index - 1] === "--extension",
      );
      assert.equal(
        paths.filter((path) => path === "/extensions/mcp.ts").length,
        1,
      );
      assert.equal(paths.length, 2);
      assert.ok(paths.at(-1)?.endsWith("/child-tool-guard.ts"));
      assert.deepEqual(result.manifest.tools[0], {
        name: "read",
        sourcePath: "<builtin:read>",
      });
      assert.deepEqual(result.manifest.activeTools, ["read", "mcp"]);
      assert.ok(Number(result.depth) >= 1);
      manifestPath = result.manifestPath;
    },
  );
  await assert.rejects(realpath(manifestPath), { code: "ENOENT" });
});

test("RPC executor fails tool verification before submitting the task", async () => {
  await withRpcScript(
    `
import { readFileSync, writeFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.env.PI_SUBAGENTS_TOOL_MANIFEST, "utf8"));
writeFileSync(3, JSON.stringify({ type: "subagent_tools_ready", taskId: manifest.taskId, tools: [], error: "missing MCP tool" }) + "\\n");
process.stdin.on("data", () => writeFileSync("unexpected-prompt", "received"));
`,
    async (executor, cwd) => {
      await assert.rejects(
        run(executor, cwd),
        /Child tool inheritance failed: missing MCP tool/u,
      );
      await assert.rejects(realpath(join(cwd, "unexpected-prompt")), {
        code: "ENOENT",
      });
    },
  );
});

test("RPC executor refuses a mismatched readiness tool list", async () => {
  await withRpcScript(
    `
import { readFileSync, writeFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.env.PI_SUBAGENTS_TOOL_MANIFEST, "utf8"));
writeFileSync(3, JSON.stringify({ type: "subagent_tools_ready", taskId: manifest.taskId, tools: [] }) + "\\n");
process.stdin.resume();
`,
    async (executor, cwd) => {
      await assert.rejects(
        run(executor, cwd),
        /did not match requested tools/u,
      );
    },
  );
});

test("RPC executor cancels child approval requests when no parent UI is attached", async () => {
  await withRpcScript(
    `${readPrompt}
globalThis.onPrompt = command => {
  if (command.type === "prompt") {
    console.log(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true }));
    console.log(JSON.stringify({ type: "extension_ui_request", id: "approval", method: "confirm", title: "MCP execution", message: "Proceed?" }));
  } else if (command.type === "extension_ui_response") {
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: String(command.cancelled) }], stopReason: "stop" } }));
    console.log(JSON.stringify({ type: "agent_settled" }));
  }
};`,
    async (executor, cwd) => {
      assert.equal(await run(executor, cwd), "true");
    },
  );
});

test("RPC stdin closure fails only the child task without an unhandled stream error", async () => {
  await withRpcScript(
    `
import { closeSync, readFileSync, writeFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.env.PI_SUBAGENTS_TOOL_MANIFEST, "utf8"));
closeSync(0);
writeFileSync(3, JSON.stringify({ type: "subagent_tools_ready", taskId: manifest.taskId, tools: manifest.tools.map(tool => tool.name) }) + "\\n");
setInterval(() => {}, 1000);
`,
    async (executor, cwd) => {
      await assert.rejects(
        run(executor, cwd),
        /Child RPC (write|stream) failed/u,
      );
    },
  );
});

test("cancellation kills extension descendants holding child RPC pipes open", {
  skip: process.platform === "win32",
}, async () => {
  await withRpcScript(
    `${readPrompt}
import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", 'require("node:fs").writeFileSync("descendant.pid", String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { detached: true, stdio: ["ignore", "inherit", "inherit", 3] });
globalThis.onPrompt = command => {
  console.log(JSON.stringify({ id: command.id, type: "response", command: "prompt", success: true }));
};`,
    async (executor, cwd) => {
      const controller = new AbortController();
      const rejected = assert.rejects(
        executor.run({
          runId: "run",
          taskId: "task-1",
          task: "inspect",
          agent,
          tools: ["read"],
          cwd,
          context: "fresh",
          signal: controller.signal,
        }),
        /Child run aborted/u,
      );
      let pid: number | undefined;
      try {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          try {
            pid = Number(await readFile(join(cwd, "descendant.pid"), "utf8"));
            break;
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
            )
              throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(pid);
        controller.abort();
        await rejected;
        let alive = true;
        const exitDeadline = Date.now() + 3_000;
        while (alive && Date.now() < exitDeadline) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            )
              alive = false;
            else throw error;
          }
          if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(
          alive,
          false,
          "extension descendant must not outlive the cancelled task",
        );
      } finally {
        controller.abort();
        if (pid) killDescendant(pid);
        await rejected;
      }
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
      await assert.rejects(
        run(executor, cwd),
        /Child startup\/prompt timed out/u,
      );
    },
    { startupTimeoutMs: 30 },
  );
});
