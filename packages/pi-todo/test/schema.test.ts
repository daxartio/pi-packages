import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
	type TaskAction,
	type TaskStatus,
	type TodoParams,
	TodoParamsSchema,
} from "../src/tool/types.js";

test("todo enums infer domain literals and preserve optional status", () => {
	const request: TodoParams = { action: "list" };
	const action: TaskAction = request.action;
	const status: TaskStatus | undefined = request.status;
	assert.equal(action, "list");
	assert.equal(status, undefined);
	assert.equal(Value.Check(TodoParamsSchema, request), true);
});

test("todo enums use Google-compatible schemas and reject unsupported values", () => {
	for (const [property, schema, values] of [
		[
			"action",
			TodoParamsSchema.properties.action,
			["create", "update", "list", "get", "delete", "clear"],
		],
		[
			"status",
			TodoParamsSchema.properties.status,
			["pending", "in_progress", "completed", "deleted"],
		],
	] as const) {
		assert.ok("type" in schema);
		assert.equal(schema.type, "string");
		assert.deepEqual(schema.enum, values);
		assert.equal(Object.hasOwn(schema, "anyOf"), false);
		for (const value of values) {
			assert.equal(
				Value.Check(TodoParamsSchema, { action: "list", [property]: value }),
				true,
			);
		}
		for (const value of ["invalid", 1, null]) {
			assert.equal(
				Value.Check(TodoParamsSchema, { action: "list", [property]: value }),
				false,
			);
		}
	}
	assert.equal(Value.Check(TodoParamsSchema, {}), false);
	assert.ok("description" in TodoParamsSchema.properties.status);
	assert.equal(typeof TodoParamsSchema.properties.status.description, "string");
});
