import { test } from "bun:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionUIContext,
	getAgentDir,
	initTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Terminal,
	type TUI,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
// Pi exports this class only as a type at its public entrypoint in 0.87.1.
import { KeybindingsManager } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
	clearSessionHistory,
	invalidateSnapshot,
	registerBtwCommand,
} from "../src/btw.js";
import { BtwOverlayController } from "../src/btw-ui.js";

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Timed out waiting for /btw harness");
		await setImmediate();
	}
}

function messageTexts(messages: TranscriptContext["messages"]): string[] {
	// Pi's runtime normalizes the legacy systemPrompt into a system message.
	return messages
		.filter((message) => message.role !== "system")
		.map((message) => {
			if (typeof message.content === "string") return message.content;
			return message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		});
}

async function createHarness() {
	const calls: Array<{
		context: TranscriptContext;
		signal: SimpleStreamOptions["signal"];
		finish: (text: string) => void;
	}> = [];
	let holdResponses = false;
	const modelRuntime = await ModelRuntime.create({
		allowModelNetwork: false,
		refreshOnCreate: false,
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
	});
	modelRuntime.registerProvider("btw-command-test", {
		api: "btw-command-test-api",
		apiKey: "synthetic-test-only-key",
		baseUrl: "http://btw-test.invalid",
		models: [
			{
				id: "side-chat",
				name: "Synthetic BTW test model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 1_000,
			},
		],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			let finished = false;
			const finish = (text: string) => {
				assert.equal(finished, false, "Synthetic response completed twice");
				finished = true;
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 10,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 11,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			};
			calls.push({ context, signal: options?.signal, finish });
			if (!holdResponses) {
				const answer = `Synthetic answer ${calls.length}`;
				queueMicrotask(() => finish(answer));
			}
			return stream;
		},
	});
	const model = modelRuntime.getModel("btw-command-test", "side-chat");
	assert.ok(model);
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		noContextFiles: true,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [registerBtwCommand],
	});
	await loader.reload();
	const sessionManager = SessionManager.inMemory(process.cwd());
	sessionManager.appendMessage({
		role: "user",
		content: "Main conversation context",
		timestamp: 1,
	});
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		model,
		modelRuntime,
		noTools: "builtin",
		resourceLoader: loader,
		sessionManager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
		}),
	});
	const mainEntries = structuredClone(sessionManager.getEntries());
	const mainMessages = structuredClone(session.agent.state.messages);
	const runner = session.extensionRunner;
	initTheme("dark", false);
	const terminal: Terminal = {
		columns: 120,
		rows: 60,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
	};
	const tui = new TuiMainScreen(terminal);
	let renders = 0;
	tui.requestRender = () => {
		renders += 1;
	};
	let active: BtwOverlayController | undefined;
	function getActiveOverlay(): BtwOverlayController {
		assert.ok(active);
		return active;
	}
	const overlayOptions: Array<Parameters<ExtensionUIContext["custom"]>[1]> = [];
	const notifications: string[] = [];
	const ui: ExtensionUIContext = {
		...runner.getUIContext(),
		notify(message) {
			notifications.push(message);
		},
		custom<T>(
			factory: (
				tui: TUI,
				theme: ExtensionUIContext["theme"],
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) =>
				| (Component & { dispose?(): void })
				| Promise<Component & { dispose?(): void }>,
			options: Parameters<ExtensionUIContext["custom"]>[1],
		) {
			overlayOptions.push(options);
			return new Promise<T>((resolve, reject) => {
				Promise.resolve(
					factory(tui, ui.theme, new KeybindingsManager(), resolve),
				)
					.then((component) => {
						assert.ok(component instanceof BtwOverlayController);
						active = component;
					})
					.catch(reject);
			});
		},
	};
	runner.setUIContext(ui, "tui");
	const command = runner.getCommand("btw");
	assert.ok(
		command,
		"/btw must be registered through the real extension runner",
	);
	const ctx = runner.createCommandContext();

	return {
		calls,
		overlayOptions,
		notifications,
		sessionManager,
		set holdResponses(value: boolean) {
			holdResponses = value;
		},
		get renders() {
			return renders;
		},
		async open(args = "") {
			active = undefined;
			let closed = false;
			const finished = command.handler(args, ctx).then(() => {
				closed = true;
			});
			await waitUntil(() => active !== undefined);
			const overlay = getActiveOverlay();
			return {
				overlay,
				finished,
				get closed() {
					return closed;
				},
				text: () => stripVTControlCharacters(overlay.render(120).join("\n")),
				async close() {
					overlay.handleInput("\x1b");
					await finished;
				},
			};
		},
		assertMainUnchanged() {
			assert.deepEqual(sessionManager.getEntries(), mainEntries);
			assert.deepEqual(session.agent.state.messages, mainMessages);
			assert.deepEqual(notifications, []);
		},
		dispose() {
			active?.handleInput("\x1b");
			clearSessionHistory(ctx);
			invalidateSnapshot(ctx);
			session.dispose();
		},
	};
}

test("/btw without args opens an idle overlay without calling the model", async () => {
	const harness = await createHarness();
	try {
		for (const args of ["", "   "]) {
			const chat = await harness.open(args);
			assert.match(chat.text(), /Ask a side question/);
			assert.match(chat.text(), /Messages stay here/);
			assert.equal(chat.closed, false);
			await setImmediate();
			assert.equal(harness.calls.length, 0);
			assert.equal(harness.overlayOptions.at(-1)?.overlay, true);
			await chat.close();
		}
		harness.assertMainUnchanged();
	} finally {
		harness.dispose();
	}
});

test("/btw <question> trims and automatically submits the initial question", async () => {
	const harness = await createHarness();
	try {
		const chat = await harness.open("  Explain the main context  ");
		await waitUntil(() => chat.text().includes("Synthetic answer 1"));
		assert.equal(harness.calls.length, 1);
		assert.deepEqual(messageTexts(harness.calls[0].context.messages), [
			"Main conversation context",
			"Explain the main context",
		]);
		assert.equal(harness.calls[0].context.messages[0]?.role, "system");
		assert.equal(chat.closed, false);
		harness.assertMainUnchanged();
		await chat.close();
	} finally {
		harness.dispose();
	}
});

test("/btw threads multiple turns, restores history on reopen, and isolates sessions", async () => {
	const harness = await createHarness();
	try {
		const chat = await harness.open();
		chat.overlay.handleInput("First side question");
		chat.overlay.handleInput("\r");
		await waitUntil(() => chat.text().includes("Synthetic answer 1"));
		chat.overlay.handleInput("Follow up");
		chat.overlay.handleInput("\r");
		await waitUntil(() => chat.text().includes("Synthetic answer 2"));
		assert.deepEqual(messageTexts(harness.calls[1].context.messages), [
			"Main conversation context",
			"First side question",
			"Synthetic answer 1",
			"Follow up",
		]);
		await chat.close();
		const reopened = await harness.open();
		assert.match(reopened.text(), /First side question/);
		assert.match(reopened.text(), /Synthetic answer 2/);
		assert.equal(harness.calls.length, 2);
		await reopened.overlay.submit("Third side question");
		assert.deepEqual(messageTexts(harness.calls[2].context.messages), [
			"Main conversation context",
			"First side question",
			"Synthetic answer 1",
			"Follow up",
			"Synthetic answer 2",
			"Third side question",
		]);
		await reopened.close();
		harness.assertMainUnchanged();
		const other = await createHarness();
		try {
			assert.notEqual(
				other.sessionManager.getSessionId(),
				harness.sessionManager.getSessionId(),
			);
			const isolated = await other.open();
			assert.doesNotMatch(
				isolated.text(),
				/First side question|Synthetic answer/,
			);
			await isolated.overlay.submit("Other session question");
			assert.deepEqual(messageTexts(other.calls[0].context.messages), [
				"Main conversation context",
				"Other session question",
			]);
			other.assertMainUnchanged();
			await isolated.close();
		} finally {
			other.dispose();
		}
	} finally {
		harness.dispose();
	}
});

test("Ctrl+L clears both the visible and persisted /btw history", async () => {
	const harness = await createHarness();
	try {
		const chat = await harness.open("Forget this question");
		await waitUntil(() => chat.text().includes("Synthetic answer 1"));
		chat.overlay.handleInput("\x0c");
		assert.doesNotMatch(chat.text(), /Forget this question|Synthetic answer 1/);
		assert.match(chat.text(), /Messages stay here/);
		assert.equal(harness.calls.length, 1);
		await chat.close();
		const reopened = await harness.open();
		assert.doesNotMatch(
			reopened.text(),
			/Forget this question|Synthetic answer 1/,
		);
		await reopened.overlay.submit("Fresh question");
		assert.deepEqual(messageTexts(harness.calls[1].context.messages), [
			"Main conversation context",
			"Fresh question",
		]);
		harness.assertMainUnchanged();
		await reopened.close();
	} finally {
		harness.dispose();
	}
});

test("Esc closes promptly, aborts the side request, and ignores a late successful response", async () => {
	const harness = await createHarness();
	try {
		harness.holdResponses = true;
		const chat = await harness.open();
		// Retain submit's promise so the test observes the late completion itself.
		const pending = chat.overlay.submit("Cancelled question");
		await waitUntil(() => harness.calls.length === 1);
		const call = harness.calls[0];
		assert.ok(call.signal);
		assert.equal(call.signal.aborted, false);
		assert.match(chat.text(), /Waiting/);
		chat.overlay.handleInput("\x1b");
		assert.equal(call.signal.aborted, true);
		// This must finish BEFORE releasing the model stream, not after it.
		await waitUntil(() => chat.closed);
		await chat.finished;
		const reopened = await harness.open();
		const rendersBeforeLateResponse = harness.renders;
		// The synthetic provider intentionally ignores abort and returns success.
		call.finish("Late answer must not be stored");
		await pending;
		assert.equal(harness.renders, rendersBeforeLateResponse);
		assert.doesNotMatch(reopened.text(), /Cancelled question|Late answer/);
		await reopened.close();
		const afterLateResponse = await harness.open();
		assert.doesNotMatch(
			afterLateResponse.text(),
			/Cancelled question|Late answer/,
		);
		harness.holdResponses = false;
		await afterLateResponse.overlay.submit("Uncancelled question");
		assert.deepEqual(messageTexts(harness.calls[1].context.messages), [
			"Main conversation context",
			"Uncancelled question",
		]);
		harness.assertMainUnchanged();
		await afterLateResponse.close();
	} finally {
		harness.dispose();
	}
});
