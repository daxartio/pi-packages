import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastModeExtension, {
	CONFIG_FIELD,
	DEFAULT_SHORTCUT,
	FAST_SERVICE_TIER,
	KEYBINDING_FIELD,
	loadDefaultEnabled,
	loadEnabled,
	loadPersistedEnabled,
	loadShortcuts,
	normalizeShortcutSetting,
	RESERVED_SHORTCUTS,
	resolveKeybindingsPath,
	resolvePiFilePath,
	resolveSettingsPath,
	resolveStatePath,
	STATE_FILE_NAME,
	STATUS_KEY,
	savePersistedEnabled,
	withFastServiceTier,
} from "../src/index.ts";

const TARGET_MODEL = "future-model";
const TARGET_PROVIDER = "custom-provider";

type MockCtx = ReturnType<typeof createCtx>;

function createMockPi() {
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: MockCtx) => Promise<void> | void }
	>();
	const shortcuts = new Map<
		string,
		{ handler: (ctx: MockCtx) => Promise<void> | void }
	>();
	const handlers = new Map<string, (event: unknown, ctx: MockCtx) => unknown>();

	return {
		commands,
		shortcuts,
		handlers,
		registerCommand(
			name: string,
			options: {
				handler: (args: string, ctx: MockCtx) => Promise<void> | void;
			},
		) {
			commands.set(name, options);
		},
		registerShortcut(
			shortcut: string,
			options: { handler: (ctx: MockCtx) => Promise<void> | void },
		) {
			shortcuts.set(shortcut, options);
		},
		on(event: string, handler: (event: unknown, ctx: MockCtx) => unknown) {
			handlers.set(event, handler);
		},
	};
}

function requireValue<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`Missing ${label}`);
	return value;
}

function createCtx(model = { provider: TARGET_PROVIDER, id: TARGET_MODEL }) {
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string>();

	return {
		model,
		notifications,
		statuses,
		ui: {
			theme: {
				fg(_color: string, text: string) {
					return text;
				},
			},
			notify(message: string, level = "info") {
				notifications.push({ message, level });
			},
			setStatus(key: string, value: string | undefined) {
				if (value === undefined) statuses.delete(key);
				else statuses.set(key, value);
			},
		},
	};
}

let previousPiDir: string | undefined;
let previousXdg: string | undefined;

beforeEach(() => {
	previousPiDir = process.env.PI_CODING_AGENT_DIR;
	previousXdg = process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
	if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousPiDir;

	if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = previousXdg;
});

test("patches payloads without a model allowlist or matching context", () => {
	for (const payload of [
		{ model: TARGET_MODEL, input: [] },
		{ model: "provider-model-alias", service_tier: "auto" },
		{ messages: [] },
		{},
	]) {
		const original = structuredClone(payload);
		expect(withFastServiceTier(payload)).toEqual({
			...payload,
			service_tier: FAST_SERVICE_TIER,
		});
		expect(payload).toEqual(original);
	}
});

test("leaves non-object and array payloads untouched", () => {
	for (const payload of [null, undefined, "model", 42, false, []]) {
		expect(withFastServiceTier(payload)).toBe(payload);
	}
});

test.each([
	"openai",
	"openai-codex",
	"github-copilot",
	"custom-provider",
	"anthropic",
])(
	"toggles priority requests and status for any model through %s",
	async (provider) => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-gpt-fast-mode-provider-"));
		try {
			process.env.PI_CODING_AGENT_DIR = tempDir;
			delete process.env.XDG_CONFIG_HOME;
			writeFileSync(
				join(tempDir, "settings.json"),
				JSON.stringify({ [CONFIG_FIELD]: { enabled: true } }),
			);
			const pi = createMockPi();
			fastModeExtension(
				pi as unknown as Parameters<typeof fastModeExtension>[0],
			);
			const ctx = createCtx({ provider, id: TARGET_MODEL });
			const hook = requireValue(
				pi.handlers.get("before_provider_request"),
				"request handler",
			);
			const sessionStart = requireValue(
				pi.handlers.get("session_start"),
				"session handler",
			);
			const command = requireValue(pi.commands.get("fast"), "fast command");
			const payload = { model: ctx.model.id, input: [], service_tier: "auto" };

			sessionStart({}, ctx);
			expect(ctx.statuses.get(STATUS_KEY)).toContain("fast");
			expect(hook({ payload }, ctx)).toEqual({
				...payload,
				service_tier: FAST_SERVICE_TIER,
			});
			expect(payload.service_tier).toBe("auto");

			await command.handler("", ctx);
			expect(hook({ payload }, ctx)).toBeUndefined();
			expect(ctx.statuses.has(STATUS_KEY)).toBe(false);
			expect(loadPersistedEnabled()).toBe(false);

			await command.handler("", ctx);
			expect(ctx.notifications.at(-1)?.message).toContain(
				"service_tier: priority",
			);
			expect(hook({ payload }, ctx)).toEqual({
				...payload,
				service_tier: FAST_SERVICE_TIER,
			});

			const otherCtx = createCtx({
				provider: "another-provider",
				id: "another-model",
			});
			expect(hook({ payload: { model: "request-alias" } }, otherCtx)).toEqual({
				model: "request-alias",
				service_tier: FAST_SERVICE_TIER,
			});
			expect(hook({ payload: { messages: [] } }, otherCtx)).toEqual({
				messages: [],
				service_tier: FAST_SERVICE_TIER,
			});
			for (const invalid of [null, undefined, [], "payload"]) {
				expect(hook({ payload: invalid }, otherCtx)).toBeUndefined();
			}
			expect(ctx.statuses.get(STATUS_KEY)).toContain("fast");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	},
);

test("adds actionable context only to tier errors from patched requests", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-gpt-fast-mode-errors-"));
	try {
		process.env.PI_CODING_AGENT_DIR = tempDir;
		delete process.env.XDG_CONFIG_HOME;
		writeFileSync(
			join(tempDir, "settings.json"),
			JSON.stringify({ [CONFIG_FIELD]: { enabled: true } }),
		);
		const pi = createMockPi();
		fastModeExtension(pi as unknown as Parameters<typeof fastModeExtension>[0]);
		const ctx = createCtx();
		const request = requireValue(
			pi.handlers.get("before_provider_request"),
			"request handler",
		);
		const messageEnd = requireValue(
			pi.handlers.get("message_end"),
			"message handler",
		);
		const sessionStart = requireValue(
			pi.handlers.get("session_start"),
			"session handler",
		);
		const command = requireValue(pi.commands.get("fast"), "fast command");
		const tierError = {
			role: "assistant",
			stopReason: "error",
			errorMessage: '400: unsupported parameter "service_tier"',
			content: [],
		};

		for (const reason of [
			tierError.errorMessage,
			"Priority tier is not available for this account",
			"Invalid service tier: priority",
		]) {
			request({ payload: {} }, ctx);
			const message = { ...tierError, errorMessage: reason };
			const original = structuredClone(message);
			expect(messageEnd({ message }, ctx)).toEqual({
				message: {
					...message,
					errorMessage: expect.stringContaining("disable /fast and retry"),
				},
			});
			request({ payload: {} }, ctx);
			expect(messageEnd({ message }, ctx)).toEqual({
				message: { ...message, errorMessage: expect.stringContaining(reason) },
			});
			expect(message).toEqual(original);
			expect(messageEnd({ message }, ctx)).toBeUndefined();
		}

		for (const message of [
			{ ...tierError, errorMessage: "401: invalid API key" },
			{ ...tierError, errorMessage: "network timeout" },
			{ ...tierError, errorMessage: undefined },
			{ ...tierError, stopReason: "stop" },
			{ ...tierError, stopReason: "aborted" },
		]) {
			request({ payload: {} }, ctx);
			expect(messageEnd({ message }, ctx)).toBeUndefined();
			expect(messageEnd({ message: tierError }, ctx)).toBeUndefined();
		}

		request({ payload: {} }, ctx);
		expect(
			messageEnd({ message: { role: "toolResult" } }, ctx),
		).toBeUndefined();
		expect(messageEnd({ message: tierError }, ctx)).toBeDefined();

		request({ payload: {} }, ctx);
		request({ payload: null }, ctx);
		expect(messageEnd({ message: tierError }, ctx)).toBeUndefined();

		request({ payload: {} }, ctx);
		sessionStart({}, ctx);
		expect(messageEnd({ message: tierError }, ctx)).toBeUndefined();

		request({ payload: {} }, ctx);
		await command.handler("", ctx);
		expect(messageEnd({ message: tierError }, ctx)).toBeDefined();
		expect(request({ payload: {} }, ctx)).toBeUndefined();
		expect(messageEnd({ message: tierError }, ctx)).toBeUndefined();
		expect(loadPersistedEnabled()).toBe(false);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("normalizes shortcut settings", () => {
	expect(normalizeShortcutSetting(undefined)).toEqual([DEFAULT_SHORTCUT]);
	expect(normalizeShortcutSetting([DEFAULT_SHORTCUT])).toEqual([
		DEFAULT_SHORTCUT,
	]);
	expect(normalizeShortcutSetting(` ${DEFAULT_SHORTCUT} `)).toEqual([
		DEFAULT_SHORTCUT,
	]);
	expect(RESERVED_SHORTCUTS.has("ctrl+m")).toBe(true);
	expect(normalizeShortcutSetting(["ctrl+m", "", "ctrl+alt+m"])).toEqual([
		"ctrl+alt+m",
	]);
	expect(normalizeShortcutSetting(["ctrl+m"])).toEqual([]);
	expect(normalizeShortcutSetting([])).toEqual([]);
	expect(normalizeShortcutSetting("ctrl+m")).toEqual([DEFAULT_SHORTCUT]);
	expect(normalizeShortcutSetting("enter")).toEqual([DEFAULT_SHORTCUT]);
	expect(normalizeShortcutSetting(false)).toEqual([]);
	expect(normalizeShortcutSetting(null)).toEqual([]);
});

test("resolves Pi config file paths from env, XDG, then default", () => {
	expect(
		resolvePiFilePath("settings.json", {
			env: { PI_CODING_AGENT_DIR: "~/pi-env" },
			home: "/home/test",
		}),
	).toBe("/home/test/pi-env/settings.json");
	expect(
		resolveKeybindingsPath({
			env: { PI_CODING_AGENT_DIR: "~/pi-env" },
			home: "/home/test",
		}),
	).toBe("/home/test/pi-env/keybindings.json");

	expect(
		resolveSettingsPath({
			env: { XDG_CONFIG_HOME: "/xdg" },
			home: "/home/test",
			exists: (path) => path === "/xdg/pi/agent/settings.json",
		}),
	).toBe("/xdg/pi/agent/settings.json");

	expect(
		resolveSettingsPath({ env: {}, home: "/home/test", exists: () => false }),
	).toBe("/home/test/.pi/agent/settings.json");
});

test("persists the last explicitly toggled state", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-gpt-fast-mode-state-"));
	const envDir = join(tempDir, "agent");
	const options = { env: { PI_CODING_AGENT_DIR: envDir }, home: tempDir };

	try {
		expect(resolveStatePath(options)).toBe(join(envDir, STATE_FILE_NAME));
		expect(loadPersistedEnabled(options)).toBeUndefined();

		mkdirSync(envDir, { recursive: true });
		writeFileSync(
			join(envDir, "settings.json"),
			JSON.stringify({ [CONFIG_FIELD]: { enabled: true } }),
			"utf8",
		);
		expect(loadEnabled(options)).toBe(true);

		await savePersistedEnabled(false, options);
		expect(loadPersistedEnabled(options)).toBe(false);
		expect(loadEnabled(options)).toBe(false);

		await savePersistedEnabled(true, options);
		expect(loadPersistedEnabled(options)).toBe(true);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("loads configured shortcuts and toggles persisted payload patching", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-gpt-fast-mode-"));

	try {
		const envDir = join(tempDir, "agent");
		mkdirSync(envDir, { recursive: true });
		writeFileSync(
			join(envDir, "keybindings.json"),
			JSON.stringify({ [KEYBINDING_FIELD]: ["ctrl+alt+m"] }),
			"utf8",
		);
		writeFileSync(
			join(envDir, "settings.json"),
			JSON.stringify({ [CONFIG_FIELD]: { enabled: true } }),
			"utf8",
		);

		expect(
			loadShortcuts({ env: { PI_CODING_AGENT_DIR: envDir }, home: tempDir }),
		).toEqual(["ctrl+alt+m"]);
		expect(
			loadShortcuts({
				env: { PI_CODING_AGENT_DIR: join(tempDir, "missing") },
				home: tempDir,
			}),
		).toEqual([DEFAULT_SHORTCUT]);
		expect(
			loadDefaultEnabled({
				env: { PI_CODING_AGENT_DIR: envDir },
				home: tempDir,
			}),
		).toBe(true);
		writeFileSync(
			join(envDir, "settings.json"),
			JSON.stringify({ [CONFIG_FIELD]: { enabled: false } }),
			"utf8",
		);
		expect(
			loadDefaultEnabled({
				env: { PI_CODING_AGENT_DIR: envDir },
				home: tempDir,
			}),
		).toBe(false);
		writeFileSync(
			join(envDir, "settings.json"),
			JSON.stringify({ [CONFIG_FIELD]: { enabled: true } }),
			"utf8",
		);
		expect(
			loadDefaultEnabled({
				env: { PI_CODING_AGENT_DIR: join(tempDir, "missing") },
				home: tempDir,
			}),
		).toBe(false);

		process.env.PI_CODING_AGENT_DIR = envDir;
		delete process.env.XDG_CONFIG_HOME;

		const pi = createMockPi();
		fastModeExtension(pi as unknown as Parameters<typeof fastModeExtension>[0]);

		expect(pi.commands.has("fast")).toBe(true);
		expect(pi.shortcuts.has("ctrl+alt+m")).toBe(true);
		expect(pi.handlers.has("before_provider_request")).toBe(true);
		expect(pi.handlers.has("message_end")).toBe(true);
		expect(pi.handlers.has("session_start")).toBe(true);

		const ctx = createCtx();
		const payloadHook = requireValue(
			pi.handlers.get("before_provider_request"),
			"provider request handler",
		);
		const sessionStart = requireValue(
			pi.handlers.get("session_start"),
			"session start handler",
		);
		const fastCommand = requireValue(pi.commands.get("fast"), "fast command");
		const fastShortcut = requireValue(
			pi.shortcuts.get("ctrl+alt+m"),
			"fast shortcut",
		);

		sessionStart({}, ctx);
		expect(ctx.statuses.get(STATUS_KEY)).toContain("fast");
		expect(
			payloadHook({ payload: { model: TARGET_MODEL, store: false } }, ctx),
		).toEqual({
			model: TARGET_MODEL,
			store: false,
			service_tier: FAST_SERVICE_TIER,
		});

		await fastCommand.handler("", ctx);
		expect(ctx.notifications.at(-1)?.message).toMatch(/disabled/);
		expect(ctx.statuses.has(STATUS_KEY)).toBe(false);
		expect(loadPersistedEnabled()).toBe(false);
		expect(
			payloadHook({ payload: { model: TARGET_MODEL } }, ctx),
		).toBeUndefined();

		sessionStart({}, ctx);
		expect(
			payloadHook({ payload: { model: TARGET_MODEL } }, ctx),
		).toBeUndefined();

		const restoredPi = createMockPi();
		fastModeExtension(
			restoredPi as unknown as Parameters<typeof fastModeExtension>[0],
		);
		const restoredPayloadHook = requireValue(
			restoredPi.handlers.get("before_provider_request"),
			"restored provider request handler",
		);
		expect(
			restoredPayloadHook({ payload: { model: TARGET_MODEL } }, ctx),
		).toBeUndefined();

		await fastCommand.handler("", ctx);
		expect(ctx.notifications.at(-1)?.message).toMatch(/enabled/);
		expect(
			payloadHook({ payload: { model: TARGET_MODEL, store: false } }, ctx),
		).toEqual({
			model: TARGET_MODEL,
			store: false,
			service_tier: FAST_SERVICE_TIER,
		});

		const otherCtx = createCtx({
			provider: "another-provider",
			id: "another-model",
		});
		await fastCommand.handler("", ctx);
		await fastShortcut.handler(otherCtx);
		expect(
			payloadHook({ payload: { model: otherCtx.model.id } }, otherCtx),
		).toEqual({
			model: otherCtx.model.id,
			service_tier: FAST_SERVICE_TIER,
		});
		expect(otherCtx.notifications.at(-1)?.level).toBe("info");
		expect(otherCtx.statuses.get(STATUS_KEY)).toContain("fast");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
