import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	loadConfig,
	saveConfig,
	toggleConfig,
	validateConfig,
} from "../src/config.ts";

describe("toggleConfig", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			directories
				.splice(0)
				.map((dir) => rm(dir, { recursive: true, force: true })),
		);
	});

	async function configPath(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "pi-auto-model-"));
		directories.push(dir);
		return join(dir, "agent", "auto-model.json");
	}

	test("missing config stays absent until toggled, then is created enabled", async () => {
		const path = await configPath();
		expect(await loadConfig(path)).toEqual({});
		await expect(readFile(path, "utf8")).rejects.toThrow();
		const result = await toggleConfig(path);
		expect(result).toEqual({
			config: { version: 1, enabled: true },
			created: true,
		});
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			version: 1,
			enabled: true,
		});
	});

	test("toggles both ways and preserves custom settings", async () => {
		const path = await configPath();
		const original = validateConfig({
			version: 1,
			enabled: true,
			classifierThinkingLevel: "low",
			extraInstructions: "hint",
			modelHints: { "a/b": "workhorse" },
		});
		await saveConfig(path, original);
		expect(await toggleConfig(path)).toEqual({
			config: { ...original, enabled: false },
			created: false,
		});
		expect((await loadConfig(path)).config).toEqual({
			...original,
			enabled: false,
		});
		expect(await toggleConfig(path)).toEqual({
			config: original,
			created: false,
		});
		expect((await loadConfig(path)).config).toEqual(original);
	});

	test("does not overwrite malformed config", async () => {
		const path = await configPath();
		await saveConfig(path, { version: 1, enabled: true });
		await writeFile(path, "invalid json");
		await expect(toggleConfig(path)).rejects.toThrow("Could not load");
		expect(await readFile(path, "utf8")).toBe("invalid json");
	});

	test("reports write failures", async () => {
		const path = await configPath();
		await writeFile(dirname(path), "not a directory");
		await expect(toggleConfig(path)).rejects.toThrow();
	});
});

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
		expect(() =>
			validateConfig({ ...valid, classifierThinkingLevel: "extreme" }),
		).toThrow("thinking level");
	});

	test("rejects malformed modelHints", () => {
		expect(() =>
			validateConfig({ ...valid, modelHints: { "no-slash": "x" } }),
		).toThrow("provider/model");
		expect(() =>
			validateConfig({ ...valid, modelHints: { "a/b": 42 } }),
		).toThrow("must be a string");
	});

	test("rejects non-boolean enabled", () => {
		expect(() => validateConfig({ version: 1, enabled: "yes" })).toThrow(
			"enabled",
		);
	});
});
