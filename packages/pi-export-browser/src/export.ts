/**
 * HTML session export into the system temp directory + opening it in the
 * default browser. Split from the extension entry point so the pure logic
 * (paths, opener resolution) stays testable without a running pi.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** Minimal shape of pi's SessionManager the exporter needs. */
export interface ExportSessionData {
	getSessionFile(): string | undefined;
	getSessionId(): string;
}

export interface ExportDeps {
	resolveExporter(): Promise<ExportSessionToHtml | undefined>;
	/** Injectable for tests; defaults to node:child_process spawn. */
	spawnFn?: typeof spawn;
}

/** Tool description rendered by pi's export template. */
export interface ExportTool {
	name: string;
	description?: string;
	parameters?: unknown;
}

/**
 * Slice of the agent state consumed by pi's export template. The built-in
 * /export passes the live AgentState; extensions reconstruct it from
 * ExtensionContext (see buildExportState in index.ts).
 */
export interface ExportState {
	systemPrompt?: string;
	tools?: ExportTool[];
}

/** Signature of pi's internal exportSessionToHtml (dist/core/export-html). */
export type ExportSessionToHtml = (
	sm: ExportSessionData,
	state: ExportState | undefined,
	options: { outputPath?: string },
) => Promise<string>;

/** Timestamped, collision-free file name for one export inside tmpdir. */
export function buildOutputPath(sessionFile: string | undefined, sessionId: string, now = new Date()): string {
	const base = sessionFile ? basename(sessionFile, ".jsonl") : sessionId;
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	return join(tmpdir(), `pi-session-${base}-${stamp}.html`);
}

/** OS-specific command that opens a file in the default browser. */
export function resolveOpener(platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
	switch (platform) {
		case "darwin":
			return { command: "open", args: [] };
		case "win32":
			return { command: "cmd", args: ["/c", "start", '""'] };
		default:
			return { command: "xdg-open", args: [] };
	}
}

/** Open a file in the default browser without blocking the caller. */
export function openInBrowser(filePath: string, spawnFn: typeof spawn = spawn): Promise<void> {
	return new Promise((resolve, reject) => {
		const { command, args } = resolveOpener();
		const child = spawnFn(command, [...args, filePath], { detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

/**
 * Resolve pi's internal exportSessionToHtml via a deep import next to the
 * package root (the function is not re-exported from the package entry).
 * Kept lazy so tests and non-export code paths never pay for it.
 */
export async function loadExportSessionToHtml(): Promise<ExportSessionToHtml | undefined> {
	try {
		const rootUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
		const deepUrl = new URL("core/export-html/index.js", rootUrl).href;
		const mod = (await import(deepUrl)) as { exportSessionToHtml?: ExportSessionToHtml };
		return typeof mod.exportSessionToHtml === "function" ? mod.exportSessionToHtml : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Fallback exporter used only when the deep import into pi internals fails
 * (e.g. a pi update moved the module). Produces a minimal but valid HTML
 * rendering from the raw JSONL session file so /browse still works. Still
 * includes the system prompt and the tool list from the export state.
 */
export function exportFallback(sm: ExportSessionData, outputPath: string, state?: ExportState): string {
	const sessionFile = sm.getSessionFile();
	if (!sessionFile) throw new Error("Cannot export an in-memory session");
	if (!existsSync(sessionFile)) throw new Error("Nothing to export yet - start a conversation first");
	const escape = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const sections: string[] = [];
	if (state?.systemPrompt) {
		sections.push(`<h2>System Prompt</h2><pre>${escape(state.systemPrompt)}</pre>`);
	}
	if (state?.tools && state.tools.length > 0) {
		const items = state.tools
			.map((tool) => `<li><b>${escape(tool.name)}</b>${tool.description ? ` — ${escape(tool.description)}` : ""}</li>`)
			.join("\n");
		sections.push(`<h2>Available Tools</h2><ul>${items}</ul>`);
	}
	const lines = readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => `<pre>${escape(line)}</pre>`)
		.join("\n");
	const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>pi session export</title></head>
<body><h1>pi session export (basic renderer)</h1>
${sections.join("\n")}
${lines}
</body></html>`;
	writeFileSync(outputPath, html, "utf8");
	return outputPath;
}

/** Export the session to tmpdir and open the result in the default browser. */
export async function exportAndOpen(
	sm: ExportSessionData,
	state: ExportState | undefined,
	deps: ExportDeps = { resolveExporter: loadExportSessionToHtml },
): Promise<{ filePath: string; opened: boolean }> {
	const outputPath = buildOutputPath(sm.getSessionFile(), sm.getSessionId());
	const exporter = await deps.resolveExporter();
	const filePath = exporter ? await exporter(sm, state, { outputPath }) : exportFallback(sm, outputPath, state);
	await openInBrowser(filePath, deps.spawnFn);
	return { filePath, opened: true };
}
