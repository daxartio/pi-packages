import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configPath,
	DEFAULT_TIMEOUT_MS,
	expandTemplate,
	loadConfig,
	parseConfig,
	toggleEnabled,
} from "../src/config.ts";

describe("configuration", () => {
	test("defaults and per-script overrides", () => {
		const config = parseConfig({ scripts: [{ command: ["tool", ""] }] });
		expect(config.enabled).toBe(true);
		expect(config.scripts[0]).toEqual({
			enabled: true,
			command: ["tool", ""],
			prompt: "",
			timeoutMs: DEFAULT_TIMEOUT_MS,
			includeEmpty: false,
		});
		expect(
			parseConfig({
				prompt: "global",
				timeoutMs: 42,
				includeEmpty: true,
				scripts: [
					{ command: ["first"] },
					{
						command: ["second"],
						prompt: "local",
						timeoutMs: 84,
						includeEmpty: false,
					},
				],
			}).scripts,
		).toEqual([
			{
				enabled: true,
				command: ["first"],
				prompt: "global",
				timeoutMs: 42,
				includeEmpty: true,
			},
			{
				enabled: true,
				command: ["second"],
				prompt: "local",
				timeoutMs: 84,
				includeEmpty: false,
			},
		]);
	});

	test("rejects invalid configuration before executing any commands", () => {
		for (const invalid of [
			null,
			[],
			{},
			{ scripts: "bad" },
			{ scripts: [null] },
			{ scripts: [{ command: [] }] },
			{ scripts: [{ command: [""] }] },
			{ scripts: [{ command: ["tool", 1] }] },
			{ scripts: [{ command: ["tool\0"] }] },
		]) {
			expect(() => parseConfig(invalid)).toThrow();
		}
		for (const timeoutMs of [0, -1, 1.5, "100", Number.NaN, 2_147_483_648]) {
			expect(() => parseConfig({ scripts: [], timeoutMs })).toThrow();
		}
		expect(() => parseConfig({ scripts: [], includeEmpty: "yes" })).toThrow();
		expect(() => parseConfig({ scripts: [], prompt: [] })).toThrow();
	});

	test("enabled defaults are independent and strict at both levels", () => {
		for (const global of [undefined, true, false]) {
			for (const local of [undefined, true, false]) {
				const config = parseConfig({
					enabled: global,
					scripts: [{ command: ["tool"], enabled: local }],
				});
				expect(config.enabled).toBe(global ?? true);
				expect(config.scripts[0]?.enabled).toBe(local ?? true);
			}
		}
		for (const invalid of [null, 0, 1, "true", "false", [], {}, Number.NaN]) {
			expect(() => parseConfig({ enabled: invalid, scripts: [] })).toThrow(
				"enabled must be a boolean",
			);
			expect(() =>
				parseConfig({ scripts: [{ command: ["tool"], enabled: invalid }] }),
			).toThrow("enabled must be a boolean");
		}
	});

	test("templates expand without recursive or shell expansion", () => {
		expect(
			expandTemplate(
				`\${projectPath}|\${projectName}|$HOME|\${HOME}|$UNKNOWN|$(echo nope)`,
				"/projects/with spaces",
				"/home/example",
			),
		).toBe(
			"/projects/with spaces|with spaces|/home/example|/home/example|$UNKNOWN|$(echo nope)",
		);
		expect(
			expandTemplate(`\${projectPath}`, "/projects/$HOME", "/home/example"),
		).toBe("/projects/$HOME");
	});

	test("uses Pi's agent directory override", () => {
		const original = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = "/custom/pi-agent";
			expect(configPath()).toBe("/custom/pi-agent/pi-startup-scripts.json");
		} finally {
			if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = original;
		}
	});

	test("missing config is enabled and empty; malformed JSON fails without exposing source", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-startup-config-"));
		try {
			const path = join(directory, "config.json");
			expect(await loadConfig(path)).toEqual({ enabled: true, scripts: [] });
			await writeFile(path, "not valid JSON");
			await expect(loadConfig(path)).rejects.toThrow("contains invalid JSON");
			await writeFile(path, JSON.stringify({ scripts: [] }));
			expect(await loadConfig(path)).toEqual({ enabled: true, scripts: [] });
			await expect(loadConfig(directory)).rejects.toThrow("cannot read");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	test("toggles raw settings without losing prompts, unknown fields, or defaults", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-startup-toggle-"));
		try {
			const path = join(directory, "config.json");
			const raw = {
				prompt: `global private prompt \${HOME}`,
				timeoutMs: 123,
				includeEmpty: true,
				unknown: { nested: ["preserve", 7] },
				scripts: [
					{
						command: ["first"],
						prompt: "local prompt",
						timeoutMs: 456,
						includeEmpty: false,
						extra: { a: true },
					},
					{ command: ["second"], enabled: false },
				],
			};
			await writeFile(path, JSON.stringify(raw), { mode: 0o600 });
			expect(await toggleEnabled(undefined, path)).toBe(false);
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				...raw,
				enabled: false,
			});
			expect(await toggleEnabled(1, path)).toBe(false);
			const expected = {
				...raw,
				enabled: false,
				scripts: [{ ...raw.scripts[0], enabled: false }, raw.scripts[1]],
			};
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual(expected);
			expect(await toggleEnabled(1, path)).toBe(true);
			expect(await toggleEnabled(2, path)).toBe(true);
			expect(await toggleEnabled(undefined, path)).toBe(true);
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				...raw,
				enabled: true,
				scripts: raw.scripts.map((script) => ({ ...script, enabled: true })),
			});
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect(await readdir(directory)).toEqual(["config.json"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("global toggle creates missing config and parent with restrictive permissions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-startup-toggle-"));
		try {
			const path = join(directory, "nested", "config.json");
			await expect(toggleEnabled(1, path)).rejects.toThrow("out of range");
			expect(await readdir(directory)).toEqual([]);
			expect(await toggleEnabled(undefined, path)).toBe(false);
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				enabled: false,
				scripts: [],
			});
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			for (const mode of [0o400, 0o600, 0o644, 0o666]) {
				await chmod(path, mode);
				await toggleEnabled(undefined, path);
				expect((await stat(path)).mode & 0o777).toBe(
					mode === 0o400 ? 0o400 : 0o600,
				);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"save failures are sanitized and leave original bytes unchanged",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "pi-startup-toggle-"));
			try {
				const path = join(directory, "config.json");
				const source = ' { "scripts": [], "prompt": "PRIVATE" }\n';
				await writeFile(path, source, { mode: 0o600 });
				await chmod(directory, 0o500);
				await expect(toggleEnabled(undefined, path)).rejects.toThrow(
					"cannot save pi-startup-scripts.json",
				);
				expect(await readFile(path, "utf8")).toBe(source);
				expect(await readdir(directory)).toEqual(["config.json"]);
			} finally {
				await chmod(directory, 0o700);
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	test("invalid numbers and configurations leave original bytes unchanged", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-startup-toggle-"));
		try {
			const path = join(directory, "config.json");
			const source =
				' { "scripts": [{"command":["tool"]}], "secret": "PRIVATE" }\n';
			await writeFile(path, source);
			for (const number of [
				0,
				-1,
				1.5,
				Number.NaN,
				Infinity,
				2,
				Number.MAX_SAFE_INTEGER + 1,
			]) {
				await expect(toggleEnabled(number, path)).rejects.toThrow(
					"script number",
				);
				expect(await readFile(path, "utf8")).toBe(source);
			}
			for (const invalid of [
				"PRIVATE invalid JSON",
				JSON.stringify({ scripts: [], enabled: "PRIVATE" }),
				JSON.stringify({
					scripts: [{ command: ["tool"], enabled: "PRIVATE" }],
				}),
				JSON.stringify({
					scripts: [{ command: ["tool"] }, { command: "PRIVATE" }],
				}),
				JSON.stringify({ scripts: [], prompt: { secret: "PRIVATE" } }),
			]) {
				await writeFile(path, invalid);
				for (const number of [undefined, 1]) {
					let message = "";
					try {
						await toggleEnabled(number, path);
					} catch (error) {
						message = String(error);
					}
					expect(message).not.toBe("");
					expect(message).not.toContain("PRIVATE");
					expect(await readFile(path, "utf8")).toBe(invalid);
				}
			}
			await expect(toggleEnabled(undefined, directory)).rejects.toThrow(
				"cannot read pi-startup-scripts.json",
			);
			expect(await readdir(directory)).toEqual(["config.json"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
