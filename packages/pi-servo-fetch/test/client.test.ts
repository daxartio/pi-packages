import { expect, test } from "bun:test";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { FetchOptions, MapOptions } from "servo-fetch";
import { type ServoBackend, ServoClient } from "../src/client.js";
import type { ResourceReader } from "../src/http.js";
import { registerTools } from "../src/index.js";
import { jsonResult, screenshotResult, textResult } from "../src/output.js";
import { FetchParams } from "../src/schema.js";

const renderResource: ResourceReader = async () => ({ kind: "render" });

const url = "https://example.com";
const html =
	"<html><head><title>Example</title></head><body><article><h1>Example</h1><p>Article</p></article></body></html>";
const markdown = "# Example\n\nArticle";
function snapshot(target = url, content = html, selected = false): string {
	return JSON.stringify({
		ok: true,
		html: content,
		title: "Example",
		url: target,
		baseUri: target,
		lang: "en",
		selected,
	});
}
function snapshotError(error: string, message: string): string {
	return JSON.stringify({ ok: false, error, message });
}
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
	"base64",
);

interface Call {
	name: string;
	url?: string;
	options?: FetchOptions | MapOptions;
	expression?: string;
}

function harness(
	overrides: Partial<ServoBackend> = {},
	read: ResourceReader = renderResource,
) {
	const calls: Call[] = [];
	let loads = 0;
	const backend: ServoBackend = {
		async map(url, options) {
			calls.push({ name: "map", url, options });
			return [{ url: `${url}/docs` }];
		},
		async evaluate(url, expression, options) {
			calls.push({ name: "evaluate", url, expression, options });
			return expression.includes("const selector =") ? snapshot(url) : "42";
		},
		async screenshot(url, options) {
			calls.push({ name: "screenshot", url, options });
			return png;
		},
		shutdown() {
			calls.push({ name: "shutdown" });
		},
		Session: {
			async open() {
				throw new Error("Unexpected session open");
			},
		},
		...overrides,
	};
	const client = new ServoClient(async () => {
		loads++;
		return backend;
	}, read);
	return { client, backend, calls, loads: () => loads };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function text(result: Awaited<ReturnType<ServoClient["fetch"]>>): string {
	const content = result.content[0];
	if (content?.type !== "text") throw new Error("Expected text content");
	return content.text;
}

test("registration exposes nine focused tools and does not load the SDK", () => {
	const names: string[] = [];
	const events: string[] = [];
	const runtime = harness();
	registerTools(
		{
			registerTool(tool) {
				names.push(tool.name);
			},
			on(event) {
				events.push(event);
				return () => {};
			},
		},
		runtime.client,
	);
	expect(names).toEqual([
		"servo_fetch",
		"servo_fetch_session_open",
		"servo_fetch_session_fetch",
		"servo_fetch_session_list",
		"servo_fetch_session_close",
		"servo_fetch_batch_fetch",
		"servo_fetch_map",
		"servo_fetch_execute_js",
		"servo_fetch_screenshot",
	]);
	expect(events).toEqual(["session_shutdown"]);
	expect(runtime.loads()).toBe(0);
	expect(FetchParams.properties.format).toMatchObject({
		type: "string",
		enum: ["markdown", "html", "text", "json"],
	});
});

test("all four HTML formats use evaluate once and expose no retired SDK functions", async () => {
	const runtime = harness();
	expect(Object.keys(runtime.backend).sort()).toEqual([
		"Session",
		"evaluate",
		"map",
		"screenshot",
		"shutdown",
	]);
	expect(text(await runtime.client.fetch({ url }))).toBe(markdown);
	expect(text(await runtime.client.fetch({ url, format: "html" }))).toBe(html);
	expect(text(await runtime.client.fetch({ url, format: "text" }))).toBe(
		"Example\n\nArticle",
	);
	const article = JSON.parse(
		text(await runtime.client.fetch({ url, format: "json" })),
	);
	expect(article).toMatchObject({
		title: "Example",
		textContent: "Article",
		url,
		lang: "en",
	});
	expect(article.content).toContain("<p>Article</p>");
	expect(runtime.calls.map((call) => call.name)).toEqual(
		Array(4).fill("evaluate"),
	);
	for (const call of runtime.calls) {
		expect(call.expression).toContain("const selector =");
		expect(call.options).toEqual({
			timeout: 30,
			settle: 0,
			signal: expect.any(AbortSignal),
		});
	}
	expect(runtime.loads()).toBe(1);
});

test("concurrent tools share one lazy SDK load", async () => {
	const runtime = harness();
	await Promise.all([
		runtime.client.fetch({ url }),
		runtime.client.evaluate({ url, expression: "6 * 7" }),
		runtime.client.map({ url }),
	]);
	expect(runtime.loads()).toBe(1);
	expect(runtime.calls.map((call) => call.name).sort()).toEqual([
		"evaluate",
		"evaluate",
		"map",
	]);
	await runtime.client.shutdown();
});

test("render settings and cancellation reach the SDK", async () => {
	const runtime = harness();
	const controller = new AbortController();
	const signal = controller.signal;
	await runtime.client.fetch(
		{ url, timeout: 15, settle: 500, selector: "main", visibility: "strict" },
		signal,
	);
	const sdkSignal = runtime.calls[0]?.options?.signal;
	expect(sdkSignal).toBeInstanceOf(AbortSignal);
	expect(sdkSignal?.aborted).toBe(false);
	expect(runtime.calls).toHaveLength(1);
	expect(runtime.calls[0]).toMatchObject({
		name: "evaluate",
		url,
		options: { timeout: 15, settle: 500, signal: expect.any(AbortSignal) },
	});
	expect(Object.keys(runtime.calls[0]?.options ?? {}).sort()).toEqual([
		"settle",
		"signal",
		"timeout",
	]);
	expect(runtime.calls[0]?.expression).toContain('const selector = "main"');
	expect(runtime.calls[0]?.expression).toContain('const visibility = "strict"');
	controller.abort();
	expect(sdkSignal?.aborted).toBe(true);
});

test("invalid URLs, embedded credentials and invalid bounds fail before SDK loading", async () => {
	const runtime = harness();
	for (const value of [
		"file:///etc/passwd",
		"https://",
		"https://fixture-user:fixture-password@example.com",
	]) {
		await expect(runtime.client.fetch({ url: value })).rejects.toThrow();
	}
	await expect(runtime.client.fetch({ url, timeout: 0 })).rejects.toThrow(
		"Invalid servo-fetch parameters",
	);
	await expect(
		runtime.client.batch({ urls: Array.from({ length: 21 }, () => url) }),
	).rejects.toThrow();
	await expect(runtime.client.map({ url, limit: 1001 })).rejects.toThrow();
	await expect(
		runtime.client.evaluate({ url, expression: "" }),
	).rejects.toThrow();
	expect(runtime.loads()).toBe(0);
});

test("raw README requests bypass Servo for both reported formats", async () => {
	const runtime = harness({}, async () => ({
		kind: "text",
		text: "# Semble\n\nREADME content",
		contentType: "text/plain",
	}));
	for (const format of ["text", "markdown"] as const) {
		const result = await runtime.client.fetch({
			url: "https://raw.githubusercontent.com/MinishLab/semble/main/README.md",
			format,
			timeout: 30,
			settle: 0,
			selector: "body",
			visibility: "off",
		});
		expect(text(result)).toContain("# Semble");
		expect(text(result)).toContain("Selector applies only to HTML");
		expect(result.details).toMatchObject({
			source: "http",
			selectorIgnored: true,
		});
	}
	expect(runtime.loads()).toBe(0);
});

test("snapshot selectors and visibility support HTML fragments and local text extraction", async () => {
	const selector = 'main[data-label="quoted"]';
	const fragment =
		'<main><h1>Heading</h1><p><strong>Selected</strong> &amp; <a href="https://example.com">link</a></p><p><code>code</code></p></main>';
	const requests: Call[] = [];
	const runtime = harness({
		async evaluate(target, expression, options) {
			requests.push({ name: "evaluate", url: target, expression, options });
			return snapshot(target, fragment, true);
		},
	});
	expect(
		text(
			await runtime.client.fetch({
				url,
				format: "html",
				selector,
				visibility: "strict",
			}),
		),
	).toBe(fragment);
	expect(
		text(
			await runtime.client.fetch({
				url,
				format: "text",
				selector,
				visibility: "strict",
			}),
		),
	).toBe("Heading\n\nSelected & link [https://example.com/]\n\ncode");
	for (const request of requests) {
		expect(request.expression).toContain(
			`const selector = ${JSON.stringify(selector)}`,
		);
		expect(request.expression).toContain('const visibility = "strict"');
		expect(request.options).toEqual({
			timeout: 30,
			settle: 0,
			signal: expect.any(AbortSignal),
		});
	}
});

for (const format of ["markdown", "html", "text", "json"] as const) {
	for (const [error, message, selector] of [
		["selector_missing", "No elements match: main.missing", "main.missing"],
		["selector_invalid", "Invalid CSS selector: [", "["],
		[
			"content_empty",
			"No content remains after visibility filtering",
			undefined,
		],
	] as const) {
		test(`${format} preserves ${error} snapshot errors without retry or fallback`, async () => {
			const requests: string[] = [];
			const reads: string[] = [];
			const runtime = harness(
				{
					async evaluate(target) {
						requests.push(target);
						return snapshotError(error, message);
					},
				},
				async (target) => {
					reads.push(target);
					return { kind: "render" };
				},
			);
			await expect(
				runtime.client.fetch({ url, format, selector, visibility: "off" }),
			).rejects.toThrow(`${error}: ${message}`);
			expect(requests).toEqual([url]);
			expect(reads).toEqual([url]);
			expect(runtime.calls).toEqual([]);
			expect(runtime.loads()).toBe(1);
			await runtime.client.shutdown();
		});
	}
}

test("empty local extraction fails without another engine request", async () => {
	for (const content of ["", " \n\t "]) {
		const requests: string[] = [];
		const runtime = harness({
			async evaluate(target) {
				requests.push(target);
				return snapshot(target, `<html><body>${content}</body></html>`);
			},
		});
		await expect(runtime.client.fetch({ url, format: "text" })).rejects.toThrow(
			"content_empty: No extractable content remains in the snapshot",
		);
		expect(requests).toEqual([url]);
		await runtime.client.shutdown();
	}
});

test("batch preserves snapshot errors per URL without fallback", async () => {
	for (const error of [
		"selector_missing",
		"selector_invalid",
		"content_empty",
	]) {
		const requests: string[] = [];
		const runtime = harness({
			async evaluate(target) {
				requests.push(target);
				return target === url
					? snapshotError(error, "Snapshot failed")
					: snapshot(target, "<p>Found</p>", true);
			},
		});
		expect(
			JSON.parse(
				text(
					await runtime.client.batch({
						urls: [url, `${url}/ok`],
						concurrency: 1,
					}),
				),
			),
		).toEqual([
			{ url, ok: false, error: `${error}: Snapshot failed` },
			{
				url: `${url}/ok`,
				ok: true,
				markdown: "Found",
				source: "servo",
				extraction: "local-dom",
			},
		]);
		expect(requests).toEqual([url, `${url}/ok`]);
		await runtime.client.shutdown();
	}
});

test("session empty strings fail actionably, including selectors, without stateless fallback", async () => {
	for (const output of ["", " \n\t "]) {
		for (const selector of [undefined, "main.missing"]) {
			const requests: Call[] = [];
			let closed = 0;
			const runtime = harness({
				Session: {
					async open() {
						return {
							async fetch(target, options) {
								requests.push({ name: "session.fetch", url: target, options });
								return output;
							},
							async close() {
								closed++;
							},
						};
					},
				},
			});
			const opened: unknown = JSON.parse(
				text(await runtime.client.openSession()),
			);
			if (
				typeof opened !== "object" ||
				opened === null ||
				!("sessionId" in opened) ||
				typeof opened.sessionId !== "string"
			)
				throw new Error("Expected session ID");
			try {
				await expect(
					runtime.client.sessionFetch({
						url,
						sessionId: opened.sessionId,
						selector,
						visibility: "off",
					}),
				).rejects.toThrow(
					"servo_fetch_execute_js is stateless and cannot inspect this session; no stateless fallback was attempted.",
				);
				expect(requests).toEqual([
					{
						name: "session.fetch",
						url,
						options: {
							timeout: 30,
							settle: 0,
							selector,
							visibility: "off",
							signal: expect.any(AbortSignal),
						},
					},
				]);
				expect(runtime.calls).toEqual([]);
			} finally {
				await runtime.client.shutdown();
			}
			expect(closed).toBe(1);
		}
	}
});

test("HTTP errors are not silently retried through Servo", async () => {
	const runtime = harness({}, async () => {
		throw new Error("HTTP blocked");
	});
	await expect(runtime.client.fetch({ url })).rejects.toThrow("HTTP blocked");
	expect(runtime.loads()).toBe(0);
});

test("shutdown aborts pending HTTP and suppresses stale output", async () => {
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const runtime = harness({}, async (_url, { signal }) => {
		started();
		await new Promise<void>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		});
		return { kind: "text", text: "stale", contentType: "text/plain" };
	});
	const result = runtime.client.fetch({ url }).catch((error: unknown) => error);
	await ready;
	await runtime.client.shutdown();
	expect(await result).toMatchObject({
		message: "Servo client was reset; retry the request",
	});
	expect(runtime.loads()).toBe(0);
});

test("stateless fetch rejects the old session field without starting Servo", async () => {
	const runtime = harness();
	const oldParams = { url, sessionId: "none" };
	await expect(runtime.client.fetch(oldParams)).rejects.toThrow(
		"Invalid servo-fetch parameters",
	);
	expect(runtime.loads()).toBe(0);
	expect(text(await runtime.client.fetch({ url }))).toBe(markdown);
});

test("mixed batch routes raw text through HTTP and HTML through evaluate, preserving failures and metadata", async () => {
	const urls = ["/raw", "/html", "/missing", "/other-raw"].map(
		(path) => `${url}${path}`,
	);
	const reads: string[] = [];
	const runtime = harness({}, async (target) => {
		reads.push(target);
		if (target.endsWith("/missing")) throw new Error("HTTP 404: Not found");
		return target.endsWith("/html")
			? { kind: "render" }
			: { kind: "text", text: `Raw ${target}`, contentType: "text/plain" };
	});
	const result = await runtime.client.batch({
		urls,
		selector: "main",
		visibility: "off",
		timeout: 12,
		settle: 100,
	});
	const notice =
		"\n\n[Selector applies only to HTML; returned the complete raw text resource.]";
	expect(JSON.parse(text(result))).toEqual([
		{
			url: urls[0],
			ok: true,
			markdown: `Raw ${urls[0]}${notice}`,
			source: "http",
			contentType: "text/plain",
			selectorIgnored: true,
		},
		{
			url: urls[1],
			ok: true,
			markdown,
			source: "servo",
			extraction: "local-dom",
		},
		{ url: urls[2], ok: false, error: "HTTP 404: Not found" },
		{
			url: urls[3],
			ok: true,
			markdown: `Raw ${urls[3]}${notice}`,
			source: "http",
			contentType: "text/plain",
			selectorIgnored: true,
		},
	]);
	expect(reads).toEqual(urls);
	expect(runtime.loads()).toBe(1);
	expect(runtime.calls).toHaveLength(1);
	expect(runtime.calls[0]).toEqual({
		name: "evaluate",
		url: urls[1],
		expression: expect.stringContaining('const selector = "main"'),
		options: { timeout: 12, settle: 100, signal: expect.any(AbortSignal) },
	});
	expect(runtime.calls[0]?.expression).toContain('const visibility = "off"');
});

test("raw-only batch never loads the SDK and omits selector metadata when unused", async () => {
	const runtime = harness({}, async () => ({
		kind: "text",
		text: "Raw content",
		contentType: "application/json",
	}));
	expect(
		JSON.parse(text(await runtime.client.batch({ urls: [url, `${url}/raw`] }))),
	).toEqual(
		[url, `${url}/raw`].map((target) => ({
			url: target,
			ok: true,
			markdown: "Raw content",
			source: "http",
			contentType: "application/json",
		})),
	);
	expect(runtime.loads()).toBe(0);
	expect(runtime.calls).toEqual([]);
});

for (const concurrency of [undefined, 1, 3]) {
	test(`batch bounds workers to ${concurrency ?? "the default of 2"} and preserves input order`, async () => {
		const bound = concurrency ?? 2;
		const urls = Array.from({ length: 5 }, (_, index) => `${url}/${index}`);
		const gates = urls.map(() => deferred());
		const started = urls.map(() => deferred());
		const requests: string[] = [];
		const completed: string[] = [];
		let active = 0;
		let peak = 0;
		const runtime = harness({
			async evaluate(target) {
				const index = urls.indexOf(target);
				requests.push(target);
				peak = Math.max(peak, ++active);
				started[index]?.resolve();
				await gates[index]?.promise;
				active--;
				completed.push(target);
				return snapshot(target, `<p>Page ${index}</p>`, true);
			},
		});
		const result = runtime.client.batch({ urls, concurrency });
		try {
			await Promise.all(started.slice(0, bound).map((gate) => gate.promise));
			expect(requests).toEqual(urls.slice(0, bound));
			for (let next = bound; next < urls.length; next++) {
				gates[next - 1]?.resolve();
				await started[next]?.promise;
				expect(requests).toEqual(urls.slice(0, next + 1));
				expect(active).toBe(bound);
			}
			for (const gate of gates) gate.resolve();
			expect(JSON.parse(text(await result))).toEqual(
				urls.map((target, index) => ({
					url: target,
					ok: true,
					markdown: `Page ${index}`,
					source: "servo",
					extraction: "local-dom",
				})),
			);
			expect(peak).toBe(bound);
			expect(active).toBe(0);
			if (bound > 1) expect(completed).not.toEqual(urls);
			expect(runtime.loads()).toBe(1);
			expect(runtime.calls).toEqual([]);
		} finally {
			for (const gate of gates) gate.resolve();
			await result;
			await runtime.client.shutdown();
		}
	});
}

test("Servo crashes are not retried or sent to fallback, and batch retains the per-URL error", async () => {
	const requests: string[] = [];
	const reads: string[] = [];
	const runtime = harness(
		{
			async evaluate(target) {
				requests.push(target);
				if (target === url) throw new Error("Servo engine crashed");
				return snapshot(target, "<p>Survivor</p>", true);
			},
		},
		async (target) => {
			reads.push(target);
			return { kind: "render" };
		},
	);
	await expect(runtime.client.fetch({ url, selector: "main" })).rejects.toThrow(
		"Servo engine crashed",
	);
	expect(requests).toEqual([url]);
	expect(
		JSON.parse(
			text(
				await runtime.client.batch({
					urls: [url, `${url}/ok`],
					concurrency: 1,
				}),
			),
		),
	).toEqual([
		{ url, ok: false, error: "Servo engine crashed" },
		{
			url: `${url}/ok`,
			ok: true,
			markdown: "Survivor",
			source: "servo",
			extraction: "local-dom",
		},
	]);
	expect(requests).toEqual([url, url, `${url}/ok`]);
	expect(reads).toEqual(requests);
	expect(runtime.calls).toEqual([]);
	expect(runtime.loads()).toBe(1);
});

test("map and evaluate forward their distinct options", async () => {
	const runtime = harness();
	expect(
		JSON.parse(
			text(
				await runtime.client.map({
					url,
					noFallback: true,
					include: ["/docs/**"],
				}),
			),
		),
	).toEqual([{ url: `${url}/docs` }]);
	expect(runtime.calls[0]).toEqual({
		name: "map",
		url,
		options: {
			timeout: 30,
			limit: 100,
			noFallback: true,
			include: ["/docs/**"],
			signal: undefined,
		},
	});
	expect(
		text(
			await runtime.client.evaluate({ url, expression: "6 * 7", settle: 100 }),
		),
	).toBe("42");
	expect(runtime.calls[1]).toEqual({
		name: "evaluate",
		url,
		expression: "6 * 7",
		options: { timeout: 30, settle: 100, signal: undefined },
	});
});

test("pre-aborted requests never load the backend", async () => {
	const runtime = harness();
	const signal = AbortSignal.abort(new Error("cancelled"));
	await expect(runtime.client.fetch({ url }, signal)).rejects.toThrow(
		"cancelled",
	);
	expect(runtime.loads()).toBe(0);
});

test("aborting while the backend loads prevents starting a request", async () => {
	const runtime = harness();
	const controller = new AbortController();
	const client = new ServoClient(async () => {
		controller.abort(new Error("cancelled"));
		return runtime.backend;
	}, renderResource);
	await expect(client.fetch({ url }, controller.signal)).rejects.toThrow(
		"cancelled",
	);
	expect(runtime.calls).toEqual([]);
});

for (const shutdown of [false, true]) {
	test(`${shutdown ? "shutdown" : "caller cancellation"} aborts in-flight batch work and prevents queued URLs`, async () => {
		const controller = new AbortController();
		const gate = deferred();
		const ready = deferred();
		const urls = Array.from({ length: 4 }, (_, index) => `${url}/${index}`);
		const requests: string[] = [];
		const reads: string[] = [];
		const signals: AbortSignal[] = [];
		const runtime = harness(
			{
				async evaluate(target, _expression, options) {
					if (!options?.signal) throw new Error("Missing request signal");
					requests.push(target);
					signals.push(options.signal);
					if (requests.length === 2) ready.resolve();
					// Deliberately ignore abort until released, to test stale-result suppression.
					await gate.promise;
					return snapshot(target, "<p>Stale page</p>", true);
				},
			},
			async (target) => {
				reads.push(target);
				return { kind: "render" };
			},
		);
		const result = runtime.client.batch(
			{ urls, concurrency: 2 },
			controller.signal,
		);
		try {
			await ready.promise;
			if (shutdown) await runtime.client.shutdown();
			else controller.abort(new Error("cancelled"));
			expect(signals).toHaveLength(2);
			expect(signals.every((signal) => signal.aborted)).toBe(true);
			// Bun's rejects matcher must only run after releasing the pending work.
			gate.resolve();
			await expect(result).rejects.toThrow(
				shutdown ? "Servo client was reset; retry the request" : "cancelled",
			);
			expect(requests).toEqual(urls.slice(0, 2));
			expect(reads).toEqual(urls.slice(0, 2));
			expect(runtime.calls.map((call) => call.name)).toEqual(
				shutdown ? ["shutdown"] : [],
			);
		} finally {
			gate.resolve();
			await result.catch(() => {});
			await runtime.client.shutdown();
		}
	});
}

test("backend errors propagate and failed SDK loading can be retried", async () => {
	const runtime = harness({
		async evaluate() {
			throw new Error("engine failed");
		},
	});
	await expect(runtime.client.fetch({ url })).rejects.toThrow("engine failed");
	let attempts = 0;
	const client = new ServoClient(async () => {
		if (++attempts === 1) throw new Error("SDK unavailable");
		return harness().backend;
	}, renderResource);
	await expect(client.fetch({ url })).rejects.toThrow("SDK unavailable");
	expect(text(await client.fetch({ url }))).toBe(markdown);
	expect(attempts).toBe(2);
});

test("shutdown is lazy, releases the loaded SDK, and permits restart", async () => {
	const runtime = harness();
	await runtime.client.shutdown();
	expect(runtime.loads()).toBe(0);
	await runtime.client.fetch({ url });
	await runtime.client.shutdown();
	expect(runtime.calls.map((call) => call.name)).toEqual([
		"evaluate",
		"shutdown",
	]);
	await runtime.client.fetch({ url });
	expect(runtime.loads()).toBe(2);
	await runtime.client.shutdown();
});

test("batch keeps complete per-page content and truncates only the combined output", async () => {
	const content = "x".repeat(60000);
	const urls = [url, `${url}/other`];
	const requests: string[] = [];
	const runtime = harness({
		async evaluate(target) {
			requests.push(target);
			return snapshot(target, `<p>${content}</p>`, true);
		},
	});
	const result = await runtime.client.batch({ urls });
	const path = result.details.fullOutputPath;
	if (!path) throw new Error("Missing combined output artifact");
	try {
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(
			urls.map((target) => ({
				url: target,
				ok: true,
				markdown: content,
				source: "servo",
				extraction: "local-dom",
			})),
		);
		expect(requests).toEqual(urls);
		expect(result.details.truncated).toBe(true);
	} finally {
		await rm(dirname(path), { recursive: true, force: true });
		await runtime.client.shutdown();
	}
});

test("oversized output is bounded, stored privately, and not duplicated in details", async () => {
	for (const output of ["line\n".repeat(2100), "я".repeat(40000)]) {
		const result = await textResult(output);
		const path = result.details.fullOutputPath;
		expect(path).toBeDefined();
		if (!path) throw new Error("Missing output artifact");
		try {
			expect(await readFile(path, "utf8")).toBe(output);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect(Buffer.byteLength(text(result))).toBeLessThan(52000);
			expect(result.details).toEqual({ fullOutputPath: path, truncated: true });
			expect(text(result)).toContain("Output truncated");
		} finally {
			await rm(dirname(path), { recursive: true, force: true });
		}
	}
	expect(await textResult("")).toEqual({
		content: [{ type: "text", text: "" }],
		details: {},
	});
	await expect(jsonResult(undefined)).rejects.toThrow("no result");
});

test("screenshots return an image and private PNG artifact, not base64 details", async () => {
	const runtime = harness();
	const result = await runtime.client.screenshot({ url, fullPage: true });
	const path = result.details.screenshotPath;
	if (!path) throw new Error("Missing screenshot artifact");
	try {
		expect(await readFile(path)).toEqual(png);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(result.content[1]).toEqual({
			type: "image",
			data: png.toString("base64"),
			mimeType: "image/png",
		});
		expect(result.details).toEqual({ screenshotPath: path, bytes: png.length });
		expect(runtime.calls[0]?.options).toMatchObject({
			fullPage: true,
			timeout: 30,
			settle: 0,
		});
	} finally {
		await rm(dirname(path), { recursive: true, force: true });
	}
	await expect(screenshotResult(Buffer.from("not a PNG"))).rejects.toThrow(
		"invalid PNG",
	);
});
