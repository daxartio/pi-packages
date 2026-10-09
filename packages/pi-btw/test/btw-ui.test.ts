import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type { BtwExecResult } from "../src/btw.js";
import {
	type BtwChatParams,
	BtwOverlayController,
	showBtwOverlay,
} from "../src/btw-ui.js";

function success(
	question: string,
	answer: string,
): Extract<BtwExecResult, { kind: "success" }> {
	return {
		kind: "success",
		answer,
		stopReason: "stop",
		userMessage: { role: "user", content: question, timestamp: 1 },
		assistantMessage: {
			role: "assistant",
			content: [{ type: "text", text: answer }],
			api: "openai-responses",
			provider: "openai",
			model: "test-only-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		},
	};
}

function harness(overrides: Partial<BtwChatParams> = {}, rows = 24) {
	const questions: string[] = [];
	const turns: BtwChatParams["history"] = [];
	let cleared = 0;
	let dismissed = 0;
	let renders = 0;
	const terminal = { rows };
	const params: BtwChatParams = {
		history: [],
		onSubmit: async (question) => {
			questions.push(question);
			return success(question, `Answer to ${question}`);
		},
		onTurn: (turn) => turns.push(turn),
		onClearHistory: () => {
			cleared++;
			turns.length = 0;
		},
		...overrides,
	};
	const controller = new BtwOverlayController(
		params,
		{ fg: (_color, text) => text, bg: (_color, text) => text },
		{
			terminal,
			requestRender: () => {
				renders++;
			},
		},
		() => {
			dismissed++;
		},
	);
	controller.focused = true;
	return {
		controller,
		terminal,
		questions,
		turns,
		cleared: () => cleared,
		dismissed: () => dismissed,
		renders: () => renders,
	};
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {
		throw new Error("Deferred not initialized");
	};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
}

function screen(controller: BtwOverlayController, width = 100): string {
	return controller.render(width).join("\n");
}

describe("BtwOverlayController", () => {
	test("opens with an editable input and does not call the model until Enter", async () => {
		const h = harness();
		expect(stripVTControlCharacters(screen(h.controller))).toContain(
			"Ask a side question",
		);
		expect(screen(h.controller)).toContain(CURSOR_MARKER);
		expect(h.questions).toEqual([]);
		h.controller.handleInput("  why x?  ");
		h.controller.handleInput("\r");
		await flush();
		expect(h.questions).toEqual(["why x?"]);
		expect(screen(h.controller)).toContain("Answer to why x?");
		expect(h.cleared()).toBe(0);
	});

	test("ignores blank submissions", async () => {
		const h = harness();
		h.controller.handleInput("   ");
		h.controller.handleInput("\r");
		await h.controller.submit("\n\t");
		expect(h.questions).toEqual([]);
		expect(h.turns).toEqual([]);
	});

	test("shows complete prior questions and answers and appends multiple turns", async () => {
		const prior = success("First question", "First answer");
		const history = [
			{
				userMessage: prior.userMessage,
				assistantMessage: prior.assistantMessage,
			},
		];
		const h = harness({ history });
		await h.controller.submit("Second question");
		await h.controller.submit("Third question");
		const output = screen(h.controller);
		for (const text of [
			"First question",
			"First answer",
			"Second question",
			"Answer to Second question",
			"Third question",
			"Answer to Third question",
		]) {
			expect(output).toContain(text);
		}
		expect(h.turns).toHaveLength(2);
		expect(history).toHaveLength(1);
	});

	test("keeps the next draft while pending and prevents parallel requests", async () => {
		const pending = deferred<BtwExecResult>();
		const questions: string[] = [];
		const h = harness({
			onSubmit: async (question) => {
				questions.push(question);
				return pending.promise;
			},
		});
		const first = h.controller.submit("first");
		h.controller.handleInput("next draft");
		h.controller.handleInput("\r");
		await h.controller.submit("duplicate");
		expect(questions).toEqual(["first"]);
		expect(screen(h.controller)).toContain("next draft");
		pending.resolve(success("first", "finished"));
		await first;
		expect(screen(h.controller)).toContain("next draft");
		h.controller.handleInput("\r");
		await flush();
		expect(questions).toEqual(["first", "next draft"]);
	});

	test("Esc closes immediately, aborts the side request and discards late success", async () => {
		const pending = deferred<BtwExecResult>();
		let signal: AbortSignal | undefined;
		const h = harness({
			onSubmit: async (_question, controller) => {
				signal = controller.signal;
				return pending.promise;
			},
		});
		const task = h.controller.submit("slow");
		h.controller.handleInput("\x1b");
		expect(h.dismissed()).toBe(1);
		expect(signal?.aborted).toBe(true);
		const renders = h.renders();
		pending.resolve(success("slow", "late answer"));
		await task;
		expect(h.turns).toEqual([]);
		expect(h.renders()).toBe(renders);
		await h.controller.submit("closed");
		h.controller.handleInput("\x1b");
		expect(h.dismissed()).toBe(1);
	});

	test("disposal aborts pending work even without an Escape key", async () => {
		const pending = deferred<BtwExecResult>();
		let signal: AbortSignal | undefined;
		const h = harness({
			onSubmit: async (_question, controller) => {
				signal = controller.signal;
				return pending.promise;
			},
		});
		const task = h.controller.submit("slow");
		h.controller.dispose();
		h.controller.dispose();
		expect(signal?.aborted).toBe(true);
		pending.resolve({ kind: "error", error: "late failure" });
		await task;
		expect(screen(h.controller)).not.toContain("late failure");
		expect(h.dismissed()).toBe(0);
	});

	test("shows errors without committing turns and allows another question", async () => {
		let attempts = 0;
		const h = harness({
			onSubmit: async (question) =>
				++attempts === 1
					? { kind: "error", error: "Synthetic failure" }
					: success(question, "Recovered"),
		});
		await h.controller.submit("fails");
		expect(screen(h.controller)).toContain("Synthetic failure");
		expect(h.turns).toHaveLength(0);
		await h.controller.submit("retry");
		expect(screen(h.controller)).not.toContain("Synthetic failure");
		expect(screen(h.controller)).toContain("Recovered");
		expect(h.turns).toHaveLength(1);
	});

	test("handles thrown executor failures and provider aborts", async () => {
		const h = harness({
			onSubmit: async () => {
				throw new Error("Synthetic exception");
			},
		});
		await h.controller.submit("fails");
		expect(screen(h.controller)).toContain("Synthetic exception");
		expect(h.turns).toHaveLength(0);
		const aborted = harness({
			onSubmit: async () => ({ kind: "aborted", stopReason: "aborted" }),
		});
		await aborted.controller.submit("aborted");
		expect(aborted.turns).toHaveLength(0);
		expect(screen(aborted.controller)).toContain("Enter to send");
	});

	test("clears visible and persisted history with Ctrl+L, keeping the input draft", async () => {
		const h = harness();
		await h.controller.submit("old question");
		h.controller.handleInput("draft x");
		h.controller.handleInput("\x0c");
		expect(h.cleared()).toBe(1);
		expect(h.turns).toEqual([]);
		expect(screen(h.controller)).not.toContain("old question");
		expect(screen(h.controller)).toContain("draft x");
	});

	test("does not clear history mid-request", async () => {
		const pending = deferred<BtwExecResult>();
		const h = harness({ onSubmit: async () => pending.promise });
		const task = h.controller.submit("pending");
		h.controller.handleInput("\x0c");
		expect(h.cleared()).toBe(0);
		pending.resolve(success("pending", "answer"));
		await task;
		expect(h.turns).toHaveLength(1);
	});

	test("scrolls older content upward while keeping header, input and footer visible", () => {
		const prior = success(
			"long question",
			Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n"),
		);
		const h = harness(
			{
				history: [
					{
						userMessage: prior.userMessage,
						assistantMessage: prior.assistantMessage,
					},
				],
			},
			16,
		);
		h.controller.handleInput("draft");
		const bottom = h.controller.render(100);
		expect(bottom).toHaveLength(13);
		expect(bottom.join("\n")).toContain("line-39");
		h.controller.handleInput("\x1b[A");
		const older = h.controller.render(100);
		expect(older[2]).not.toBe(bottom[2]);
		expect(older[0]).toBe(bottom[0]);
		expect(older.slice(-2)).toEqual(bottom.slice(-2));
		h.controller.handleInput("\x1b[B");
		expect(h.controller.render(100)).toEqual(bottom);
		h.controller.handleInput("\x1b[5~");
		expect(screen(h.controller)).not.toContain("line-39");
		h.controller.handleInput("\x1b[6~");
		expect(h.controller.render(100)).toEqual(bottom);
	});

	test("keeps layout within narrow and resized terminal dimensions", async () => {
		const h = harness();
		await h.controller.submit("A long question with unicode Привет");
		for (const rows of [2, 6, 10, 24]) {
			h.terminal.rows = rows;
			for (const width of [1, 2, 3, 6, 20, 100]) {
				const lines = h.controller.render(width);
				expect(lines.length).toBeLessThanOrEqual(
					Math.max(1, Math.floor(rows * 0.85)),
				);
				for (const line of lines)
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("forwards focus and resets trim notices between requests", async () => {
		let count = 0;
		const h = harness({
			onSubmit: async (question) => ({
				...success(question, "answer"),
				trimmed: count++ === 0,
			}),
		});
		await h.controller.submit("trimmed");
		expect(screen(h.controller)).toContain("context trimmed to fit budget");
		h.controller.focused = false;
		expect(screen(h.controller)).not.toContain(CURSOR_MARKER);
		h.controller.focused = true;
		expect(screen(h.controller)).toContain(CURSOR_MARKER);
		await h.controller.submit("untrimmed");
		expect(screen(h.controller)).not.toContain("context trimmed to fit budget");
	});
});

test("overlay setup failure propagates without waiting for a controller", async () => {
	const ctx = {
		ui: {
			custom: async () => {
				throw new Error("Synthetic UI setup failure");
			},
		},
	};
	await expect(
		showBtwOverlay({
			ctx,
			history: [],
			onSubmit: async () => ({ kind: "aborted", stopReason: "aborted" }),
			onTurn: () => {},
			onClearHistory: () => {},
		}),
	).rejects.toThrow("Synthetic UI setup failure");
});
