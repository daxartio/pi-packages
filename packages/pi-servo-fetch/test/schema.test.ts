import { expect, expectTypeOf, test } from "bun:test";
import type { Static, TSchema } from "typebox";
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

test("extraction enums retain literal inference, optionality, and Google-compatible schemas", () => {
	expectTypeOf<Static<typeof FetchParams>["format"]>().toEqualTypeOf<
		"markdown" | "html" | "text" | "json" | undefined
	>();
	expectTypeOf<Static<typeof FetchParams>["visibility"]>().toEqualTypeOf<
		"moderate" | "strict" | "off" | undefined
	>();
	expectTypeOf<Static<typeof BatchParams>["visibility"]>().toEqualTypeOf<
		"moderate" | "strict" | "off" | undefined
	>();
	for (const [schema, property, enumSchema, values] of [
		[
			FetchParams,
			"format",
			FetchParams.properties.format,
			["markdown", "html", "text", "json"],
		],
		[
			FetchParams,
			"visibility",
			FetchParams.properties.visibility,
			["moderate", "strict", "off"],
		],
		[
			BatchParams,
			"visibility",
			BatchParams.properties.visibility,
			["moderate", "strict", "off"],
		],
	] as const) {
		expect(JSON.parse(JSON.stringify(enumSchema))).toMatchObject({
			type: "string",
			enum: values,
		});
		expect(enumSchema).not.toHaveProperty("anyOf");
		expect(enumSchema).toHaveProperty("description", expect.any(String));
		const request = schema === BatchParams ? { urls: [url] } : { url };
		expect(Value.Check(schema, request)).toBe(true);
		for (const value of values) {
			expect(Value.Check(schema, { ...request, [property]: value })).toBe(true);
		}
		for (const value of ["invalid", 1, null]) {
			expect(Value.Check(schema, { ...request, [property]: value })).toBe(
				false,
			);
		}
	}
});

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
