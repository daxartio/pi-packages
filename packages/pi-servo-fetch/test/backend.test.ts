import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
	chmod,
	copyFile,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createBackend } from "../src/backend.js";

const url = "https://example.com";

async function harness() {
	const directory = await mkdtemp(join(tmpdir(), "pi-servo-fetch-test-"));
	const binary = join(directory, "servo-rpc");
	await copyFile(
		fileURLToPath(new URL("fixtures/servo-rpc.mjs", import.meta.url)),
		binary,
	);
	await chmod(binary, 0o700);
	const backend = createBackend(binary);
	return {
		backend,
		binary,
		async cleanup() {
			await backend.shutdown();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

async function runtimeDirectory(
	backend: ReturnType<typeof createBackend>,
	expression = "cwd",
) {
	const response: { cwd: string } = JSON.parse(
		await backend.evaluate(url, expression),
	);
	return response.cwd;
}

async function waitForFile(path: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "ENOENT"
			)
				throw error;
			await delay(10);
		}
	}
	throw new Error("Timed out waiting for fixture file");
}

test("Servo runs in a private tmp directory and removes bottles after graceful process exit", async () => {
	const runtime = await harness();
	const cwd = process.cwd();
	const originalEntries = await readdir(cwd);
	try {
		const directory = await runtimeDirectory(runtime.backend, "delay-shutdown");
		expect(dirname(directory)).toBe(await realpath(tmpdir()));
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect(await readdir(join(directory, "bottles"))).toEqual(["indexeddb"]);
		expect(process.cwd()).toBe(cwd);
		expect(await readdir(cwd)).toEqual(originalEntries);
		await runtime.backend.shutdown();
		await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await runtime.cleanup();
	}
});

test("concurrent calls share a runtime while independent backends isolate storage", async () => {
	const first = await harness();
	const second = await harness();
	try {
		const [firstDirectory, sharedDirectory, secondDirectory] =
			await Promise.all([
				runtimeDirectory(first.backend),
				runtimeDirectory(first.backend),
				runtimeDirectory(second.backend),
			]);
		expect(firstDirectory).toBe(sharedDirectory);
		expect(firstDirectory).not.toBe(secondDirectory);
		await first.backend.shutdown();
		await expect(stat(firstDirectory)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await stat(secondDirectory)).toBeDefined();
		const restartedDirectory = await runtimeDirectory(first.backend);
		expect(restartedDirectory).not.toBe(firstDirectory);
		await first.backend.shutdown();
		await expect(stat(restartedDirectory)).rejects.toMatchObject({
			code: "ENOENT",
		});
	} finally {
		await Promise.all([first.cleanup(), second.cleanup()]);
	}
});

async function waitForRemoval(path: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			await stat(path);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return;
			throw error;
		}
		await delay(10);
	}
	throw new Error("Timed out waiting for Servo storage cleanup");
}

test("process crashes reject pending requests and clean their temporary storage", async () => {
	const runtime = await harness();
	try {
		const directory = await runtimeDirectory(runtime.backend);
		await expect(runtime.backend.evaluate(url, "crash")).rejects.toThrow(
			"Servo process",
		);
		await waitForRemoval(directory);
		await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await runtime.cleanup();
	}
});

test("shutdown rejects active requests and removes their storage before completing", async () => {
	const runtime = await harness();
	try {
		const directory = await runtimeDirectory(runtime.backend);
		const request = runtime.backend
			.evaluate(url, "hold")
			.catch((error: unknown) => error);
		await waitForFile(join(directory, "hold-started"));
		await runtime.backend.shutdown();
		expect(await request).toMatchObject({
			message: "Servo client was reset; retry the request",
		});
		await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await runtime.cleanup();
	}
});

test("shutdown kills an uncooperative process before removing its storage", async () => {
	const runtime = await harness();
	try {
		const directory = await runtimeDirectory(
			runtime.backend,
			"ignore-shutdown",
		);
		await runtime.backend.shutdown();
		await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await runtime.cleanup();
	}
});

test("RPC options, screenshots and cancellation retain their behavior", async () => {
	const runtime = await harness();
	try {
		const response = JSON.parse(
			await runtime.backend.evaluate(url, "cwd", { timeout: 5, settle: 10 }),
		);
		expect(response.params).toMatchObject({
			url,
			expression: "cwd",
			timeout: 5,
			settleMs: 10,
		});
		expect(await runtime.backend.map(url, { include: ["/**"] })).toEqual([
			{ url },
		]);
		expect(await runtime.backend.screenshot(url)).toEqual(
			Buffer.from("fixture PNG"),
		);
		const controller = new AbortController();
		const request = runtime.backend.evaluate(url, "hold", {
			signal: controller.signal,
		});
		const requestId = Number(
			await waitForFile(join(response.cwd, "hold-started")),
		);
		controller.abort(new Error("cancelled"));
		await expect(request).rejects.toThrow("cancelled");
		expect(
			JSON.parse(await waitForFile(join(response.cwd, "cancelled-request"))),
		).toEqual({ id: requestId });
		expect(await runtimeDirectory(runtime.backend)).toBe(response.cwd);
	} finally {
		await runtime.cleanup();
	}
});

test("natural host exit shuts down idle Servo and removes storage without explicit shutdown", async () => {
	const runtime = await harness();
	try {
		const backendUrl = new URL("../src/backend.ts", import.meta.url).href;
		const script = `import { createBackend } from ${JSON.stringify(backendUrl)};
			const backend = createBackend(${JSON.stringify(runtime.binary)});
			console.log(JSON.parse(await backend.evaluate(${JSON.stringify(url)}, "delay-shutdown")).cwd);`;
		const { stdout } = await promisify(execFile)(
			"node",
			["--import", "tsx", "--input-type=module", "-e", script],
			{ timeout: 4000 },
		);
		await expect(stat(stdout.trim())).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await runtime.cleanup();
	}
});

test("failed binary startup rejects requests and still allows shutdown", async () => {
	const originalDirectories = (await readdir(tmpdir())).filter((entry) =>
		entry.startsWith("pi-servo-fetch-runtime-"),
	);
	const runtime = createBackend(
		join(tmpdir(), "nonexistent-pi-servo-fetch-binary"),
	);
	try {
		await expect(runtime.evaluate(url, "cwd")).rejects.toThrow("ENOENT");
	} finally {
		await runtime.shutdown();
	}
	expect(
		(await readdir(tmpdir())).filter((entry) =>
			entry.startsWith("pi-servo-fetch-runtime-"),
		),
	).toEqual(originalDirectories);
});
