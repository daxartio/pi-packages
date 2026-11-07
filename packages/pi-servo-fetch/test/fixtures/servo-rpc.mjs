#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

await mkdir("bottles", { recursive: true });
await writeFile(join("bottles", "indexeddb"), "fixture storage");
let ignoreShutdown = false;
let delayShutdown = false;
let keepAlive;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.method === "$/cancelRequest") {
		void writeFile("cancelled-request", JSON.stringify(request.params));
		return;
	}
	const { id, method, params } = request;
	if (params.expression === "crash") process.exit(1);
	if (params.expression === "hold") {
		void writeFile("hold-started", String(id));
		return;
	}
	if (params.expression === "ignore-shutdown") {
		ignoreShutdown = true;
		keepAlive = setInterval(() => {}, 1000);
		process.on("SIGTERM", () => {});
	}
	if (params.expression === "delay-shutdown") delayShutdown = true;
	const result =
		method === "evaluate"
			? { result: JSON.stringify({ cwd: process.cwd(), params }) }
			: method === "screenshot"
				? Buffer.from("fixture PNG").toString("base64")
				: [{ url: params.url }];
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
});
lines.on("close", () => {
	if (ignoreShutdown) return;
	clearInterval(keepAlive);
	if (delayShutdown) {
		setTimeout(async () => {
			await writeFile(join("bottles", "late-write"), "shutdown storage");
		}, 100);
	}
});
