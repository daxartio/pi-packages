/**
 * buildSystemPrompt is implemented in dist/core/system-prompt.js but not
 * re-exported from the package root at runtime. Declare the deep import path
 * so we can call pi's own prompt builder instead of forking it.
 */
declare module "*/dist/core/system-prompt.js" {
	import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
	export function buildSystemPrompt(options: BuildSystemPromptOptions): string;
}
