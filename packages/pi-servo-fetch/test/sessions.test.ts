import { expect, test } from "bun:test";
import type { SessionFetchOptions } from "servo-fetch";
import { type ServoBackend, ServoClient } from "../src/client.js";
import {
	type BrowserSession,
	BrowserSessions,
	MAX_SESSIONS,
} from "../src/sessions.js";

const url = "https://example.com";

class FakeSession implements BrowserSession {
	closed = false;
	closeCalls = 0;
	readonly requests: { url: string; options?: SessionFetchOptions }[] = [];

	async fetch(url: string, options?: SessionFetchOptions): Promise<string> {
		if (this.closed) throw new Error("Session is closed");
		options?.signal?.throwIfAborted();
		this.requests.push({ url, options });
		return `Request ${this.requests.length}`;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.closeCalls++;
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function harness(open?: ServoBackend["Session"]["open"]) {
	const sessions: FakeSession[] = [];
	const openOptions: ({ userAgent?: string } | undefined)[] = [];
	const events: string[] = [];
	let loads = 0;
	const unexpected = () => {
		throw new Error("Unexpected SDK operation");
	};
	const backend: ServoBackend = {
		map: unexpected,
		async evaluate(target, expression) {
			if (!expression.includes("const selector =")) return unexpected();
			return JSON.stringify({
				ok: true,
				html: "<h1>Stateless</h1>",
				title: "Stateless",
				url: target,
				baseUri: target,
				lang: "en",
				selected: true,
			});
		},
		screenshot: unexpected,
		shutdown() {
			events.push("shutdown");
		},
		Session: {
			open:
				open ??
				(async (options) => {
					openOptions.push(options);
					const session = new FakeSession();
					sessions.push(session);
					return session;
				}),
		},
	};
	const client = new ServoClient(
		async () => {
			loads++;
			return backend;
		},
		async () => ({ kind: "render" }),
	);
	return { client, backend, sessions, openOptions, events, loads: () => loads };
}

function text(result: Awaited<ReturnType<ServoClient["openSession"]>>): string {
	const content = result.content[0];
	if (content?.type !== "text") throw new Error("Expected text");
	return content.text;
}

async function open(client: ServoClient, userAgent?: string): Promise<string> {
	const result = JSON.parse(text(await client.openSession({ userAgent })));
	if (typeof result.sessionId !== "string")
		throw new Error("Expected session ID");
	return result.sessionId;
}

test("sessions are reused within a client and isolated from other sessions and clients", async () => {
	const first = harness();
	const second = harness();
	const sessionId = await open(first.client, "FixtureAgent/1.0");
	const otherId = await open(first.client);
	expect(sessionId).not.toBe(otherId);
	expect(first.openOptions).toEqual([{ userAgent: "FixtureAgent/1.0" }, {}]);
	expect(text(await first.client.sessionFetch({ url, sessionId }))).toBe(
		"Request 1",
	);
	expect(text(await first.client.sessionFetch({ url, sessionId }))).toBe(
		"Request 2",
	);
	expect(
		text(await first.client.sessionFetch({ url, sessionId: otherId })),
	).toBe("Request 1");
	expect(text(await first.client.fetch({ url }))).toBe("# Stateless");
	await expect(second.client.sessionFetch({ url, sessionId })).rejects.toThrow(
		"Unknown or closed",
	);
	expect(second.loads()).toBe(0);
	expect(JSON.parse(text(await first.client.listSessions({})))).toEqual({
		sessions: [
			{ sessionId, state: "open" },
			{ sessionId: otherId, state: "open" },
		],
	});
	await first.client.shutdown();
	await second.client.shutdown();
});

test("null userAgent uses the SDK default instead of creating a placeholder identity", async () => {
	const runtime = harness();
	await runtime.client.openSession({ userAgent: null });
	expect(runtime.openOptions).toEqual([{}]);
	await runtime.client.shutdown();
});

test("session fetch forwards extraction settings and cancellation", async () => {
	const runtime = harness();
	const sessionId = await open(runtime.client);
	const controller = new AbortController();
	await runtime.client.sessionFetch(
		{
			url,
			sessionId,
			timeout: 12,
			settle: 200,
			selector: "main",
			visibility: "strict",
		},
		controller.signal,
	);
	const request = runtime.sessions[0]?.requests[0];
	expect(request).toMatchObject({
		url,
		options: {
			timeout: 12,
			settle: 200,
			selector: "main",
			visibility: "strict",
		},
	});
	expect(request?.options?.signal?.aborted).toBe(false);
	controller.abort();
	expect(request?.options?.signal?.aborted).toBe(true);
	await runtime.client.shutdown();
});

test("session fetch has no format selector and rejects extraneous parameters", async () => {
	const runtime = harness();
	const sessionId = await open(runtime.client);
	for (const format of ["markdown", "html", "text", "json"] as const) {
		const invalid = { url, sessionId, format };
		await expect(runtime.client.sessionFetch(invalid)).rejects.toThrow(
			"Invalid servo-fetch parameters",
		);
	}
	expect(runtime.sessions[0]?.requests).toEqual([]);
	expect(text(await runtime.client.sessionFetch({ url, sessionId }))).toBe(
		"Request 1",
	);
	await runtime.client.shutdown();
});

test("listing and invalid session operations do not load the SDK", async () => {
	const runtime = harness();
	expect(JSON.parse(text(await runtime.client.listSessions()))).toEqual({
		sessions: [],
	});
	await expect(runtime.client.closeSession({ sessionId: "" })).rejects.toThrow(
		"Invalid servo-fetch parameters",
	);
	await expect(
		runtime.client.closeSession({
			sessionId: "00000000-0000-4000-8000-000000000000",
		}),
	).rejects.toThrow("servo_fetch_session_list");
	const invalidOpen = { userAgent: "FixtureAgent", sessionId: "semble-info" };
	await expect(runtime.client.openSession(invalidOpen)).rejects.toThrow(
		"Invalid servo-fetch parameters",
	);
	await expect(
		runtime.client.listSessions({ sessionId: "unexpected" }),
	).rejects.toThrow("Invalid servo-fetch parameters");
	await expect(
		runtime.client.listSessions({ userAgent: "Unexpected" }),
	).rejects.toThrow("Invalid servo-fetch parameters");
	await expect(
		runtime.client.openSession({ userAgent: "Invalid\r\nHeader" }),
	).rejects.toThrow("Invalid servo-fetch parameters");
	await expect(
		runtime.client.openSession({}, AbortSignal.abort(new Error("cancelled"))),
	).rejects.toThrow("cancelled");
	expect(runtime.loads()).toBe(0);
});

test("closing invalidates handles and releases the worker exactly once", async () => {
	const runtime = harness();
	const sessionId = await open(runtime.client);
	const result = await runtime.client.closeSession({ sessionId });
	expect(JSON.parse(text(result))).toEqual({ sessionId, closed: true });
	await expect(runtime.client.sessionFetch({ url, sessionId })).rejects.toThrow(
		"Unknown or closed",
	);
	await expect(runtime.client.closeSession({ sessionId })).rejects.toThrow(
		"Unknown or closed",
	);
	await runtime.client.shutdown();
	expect(runtime.sessions[0]?.closeCalls).toBe(1);
});

test("capacity is reserved before concurrent opens complete", async () => {
	const pending = deferred<BrowserSession>();
	const registry = new BrowserSessions();
	let creates = 0;
	const requests = Array.from({ length: MAX_SESSIONS }, () =>
		registry.open(async () => {
			creates++;
			return pending.promise;
		}),
	);
	await expect(registry.open(async () => new FakeSession())).rejects.toThrow(
		"At most 8",
	);
	expect(registry.list()).toHaveLength(MAX_SESSIONS);
	pending.reject(new Error("worker failed"));
	const results = await Promise.allSettled(requests);
	expect(creates).toBe(MAX_SESSIONS);
	expect(results.every((result) => result.status === "rejected")).toBe(true);
	expect(registry.list()).toEqual([]);
	const session = new FakeSession();
	const id = await registry.open(async () => session);
	await registry.close(id);
	expect(session.closeCalls).toBe(1);
});

test("aborting a pending open closes the worker when it arrives", async () => {
	const pending = deferred<BrowserSession>();
	const controller = new AbortController();
	const registry = new BrowserSessions();
	const request = registry.open(() => pending.promise, controller.signal);
	controller.abort(new Error("cancelled"));
	const session = new FakeSession();
	pending.resolve(session);
	await expect(request).rejects.toThrow("cancelled");
	expect(session.closeCalls).toBe(1);
	expect(registry.list()).toEqual([]);
});

test("clear cleans up pending opens, blocks new opens, and allows a fresh generation", async () => {
	const pending = deferred<BrowserSession>();
	const registry = new BrowserSessions();
	const request = registry.open(() => pending.promise);
	const clearing = registry.clear();
	await expect(registry.open(async () => new FakeSession())).rejects.toThrow(
		"being cleared",
	);
	const session = new FakeSession();
	pending.resolve(session);
	await expect(request).rejects.toThrow("Browser session closed");
	await clearing;
	expect(session.closeCalls).toBe(1);
	expect(registry.list()).toEqual([]);
	await registry.open(async () => new FakeSession());
	await registry.clear();
});

test("closing a session cancels in-flight fetches", async () => {
	const started = deferred<AbortSignal>();
	const registry = new BrowserSessions();
	const session: BrowserSession = {
		async fetch(_url, options) {
			const signal = options?.signal;
			if (!signal) throw new Error("Expected lifecycle cancellation signal");
			started.resolve(signal);
			await new Promise<void>((resolve) =>
				signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return "SDK returned after cancellation";
		},
		async close() {},
	};
	const sessionId = await registry.open(async () => session);
	const request = registry.fetch(sessionId, url, {});
	const signal = await started.promise;
	await registry.close(sessionId);
	expect(signal.aborted).toBe(true);
	await expect(request).rejects.toThrow("Browser session closed");
});

test("shutdown waits for pending opens, closes all sessions, then stops the backend", async () => {
	const pending = deferred<BrowserSession>();
	const started = deferred<void>();
	const runtime = harness(async () => {
		started.resolve();
		return pending.promise;
	});
	const opening = runtime.client.openSession({});
	await started.promise;
	const stopping = runtime.client.shutdown();
	await expect(runtime.client.openSession({})).rejects.toThrow("reset");
	const session = new FakeSession();
	pending.resolve(session);
	await expect(opening).rejects.toThrow("Browser session closed");
	await stopping;
	expect(session.closeCalls).toBe(1);
	expect(runtime.events).toEqual(["shutdown"]);
	expect(JSON.parse(text(await runtime.client.listSessions({})))).toEqual({
		sessions: [],
	});
});

test("shutdown closes every session and stops the engine even when one close fails", async () => {
	const events: string[] = [];
	let index = 0;
	const runtime = harness(async () => {
		const id = index++;
		return {
			async fetch() {
				return "session";
			},
			async close() {
				events.push(`close ${id}`);
				runtime.events.push(`close ${id}`);
				if (id === 0) throw new Error("worker close failed");
			},
		};
	});
	await open(runtime.client);
	await open(runtime.client);
	await expect(runtime.client.shutdown()).rejects.toThrow(
		"Failed to close browser sessions",
	);
	expect(events).toEqual(["close 0", "close 1"]);
	expect(runtime.events).toEqual(["close 0", "close 1", "shutdown"]);
	expect(JSON.parse(text(await runtime.client.listSessions({})))).toEqual({
		sessions: [],
	});
});

test("reset does not allow late stateless results from the old generation", async () => {
	const runtime = harness();
	const started = deferred<void>();
	const pending = deferred<string>();
	runtime.backend.evaluate = async () => {
		started.resolve();
		return pending.promise;
	};
	const request = runtime.client.fetch({ url });
	await started.promise;
	await runtime.client.shutdown();
	pending.resolve(
		JSON.stringify({
			ok: true,
			html: "<p>Old result</p>",
			title: "Old result",
			url,
			baseUri: url,
			lang: "en",
			selected: true,
		}),
	);
	await expect(request).rejects.toThrow("reset");
});

test("concurrent closes share one cleanup operation", async () => {
	const registry = new BrowserSessions();
	const pending = deferred<void>();
	const session = new FakeSession();
	session.close = async () => {
		session.closeCalls++;
		await pending.promise;
	};
	const id = await registry.open(async () => session);
	const first = registry.close(id);
	const second = registry.close(id);
	expect(first).toBe(second);
	pending.resolve();
	await Promise.all([first, second]);
	expect(session.closeCalls).toBe(1);
	expect(registry.list()).toEqual([]);
});

test("reset invalidates old handles while permitting new sessions", async () => {
	const runtime = harness();
	const oldId = await open(runtime.client);
	await runtime.client.shutdown();
	const newId = await open(runtime.client);
	expect(newId).not.toBe(oldId);
	await expect(
		runtime.client.sessionFetch({ url, sessionId: oldId }),
	).rejects.toThrow("Unknown or closed");
	expect(
		text(await runtime.client.sessionFetch({ url, sessionId: newId })),
	).toBe("Request 1");
	await runtime.client.shutdown();
	expect(runtime.sessions.map((session) => session.closeCalls)).toEqual([1, 1]);
});
