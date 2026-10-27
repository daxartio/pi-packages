import { expect, spyOn, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	STATE_ENTRY,
	type StartupContext,
	StartupRuntime,
	type StartupState,
} from "../src/runtime.ts";

function harness() {
	const sessionManager = SessionManager.inMemory("/project");
	const notifications: string[] = [];
	const ctx: StartupContext = {
		cwd: "/project",
		hasUI: true,
		sessionManager,
		ui: {
			notify: (message) => {
				notifications.push(message);
			},
		},
	};
	const save = (state: StartupState) => {
		sessionManager.appendCustomEntry(STATE_ENTRY, structuredClone(state));
	};
	return { ctx, save, notifications, sessionManager };
}

test("single execution for concurrent initialization and subsequent inputs", async () => {
	const { ctx, save } = harness();
	let executions = 0;
	const runtime = new StartupRuntime(
		save,
		async () => ({ enabled: true, scripts: [] }),
		async () => {
			executions++;
			return { context: "inventory", errors: [] };
		},
	);
	const states = await Promise.all([
		runtime.ensure(ctx),
		runtime.ensure(ctx),
		runtime.ensure(ctx),
	]);
	expect(executions).toBe(1);
	expect(
		states.every((state) => state.context === "inventory" && !state.blocked),
	).toBe(true);
	await runtime.ensure(ctx);
	expect(executions).toBe(1);
});

test("resume and reload restore output without rerunning commands or loading config", async () => {
	const { ctx, save } = harness();
	await new StartupRuntime(
		save,
		async () => ({ enabled: true, scripts: [] }),
		async () => ({ context: "persisted", errors: [] }),
	).ensure(ctx);
	const resumed = new StartupRuntime(save, async () => {
		throw new Error("must not reload config");
	});
	expect(await resumed.ensure(ctx)).toMatchObject({
		context: "persisted",
		blocked: false,
	});
});

test("new sessions get independent execution", async () => {
	const first = harness();
	const second = harness();
	let executions = 0;
	const runtime = new StartupRuntime(
		() => {},
		async () => ({ enabled: true, scripts: [] }),
		async () => {
			executions++;
			return { context: "", errors: [] };
		},
	);
	await runtime.ensure(first.ctx);
	await runtime.ensure(second.ctx);
	expect(executions).toBe(2);
});

test("one combined error notification, explicit continue is persisted", async () => {
	const { ctx, save, notifications } = harness();
	const runtime = new StartupRuntime(
		save,
		async () => ({ enabled: true, scripts: [] }),
		async () => ({
			context: "successful output",
			errors: ["first failure", "second failure"],
		}),
	);
	const state = await runtime.ensure(ctx);
	expect(state.blocked).toBe(true);
	expect(notifications).toHaveLength(1);
	expect(notifications[0]).toContain("first failure\nsecond failure");
	await runtime.continue(ctx);
	expect(state.blocked).toBe(false);
	const resumed = new StartupRuntime(save);
	expect(await resumed.ensure(ctx)).toMatchObject({
		blocked: false,
		context: "successful output",
	});
});

test("configuration errors block without execution", async () => {
	const { ctx, save, notifications } = harness();
	let executed = false;
	const runtime = new StartupRuntime(
		save,
		async () => {
			throw new Error("invalid configuration");
		},
		async () => {
			executed = true;
			return { context: "", errors: [] };
		},
	);
	expect((await runtime.ensure(ctx)).blocked).toBe(true);
	expect(executed).toBe(false);
	expect(notifications[0]).toContain("invalid configuration");
	await runtime.continue(ctx);
	expect((await runtime.ensure(ctx)).blocked).toBe(false);
});

test("interrupted execution is not retried and requires explicit continue", async () => {
	const { ctx, save } = harness();
	save({ phase: "running", blocked: true, context: "", errors: [] });
	const runtime = new StartupRuntime(save, async () => {
		throw new Error("must not run");
	});
	const state = await runtime.ensure(ctx);
	expect(state.blocked).toBe(true);
	expect(state.errors).toEqual([
		"Previous startup execution was interrupted; commands were not rerun.",
	]);
	await runtime.continue(ctx);
	expect(state.blocked).toBe(false);
});

test("saved session-wide result survives branch navigation", async () => {
	const { ctx, save, sessionManager } = harness();
	const userEntry = sessionManager.appendMessage({
		role: "user",
		content: "hello",
		timestamp: Date.now(),
	});
	await new StartupRuntime(
		save,
		async () => ({ enabled: true, scripts: [] }),
		async () => ({ context: "session-wide", errors: [] }),
	).ensure(ctx);
	sessionManager.branch(userEntry);
	expect((await new StartupRuntime(save).ensure(ctx)).context).toBe(
		"session-wide",
	);
});

test("headless failures are visible on stderr, including after resume", async () => {
	const { ctx, save, notifications } = harness();
	ctx.hasUI = false;
	const stderr = spyOn(console, "error").mockImplementation(() => {});
	try {
		const runtime = new StartupRuntime(save, async () => {
			throw new Error("invalid configuration");
		});
		expect((await runtime.ensure(ctx)).blocked).toBe(true);
		expect(stderr).toHaveBeenCalledTimes(1);
		expect(stderr.mock.calls[0]?.[0]).toContain("invalid configuration");
		expect(notifications).toHaveLength(0);
		await new StartupRuntime(save).ensure(ctx);
		expect(stderr).toHaveBeenCalledTimes(2);
	} finally {
		stderr.mockRestore();
	}
});
