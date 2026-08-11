import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAgents, resolveAgent } from "../src/agents.js";

const expectedModels = new Map([
	["dependency-updater", "openai-codex/gpt-5.6-luna"],
	["researcher", "openai-codex/gpt-5.6-terra"],
	["reviewer", "openai-codex/gpt-5.6-sol"],
	["system-designer", "openai-codex/gpt-5.6-sol"],
]);

test("discovers specialized built-in agents with their assigned models", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subagents-agents-"));

	try {
		const agents = await discoverAgents({
			cwd,
			scope: "project",
			projectTrusted: false,
		});

		for (const [name, model] of expectedModels) {
			const agent = resolveAgent(agents, name);
			assert.equal(agent.model, model);
			assert.equal(agent.source, "builtin");
		}

		assert.equal(resolveAgent(agents, "review").name, "reviewer");
		assert.equal(resolveAgent(agents, "deps").name, "dependency-updater");
		assert.equal(resolveAgent(agents, "research").name, "researcher");
		assert.equal(resolveAgent(agents, "design").name, "system-designer");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
