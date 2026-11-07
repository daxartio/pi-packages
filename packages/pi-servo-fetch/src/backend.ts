import { type ChildProcessByStdio, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { FetchOptions, MappedUrl } from "servo-fetch";
import type { ServoBackend } from "./client.js";

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

function common(options: FetchOptions) {
	return {
		timeout: options.timeout,
		settleMs: options.settle,
		userAgent: options.userAgent,
		cookiesFile: options.cookiesFile && resolve(options.cookiesFile),
		headers: options.headers,
	};
}

function setReferenced(handle: object, active: boolean): void {
	const method: unknown = Reflect.get(handle, active ? "ref" : "unref");
	if (typeof method === "function") method.call(handle);
}

async function startProcess(binary: string) {
	const directory = await mkdtemp(join(tmpdir(), "pi-servo-fetch-runtime-"));
	let child: ChildProcessByStdio<Writable, Readable, null>;
	try {
		child = spawn(binary, ["--quiet", "rpc"], {
			cwd: directory,
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
		});
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	const pending = new Map<number, PendingRequest>();
	let nextId = 0;
	let failure: Error | undefined;
	let shuttingDown = false;
	const updateReferences = () => {
		for (const handle of [child, child.stdin, child.stdout]) {
			setReferenced(handle, pending.size > 0 || shuttingDown);
		}
	};
	const fail = (error: Error) => {
		failure ??= error;
		for (const request of pending.values()) request.reject(error);
		pending.clear();
		updateReferences();
	};
	const onExit = () => {
		child.kill("SIGKILL");
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			console.warn(
				"Could not remove Servo temporary storage during process exit",
			);
		}
	};
	process.once("exit", onExit);
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		try {
			const message: unknown = JSON.parse(line);
			if (!message || typeof message !== "object" || !("id" in message)) return;
			if (typeof message.id !== "number") return;
			const request = pending.get(message.id);
			if (!request) return;
			pending.delete(message.id);
			updateReferences();
			if ("error" in message) {
				const error = message.error;
				request.reject(
					new Error(
						error &&
							typeof error === "object" &&
							"message" in error &&
							typeof error.message === "string"
							? error.message
							: "Servo RPC request failed",
					),
				);
			} else if ("result" in message) request.resolve(message.result);
			else request.reject(new Error("Invalid Servo RPC response"));
		} catch {
			fail(new Error("Invalid Servo RPC response"));
			child.kill();
		}
	});
	child.on("error", fail);
	const onPipeError = (error: Error) => {
		fail(error);
		child.kill();
	};
	child.stdin.on("error", onPipeError);
	child.stdout.on("error", onPipeError);
	const closed = new Promise<void>((resolveClosed, rejectClosed) => {
		child.once("exit", () => fail(new Error("Servo process exited")));
		child.once("close", () => {
			fail(new Error("Servo process closed"));
			lines.close();
			void rm(directory, { recursive: true, force: true }).then(() => {
				process.removeListener("exit", onExit);
				process.removeListener("beforeExit", onBeforeExit);
				resolveClosed();
			}, rejectClosed);
		});
	});
	let stopping: Promise<void> | undefined;
	function stop(): Promise<void> {
		stopping ??= (async () => {
			shuttingDown = true;
			fail(new Error("Servo client was reset; retry the request"));
			child.stdin.end();
			const terminate = setTimeout(() => child.kill("SIGTERM"), 1000);
			const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
			try {
				await closed;
			} finally {
				clearTimeout(terminate);
				clearTimeout(kill);
			}
		})();
		return stopping;
	}
	const onBeforeExit = () => {
		void stop().catch(() => {
			console.warn("Could not clean up Servo temporary storage");
		});
	};
	process.once("beforeExit", onBeforeExit);
	updateReferences();
	return {
		closed,
		request(
			method: string,
			params: object,
			signal?: AbortSignal,
		): Promise<unknown> {
			if (failure) return Promise.reject(failure);
			if (signal?.aborted) return Promise.reject(signal.reason);
			const id = ++nextId;
			return new Promise((resolveRequest, rejectRequest) => {
				const onAbort = () => {
					pending.delete(id);
					updateReferences();
					child.stdin.write(
						`${JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } })}\n`,
					);
					rejectRequest(signal?.reason);
				};
				const finish = () => signal?.removeEventListener("abort", onAbort);
				pending.set(id, {
					resolve(value) {
						finish();
						resolveRequest(value);
					},
					reject(error) {
						finish();
						rejectRequest(error);
					},
				});
				signal?.addEventListener("abort", onAbort, { once: true });
				updateReferences();
				child.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
				);
			});
		},
		stop,
	};
}

export async function loadBackend(): Promise<ServoBackend> {
	const { binaryPath } = await import("servo-fetch");
	return createBackend(binaryPath());
}

export function createBackend(binary: string): ServoBackend {
	const absoluteBinary = isAbsolute(binary) ? binary : resolve(binary);
	let runtime: ReturnType<typeof startProcess> | undefined;
	const getRuntime = () => {
		if (!runtime) {
			const starting = startProcess(absoluteBinary);
			runtime = starting;
			void starting
				.then(
					(process) =>
						process.closed.then(() => {
							if (runtime === starting) runtime = undefined;
						}),
					() => {
						if (runtime === starting) runtime = undefined;
					},
				)
				.catch(() => {
					console.warn("Could not clean up Servo temporary storage");
				});
		}
		return runtime;
	};
	return {
		async evaluate(url, expression, options = {}) {
			const result = await (await getRuntime()).request(
				"evaluate",
				{ url, expression, ...common(options) },
				options.signal,
			);
			if (
				!result ||
				typeof result !== "object" ||
				!("result" in result) ||
				typeof result.result !== "string"
			)
				throw new Error("Invalid Servo evaluate response");
			return result.result;
		},
		async screenshot(url, options = {}) {
			const result = await (await getRuntime()).request(
				"screenshot",
				{ url, fullPage: options.fullPage, ...common(options) },
				options.signal,
			);
			if (typeof result !== "string")
				throw new Error("Invalid Servo screenshot response");
			return Buffer.from(result, "base64");
		},
		async map(url, options = {}) {
			const { signal, include, exclude, ...discovery } = options;
			const result = await (await getRuntime()).request(
				"map",
				{
					url,
					...discovery,
					include: typeof include === "string" ? [include] : include,
					exclude: typeof exclude === "string" ? [exclude] : exclude,
				},
				signal,
			);
			if (
				!Array.isArray(result) ||
				!result.every(
					(entry: unknown): entry is MappedUrl =>
						entry !== null &&
						typeof entry === "object" &&
						"url" in entry &&
						typeof entry.url === "string",
				)
			)
				throw new Error("Invalid Servo map response");
			return result;
		},
		async shutdown() {
			const pendingRuntime = runtime;
			runtime = undefined;
			if (pendingRuntime) await (await pendingRuntime).stop();
		},
	};
}
