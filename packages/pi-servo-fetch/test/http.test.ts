import { expect, test } from "bun:test";
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { gzipSync } from "node:zlib";
import {
	HttpResourceReader,
	isPublicAddress,
	type Requester,
} from "../src/http.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function withServer(
	handler: Handler,
	run: (url: string, calls: string[]) => Promise<void>,
): Promise<void> {
	const calls: string[] = [];
	const server = createServer((request, response) => {
		calls.push(`${request.method} ${request.url}`);
		handler(request, response);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing server address");
		await run(`http://127.0.0.1:${address.port}`, calls);
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
			server.closeAllConnections();
		});
	}
}

function reader(maxBytes?: number): HttpResourceReader {
	return new HttpResourceReader({ allowPrivate: () => true, maxBytes });
}

function signal(): AbortSignal {
	return AbortSignal.timeout(1_000);
}

function networkGuard() {
	let requests = 0;
	const request: Requester = () => {
		requests++;
		throw new Error("Unexpected network request");
	};
	return { request, count: () => requests };
}

test("raw text uses HEAD then GET and normalizes the content type", async () => {
	await withServer(
		(_request, response) => {
			response.setHeader("Content-Type", "Text/Plain; charset=utf-8");
			response.end("hello π\n");
		},
		async (url, calls) => {
			expect(await reader().read(url, { signal: signal() })).toEqual({
				kind: "text",
				text: "hello π\n",
				contentType: "text/plain",
			});
			expect(calls).toEqual(["HEAD /", "GET /"]);
		},
	);
}, 2_000);

test("HTML HEAD returns render without GET", async () => {
	await withServer(
		(_request, response) => {
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end("<html>page</html>");
		},
		async (url, calls) => {
			expect(await reader().read(url, { signal: signal() })).toEqual({
				kind: "render",
			});
			expect(calls).toEqual(["HEAD /"]);
		},
	);
}, 2_000);

test("HEAD 405 falls back to GET", async () => {
	await withServer(
		(request, response) => {
			response.statusCode = request.method === "HEAD" ? 405 : 200;
			response.setHeader("Content-Type", "application/json");
			response.end('{"ok":true}');
		},
		async (url, calls) => {
			expect(await reader().read(url, { signal: signal() })).toEqual({
				kind: "text",
				text: '{"ok":true}',
				contentType: "application/json",
			});
			expect(calls).toEqual(["HEAD /", "GET /"]);
		},
	);
}, 2_000);

for (const status of [301, 302, 303, 307, 308]) {
	test(`follows relative ${status} redirects for both HEAD and GET`, async () => {
		await withServer(
			(request, response) => {
				if (request.url === "/start") {
					response.writeHead(status, { Location: "./text" });
					response.end();
				} else {
					response.setHeader("Content-Type", "text/plain");
					response.end("redirected");
				}
			},
			async (url, calls) => {
				expect(
					await reader().read(`${url}/start`, { signal: signal() }),
				).toEqual({
					kind: "text",
					text: "redirected",
					contentType: "text/plain",
				});
				expect(calls).toEqual([
					"HEAD /start",
					"HEAD /text",
					"GET /start",
					"GET /text",
				]);
			},
		);
	}, 2_000);
}

for (const redirects of [5, 6]) {
	test(`redirect limit ${redirects === 5 ? "allows five" : "rejects six"} hops`, async () => {
		await withServer(
			(request, response) => {
				const hop = Number(request.url?.slice(1));
				if (hop < redirects)
					response.writeHead(302, { Location: `/${hop + 1}` });
				else response.setHeader("Content-Type", "text/html");
				response.end();
			},
			async (url, calls) => {
				const result = reader().read(`${url}/0`, { signal: signal() });
				if (redirects === 5) expect(await result).toEqual({ kind: "render" });
				else await expect(result).rejects.toThrow("Too many HTTP redirects");
				expect(calls).toEqual(
					Array.from({ length: 6 }, (_, hop) => `HEAD /${hop}`),
				);
			},
		);
	}, 2_000);
}

test("redirect without Location is rejected", async () => {
	await withServer(
		(_request, response) => {
			response.writeHead(302);
			response.end();
		},
		async (url, calls) => {
			await expect(reader().read(url, { signal: signal() })).rejects.toThrow(
				"HTTP redirect has no Location header",
			);
			expect(calls).toEqual(["HEAD /"]);
		},
	);
}, 2_000);

test("gzip size limit measures decoded bytes, allowing the exact boundary", async () => {
	const text = "a".repeat(1_024);
	const compressed = gzipSync(text);
	expect(compressed.length).toBeLessThan(1_023);
	await withServer(
		(_request, response) => {
			response.writeHead(200, {
				"Content-Type": "text/plain",
				"Content-Encoding": "gzip",
				"Content-Length": compressed.length,
			});
			response.end(compressed);
		},
		async (url, calls) => {
			expect(await reader(1_024).read(url, { signal: signal() })).toEqual({
				kind: "text",
				text,
				contentType: "text/plain",
			});
			await expect(
				reader(1_023).read(url, { signal: signal() }),
			).rejects.toThrow("HTTP text resource exceeds the size limit");
			expect(calls).toEqual(["HEAD /", "GET /", "HEAD /", "GET /"]);
		},
	);
}, 2_000);

test("timeout signal terminates a stalled HEAD request", async () => {
	await withServer(
		() => {},
		async (url, calls) => {
			const timeout = AbortSignal.timeout(50);
			await expect(
				reader().read(url, { signal: timeout }),
			).rejects.toMatchObject({
				name: "TimeoutError",
			});
			expect(timeout.reason.name).toBe("TimeoutError");
			expect(calls).toEqual(["HEAD /"]);
		},
	);
}, 2_000);

test("cancellation terminates a GET body and preserves the abort reason", async () => {
	const controller = new AbortController();
	const reason = new Error("cancelled by caller");
	await withServer(
		(request, response) => {
			response.setHeader("Content-Type", "text/plain");
			if (request.method === "HEAD") response.end();
			else {
				response.write("partial body");
			}
		},
		async (url, calls) => {
			const resourceReader = new HttpResourceReader({
				allowPrivate: () => true,
				request: (target, options, respond) =>
					httpRequest(target, options, (message) => {
						if (options.method === "GET")
							message.once("data", () => controller.abort(reason));
						respond(message);
					}),
			});
			await expect(
				resourceReader.read(url, {
					signal: AbortSignal.any([controller.signal, signal()]),
				}),
			).rejects.toBe(reason);
			expect(calls).toEqual(["HEAD /", "GET /"]);
		},
	);
}, 2_000);

test("already aborted reads never issue a request", async () => {
	const guard = networkGuard();
	const reason = new Error("already cancelled");
	await expect(
		new HttpResourceReader({ request: guard.request }).read(
			"http://127.0.0.1",
			{
				signal: AbortSignal.abort(reason),
			},
		),
	).rejects.toBe(reason);
	expect(guard.count()).toBe(0);
});

const publicAddresses = [
	"8.8.8.8",
	"1.1.1.1",
	"2606:4700:4700::1111",
	"::ffff:8.8.8.8",
];
const blockedAddresses = [
	"127.0.0.1",
	"10.0.0.1",
	"172.16.0.1",
	"192.168.1.1",
	"169.254.169.254",
	"100.64.0.1",
	"0.0.0.0",
	"224.0.0.1",
	"192.0.2.1",
	"198.51.100.1",
	"203.0.113.1",
	"::",
	"::1",
	"fc00::1",
	"fe80::1",
	"ff02::1",
	"2001:db8::1",
	"::ffff:127.0.0.1",
	"::ffff:192.168.1.1",
	"not-an-ip",
];

test("public address classification includes IPv4-mapped IPv6", () => {
	for (const address of publicAddresses)
		expect(isPublicAddress(address)).toBe(true);
	for (const address of blockedAddresses)
		expect(isPublicAddress(address)).toBe(false);
});

test("default SSRF policy rejects private literals before requesting", async () => {
	const previous = process.env.SERVO_FETCH_ALLOW_PRIVATE;
	delete process.env.SERVO_FETCH_ALLOW_PRIVATE;
	const guard = networkGuard();
	try {
		const resourceReader = new HttpResourceReader({ request: guard.request });
		for (const host of [
			"127.0.0.1",
			"10.0.0.1",
			"[::1]",
			"[::ffff:127.0.0.1]",
			"localhost",
			"app.localhost",
		]) {
			await expect(
				resourceReader.read(`http://${host}/`, { signal: signal() }),
			).rejects.toThrow("Private or reserved HTTP addresses are blocked");
		}
		expect(guard.count()).toBe(0);
	} finally {
		if (previous === undefined) delete process.env.SERVO_FETCH_ALLOW_PRIVATE;
		else process.env.SERVO_FETCH_ALLOW_PRIVATE = previous;
	}
});

for (const privateFirst of [false, true]) {
	test(`mixed public/private DNS rejects all results (private first: ${privateFirst})`, async () => {
		const guard = networkGuard();
		const addresses = [
			{ address: "8.8.8.8", family: 4 },
			{ address: "::ffff:127.0.0.1", family: 6 },
		];
		let resolutions = 0;
		const resourceReader = new HttpResourceReader({
			allowPrivate: () => false,
			request: guard.request,
			resolve: async (hostname) => {
				expect(hostname).toBe("mixed.test");
				resolutions++;
				return privateFirst ? [...addresses].reverse() : addresses;
			},
		});
		await expect(
			resourceReader.read("http://mixed.test/", { signal: signal() }),
		).rejects.toThrow("Private or reserved HTTP addresses are blocked");
		expect(resolutions).toBe(1);
		expect(guard.count()).toBe(0);
	});
}
