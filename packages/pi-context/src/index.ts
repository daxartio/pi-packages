/**
 * Assemble the system prompt from known context sources (AGENTS.md chain,
 * SYSTEM.md / APPEND_SYSTEM.md via pi's customPrompt/appendSystemPrompt,
 * skills, extra files) with persistent defaults, per-session overrides,
 * review output, and token estimates.
 *
 * Usage:
 * /context            - interactive picker: arrows move, space toggles,
 *                       enter applies for this session, ctrl+s also saves
 *                       defaults to the config file, esc cancels
 * /context on|off <id>- force-enable/disable a source for this session
 * /context reset      - clear per-session overrides
 * Persistent defaults: ~/.pi/agent/pi-context.json (respects PI_CODING_AGENT_DIR)
 *   { "sources": { "agents": true, "system": true, "appendSystem": true, "skills": true },
 *     "extraFiles": [], "startupSummary": true }
 */

import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	BeforeAgentStartEvent,
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey } from "@earendil-works/pi-tui";
import { configPath, loadConfig, saveSourceDefaults } from "./config.js";
import { discoverContextFiles } from "./discovery.js";
import {
	applyConfig,
	applyDraft,
	buildPlan,
	collectEntries,
	emptyOverrides,
	formatPlanReview,
	formatStatus,
	rebuildSystemPrompt,
	type ContextPlan,
	type PlanEntry,
	type SessionOverrides,
	type SourceDefaults,
} from "./plan.js";

const STATUS_KEY = "pi-context";

type BuildPrompt = (options: BuildSystemPromptOptions) => string;

/**
 * buildSystemPrompt lives in dist/core/system-prompt.js but is not re-exported
 * from the package root at runtime. Resolve it dynamically with a small
 * fallback so a pi update that drops the deep path degrades to a local
 * builder instead of failing to load the extension.
 */
async function loadBuildPrompt(): Promise<BuildPrompt> {
	try {
		const rootUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
		const deepUrl = new URL("core/system-prompt.js", rootUrl).href;
		const mod = (await import(deepUrl)) as { buildSystemPrompt?: BuildPrompt };
		if (typeof mod.buildSystemPrompt === "function") return mod.buildSystemPrompt;
	} catch {
		// Fall through to the local approximation below.
	}
	return fallbackBuildPrompt;
}

/** Local approximation of pi's buildSystemPrompt, used only when the deep import fails. */
function fallbackBuildPrompt(options: BuildSystemPromptOptions): string {
	let prompt = options.customPrompt ?? "You are an expert coding assistant operating inside pi, a coding agent harness.";
	if (options.appendSystemPrompt) prompt += `\n\n${options.appendSystemPrompt}`;
	const contextFiles = options.contextFiles ?? [];
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
		for (const { path, content } of contextFiles) {
			prompt += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}
	const skills = (options.skills ?? []).filter((skill) => !skill.disableModelInvocation);
	if (skills.length > 0) {
		const list = skills
			.map((skill) => `  <skill>\n    <name>${skill.name}</name>\n    <description>${skill.description}</description>\n    <location>${skill.filePath}</location>\n  </skill>`)
			.join("\n");
		prompt += `\n\n<available_skills>\n${list}\n</available_skills>`;
	}
	prompt += `\nCurrent working directory: ${options.cwd.replace(/\\/g, "/")}`;
	return prompt;
}

type Notify = (message: string, level?: "info" | "warning" | "error") => void;

function notifyOf(ctx: ExtensionContext): Notify {
	return (message, level = "info") => ctx.ui?.notify?.(message, level);
}

function computePlan(options: BuildSystemPromptOptions): ContextPlan {
	const config = loadConfig();
	const discovered = discoverContextFiles({ cwd: options.cwd, extraFiles: config.extraFiles });
	return buildPlan(applyConfig(collectEntries(options, discovered), config, sessionOverrides));
}

let sessionOverrides: SessionOverrides = emptyOverrides();

function updateStatus(ctx: ExtensionContext, plan: ContextPlan | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui?.setStatus?.(STATUS_KEY, plan ? formatStatus(plan) : undefined);
}

function parseToggleArgs(args: string): { action: string; id?: string } {
	const [action = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
	return { action: action.toLowerCase(), id: rest.join(" ") || undefined };
}

function findEntryId(plan: ContextPlan, query: string): string | undefined {
	const exact = plan.entries.find((entry) => entry.id === query);
	if (exact) return exact.id;
	const matches = plan.entries.filter(
		(entry) => entry.label === query || entry.path.endsWith(query) || entry.id.endsWith(query),
	);
	return matches.length === 1 ? matches[0]?.id : undefined;
}

function formatDefaultsReview(): string {
	const config = loadConfig();
	const { agents, system, appendSystem, skills } = config.sources;
	const lines = [
		`Persistent defaults (${configPath()}):`,
		`  agents: ${agents ? "on" : "off"}  system: ${system ? "on" : "off"}  appendSystem: ${appendSystem ? "on" : "off"}  skills: ${skills ? "on" : "off"}`,
		`  extraFiles: ${config.extraFiles.length > 0 ? config.extraFiles.join(", ") : "(none)"}`,
		`  startupSummary: ${config.startupSummary ? "on" : "off"}`,
	];
	return lines.join("\n");
}

/** Map each kind to the config flag it feeds, so Ctrl+S can derive source defaults. */
const KIND_TO_SOURCE: Partial<Record<PlanEntry["kind"], keyof SourceDefaults>> = {
	agents: "agents",
	system: "system",
	appendSystem: "appendSystem",
	skill: "skills",
};

/** Result of the interactive picker: what to apply to the session and/or persist. */
interface PickerResult {
	sessionDraft: Map<string, boolean>;
	persistDefaults: boolean;
}

/** Interactive multi-select: arrows move, space toggles, Ctrl+S persists defaults, Enter applies, Esc cancels. */
async function runContextPicker(ctx: ExtensionCommandContext, plan: ContextPlan): Promise<PickerResult | null> {
	const entries = plan.entries;
	if (entries.length === 0) return null;

	return ctx.ui.custom<PickerResult | null>((tui, theme, _kb, done) => {
		const draft = new Map(entries.map((entry) => [entry.id, entry.enabled]));
		let selectedIndex = 0;
		let persist = false;

		const container = new Container();
		const border = new DynamicBorder((str) => theme.fg("accent", str));
		container.addChild(border);
		const title = new Text(theme.fg("accent", theme.bold("Context sources")), 0);
		container.addChild(title);
		const list = new Text("", 0);
		container.addChild(list);
		const hint = new Text(
			theme.fg("dim", "↑/↓ move  ·  space toggle  ·  ctrl+s save defaults for all sessions  ·  enter apply  ·  esc cancel"),
			0,
		);
		container.addChild(hint);
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		const renderList = (): void => {
			const lines: string[] = [];
			let lastKind: string | undefined;
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i]!;
				if (entry.kind !== lastKind) {
					lines.push(theme.fg("muted", `${entry.kind}:`));
					lastKind = entry.kind;
				}
				const checked = draft.get(entry.id) === true;
				const checkbox = checked ? "[x]" : "[ ]";
				const cursor = i === selectedIndex ? theme.fg("accent", "›") : " ";
				const label = i === selectedIndex ? theme.fg("accent", entry.label) : entry.label;
				const tokens = theme.fg("dim", `~${entry.tokens} tok`);
				lines.push(`${cursor} ${checkbox} ${label} — ${tokens}`);
			}
			const enabledCount = entries.filter((e) => draft.get(e.id)).length;
			const enabledTokens = entries.filter((e) => draft.get(e.id)).reduce((sum, e) => sum + e.tokens, 0);
			lines.push("");
			lines.push(theme.fg("muted", `selected: ${enabledCount}/${entries.length}  ~${enabledTokens} tok${persist ? "  (will persist)" : ""}`));
			list.setText(lines.join("\n"));
			tui.requestRender();
		};

		renderList();

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, "up")) {
					selectedIndex = selectedIndex === 0 ? entries.length - 1 : selectedIndex - 1;
					renderList();
					return;
				}
				if (matchesKey(data, "down")) {
					selectedIndex = selectedIndex === entries.length - 1 ? 0 : selectedIndex + 1;
					renderList();
					return;
				}
				if (data === " " || matchesKey(data, "space")) {
					const entry = entries[selectedIndex]!;
					draft.set(entry.id, !draft.get(entry.id));
					renderList();
					return;
				}
				if (matchesKey(data, "ctrl+s")) {
					persist = true;
					done({ sessionDraft: draft, persistDefaults: true });
					return;
				}
				if (matchesKey(data, "enter")) {
					done({ sessionDraft: draft, persistDefaults: persist });
					return;
				}
				if (matchesKey(data, "escape")) {
					done(null);
				}
			},
		};
	});
}

/** Apply a picker result: update session overrides and optionally persist kind defaults. */
function applyPickerResult(
	ctx: ExtensionCommandContext,
	plan: ContextPlan,
	result: PickerResult,
): ContextPlan {
	for (const entry of plan.entries) {
		const wanted = result.sessionDraft.get(entry.id);
		if (wanted === undefined || wanted === entry.enabled) continue;
		const target = wanted ? sessionOverrides.forceOn : sessionOverrides.forceOff;
		const other = wanted ? sessionOverrides.forceOff : sessionOverrides.forceOn;
		other.delete(entry.id);
		target.add(entry.id);
	}
	if (result.persistDefaults) {
		// Derive per-kind defaults from the draft: a kind is persisted as enabled
		// only when every shown entry of that kind is enabled.
		const config = loadConfig();
		const sources = { ...config.sources };
		for (const key of ["agents", "system", "appendSystem", "skills"] as const) {
			const kindEntries = plan.entries.filter((e) => KIND_TO_SOURCE[e.kind] === key);
			if (kindEntries.length === 0) continue;
			sources[key] = kindEntries.every((e) => result.sessionDraft.get(e.id) === true);
		}
		saveSourceDefaults(sources);
	}
	return computePlan(ctx.getSystemPromptOptions());
}

async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const notify = notifyOf(ctx);
	const plan = computePlan(ctx.getSystemPromptOptions());
	const { action, id } = parseToggleArgs(args);

	switch (action) {
		case "":
		case "show": {
			const result = await runContextPicker(ctx, plan);
			if (result) {
				const next = applyPickerResult(ctx, plan, result);
				updateStatus(ctx, next);
				const saved = result.persistDefaults ? `\nSaved defaults to ${configPath()}` : "";
				notify(`${formatPlanReview(next)}${saved}`);
				return;
			}
			// Cancelled (or no UI): fall back to the plain review.
			notify(`${formatPlanReview(plan)}\n\n${formatDefaultsReview()}`);
			return;
		}
		case "on":
		case "off": {
			if (!id) {
				notify(`Usage: /context ${action} <id|label>`, "warning");
				return;
			}
			const entryId = findEntryId(plan, id);
			if (!entryId) {
				notify(`pi-context: no unique source matching "${id}". Run /context to list ids.`, "warning");
				return;
			}
			const target = action === "on" ? sessionOverrides.forceOn : sessionOverrides.forceOff;
			const other = action === "on" ? sessionOverrides.forceOff : sessionOverrides.forceOn;
			other.delete(entryId);
			target.add(entryId);
			const next = computePlan(ctx.getSystemPromptOptions());
			updateStatus(ctx, next);
			notify(`pi-context: ${entryId} ${action} for this session.\n${formatPlanReview(next)}`);
			return;
		}
		case "reset":
			sessionOverrides = emptyOverrides();
			{
				const next = computePlan(ctx.getSystemPromptOptions());
				updateStatus(ctx, next);
				notify(`pi-context: session overrides cleared.\n${formatPlanReview(next)}`);
			}
			return;
		default:
			notify(`pi-context: unknown action "${action}". Use: show | on <id> | off <id> | reset`, "warning");
	}
}

export default function contextExtension(pi: ExtensionAPI): void {
	sessionOverrides = emptyOverrides();

	pi.registerCommand("context", {
		description: "Show and tune which context sources enter the system prompt",
		handler: async (args, ctx) => {
			await handleCommand(args, ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		sessionOverrides = emptyOverrides();
		if (!ctx.hasUI) return;
		const commandCtx = ctx as ExtensionContext & Partial<Pick<ExtensionCommandContext, "getSystemPromptOptions">>;
		if (typeof commandCtx.getSystemPromptOptions !== "function") return;
		try {
			const plan = computePlan(commandCtx.getSystemPromptOptions());
			updateStatus(ctx, plan);
			if (loadConfig().startupSummary) {
				ctx.ui?.notify?.(`pi-context: ${formatStatus(plan)} — /context to review`, "info");
			}
		} catch {
			// Startup must never fail because of a display-only summary.
		}
	});

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		const plan = computePlan(event.systemPromptOptions);
		updateStatus(ctx, plan);
		const prompt = rebuildSystemPrompt(event.systemPromptOptions, plan, await loadBuildPrompt());
		return prompt === undefined ? undefined : { systemPrompt: prompt };
	});
}
