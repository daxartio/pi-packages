import { expect, test } from "bun:test";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { registerTools } from "../src/index.js";
import {
	BatchParams,
	EvaluateParams,
	FetchParams,
	MapParams,
	ScreenshotParams,
} from "../src/schema.js";

const url = "https://github.com/MinishLab/semble";

function schemas(): Map<string, TSchema> {
	const result = new Map<string, TSchema>();
	registerTools({
		registerTool(tool) {
			result.set(tool.name, tool.parameters);
		},
		on() {
			return () => {};
		},
	});
	return result;
}

test("only stateless tool schemas are registered", () => {
	expect(schemas()).toEqual(
		new Map<string, TSchema>([
			["servo_fetch", FetchParams],
			["servo_fetch_batch_fetch", BatchParams],
			["servo_fetch_map", MapParams],
			["servo_fetch_execute_js", EvaluateParams],
			["servo_fetch_screenshot", ScreenshotParams],
		]),
	);
});

test("every tool accepts its independent request and rejects session or authentication options", () => {
	const requests = [
		[FetchParams, { url }],
		[BatchParams, { urls: [url] }],
		[MapParams, { url }],
		[EvaluateParams, { url, expression: "document.title" }],
		[ScreenshotParams, { url }],
	] as const;
	for (const [schema, params] of requests) {
		expect(Value.Check(schema, params)).toBe(true);
		for (const forbidden of [
			{ sessionId: "none" },
			{ sessionId: "00000000-0000-4000-8000-000000000000" },
			{ sessionId: null },
			{ action: "open" },
			{ userAgent: "Fixture/1.0" },
			{ cookiesFile: "fixture.cookies" },
			{ headers: { "X-Fixture": "test" } },
		]) {
			expect(Value.Check(schema, { ...params, ...forbidden })).toBe(false);
		}
		expect(Object.hasOwn(schema.properties, "sessionId")).toBe(false);
	}
});
