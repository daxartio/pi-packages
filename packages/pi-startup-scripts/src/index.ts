import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, toggleEnabled } from "./config.ts";
import {
	reportError,
	STATE_ENTRY,
	StartupRuntime,
	type StartupState,
} from "./runtime.ts";

export const OUTPUT_MESSAGE = "pi-startup-scripts:output";
const USAGE = "Usage: /startup-scripts continue | toggle [script-number]";

export default function startupScriptsExtension(pi: ExtensionAPI): void {
	const runtime = new StartupRuntime((state) =>
		pi.appendEntry(STATE_ENTRY, state),
	);
	let enabled: boolean | undefined;
	let commands = Promise.resolve();

	function publishOutput(ctx: ExtensionContext, state: StartupState): void {
		if (!state.context) return;
		const published = ctx.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === OUTPUT_MESSAGE,
			);
		if (published) return;
		pi.sendMessage(
			{
				customType: OUTPUT_MESSAGE,
				content: state.context,
				display: true,
			},
			{ triggerTurn: false },
		);
	}

	async function activeState(
		ctx: ExtensionContext,
	): Promise<StartupState | undefined> {
		if (enabled === undefined) {
			try {
				enabled = (await loadConfig()).enabled;
			} catch {
				enabled = true;
			}
		}
		if (!enabled) return undefined;
		const state = await runtime.ensure(ctx);
		publishOutput(ctx, state);
		return state;
	}

	pi.on("session_start", async (_event, ctx) => {
		enabled = undefined;
		await activeState(ctx);
	});

	pi.registerCommand("startup-scripts", {
		description:
			"Toggle startup scripts or continue after errors: toggle [script-number] | continue",
		handler: async (args, ctx) => {
			const pending = commands.then(async () => {
				const [action, scriptArgument, ...extra] = args.trim().split(/\s+/);
				if (action === "continue" && scriptArgument === undefined) {
					if (await activeState(ctx)) await runtime.continue(ctx);
					else ctx.ui.notify("pi-startup-scripts: disabled.", "info");
					return;
				}
				if (
					action !== "toggle" ||
					extra.length ||
					(scriptArgument !== undefined && !/^[1-9]\d*$/.test(scriptArgument))
				) {
					ctx.ui.notify(USAGE, "info");
					return;
				}
				try {
					const scriptNumber =
						scriptArgument === undefined ? undefined : Number(scriptArgument);
					const next = await toggleEnabled(scriptNumber);
					if (scriptNumber === undefined) enabled = next;
					ctx.ui.notify(
						scriptNumber === undefined
							? `pi-startup-scripts: ${next ? "enabled" : "disabled"}. Saved to configuration.`
							: `pi-startup-scripts: script #${scriptNumber} ${next ? "enabled" : "disabled"} for new sessions. Saved to configuration.`,
						"info",
					);
					if (scriptNumber === undefined && next) await activeState(ctx);
				} catch (error) {
					reportError(
						ctx,
						error instanceof Error
							? error.message
							: "pi-startup-scripts: cannot toggle configuration",
					);
				}
			});
			commands = pending.catch(() => {});
			await pending;
		},
	});

	pi.on("input", async (_event, ctx) => {
		try {
			const state = await activeState(ctx);
			if (!state?.blocked) return { action: "continue" };
			reportError(
				ctx,
				"pi-startup-scripts: input blocked; use /startup-scripts continue after reviewing startup errors.",
			);
		} catch {
			reportError(
				ctx,
				"pi-startup-scripts: cannot initialize session state; input blocked.",
			);
		}
		return { action: "handled" };
	});

	pi.on("context", (event) => ({
		messages: event.messages.filter(
			(message) =>
				message.role !== "custom" || message.customType !== OUTPUT_MESSAGE,
		),
	}));

	pi.on("before_agent_start", async (event, ctx) => {
		const state = await activeState(ctx);
		if (state?.context && !state.blocked) {
			return { systemPrompt: `${event.systemPrompt}\n\n${state.context}` };
		}
	});
}
