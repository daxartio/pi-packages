import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Per-source defaults: which known context sources are included in the prompt.
 * `system` governs pi's customPrompt source (SYSTEM.md), `appendSystem`
 * governs pi's appendSystemPrompt source (APPEND_SYSTEM.md).
 */
export interface SourceDefaults {
	agents: boolean;
	system: boolean;
	appendSystem: boolean;
	skills: boolean;
}

export interface ContextConfig {
	sources: SourceDefaults;
	/** Extra file paths (absolute or relative to cwd) always considered as context sources. */
	extraFiles: string[];
	/** Show the startup context summary notification at session start. Default: true. */
	startupSummary: boolean;
}

export const DEFAULT_CONFIG: ContextConfig = {
	sources: { agents: true, system: true, appendSystem: true, skills: true },
	extraFiles: [],
	startupSummary: true,
};

const CONFIG_FILE_NAME = "pi-context.json";

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSources(value: unknown): SourceDefaults {
	const defaults = { ...DEFAULT_CONFIG.sources };
	if (!isObject(value)) return defaults;
	for (const key of Object.keys(defaults) as Array<keyof SourceDefaults>) {
		const flag = value[key];
		if (typeof flag === "boolean") defaults[key] = flag;
	}
	return defaults;
}

function normalizeExtraFiles(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function normalizeConfig(raw: unknown): ContextConfig {
	if (!isObject(raw)) return { ...DEFAULT_CONFIG, sources: { ...DEFAULT_CONFIG.sources } };
	return {
		sources: normalizeSources(raw.sources),
		extraFiles: normalizeExtraFiles(raw.extraFiles),
		startupSummary: typeof raw.startupSummary === "boolean" ? raw.startupSummary : DEFAULT_CONFIG.startupSummary,
	};
}

/** Config file path inside pi's agent dir (respects PI_CODING_AGENT_DIR). */
export function configPath(agentDir = getAgentDir()): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

/** Load the persistent defaults from the extension-owned config file. */
export function loadConfig(path = configPath()): ContextConfig {
	if (!existsSync(path)) return normalizeConfig(undefined);
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return normalizeConfig(parsed);
	} catch (error) {
		console.warn(`pi-context: invalid JSON at ${path}, using defaults — ${String(error)}`);
		return normalizeConfig(undefined);
	}
}

/** Persist per-kind defaults, keeping other config fields intact. */
export function saveSourceDefaults(sources: SourceDefaults, path = configPath()): void {
	const current = loadConfig(path);
	const next: ContextConfig = { ...current, sources: { ...sources } };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
