/**
 * Export the current session to a timestamped HTML file in the system temp
 * directory and open it in the default browser.
 *
 * Usage:
 * /browse    - export session HTML to $TMPDIR and open it in the browser
 *
 * The export includes the recorded system prompt and active tool definitions.
 * Note: pi's built-in
 * /export is handled by the TUI before extension commands run, so it cannot
 * be overridden - /browse is the browser-opening counterpart.
 */

import {
	getCurrentSystemMessage,
	getSystemMessageText,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { type ExportState, exportAndOpen } from "./export.js";

/** Replay recorded prompt sections; idle getSystemPrompt() omits per-run additions. */
export function buildExportState(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionCommandContext, "getSystemPrompt" | "sessionManager">,
): ExportState {
	const systemMessages = ctx.sessionManager
		.buildSessionProjection()
		.messages.filter((message) => message.role === "system");
	const recordedPrompt = getCurrentSystemMessage(systemMessages);
	const activeNames = new Set(pi.getActiveTools());
	const tools = pi
		.getAllTools()
		.filter((tool) => activeNames.has(tool.name))
		.map(({ name, description, parameters }) => ({
			name,
			description,
			parameters,
		}));
	return {
		systemPrompt: recordedPrompt
			? getSystemMessageText(recordedPrompt)
			: ctx.getSystemPrompt(),
		tools,
	};
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
