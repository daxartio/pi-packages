import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import test from "node:test";
import { ServoClient } from "../src/client.js";

function text(result: Awaited<ReturnType<ServoClient["fetch"]>>): string {
	const block = result.content[0];
	assert.ok(block?.type === "text");
	return block.text;
}

test("official SDK renders pages, runs web tools, and isolates persistent browser sessions", {
	skip: process.env.PI_SERVO_FETCH_E2E !== "1",
	timeout: 90000,
}, async () => {
	const paragraph =
		"This is a deterministic local article used to verify Servo rendering and readable content extraction. ".repeat(
			10,
		);
	const server = createServer((request, response) => {
		const origin = `http://${request.headers.host}`;
		if (request.url?.startsWith("/state/")) {
			const state =
				request.url === "/state/set-alpha"
					? "alpha"
					: request.url === "/state/set-beta"
						? "beta"
						: undefined;
			const cookieState = request.headers.cookie?.includes(
				"fixture-state=alpha",
			)
				? "alpha"
				: request.headers.cookie?.includes("fixture-state=beta")
					? "beta"
					: "empty";
			response.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				...(state
					? { "set-cookie": `fixture-state=${state}; Path=/; HttpOnly` }
					: {}),
			});
			response.end(
				`<!doctype html><html><head><title>Session fixture</title></head><body><article><h1>Session fixture</h1><p>${paragraph}</p><p>Cookie ${cookieState}.</p><p id="storage">Storage not read.</p></article><script>${state ? `localStorage.setItem('fixture-state', '${state}');` : ""}document.getElementById('storage').textContent = 'Storage ' + (localStorage.getItem('fixture-state') || 'empty') + '.';</script></body></html>`,
			);
		} else if (
			request.url === "/overfiltered" ||
			request.url === "/layout-static"
		) {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			const position = request.url === "/overfiltered" ? "fixed" : "static";
			response.end(
				`<!doctype html><html><head><title>Extraction fixture</title></head><body><div id="toolbar" style="position:${position};height:50px;width:300px;top:0">Menu</div><div><article><h1>Preserved DOM article</h1><p>${paragraph}</p><a href="/next">Next</a></article></div></body></html>`,
			);
		} else if (request.url === "/robots.txt") {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
		} else if (request.url === "/sitemap.xml") {
			response.writeHead(200, { "content-type": "application/xml" });
			response.end(
				`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/next</loc></url></urlset>`,
			);
		} else {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			const title = request.url === "/next" ? "Next fixture" : "Servo fixture";
			response.end(
				`<!doctype html><html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${paragraph}</p><p id="dynamic">Before JS</p><a href="/next">Next page</a></article><script>document.getElementById('dynamic').textContent = 'Rendered by JavaScript';</script></body></html>`,
			);
		}
	});
	const previousAllowPrivate = process.env.SERVO_FETCH_ALLOW_PRIVATE;
	const client = new ServoClient();
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const url = `http://127.0.0.1:${address.port}`;
		process.env.SERVO_FETCH_ALLOW_PRIVATE = "1";

		for (const format of ["text", "markdown"] as const) {
			const raw = await client.fetch({
				url: `${url}/robots.txt`,
				format,
				selector: "body",
				settle: 0,
				visibility: "off",
			});
			assert.match(text(raw), /User-agent: \*/);
			assert.equal(raw.details.source, "http");
			assert.equal(raw.details.selectorIgnored, true);
		}
		assert.equal(
			text(
				await client.fetch({
					url,
					format: "text",
					selector: "#dynamic",
					visibility: "off",
				}),
			),
			"Rendered by JavaScript",
		);

		const markdown = text(await client.fetch({ url }));
		assert.match(markdown, /Servo fixture/);
		assert.match(markdown, /Rendered by JavaScript/);
		assert.match(text(await client.fetch({ url, format: "html" })), /<h1/);
		assert.match(
			text(await client.fetch({ url, format: "text" })),
			/Rendered by JavaScript/,
		);
		assert.equal(
			JSON.parse(text(await client.fetch({ url, format: "json" }))).title,
			"Servo fixture",
		);
		assert.match(
			text(
				await client.evaluate({
					url,
					expression: "document.getElementById('dynamic').textContent",
				}),
			),
			/Rendered by JavaScript/,
		);

		const batch = JSON.parse(
			text(await client.batch({ urls: [url, `${url}/next`] })),
		);
		assert.equal(batch.length, 2);
		assert.ok(batch.every((page: { ok: boolean }) => page.ok));
		const mixed = JSON.parse(
			text(
				await client.batch({
					urls: [url, `${url}/robots.txt`, `${url}/overfiltered`],
					concurrency: 2,
					selector: "article",
					visibility: "off",
				}),
			),
		);
		assert.equal(mixed[0].ok, true);
		assert.equal(mixed[0].source, "servo");
		assert.equal(mixed[1].ok, true);
		assert.equal(mixed[1].source, "http");
		assert.match(mixed[1].markdown, /User-agent/);
		assert.equal(mixed[2].ok, true);
		assert.match(mixed[2].markdown, /Preserved DOM article/);
		assert.equal(mixed[2].extraction, "local-dom");
		assert.match(
			text(
				await client.evaluate({
					url: `${url}/overfiltered`,
					expression: "document.querySelector('article').textContent",
				}),
			),
			/Preserved DOM article/,
		);

		assert.equal(
			text(await client.fetch({ url, format: "html", selector: "article h1" })),
			"<h1>Servo fixture</h1>",
		);
		assert.equal(
			text(
				await client.evaluate({
					url: `${url}/overfiltered`,
					expression: "document.querySelector('article h1').outerHTML",
				}),
			),
			"<h1>Preserved DOM article</h1>",
		);
		const layoutEvidence = [];
		for (const fixture of ["overfiltered", "layout-static"]) {
			layoutEvidence.push(
				JSON.parse(
					text(
						await client.evaluate({
							url: `${url}/${fixture}`,
							expression:
								"JSON.stringify({articleCount:document.querySelectorAll('article').length,articleTextLength:document.querySelector('article').textContent.length,position:getComputedStyle(document.getElementById('toolbar')).position})",
						}),
					),
				),
			);
		}
		assert.equal(layoutEvidence[0].articleCount, 1);
		assert.equal(layoutEvidence[1].articleCount, 1);
		assert.equal(
			layoutEvidence[0].articleTextLength,
			layoutEvidence[1].articleTextLength,
		);
		assert.equal(layoutEvidence[0].position, "fixed");
		assert.equal(layoutEvidence[1].position, "static");
		for (const format of ["markdown", "text", "json"] as const) {
			assert.match(
				text(
					await client.fetch({
						url: `${url}/overfiltered`,
						format,
						selector: "article",
						visibility: "off",
					}),
				),
				/Preserved DOM article/,
			);
			assert.match(
				text(
					await client.fetch({
						url: `${url}/layout-static`,
						format,
						selector: "article",
						visibility: "off",
					}),
				),
				/Preserved DOM article/,
			);
			await assert.rejects(
				client.fetch({
					url: `${url}/layout-static`,
					format,
					selector: "#missing",
					visibility: "off",
				}),
				/selector_missing/,
			);
		}
		await assert.rejects(
			client.fetch({ url, selector: "[" }),
			/selector_invalid/,
		);
		const mapped = JSON.parse(
			text(await client.map({ url, noFallback: true })),
		);
		assert.deepEqual(
			mapped.map((page: { url: string }) => page.url).sort(),
			[`${url}/`, `${url}/next`].sort(),
		);

		const firstSession = JSON.parse(
			text(await client.openSession({ userAgent: "ServoFixture/1.0" })),
		).sessionId;
		const secondSession = JSON.parse(
			text(await client.openSession({})),
		).sessionId;
		assert.equal(typeof firstSession, "string");
		assert.equal(typeof secondSession, "string");
		await client.sessionFetch({
			url: `${url}/state/set-alpha`,
			sessionId: firstSession,
		});
		const firstState = text(
			await client.sessionFetch({
				url: `${url}/state/read`,
				sessionId: firstSession,
			}),
		);
		assert.match(firstState, /Cookie alpha/);
		assert.match(firstState, /Storage alpha/);
		const secondEmpty = text(
			await client.sessionFetch({
				url: `${url}/state/read`,
				sessionId: secondSession,
			}),
		);
		assert.match(secondEmpty, /Cookie empty/);
		assert.match(secondEmpty, /Storage empty/);
		await client.sessionFetch({
			url: `${url}/state/set-beta`,
			sessionId: secondSession,
		});
		const secondState = text(
			await client.sessionFetch({
				url: `${url}/state/read`,
				sessionId: secondSession,
			}),
		);
		assert.match(secondState, /Cookie beta/);
		assert.match(secondState, /Storage beta/);
		const firstStillIsolated = text(
			await client.sessionFetch({
				url: `${url}/state/read`,
				sessionId: firstSession,
			}),
		);
		assert.match(firstStillIsolated, /Cookie alpha/);
		assert.match(firstStillIsolated, /Storage alpha/);
		await assert.rejects(
			client.sessionFetch({
				url: `${url}/overfiltered`,
				sessionId: firstSession,
				selector: "article",
				visibility: "off",
			}),
			/no extractable content in the browser session/,
		);
		assert.match(
			text(
				await client.sessionFetch({
					url: `${url}/layout-static`,
					sessionId: firstSession,
					selector: "article",
					visibility: "off",
				}),
			),
			/Preserved DOM article/,
		);
		const afterExtractionFailure = text(
			await client.sessionFetch({
				url: `${url}/state/read`,
				sessionId: firstSession,
			}),
		);
		assert.match(afterExtractionFailure, /Cookie alpha/);
		assert.match(afterExtractionFailure, /Storage alpha/);

		const statelessState = text(
			await client.fetch({ url: `${url}/state/read` }),
		);
		assert.match(statelessState, /Cookie empty/);
		assert.match(statelessState, /Storage empty/);
		await client.closeSession({ sessionId: firstSession });
		await assert.rejects(
			client.sessionFetch({ url, sessionId: firstSession }),
			/Unknown or closed/,
		);
		await client.shutdown();
		assert.deepEqual(JSON.parse(text(await client.listSessions({}))), {
			sessions: [],
		});
		await assert.rejects(
			client.sessionFetch({ url, sessionId: secondSession }),
			/Unknown or closed/,
		);
		const freshSession = JSON.parse(
			text(await client.openSession({})),
		).sessionId;
		const freshState = text(
			await client.sessionFetch({
				url: `${url}/state/read`,
				sessionId: freshSession,
			}),
		);
		assert.match(freshState, /Cookie empty/);
		assert.match(freshState, /Storage empty/);

		const screenshot = await client.screenshot({ url });
		const path = screenshot.details.screenshotPath;
		assert.ok(path);
		try {
			const png = await readFile(path);
			assert.deepEqual(
				png.subarray(0, 8),
				Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			);
			assert.equal(screenshot.content[1]?.type, "image");
		} finally {
			await rm(dirname(path), { recursive: true, force: true });
		}
	} finally {
		await client.shutdown();
		if (previousAllowPrivate === undefined)
			delete process.env.SERVO_FETCH_ALLOW_PRIVATE;
		else process.env.SERVO_FETCH_ALLOW_PRIVATE = previousAllowPrivate;
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
