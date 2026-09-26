import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	buildOutputPath,
	type ExportSessionData,
	type ExportSessionToHtml,
	exportAndOpen,
	exportFallback,
	resolveOpener,
} from "../src/export.js";
import { buildExportState } from "../src/index.js";

function fakeSession(
	overrides: Partial<ExportSessionData> = {},
): ExportSessionData {
	return {
		getSessionFile: () =>
			"/home/user/.pi/agent/sessions/2024-01-01/abc123.jsonl",
		getSessionId: () => "abc123",
		...overrides,
	};
}

describe("buildOutputPath", () => {
	test("uses session file basename with a sanitized timestamp inside tmpdir", () => {
		const now = new Date("2025-06-15T10:20:30.456Z");
		const path = buildOutputPath("/sessions/abc123.jsonl", "ignored", now);
		expect(path).toBe(
			join(tmpdir(), "pi-session-abc123-2025-06-15T10-20-30-456Z.html"),
		);
		expect(path.startsWith(tmpdir())).toBe(true);
	});

	test("falls back to session id when there is no session file", () => {
		const now = new Date("2025-06-15T10:20:30.456Z");
		const path = buildOutputPath(undefined, "session-id-9", now);
		expect(path).toContain("pi-session-session-id-9-");
	});

	test("two sequential exports get distinct paths", () => {
		const first = buildOutputPath(
			"/s/a.jsonl",
			"a",
			new Date("2025-01-01T00:00:00.000Z"),
		);
		const second = buildOutputPath(
			"/s/a.jsonl",
			"a",
			new Date("2025-01-01T00:00:00.001Z"),
		);
		expect(first).not.toBe(second);
	});
});

describe("resolveOpener", () => {
	test("picks the platform-specific opener", () => {
		expect(resolveOpener("darwin").command).toBe("open");
		expect(resolveOpener("linux").command).toBe("xdg-open");
		expect(resolveOpener("win32").command).toBe("cmd");
		expect(resolveOpener("win32").args).toContain("/c");
	});
});

describe("exportFallback", () => {
	const created: string[] = [];

	afterEach(() => {
		for (const path of created.splice(0)) {
			if (existsSync(path)) rmSync(path, { recursive: true });
		}
	});

	test("renders session JSONL lines as escaped HTML", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-export-browser-test-"));
		created.push(dir);
		const sessionFile = join(dir, "sess.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "s1" })}\n`,
			"utf8",
		);
		const out = join(dir, "out.html");
		exportFallback(fakeSession({ getSessionFile: () => sessionFile }), out);
		const html = readFileSync(out, "utf8");
		expect(html).toContain("<!doctype html>");
		expect(html).toContain("&quot;type&quot;");
	});

	test("includes the system prompt and tools from the export state", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-export-browser-test-"));
		created.push(dir);
		const sessionFile = join(dir, "sess.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "s1" })}\n`,
			"utf8",
		);
		const out = join(dir, "out.html");
		exportFallback(fakeSession({ getSessionFile: () => sessionFile }), out, {
			systemPrompt: "You are a <test> assistant",
			tools: [
				{
					name: "bash",
					description: "Run <shell> commands",
					parameters: { type: "object" },
				},
			],
		});
		const html = readFileSync(out, "utf8");
		expect(html).toContain("System Prompt");
		expect(html).toContain("You are a &lt;test&gt; assistant");
		expect(html).toContain("Available Tools");
		expect(html).toContain("<b>bash</b>");
		expect(html).toContain("Run &lt;shell&gt; commands");
	});

	test("rejects in-memory sessions", () => {
		const sm = fakeSession({ getSessionFile: () => undefined });
		expect(() => exportFallback(sm, join(tmpdir(), "x.html"))).toThrow(
			/in-memory/,
		);
	});

	test("rejects when the session file does not exist yet", () => {
		const sm = fakeSession({
			getSessionFile: () =>
				join(tmpdir(), "definitely-missing-pi-session.jsonl"),
		});
		expect(() => exportFallback(sm, join(tmpdir(), "x.html"))).toThrow(
			/Nothing to export/,
		);
	});
});

describe("exportAndOpen", () => {
	const created: string[] = [];

	afterEach(() => {
		for (const path of created.splice(0)) {
			if (existsSync(path)) rmSync(path, { recursive: true });
		}
	});

	function stubOpener(
		calls: string[],
	): typeof import("node:child_process").spawn {
		const { EventEmitter } = require("node:events");
		return ((command: string, args: string[]) => {
			calls.push([command, ...args].join(" "));
			const child = new EventEmitter() as ReturnType<
				typeof import("node:child_process").spawn
			>;
			child.unref = () => child;
			queueMicrotask(() => child.emit("spawn"));
			return child;
		}) as typeof import("node:child_process").spawn;
	}

	test("exports via pi's exporter to a tmp path and opens it in the browser", async () => {
		const opened: string[] = [];
		const exporter: ExportSessionToHtml = async (_sm, _state, options) => {
			writeFileSync(options.outputPath as string, "<html>ok</html>", "utf8");
			return options.outputPath as string;
		};
		const result = await exportAndOpen(fakeSession(), undefined, {
			resolveExporter: async () => exporter,
			spawnFn: stubOpener(opened),
		});
		created.push(result.filePath);
		expect(result.filePath.startsWith(tmpdir())).toBe(true);
		expect(result.filePath.endsWith(".html")).toBe(true);
		expect(readFileSync(result.filePath, "utf8")).toBe("<html>ok</html>");
		expect(opened).toHaveLength(1);
		expect(opened[0]).toContain(result.filePath);
		expect(opened[0]).toStartWith(`${resolveOpener().command} `);
	});

	test("falls back to the basic renderer when pi internals are unavailable", async () => {
		const opened: string[] = [];
		const dir = mkdtempSync(join(tmpdir(), "pi-export-browser-test-"));
		created.push(dir);
		const sessionFile = join(dir, "sess.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "s1" })}\n`,
			"utf8",
		);
		const result = await exportAndOpen(
			fakeSession({ getSessionFile: () => sessionFile }),
			{
				systemPrompt: "prompt",
				tools: [{ name: "read", description: "Read files" }],
			},
			{
				resolveExporter: async () => undefined,
				spawnFn: stubOpener(opened),
			},
		);
		created.push(result.filePath);
		const html = readFileSync(result.filePath, "utf8");
		expect(html).toContain("basic renderer");
		expect(html).toContain("System Prompt");
		expect(html).toContain("<b>read</b>");
		expect(opened).toHaveLength(1);
	});

	test("propagates exporter errors without opening a browser", async () => {
		const opened: string[] = [];
		const exporter: ExportSessionToHtml = async () => {
			throw new Error("boom");
		};
		await expect(
			exportAndOpen(fakeSession(), undefined, {
				resolveExporter: async () => exporter,
				spawnFn: stubOpener(opened),
			}),
		).rejects.toThrow("boom");
		expect(opened).toHaveLength(0);
	});
});

describe("buildExportState", () => {
	function fakePi(
		tools: {
			name: string;
			description?: string;
			parameters?: unknown;
			sourceInfo?: unknown;
		}[],
		active?: string[],
	) {
		return {
			getAllTools: () => tools,
			getActiveTools: () => active ?? tools.map((t) => t.name),
		} as unknown as ExtensionAPI;
	}

	const fakeCtx = {
		getSystemPrompt: () => "effective system prompt",
	} as ExtensionCommandContext;

	test("takes the effective system prompt and active tools with schemas", () => {
		const pi = fakePi([
			{
				name: "read",
				description: "Read files",
				parameters: { type: "object" },
				sourceInfo: { source: "builtin" },
			},
			{
				name: "write",
				description: "Write files",
				parameters: { type: "object" },
			},
		]);
		const state = buildExportState(pi, fakeCtx);
		expect(state.systemPrompt).toBe("effective system prompt");
		expect(state.tools).toEqual([
			{
				name: "read",
				description: "Read files",
				parameters: { type: "object" },
			},
			{
				name: "write",
				description: "Write files",
				parameters: { type: "object" },
			},
		]);
	});

	test("filters tools down to the active set", () => {
		const tools = [
			{ name: "read", description: "Read files" },
			{ name: "write", description: "Write files" },
		];
		expect(
			buildExportState(fakePi(tools, ["write"]), fakeCtx).tools?.map(
				(tool) => tool.name,
			),
		).toEqual(["write"]);
		expect(buildExportState(fakePi(tools, []), fakeCtx).tools).toEqual([]);
	});
});
