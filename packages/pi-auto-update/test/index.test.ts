import { afterEach, beforeEach, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import autoUpdateExtension from "../src/index.ts";

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
type StartupHandler = (
	event: { reason: string },
	ctx: ExtensionContext,
) => unknown;
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

function createHarness() {
	const handlers = new Map<string, StartupHandler>();
	const commands = new Map<string, CommandOptions>();
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses = new Map<string, string>();
	const executions: Array<{ command: string; args: string[] }> = [];
	const extensionsUpdate = Promise.withResolvers<ExecResult>();
	const piUpdate = Promise.withResolvers<ExecResult>();
	const pendingUpdates = [extensionsUpdate, piUpdate];
	const api = {
		on(event: string, handler: StartupHandler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, options: CommandOptions) {
			commands.set(name, options);
		},
		exec(command: string, args: string[]) {
			const pendingUpdate = pendingUpdates[executions.length];
			if (!pendingUpdate) throw new Error("Unexpected update execution");
			executions.push({ command, args });
			return pendingUpdate.promise;
		},
	};
	const context = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			setStatus(key: string, value: string | undefined) {
				if (value === undefined) statuses.delete(key);
				else statuses.set(key, value);
			},
			notify(message: string, level = "info") {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionCommandContext;

	autoUpdateExtension(api as unknown as ExtensionAPI);

	return {
		context,
		notifications,
		statuses,
		executions,
		extensionsUpdate,
		piUpdate,
		start(reason = "startup") {
			const handler = handlers.get("session_start");
			if (!handler) throw new Error("Missing session_start handler");
			return handler({ reason }, context);
		},
		manualUpdate() {
			const command = commands.get("auto-update-now");
			if (!command) throw new Error("Missing auto-update-now command");
			return command.handler("", context);
		},
	};
}

const successfulUpdate: ExecResult = {
	code: 0,
	stdout: "",
	stderr: "",
	killed: false,
};

let previousOffline: string | undefined;
let previousAutoUpdate: string | undefined;

beforeEach(() => {
	previousOffline = process.env.PI_OFFLINE;
	previousAutoUpdate = process.env.PI_AUTO_UPDATE;
	delete process.env.PI_OFFLINE;
	delete process.env.PI_AUTO_UPDATE;
});

afterEach(() => {
	if (previousOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = previousOffline;
	if (previousAutoUpdate === undefined) delete process.env.PI_AUTO_UPDATE;
	else process.env.PI_AUTO_UPDATE = previousAutoUpdate;
});

test("startup returns immediately while updates continue sequentially in the background", async () => {
	const harness = createHarness();

	expect(harness.start()).toBeUndefined();
	expect(harness.executions).toHaveLength(1);
	expect(harness.statuses.get("pi-auto-update")).toBe("Updating extensions...");
	expect(harness.notifications).toEqual([]);

	harness.extensionsUpdate.resolve(successfulUpdate);
	await Bun.sleep(0);
	expect(harness.executions).toHaveLength(2);
	expect(harness.executions[0]?.args.join(" ")).toContain(
		"update --extensions",
	);
	expect(harness.executions[1]?.args.join(" ")).toContain("update");
	expect(harness.statuses.get("pi-auto-update")).toBe("Updating Pi...");

	harness.piUpdate.resolve(successfulUpdate);
	await Bun.sleep(0);
	expect(harness.statuses.size).toBe(0);
	expect(harness.notifications).toEqual([
		{ message: "Pi extensions and Pi update checks completed", level: "info" },
	]);
});

test("manual command returns without waiting and shares an in-flight startup update", async () => {
	const harness = createHarness();
	harness.start();
	await harness.manualUpdate();
	expect(harness.executions).toHaveLength(1);

	harness.extensionsUpdate.resolve(successfulUpdate);
	harness.piUpdate.resolve(successfulUpdate);
	await Bun.sleep(0);
	expect(harness.executions).toHaveLength(2);
	expect(harness.notifications).toHaveLength(1);
});

test("manual command starts a background update when auto-update is disabled", async () => {
	process.env.PI_AUTO_UPDATE = "0";
	const harness = createHarness();
	harness.start();
	expect(harness.executions).toHaveLength(0);

	await harness.manualUpdate();
	expect(harness.executions).toHaveLength(1);
	harness.extensionsUpdate.resolve(successfulUpdate);
	harness.piUpdate.resolve(successfulUpdate);
	await Bun.sleep(0);
	expect(harness.executions).toHaveLength(2);
});

test("background execution failures are reported and do not stop the next update", async () => {
	const harness = createHarness();
	harness.start();
	harness.extensionsUpdate.reject(new Error("Update unavailable"));
	await Bun.sleep(0);
	expect(harness.executions).toHaveLength(2);

	harness.piUpdate.resolve({
		...successfulUpdate,
		code: 1,
		stderr: "Pi update failed",
	});
	await Bun.sleep(0);
	expect(harness.statuses.size).toBe(0);
	expect(harness.notifications).toEqual([
		{
			message:
				"Pi auto-update failed\nextensions: Update unavailable\nPi: exit 1 — Pi update failed",
			level: "warning",
		},
	]);
});

test("offline and non-startup sessions do not launch automatic updates", () => {
	const harness = createHarness();
	expect(harness.start("resume")).toBeUndefined();
	process.env.PI_OFFLINE = "1";
	expect(harness.start()).toBeUndefined();
	expect(harness.executions).toHaveLength(0);
});
