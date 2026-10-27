import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ScriptConfig {
	enabled: boolean;
	command: string[];
	prompt: string;
	timeoutMs: number;
	includeEmpty: boolean;
}

export interface StartupConfig {
	enabled: boolean;
	scripts: ScriptConfig[];
}

export const DEFAULT_TIMEOUT_MS = 300_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeout(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value <= 0 ||
		value > 2_147_483_647
	) {
		throw new Error("timeoutMs must be an integer between 1 and 2147483647");
	}
	return value;
}

function prompt(value: unknown): string {
	if (typeof value !== "string") throw new Error("prompt must be a string");
	return value;
}

function includeEmpty(value: unknown): boolean {
	if (typeof value !== "boolean") {
		throw new Error("includeEmpty must be a boolean");
	}
	return value;
}

function enabled(value: unknown): boolean {
	if (value === undefined) return true;
	if (typeof value !== "boolean") throw new Error("enabled must be a boolean");
	return value;
}

export function parseConfig(value: unknown): StartupConfig {
	if (!isRecord(value) || !Array.isArray(value.scripts)) {
		throw new Error("configuration must contain a scripts array");
	}
	const defaults = {
		prompt: prompt(value.prompt ?? ""),
		timeoutMs: timeout(value.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		includeEmpty: includeEmpty(value.includeEmpty ?? false),
	};
	return {
		enabled: enabled(value.enabled),
		scripts: value.scripts.map((script: unknown, scriptIndex: number) => {
			if (
				!isRecord(script) ||
				!Array.isArray(script.command) ||
				script.command.length === 0 ||
				!script.command.every(
					(argument: unknown) =>
						typeof argument === "string" && !argument.includes("\0"),
				) ||
				!script.command[0]?.trim()
			) {
				throw new Error(
					`script #${scriptIndex + 1}: command must be a non-empty string array with an executable`,
				);
			}
			return {
				enabled: enabled(script.enabled),
				command: script.command,
				prompt: prompt(script.prompt ?? defaults.prompt),
				timeoutMs: timeout(script.timeoutMs ?? defaults.timeoutMs),
				includeEmpty: includeEmpty(
					script.includeEmpty ?? defaults.includeEmpty,
				),
			};
		}),
	};
}

export function configPath(): string {
	return join(getAgentDir(), "pi-startup-scripts.json");
}

async function readRawConfig(path: string): Promise<unknown> {
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return { scripts: [] };
		throw new Error("cannot read pi-startup-scripts.json");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		throw new Error("pi-startup-scripts.json contains invalid JSON");
	}
	return parsed;
}

export async function loadConfig(path = configPath()): Promise<StartupConfig> {
	return parseConfig(await readRawConfig(path));
}

export async function toggleEnabled(
	scriptNumber?: number,
	path = configPath(),
): Promise<boolean> {
	if (
		scriptNumber !== undefined &&
		(!Number.isSafeInteger(scriptNumber) || scriptNumber < 1)
	) {
		throw new Error("script number must be a positive integer");
	}
	const raw = await readRawConfig(path);
	const config = parseConfig(raw);
	// Keep the original object: normalization would discard unknown fields and defaults.
	if (!isRecord(raw)) throw new Error("configuration must be an object");
	let next: boolean;
	if (scriptNumber === undefined) {
		next = !config.enabled;
		raw.enabled = next;
	} else {
		const script = config.scripts[scriptNumber - 1];
		if (!script) throw new Error("script number is out of range");
		const rawScript = Array.isArray(raw.scripts)
			? raw.scripts[scriptNumber - 1]
			: undefined;
		if (!isRecord(rawScript)) throw new Error("invalid script configuration");
		next = !script.enabled;
		rawScript.enabled = next;
	}
	let temporary: string | undefined;
	let failed = false;
	try {
		let mode = 0o600;
		try {
			const existing = (await stat(path)).mode & 0o7777;
			if ((existing & ~0o600) === 0) mode = existing;
		} catch (error) {
			if (!isRecord(error) || error.code !== "ENOENT") throw error;
		}
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		temporary = await mkdtemp(join(dirname(path), ".pi-startup-scripts-"));
		const destination = join(temporary, "config.json");
		await writeFile(destination, `${JSON.stringify(raw, null, 2)}\n`, {
			mode: 0o600,
		});
		await chmod(destination, mode);
		await rename(destination, path);
	} catch {
		failed = true;
	}
	if (temporary) {
		try {
			await rm(temporary, { recursive: true, force: true });
		} catch {
			failed = true;
		}
	}
	if (failed) throw new Error("cannot save pi-startup-scripts.json");
	return next;
}

export function expandTemplate(
	value: string,
	cwd: string,
	home = homedir(),
): string {
	const projectPath = resolve(cwd);
	const replacements: Record<string, string> = {
		"${projectPath}": projectPath,
		"${projectName}": basename(projectPath),
		"${HOME}": home,
		$HOME: home,
	};
	return value.replace(
		/\$\{projectPath\}|\$\{projectName\}|\$\{HOME\}|\$HOME\b/g,
		(token) => replacements[token] ?? token,
	);
}
