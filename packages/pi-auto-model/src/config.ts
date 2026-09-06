import fs from "node:fs";
import path from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AutoModelConfig {
	version: 1;
	enabled: boolean;
	/** Thinking level for the classifier call itself. Defaults to "off" (cheapest). */
	classifierThinkingLevel?: ThinkingLevel;
	/** Extra classifiers hints users can tune, appended to the classifier system prompt. */
	extraInstructions?: string;
	/** Per-model routing hints shown to the classifier, keyed by "provider/model". */
	modelHints?: Record<string, string>;
}

export interface LoadConfigResult {
	config?: AutoModelConfig;
	warning?: string;
}

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

export function getConfigPath(agentDir: string): string {
	return path.join(agentDir, "auto-model.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateConfig(value: unknown): AutoModelConfig {
	if (!isRecord(value)) throw new Error("configuration must be a JSON object");
	if (value.version !== 1) throw new Error("unsupported or missing configuration version");
	if (typeof value.enabled !== "boolean") throw new Error("enabled must be true or false");
	if (
		value.classifierThinkingLevel !== undefined &&
		(typeof value.classifierThinkingLevel !== "string" ||
			!THINKING_LEVEL_SET.has(value.classifierThinkingLevel))
	) {
		throw new Error("classifierThinkingLevel has an invalid thinking level");
	}
	if (value.extraInstructions !== undefined && typeof value.extraInstructions !== "string") {
		throw new Error("extraInstructions must be a string");
	}
	if (value.modelHints !== undefined) {
		if (!isRecord(value.modelHints)) throw new Error("modelHints must be an object");
		for (const [ref, hint] of Object.entries(value.modelHints)) {
			if (ref.trim() === "" || !ref.includes("/")) {
				throw new Error(`modelHints key ${JSON.stringify(ref)} must look like provider/model`);
			}
			if (typeof hint !== "string") {
				throw new Error(`modelHints[${JSON.stringify(ref)}] must be a string`);
			}
		}
	}
	return {
		version: 1,
		enabled: value.enabled,
		classifierThinkingLevel: value.classifierThinkingLevel as ThinkingLevel | undefined,
		extraInstructions: value.extraInstructions as string | undefined,
		modelHints: value.modelHints as Record<string, string> | undefined,
	};
}

export async function loadConfig(configPath: string): Promise<LoadConfigResult> {
	try {
		const content = await fs.promises.readFile(configPath, "utf8");
		return { config: validateConfig(JSON.parse(content)) };
	} catch (error: unknown) {
		if ((error as { code?: unknown }).code === "ENOENT") return {};
		const message = error instanceof Error ? error.message : String(error);
		return { warning: `Could not load ${configPath}: ${message}` };
	}
}

export async function saveConfig(configPath: string, config: AutoModelConfig): Promise<void> {
	const validated = validateConfig(config);
	await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
	const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await fs.promises.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
		await fs.promises.rename(temporary, configPath);
	} finally {
		await fs.promises.rm(temporary, { force: true });
	}
}
