import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type StartupConfig } from "./config.ts";
import { type RunSummary, runScripts } from "./runner.ts";

export const STATE_ENTRY = "pi-startup-scripts:state:v1";

export interface StartupState extends RunSummary {
	phase: "running" | "complete";
	blocked: boolean;
}

export interface StartupContext {
	cwd: string;
	hasUI: boolean;
	sessionManager: Pick<
		ExtensionContext["sessionManager"],
		"getSessionId" | "getEntries"
	>;
	ui: Pick<ExtensionContext["ui"], "notify">;
}

type SaveState = (state: StartupState) => void;

export function reportError(ctx: StartupContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "error");
	else console.error(message);
}

function reportFailures(ctx: StartupContext, state: StartupState): void {
	if (!state.blocked) return;
	reportError(
		ctx,
		`pi-startup-scripts: startup failed\n${state.errors.join("\n")}\nAgent input is blocked. Use /startup-scripts continue to proceed without failed commands.`,
	);
}

function isState(value: unknown): value is StartupState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Record<string, unknown>;
	return (
		(state.phase === "running" || state.phase === "complete") &&
		typeof state.blocked === "boolean" &&
		typeof state.context === "string" &&
		Array.isArray(state.errors) &&
		state.errors.every((error: unknown) => typeof error === "string")
	);
}

export class StartupRuntime {
	readonly #sessions = new Map<string, Promise<StartupState>>();

	constructor(
		private readonly save: SaveState,
		private readonly load: () => Promise<StartupConfig> = loadConfig,
		private readonly run: (
			config: StartupConfig,
			cwd: string,
		) => Promise<RunSummary> = runScripts,
	) {}

	ensure(ctx: StartupContext): Promise<StartupState> {
		const sessionId = ctx.sessionManager.getSessionId();
		const existing = this.#sessions.get(sessionId);
		if (existing) return existing;
		const pending = this.#initialize(ctx);
		this.#sessions.set(sessionId, pending);
		return pending;
	}

	async continue(ctx: StartupContext): Promise<void> {
		const state = await this.ensure(ctx);
		if (state.blocked) {
			this.save({ ...state, blocked: false });
			state.blocked = false;
		}
		ctx.ui.notify(
			"pi-startup-scripts: continuing with successful script output only.",
			"info",
		);
	}

	async #initialize(ctx: StartupContext): Promise<StartupState> {
		let saved: StartupState | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				if (!isState(entry.data)) {
					throw new Error("pi-startup-scripts: invalid saved session state");
				}
				saved = entry.data;
			}
		}
		if (saved?.phase === "complete") {
			reportFailures(ctx, saved);
			return { ...saved };
		}
		const state: StartupState = {
			phase: "running",
			context: "",
			errors: [],
			blocked: true,
		};
		if (saved) {
			state.errors.push(
				"Previous startup execution was interrupted; commands were not rerun.",
			);
		} else {
			this.save({ ...state });
			let config: StartupConfig | undefined;
			try {
				config = await this.load();
			} catch (error) {
				state.errors.push(
					error instanceof Error
						? error.message
						: "Cannot load startup configuration",
				);
			}
			if (config) {
				try {
					Object.assign(state, await this.run(config, ctx.cwd));
				} catch {
					state.errors.push(
						"Startup execution failed unexpectedly; commands were not rerun.",
					);
				}
			}
		}
		state.phase = "complete";
		state.blocked = state.errors.length > 0;
		this.save({ ...state });
		reportFailures(ctx, state);
		return state;
	}
}
