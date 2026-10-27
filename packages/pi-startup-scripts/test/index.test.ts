import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import startupScriptsExtension, { OUTPUT_MESSAGE } from "../src/index.ts";
import { STATE_ENTRY } from "../src/runtime.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

async function withHarness(
	config: unknown,
	run: (
		harness: ReturnType<typeof createHarness>,
		directory: string,
	) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-startup-hooks-"));
	const original = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = directory;
		await writeFile(
			join(directory, "pi-startup-scripts.json"),
			JSON.stringify(config),
		);
		await run(createHarness(directory), directory);
	} finally {
		if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = original;
		await rm(directory, { recursive: true, force: true });
	}
}

function createHarness(directory: string) {
	const sessionManager = SessionManager.create(
		directory,
		join(directory, "sessions"),
	);
	const notifications: string[] = [];
	const ctx = {
		cwd: directory,
		hasUI: true,
		sessionManager,
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionCommandContext;
	const handlers = new Map<string, Handler>();
	let command:
		| ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
		| undefined;
	const api = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		appendEntry: (customType: string, data: unknown) =>
			sessionManager.appendCustomEntry(customType, structuredClone(data)),
		sendMessage: (
			message: Parameters<ExtensionAPI["sendMessage"]>[0],
			options: { triggerTurn?: boolean },
		) => {
			expect(options.triggerTurn).toBe(false);
			sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		},
		registerCommand: (name: string, options: { handler: typeof command }) => {
			expect(name).toBe("startup-scripts");
			command = options.handler;
		},
	} as unknown as ExtensionAPI;
	startupScriptsExtension(api);
	return {
		ctx,
		sessionManager,
		notifications,
		reload: () => startupScriptsExtension(api),
		invoke: async (event: string, payload: unknown = {}) => {
			const handler = handlers.get(event);
			if (!handler) throw new Error(`Missing handler: ${event}`);
			return await handler(payload, ctx);
		},
		command: async (args: string) => {
			if (!command) throw new Error("Missing startup-scripts command");
			await command(args, ctx);
		},
		outputs: () =>
			ctx.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === OUTPUT_MESSAGE,
				),
	};
}

const successfulScript = {
	command: [
		"node",
		"-e",
		'require("fs").appendFileSync("runs", "once"); console.log("inventory for agent")',
	],
	prompt: "Use this inventory",
};

test("startup publishes output once, gates errors and keeps output only in system context", async () => {
	await withHarness(
		{
			scripts: [
				successfulScript,
				{ command: ["node", "-e", "process.exit(3)"] },
			],
		},
		async (harness, directory) => {
			await harness.invoke("session_start");
			expect(harness.notifications).toHaveLength(1);
			expect(harness.notifications[0]).toContain("Script #2: exit code 3");
			expect(harness.outputs()).toHaveLength(1);
			expect(harness.outputs()[0]).toMatchObject({
				display: true,
				content: expect.stringContaining("inventory for agent"),
			});
			for (const source of ["interactive", "rpc", "extension"]) {
				expect(await harness.invoke("input", { text: "work", source })).toEqual(
					{ action: "handled" },
				);
			}
			await harness.command("continue");
			expect(await harness.invoke("input", { text: "work" })).toEqual({
				action: "continue",
			});
			const event = { systemPrompt: "Original system prompt" };
			const first = await harness.invoke("before_agent_start", event);
			expect(first).toMatchObject({
				systemPrompt: expect.stringContaining(
					"Use this inventory\n\ninventory for agent",
				),
			});
			expect(await harness.invoke("before_agent_start", event)).toEqual(first);
			const user = { role: "user", content: "work", timestamp: 1 };
			const other = {
				role: "custom",
				customType: "another-plugin",
				content: "keep",
				timestamp: 1,
			};
			expect(
				await harness.invoke("context", {
					messages: [
						user,
						{
							role: "custom",
							customType: OUTPUT_MESSAGE,
							content: "inventory",
							timestamp: 1,
						},
						other,
					],
				}),
			).toEqual({ messages: [user, other] });
			harness.reload();
			await harness.invoke("session_start");
			expect(await harness.invoke("before_agent_start", event)).toEqual(first);
			expect(harness.outputs()).toHaveLength(1);
			expect(await readFile(join(directory, "runs"), "utf8")).toBe("once");
		},
	);
});

test("global toggle persists, suppresses current context and does not rerun scripts", async () => {
	await withHarness(
		{ scripts: [successfulScript] },
		async (harness, directory) => {
			await harness.invoke("session_start");
			await harness.command("toggle");
			expect(
				JSON.parse(
					await readFile(join(directory, "pi-startup-scripts.json"), "utf8"),
				).enabled,
			).toBe(false);
			expect(
				await harness.invoke("before_agent_start", { systemPrompt: "base" }),
			).toBeUndefined();
			harness.reload();
			await harness.invoke("session_start");
			expect(
				await harness.invoke("before_agent_start", { systemPrompt: "base" }),
			).toBeUndefined();
			await harness.command("toggle");
			expect(
				await harness.invoke("before_agent_start", { systemPrompt: "base" }),
			).toMatchObject({
				systemPrompt: expect.stringContaining("inventory for agent"),
			});
			expect(harness.outputs()).toHaveLength(1);
			expect(await readFile(join(directory, "runs"), "utf8")).toBe("once");
		},
	);
});

test("disabled startup and continue do not execute scripts; enabling runs once", async () => {
	await withHarness(
		{ enabled: false, scripts: [successfulScript] },
		async (harness, directory) => {
			await harness.invoke("session_start");
			await harness.command("continue");
			expect(harness.sessionManager.getEntries()).toHaveLength(0);
			expect(await harness.invoke("input", { text: "work" })).toEqual({
				action: "continue",
			});
			await harness.command("toggle");
			expect(await readFile(join(directory, "runs"), "utf8")).toBe("once");
			expect(harness.outputs()).toHaveLength(1);
		},
	);
});

test("individual toggles persist for future sessions and invalid command args do not toggle", async () => {
	await withHarness(
		{ enabled: false, scripts: [successfulScript] },
		async (harness, directory) => {
			await harness.invoke("session_start");
			await harness.command("toggle 1");
			const path = join(directory, "pi-startup-scripts.json");
			const before = await readFile(path, "utf8");
			expect(JSON.parse(before).scripts[0].enabled).toBe(false);
			for (const invalid of [
				"toggle 0",
				"toggle abc",
				"toggle 1 extra",
				"toggle 99",
			])
				await harness.command(invalid);
			expect(await readFile(path, "utf8")).toBe(before);
			await harness.command("toggle");
			expect(harness.outputs()).toHaveLength(0);
			await expect(readFile(join(directory, "runs"), "utf8")).rejects.toThrow();
		},
	);
});

test("disabling bypasses prior startup error gate without acknowledging or rerunning", async () => {
	await withHarness(
		{ scripts: [{ command: ["node", "-e", "process.exit(3)"] }] },
		async (harness) => {
			await harness.invoke("session_start");
			await harness.command("toggle");
			expect(await harness.invoke("input", { text: "work" })).toEqual({
				action: "continue",
			});
			await harness.command("toggle");
			expect(await harness.invoke("input", { text: "work" })).toEqual({
				action: "handled",
			});
		},
	);
});

test("legacy saved context becomes visible and is included in the real HTML export", async () => {
	await withHarness({ scripts: [] }, async (harness, directory) => {
		harness.sessionManager.appendCustomEntry(STATE_ENTRY, {
			phase: "complete",
			blocked: false,
			context: "Saved startup inventory",
			errors: [],
		});
		await harness.invoke("session_start");
		expect(harness.outputs()).toHaveLength(1);
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Ready" }],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const exportUrl = new URL(
			"core/export-html/index.js",
			import.meta.resolve("@earendil-works/pi-coding-agent"),
		).href;
		const exporter = (await import(exportUrl)) as {
			exportSessionToHtml: (
				session: SessionManager,
				state: undefined,
				options: { outputPath: string },
			) => Promise<string>;
		};
		const htmlPath = await exporter.exportSessionToHtml(
			harness.sessionManager,
			undefined,
			{ outputPath: join(directory, "export.html") },
		);
		const html = await readFile(htmlPath, "utf8");
		const encoded = html.match(
			/<script id="session-data" type="application\/json">([^<]+)<\/script>/,
		)?.[1];
		if (!encoded) throw new Error("Export is missing session data");
		const exported: { entries: unknown[] } = JSON.parse(
			Buffer.from(encoded, "base64").toString("utf8"),
		);
		expect(exported.entries).toContainEqual(
			expect.objectContaining({
				type: "custom_message",
				customType: OUTPUT_MESSAGE,
				display: true,
				content: "Saved startup inventory",
			}),
		);
		harness.reload();
		await harness.invoke("session_start");
		expect(harness.outputs()).toHaveLength(1);
	});
});
