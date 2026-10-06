import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import autoModel from "../src/index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandContext = Parameters<Command["handler"]>[1];

describe("automodel command", () => {
	let directory: string;
	let previousAgentDir: string | undefined;
	let command: Command;
	let context: CommandContext;
	let notices: { message: string; type?: string }[];
	let statuses: (string | undefined)[];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-auto-model-command-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = directory;
		notices = [];
		statuses = [];
		const api = {
			registerCommand(name: string, registered: Command) {
				expect(name).toBe("automodel");
				command = registered;
			},
			registerShortcut() {},
			on() {},
		};
		autoModel(api as unknown as ExtensionAPI);
		context = {
			scopedModels: [],
			ui: {
				notify(message: string, type?: string) {
					notices.push({ message, type });
				},
				setStatus(_key: string, status: string | undefined) {
					statuses.push(status);
				},
				theme: { fg: (_color: string, text: string) => text },
			},
		} as unknown as CommandContext;
	});

	afterEach(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	});

	test("creates enabled config, notifies, then toggles off and on", async () => {
		await command.handler("", context);
		expect(
			JSON.parse(await readFile(join(directory, "auto-model.json"), "utf8")),
		).toEqual({
			version: 1,
			enabled: true,
		});
		expect(notices.at(-1)?.message).toContain("config created");
		expect(notices.at(-1)?.message).toContain(directory);
		expect(statuses.at(-1)).toBe("auto:model");
		await command.handler(" ", context);
		expect(notices.at(-1)?.message).toBe("Auto model disabled.");
		expect(statuses.at(-1)).toBeUndefined();
		await command.handler("", context);
		expect(notices.at(-1)?.message).toBe("Auto model enabled.");
		expect(statuses.at(-1)).toBe("auto:model");
	});

	test("status and removed on/off arguments do not create config", async () => {
		await command.handler("status", context);
		expect(notices.at(-1)?.message).toContain("enabled: false");
		for (const argument of ["on", "off"]) {
			await command.handler(argument, context);
			expect(notices.at(-1)?.message).toContain("Usage:");
		}
		await expect(
			readFile(join(directory, "auto-model.json"), "utf8"),
		).rejects.toThrow();
		const completions = await command.getArgumentCompletions?.("");
		expect(completions?.map((item) => item.value)).toEqual([
			"status",
			"accept",
			"dismiss",
		]);
	});

	test("failed toggle leaves active status unchanged and reports error", async () => {
		await command.handler("", context);
		const path = join(directory, "auto-model.json");
		await writeFile(path, "invalid json");
		await command.handler("", context);
		expect(notices.at(-1)?.type).toBe("error");
		expect(statuses).toEqual(["auto:model"]);
		expect(await readFile(path, "utf8")).toBe("invalid json");
		await command.handler("status", context);
		expect(notices.at(-1)?.message).toContain("enabled: true");
	});
});
