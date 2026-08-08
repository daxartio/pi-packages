import assert from "node:assert/strict";
import test from "node:test";
import register, { Params } from "../src/index.js";

test("tool schema uses Google-compatible string enums", () => {
  const action = (
    Params as unknown as {
      properties: { action: { type: string; enum: string[] } };
    }
  ).properties.action;
  assert.equal(action.type, "string");
  assert.deepEqual(action.enum, [
    "create",
    "list",
    "status",
    "remove",
    "cleanup",
  ]);
});

test("tool execution throws instead of returning a successful error envelope", async () => {
  let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
  register({
    registerTool(value: unknown) {
      tool = value as typeof tool;
    },
    registerCommand() {},
  } as never);
  assert.ok(tool);
  await assert.rejects(
    () =>
      tool!.execute("call", { action: "status" }, undefined, undefined, {
        cwd: process.cwd(),
      }),
    /id is required/u,
  );
});
