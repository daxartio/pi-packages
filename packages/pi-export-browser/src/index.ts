/**
 * Export the current session to a timestamped HTML file in the system temp
 * directory and open it in the default browser.
 *
 * Usage:
 * /browse    - export session HTML to $TMPDIR and open it in the browser
 *
 * The export includes the full effective system prompt and the available
 * tool definitions, same as the built-in /export. Note: pi's built-in
 * /export is handled by the TUI before extension commands run, so it cannot
 * be overridden - /browse is the browser-opening counterpart.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { type ExportState, exportAndOpen } from "./export.js";

/**
 * Reconstruct the AgentState slice the export template needs. The built-in
 * /export reads it from the live AgentSession; extensions use the public
 * API instead: ctx.getSystemPrompt() for the full effective prompt and
 * pi.getAllTools() filtered down to the currently active tools.
 */
export function buildExportState(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): ExportState {
	const activeNames = new Set(pi.getActiveTools());
	const tools = pi
		.getAllTools()
		.filter((tool) => activeNames.has(tool.name))
		.map(({ name, description, parameters }) => ({
			name,
			description,
			parameters,
		}));
	return { systemPrompt: ctx.getSystemPrompt(), tools };
}

export default function exportBrowserExtension(pi: ExtensionAPI): void {
	pi.registerCommand("browse", {
		description:
			"Export session HTML (with system prompt and tools) to the temp dir and open it in the browser",
		handler: async (_args, ctx) => {
			const notify = (
				message: string,
				level: "info" | "warning" | "error" = "info",
			) => ctx.ui?.notify?.(message, level);
			if (!ctx.sessionManager.getSessionFile()) {
				notify(
					"pi-export-browser: nothing to export yet - start a conversation first",
					"warning",
				);
				return;
			}
			try {
				const { filePath } = await exportAndOpen(
					ctx.sessionManager,
					buildExportState(pi, ctx),
				);
				notify(`Session exported and opened in browser: ${filePath}`);
			} catch (error) {
				notify(
					`pi-export-browser: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
