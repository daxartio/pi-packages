import assert from "node:assert/strict";
import test from "node:test";
import {
  assertInheritedTools,
  captureToolSources,
  parseChildToolsManifest,
  resolveChildTools,
} from "../src/tool-inheritance.js";
import { BUILTIN_TOOLS } from "../src/tools.js";

const sources = [
  { name: "read", sourcePath: "<builtin:read>" },
  { name: "mcp", sourcePath: "/extensions/mcp-adapter.ts" },
  { name: "mcp__server", sourcePath: "/extensions/mcp-adapter.ts" },
  { name: "codemode", sourcePath: "builtin:codemode" },
  { name: "custom", sourcePath: "/extensions/custom.ts", exposure: "deferred" },
];

test("captures runtime source metadata and deferred exposure", () => {
  const result = captureToolSources(
    [
      {
        name: "custom",
        description: "custom",
        parameters: { type: "object" },
        exposure: "deferred",
        sourceInfo: {
          path: "extensions/custom.ts",
          source: "local",
          scope: "temporary",
          origin: "top-level",
        },
      },
    ],
    "/project",
  );
  assert.deepEqual(result, [
    {
      name: "custom",
      sourcePath: "/project/extensions/custom.ts",
      exposure: "deferred",
    },
  ]);
});

test("reloads exact tool owners once and retains built-in extension identifiers", () => {
  const tools = resolveChildTools(
    sources.map((tool) => tool.name),
    ["read", "mcp", "codemode"],
    sources,
  );
  assert.deepEqual(tools.extensionPaths, [
    "/extensions/mcp-adapter.ts",
    "builtin:codemode",
    "/extensions/custom.ts",
  ]);
  assert.deepEqual(tools.activeTools, ["read", "mcp", "codemode"]);
  assert.deepEqual(tools.toolSources, sources);
});

test("both runtime built-in source formats resolve without loading extensions", () => {
  for (const wrapped of [false, true]) {
    const builtinSources = BUILTIN_TOOLS.map((name) => ({
      name,
      sourcePath: wrapped ? `<builtin:${name}>` : `builtin:${name}`,
    }));
    const captured = captureToolSources(
      builtinSources.map(({ name, sourcePath }) => ({
        name,
        description: name,
        parameters: { type: "object" },
        sourceInfo: {
          path: sourcePath,
          source: "builtin",
          scope: "temporary",
          origin: "top-level",
        },
      })),
      "/project",
    );
    const canonical = BUILTIN_TOOLS.map((name) => ({
      name,
      sourcePath: `<builtin:${name}>`,
    }));
    assert.deepEqual(captured, canonical);
    assert.deepEqual(
      resolveChildTools(BUILTIN_TOOLS, BUILTIN_TOOLS, builtinSources),
      {
        activeTools: [...BUILTIN_TOOLS],
        toolSources: canonical,
        extensionPaths: [],
      },
    );
    assert.doesNotThrow(() => assertInheritedTools(builtinSources, canonical));
    assert.doesNotThrow(() => assertInheritedTools(canonical, builtinSources));
  }
});

test("restricted tasks do not load unrelated extension owners", () => {
  assert.deepEqual(resolveChildTools(["read"], ["read", "mcp"], sources), {
    activeTools: ["read"],
    toolSources: [sources[0]],
    extensionPaths: [],
  });
  assert.deepEqual(resolveChildTools([], [], sources), {
    activeTools: [],
    toolSources: [],
    extensionPaths: [],
  });
});

test("built-in overrides retain their extension source", () => {
  const override = { name: "read", sourcePath: "/extensions/custom-read.ts" };
  assert.deepEqual(
    resolveChildTools(["read"], ["read"], [override]).extensionPaths,
    [override.sourcePath],
  );
});

test("unsupported synthetic sources and missing metadata fail rather than dropping tools", () => {
  assert.throws(
    () => resolveChildTools(["custom"], ["custom"], []),
    /No parent source metadata/u,
  );
  for (const sourcePath of ["<inline:custom>", "<sdk:custom>"]) {
    assert.throws(
      () =>
        resolveChildTools(
          ["custom"],
          ["custom"],
          [{ name: "custom", sourcePath }],
        ),
      /synthetic source/u,
    );
  }
  assert.throws(
    () => resolveChildTools(["read,bash"], [], []),
    /Invalid tool name/u,
  );
});

test("manifest parsing validates tools and active selections", () => {
  const manifest = {
    version: 1,
    taskId: "task",
    tools: sources,
    activeTools: ["read", "mcp"],
  };
  assert.deepEqual(parseChildToolsManifest(manifest), manifest);
  assert.throws(() => parseChildToolsManifest(null), /manifest/u);
  assert.throws(
    () => parseChildToolsManifest({ ...manifest, activeTools: ["unknown"] }),
    /active tool/u,
  );
  assert.throws(
    () =>
      parseChildToolsManifest({
        ...manifest,
        tools: [{ name: "*", sourcePath: "/extension.ts" }],
      }),
    /tool source/u,
  );
});

test("child verification fails on missing or replaced tool sources", () => {
  assert.doesNotThrow(() => assertInheritedTools(sources, sources));
  assert.throws(
    () => assertInheritedTools(sources, sources.slice(1)),
    /failed to load: read/u,
  );
  assert.throws(
    () =>
      assertInheritedTools(
        [{ name: "read", sourcePath: "<builtin:read>" }],
        [{ name: "read", sourcePath: "/other.ts" }],
      ),
    /source changed/u,
  );
  assert.throws(
    () =>
      assertInheritedTools(
        [{ name: "custom", sourcePath: "/extension.ts", exposure: "deferred" }],
        [{ name: "custom", sourcePath: "/extension.ts", exposure: "direct" }],
      ),
    /exposure changed/u,
  );
});
