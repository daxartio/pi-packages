import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config.ts";

describe("validateConfig", () => {
	const valid = { version: 1, enabled: true };

	test("accepts a minimal config", () => {
		const config = validateConfig(valid);
		expect(config.enabled).toBe(true);
		expect(config.classifierThinkingLevel).toBeUndefined();
		expect(config.extraInstructions).toBeUndefined();
		expect(config.modelHints).toBeUndefined();
	});

	test("accepts classifierThinkingLevel, extraInstructions and modelHints", () => {
		const config = validateConfig({
			...valid,
			classifierThinkingLevel: "low",
			extraInstructions: "hint",
			modelHints: { "openai/gpt-5.6-mini": "cheap and fast" },
		});
		expect(config.classifierThinkingLevel).toBe("low");
		expect(config.extraInstructions).toBe("hint");
		expect(config.modelHints?.["openai/gpt-5.6-mini"]).toBe("cheap and fast");
	});

	test("rejects wrong version", () => {
		expect(() => validateConfig({ ...valid, version: 2 })).toThrow("version");
	});

	test("rejects invalid classifierThinkingLevel", () => {
		expect(() => validateConfig({ ...valid, classifierThinkingLevel: "extreme" })).toThrow(
			"thinking level",
		);
	});

	test("rejects malformed modelHints", () => {
		expect(() => validateConfig({ ...valid, modelHints: { "no-slash": "x" } })).toThrow(
			"provider/model",
		);
		expect(() => validateConfig({ ...valid, modelHints: { "a/b": 42 } })).toThrow("must be a string");
	});

	test("rejects non-boolean enabled", () => {
		expect(() => validateConfig({ version: 1, enabled: "yes" })).toThrow("enabled");
	});
});
