import { readFileSync } from "node:fs";
import type {
	BuildSystemPromptOptions,
	Skill,
} from "@earendil-works/pi-coding-agent";
import type { ContextConfig, SourceDefaults } from "./config.js";

export type { SourceDefaults } from "./config.js";

import { estimateTokensFromText } from "./discovery.js";

/** Map plan entry kinds onto config source flags. */
export function sourceKeyOf(kind: PlanEntry["kind"]): keyof SourceDefaults {
	if (kind === "skill") return "skills";
	if (kind === "appendSystem") return "appendSystem";
	if (kind === "extra") return "agents"; // extras have no own flag; always-on anyway
	return kind;
}

/** One row in the context plan: a single file or skill that may enter the prompt. */
export interface PlanEntry {
	/** Stable id used for per-session toggles: `file:<path>` or `skill:<name>`. */
	id: string;
	kind: "agents" | "system" | "appendSystem" | "skill" | "extra";
	/** Display label: file name or skill name. */
	label: string;
	/** Absolute file path (skill file path for skills). */
	path: string;
	/** Included in the effective config after defaults + session overrides. */
	enabled: boolean;
	/** Estimated tokens this entry contributes to the system prompt. */
	tokens: number;
	/** Why the entry is enabled/disabled: "default", "session-on", "session-off". */
	origin: "default" | "session-on" | "session-off";
}

export interface ContextPlan {
	entries: PlanEntry[];
	enabledTokens: number;
	totalTokens: number;
}

/** Per-session overrides applied on top of the persistent defaults. */
export interface SessionOverrides {
	forceOn: Set<string>;
	forceOff: Set<string>;
}

export function emptyOverrides(): SessionOverrides {
	return { forceOn: new Set(), forceOff: new Set() };
}

function fileKind(path: string): PlanEntry["kind"] {
	const base = path.split("/").pop() ?? "";
	if (base === "SYSTEM.md") return "system";
	if (base === "APPEND_SYSTEM.md") return "appendSystem";
	return "agents";
}

function readContent(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function skillSnippetTokens(skill: Skill): number {
	// Estimate what buildSystemPrompt actually injects per skill:
	// <skill><name/><description/><location/></skill> plus wrapper lines.
	return estimateTokensFromText(
		`${skill.name}${skill.description}${skill.filePath}`,
	);
}

/**
 * Flatten pi's systemPromptOptions into plan entries: pi-loaded context files
 * (AGENTS.md chain — SYSTEM.md/APPEND_SYSTEM.md are loaded by pi as
 * customPrompt/appendSystemPrompt, not contextFiles), plus discovered extra
 * files, plus skills (estimated by their prompt snippet, not the whole SKILL.md).
 */
export function collectEntries(
	options: BuildSystemPromptOptions,
	discovered: Array<{
		path: string;
		kind: PlanEntry["kind"];
		label: string;
		content: string;
		tokens: number;
	}>,
): PlanEntry[] {
	const entries: PlanEntry[] = [];
	const seenPaths = new Set<string>();
	for (const file of options.contextFiles ?? []) {
		seenPaths.add(file.path);
		entries.push({
			id: `file:${file.path}`,
			kind: fileKind(file.path),
			label: file.path.split("/").pop() ?? file.path,
			path: file.path,
			enabled: true,
			tokens: estimateTokensFromText(file.content),
			origin: "default",
		});
	}
	for (const file of discovered) {
		if (seenPaths.has(file.path)) continue;
		seenPaths.add(file.path);
		entries.push({
			id: `file:${file.path}`,
			kind: file.kind,
			label: file.label,
			path: file.path,
			enabled: true,
			tokens: file.tokens,
			origin: "default",
		});
	}
	for (const skill of options.skills ?? []) {
		entries.push({
			id: `skill:${skill.name}`,
			kind: "skill",
			label: skill.name,
			path: skill.filePath,
			enabled: true,
			tokens: skillSnippetTokens(skill),
			origin: "default",
		});
	}
	// SYSTEM.md / APPEND_SYSTEM.md are loaded by pi as customPrompt /
	// appendSystemPrompt (not as contextFiles), so surface them explicitly.
	if (options.customPrompt) {
		entries.push({
			id: "prompt:system",
			kind: "system",
			label: "SYSTEM.md (custom prompt)",
			path: "SYSTEM.md",
			enabled: true,
			tokens: estimateTokensFromText(options.customPrompt),
			origin: "default",
		});
	}
	if (options.appendSystemPrompt) {
		entries.push({
			id: "prompt:appendSystem",
			kind: "appendSystem",
			label: "APPEND_SYSTEM.md",
			path: "APPEND_SYSTEM.md",
			enabled: true,
			tokens: estimateTokensFromText(options.appendSystemPrompt),
			origin: "default",
		});
	}
	return entries;
}

/** Apply persistent defaults (per kind) and per-session overrides (per id) to entries. */
export function applyConfig(
	entries: PlanEntry[],
	config: ContextConfig,
	overrides: SessionOverrides,
): PlanEntry[] {
	return entries.map((entry) => {
		let enabled =
			entry.kind === "extra"
				? true
				: config.sources[sourceKeyOf(entry.kind)] !== false;
		let origin: PlanEntry["origin"] = "default";
		if (overrides.forceOn.has(entry.id)) {
			enabled = true;
			origin = "session-on";
		} else if (overrides.forceOff.has(entry.id)) {
			enabled = false;
			origin = "session-off";
		}
		return { ...entry, enabled, origin };
	});
}

export function buildPlan(entries: PlanEntry[]): ContextPlan {
	return {
		entries,
		enabledTokens: entries
			.filter((e) => e.enabled)
			.reduce((sum, e) => sum + e.tokens, 0),
		totalTokens: entries.reduce((sum, e) => sum + e.tokens, 0),
	};
}

/**
 * Recompute the plan with a draft enabled-state per entry, without touching
 * config or session overrides. Used to preview pending picker changes.
 */
export function applyDraft(
	entries: PlanEntry[],
	draftEnabled: Map<string, boolean>,
): ContextPlan {
	const next = entries.map((entry) => {
		const enabled = draftEnabled.get(entry.id) ?? entry.enabled;
		return { ...entry, enabled };
	});
	return buildPlan(next);
}

/** Apply the selected sources to pi's mutable structured prompt options. */
export function applyContextPlan(
	options: BuildSystemPromptOptions,
	plan: ContextPlan,
): boolean {
	const isFileEntry = (e: PlanEntry) =>
		e.kind === "agents" || e.kind === "extra";
	const disabledFiles = new Set(
		plan.entries.filter((e) => !e.enabled && isFileEntry(e)).map((e) => e.path),
	);
	const disabledSkills = new Set(
		plan.entries
			.filter((e) => !e.enabled && e.kind === "skill")
			.map((e) => e.label),
	);
	const piFilePaths = new Set(
		(options.contextFiles ?? []).map((file) => file.path),
	);
	const addedFiles = plan.entries.filter(
		(e) => e.enabled && e.kind === "extra" && !piFilePaths.has(e.path),
	);
	const systemEntry = plan.entries.find((e) => e.kind === "system");
	const appendEntry = plan.entries.find((e) => e.kind === "appendSystem");
	const dropCustomPrompt = systemEntry !== undefined && !systemEntry.enabled;
	const dropAppendPrompt = appendEntry !== undefined && !appendEntry.enabled;
	const changed =
		disabledFiles.size > 0 ||
		disabledSkills.size > 0 ||
		addedFiles.length > 0 ||
		dropCustomPrompt ||
		dropAppendPrompt;
	if (!changed) return false;
	const contextFiles = (options.contextFiles ?? []).filter(
		(file) => !disabledFiles.has(file.path),
	);
	for (const entry of addedFiles) {
		contextFiles.push({ path: entry.path, content: readContent(entry.path) });
	}
	const skills = (options.skills ?? []).filter(
		(skill: Skill) => !disabledSkills.has(skill.name),
	);
	options.contextFiles = contextFiles;
	options.skills = skills;
	if (dropCustomPrompt) options.customPrompt = undefined;
	if (dropAppendPrompt) options.appendSystemPrompt = undefined;
	return true;
}

/** Compact one-line summary for the footer status. */
export function formatStatus(plan: ContextPlan): string {
	const enabled = plan.entries.filter((e) => e.enabled).length;
	return `ctx ${enabled}/${plan.entries.length} ~${plan.enabledTokens}tok`;
}

/** Multi-line human-readable review of the current context plan. */
export function formatPlanReview(plan: ContextPlan): string {
	const lines: string[] = [];
	lines.push(
		`Context plan — ${plan.entries.filter((e) => e.enabled).length}/${plan.entries.length} sources, ~${plan.enabledTokens} of ~${plan.totalTokens} tokens`,
	);
	const byKind = new Map<PlanEntry["kind"], PlanEntry[]>();
	for (const entry of plan.entries) {
		const group = byKind.get(entry.kind) ?? [];
		group.push(entry);
		byKind.set(entry.kind, group);
	}
	for (const kind of [
		"agents",
		"system",
		"appendSystem",
		"skill",
		"extra",
	] as const) {
		const group = byKind.get(kind);
		if (!group || group.length === 0) continue;
		lines.push("");
		lines.push(`${kind}:`);
		for (const entry of group) {
			const mark = entry.enabled ? "[x]" : "[ ]";
			const origin = entry.origin === "default" ? "" : ` (${entry.origin})`;
			lines.push(`  ${mark} ${entry.label} — ~${entry.tokens} tok${origin}`);
			lines.push(`      ${entry.path}`);
		}
	}
	return lines.join("\n");
}
