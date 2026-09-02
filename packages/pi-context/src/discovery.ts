import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** A discovered context source file with its estimated prompt cost. */
export interface ContextSourceFile {
	/** Absolute path of the source file. */
	path: string;
	/** Short source kind label for display. */
	kind: "agents" | "system" | "skill" | "extra";
	/** Human label, e.g. file name or skill name. */
	label: string;
	/** Raw file content. */
	content: string;
	/** Estimated token count (chars / 4, matching pi's estimateTokens heuristic). */
	tokens: number;
}

export interface DiscoveryOptions {
	cwd: string;
	extraFiles?: string[];
}

/** Rough token estimate matching pi-coding-agent's estimateTokens (chars/4). */
export function estimateTokensFromText(text: string): number {
	return Math.ceil(text.length / 4);
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function readSource(path: string, kind: ContextSourceFile["kind"], label?: string): ContextSourceFile | undefined {
	if (!isFile(path)) return undefined;
	try {
		const content = readFileSync(path, "utf8");
		return { path, kind, label: label ?? path.split("/").pop() ?? path, content, tokens: estimateTokensFromText(content) };
	} catch {
		return undefined;
	}
}

function discoverExtraFiles(cwd: string, extraFiles: string[]): ContextSourceFile[] {
	const files: ContextSourceFile[] = [];
	for (const raw of extraFiles) {
		const path = resolve(cwd, raw);
		const source = readSource(path, "extra");
		if (source) files.push(source);
	}
	return files;
}

/**
 * Discover extra context sources pi itself does not surface as plan entries:
 * configured extra files. AGENTS.md chain, skills, and SYSTEM.md /
 * APPEND_SYSTEM.md are already loaded by pi into systemPromptOptions
 * (contextFiles, skills, customPrompt, appendSystemPrompt), so they are
 * governed through those, not re-discovered here.
 */
export function discoverContextFiles(options: DiscoveryOptions): ContextSourceFile[] {
	return discoverExtraFiles(options.cwd, options.extraFiles ?? []).filter((file) => existsSync(file.path));
}

/** Total estimated tokens across the given source files. */
export function totalTokens(files: ContextSourceFile[]): number {
	return files.reduce((sum, file) => sum + file.tokens, 0);
}
