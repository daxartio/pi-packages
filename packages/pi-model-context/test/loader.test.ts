import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import modelContext from "../src/index.ts";
import { SECTION_KEY } from "../src/prompt.ts";

test("Pi's loader registers an awaited before_agent_start handler", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-model-context-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, "agent"),
			settingsManager: SettingsManager.inMemory({}),
			extensionFactories: [
				{ name: "model-context-test", factory: modelContext },
			],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		expect(loaded.errors).toEqual([]);
		loaded.runtime.getActiveTools = () => ["codemode"];
		const extension = loaded.extensions.find(
			(item) => item.path === "<inline:model-context-test>",
		);
		const handlers = extension?.handlers.get("before_agent_start");
		expect(handlers).toHaveLength(1);
		const handler = handlers?.[0];
		if (!handler) throw new Error("Missing model-context handler");
		const sections: Record<string, string> = { unrelated: "keep" };
		const pending = handler(
			{ systemPromptOptions: { sections } },
			{
				model: undefined,
				scopedModels: [],
				modelRegistry: {
					async getAvailableOfType() {
						return [];
					},
				},
				ui: {
					notify() {
						throw new Error("Unexpected warning");
					},
				},
			},
		);
		expect(pending).toBeInstanceOf(Promise);
		await pending;
		expect(sections.unrelated).toBe("keep");
		expect(sections[SECTION_KEY]).toContain("No explicit scope is configured");
		expect(sections[SECTION_KEY]).toContain("call the codemode tool");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
