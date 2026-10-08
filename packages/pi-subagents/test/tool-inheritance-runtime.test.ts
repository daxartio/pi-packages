import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveChildTools } from "../src/tool-inheritance.js";
import { BUILTIN_TOOLS, isBuiltinTool } from "../src/tools.js";

const cli = fileURLToPath(
  new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const guard = fileURLToPath(
  new URL("../src/child-tool-guard.ts", import.meta.url),
);

interface ProbeResult {
  ready: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}

async function probe(
  expectedNames: string[],
  allowlist: string[],
): Promise<ProbeResult> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "pi-tools-runtime-")),
  );
  const agentDir = join(directory, "agent");
  const extensionPath = join(directory, "tools.ts");
  const manifestPath = join(directory, "manifest.json");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [], extensions: [] }),
  );
  await writeFile(
    extensionPath,
    `
import { writeFileSync } from "node:fs";
export default function(pi) {
  for (const name of ["probe_allowed", "probe_denied"]) {
    pi.registerTool({ name, label: name, description: name, parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: name + " executed" }], details: {} }; }
    });
  }
  pi.on("session_start", () => {
    writeFileSync(3, JSON.stringify({ type: "probe_snapshot", tools: pi.getAllTools().map(tool => ({ name: tool.name, path: tool.sourceInfo.path })) }) + "\\n");
  });
}
`,
  );
  const inherited = resolveChildTools(
    expectedNames,
    expectedNames,
    expectedNames.map((name) => ({
      name,
      sourcePath: isBuiltinTool(name) ? `builtin:${name}` : extensionPath,
    })),
  );
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      taskId: "probe",
      tools: inherited.toolSources,
      activeTools: inherited.activeTools,
    }),
  );
  const child = spawn(
    process.execPath,
    [
      cli,
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      ...[...new Set([extensionPath, ...inherited.extensionPaths])].flatMap(
        (path) => ["--extension", path],
      ),
      "--extension",
      guard,
      ...(allowlist.length ? ["--tools", allowlist.join(",")] : ["--no-tools"]),
    ],
    {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SUBAGENTS_TOOL_MANIFEST: manifestPath,
      },
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let timer: NodeJS.Timeout | undefined;
  let snapshot: Record<string, unknown> | undefined;
  try {
    return await new Promise<ProbeResult>((resolve, reject) => {
      let buffer = "";
      let resolved = false;
      timer = setTimeout(
        () => reject(new Error(`Runtime probe timed out: ${stderr}`)),
        15_000,
      );
      child.on("error", reject);
      child.on("close", (code) => {
        if (!resolved)
          reject(new Error(`Runtime probe exited (${code}): ${stderr}`));
      });
      child.stdio[3]?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const event: Record<string, unknown> = JSON.parse(line);
            if (event.type === "probe_snapshot") snapshot = event;
            if (event.type === "subagent_tools_ready") {
              if (!snapshot) throw new Error("Missing runtime tool snapshot");
              resolved = true;
              resolve({ ready: event, snapshot });
            }
          } catch (error) {
            reject(
              new Error(`Invalid runtime frame ${line}: ${String(error)}`),
            );
          }
        }
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
      child.kill("SIGKILL");
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("real child Pi reloads an extension tool and excludes its sibling", async () => {
  const result = await probe(["probe_allowed"], ["probe_allowed"]);
  assert.equal(result.ready.error, undefined);
  assert.deepEqual(result.ready.tools, ["probe_allowed"]);
  const tools = result.snapshot.tools;
  assert.ok(Array.isArray(tools));
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["probe_allowed"],
  );
  assert.ok(tools.every((tool) => tool.path.endsWith("/tools.ts")));
});

test("real child Pi inherits plain built-in sources alongside extension tools", async () => {
  const names = [...BUILTIN_TOOLS, "probe_allowed"];
  const result = await probe(names, names);
  assert.equal(result.ready.error, undefined);
  assert.deepEqual(result.ready.tools, names);
  const tools = result.snapshot.tools;
  assert.ok(Array.isArray(tools));
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...names].sort());
  for (const name of BUILTIN_TOOLS) {
    const tool = tools.find((tool) => tool.name === name);
    assert.ok(tool);
    assert.ok(
      tool.path === `builtin:${name}` || tool.path === `<builtin:${name}>`,
    );
  }
});

test("real child Pi reports missing inherited tools before accepting a task", async () => {
  const result = await probe(["missing"], ["missing"]);
  assert.match(
    String(result.ready.error),
    /Inherited tool failed to load: missing/u,
  );
  assert.deepEqual(result.snapshot.tools, []);
});

test("real child Pi keeps an empty allowlist empty despite loaded extensions", async () => {
  const result = await probe([], []);
  assert.equal(result.ready.error, undefined);
  assert.deepEqual(result.snapshot.tools, []);
  assert.deepEqual(result.ready.tools, []);
});
