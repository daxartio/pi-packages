import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import register, { Params } from "../src/index.js";
import type { CreateRequest } from "../src/types.js";

test("tool schema uses Google-compatible string enums", () => {
	const action = Params.properties.action;
	assert.ok("type" in action);
	assert.equal(action.type, "string");
	assert.deepEqual(action.enum, [
		"create",
		"list",
		"status",
		"remove",
		"cleanup",
	]);
});

test("worktree enums retain literal inference, optionality, and validation", () => {
	const request: Params = { action: "create", name: "example" };
	const action: "create" | "list" | "status" | "remove" | "cleanup" =
		request.action;
	const dirtyPolicy: CreateRequest["dirtyPolicy"] = request.dirtyPolicy;
	assert.equal(action, "create");
	assert.equal(dirtyPolicy, undefined);
	assert.equal(Value.Check(Params, request), true);
	assert.equal(Value.Check(Params, {}), false);
	for (const [property, schema, values] of [
		[
			"action",
			Params.properties.action,
			["create", "list", "status", "remove", "cleanup"],
		],
		[
			"dirtyPolicy",
			Params.properties.dirtyPolicy,
			["reject", "ignore", "snapshot"],
		],
	] as const) {
		assert.ok("type" in schema);
		assert.equal(schema.type, "string");
		assert.deepEqual(schema.enum, values);
		assert.equal(Object.hasOwn(schema, "anyOf"), false);
		for (const value of values) {
			assert.equal(
				Value.Check(Params, { ...request, [property]: value }),
				true,
			);
		}
		for (const value of ["invalid", 1, null]) {
			assert.equal(
				Value.Check(Params, { ...request, [property]: value }),
				false,
			);
		}
	}
});

test("tool execution throws instead of returning a successful error envelope", async () => {
	let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
	register({
		registerTool(value: unknown) {
			tool = value as typeof tool;
		},
		registerCommand() {},
	} as never);
	const registeredTool = tool;
	assert.ok(registeredTool);
	await assert.rejects(
		() =>
			registeredTool.execute(
				"call",
				{ action: "status" },
				undefined,
				undefined,
				{
					cwd: process.cwd(),
				},
			),
		/id is required/u,
	);
});
