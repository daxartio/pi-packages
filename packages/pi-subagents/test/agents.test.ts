import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	discoverAgents,
	formatAvailableAgents,
	resolveAgent,
} from "../src/agents.js";

const expectedAgents = [
	"default",
	"dependency-updater",
	"researcher",
	"reviewer",
	"scout",
	"system-designer",
];

test("discovers built-in agents without pinned models or tool restrictions", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subagents-agents-"));

	try {
		const agents = await discoverAgents({
			cwd,
			scope: "project",
			projectTrusted: false,
		});

		for (const name of expectedAgents) {
			const agent = resolveAgent(agents, name);
			assert.equal(agent.model, undefined);
			assert.equal(agent.tools, undefined);
			assert.equal(agent.source, "builtin");
			assert.match(agent.description, /Recommended model:/u);
			assert.doesNotMatch(agent.systemPrompt, /Recommended model:/u);
		}

		assert.equal(resolveAgent(agents, "review").name, "reviewer");
		assert.equal(resolveAgent(agents, "deps").name, "dependency-updater");
		assert.equal(resolveAgent(agents, "research").name, "researcher");
		assert.equal(resolveAgent(agents, "design").name, "system-designer");

		const listing = formatAvailableAgents(agents);
		for (const name of expectedAgents) {
			assert.ok(listing.includes(`- ${name}`), `missing ${name} in listing`);
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("custom agent tool restrictions remain optional and validated", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subagents-custom-"));
	const root = join(cwd, ".pi", "agents");
	await mkdir(root, { recursive: true });
	const path = join(root, "custom.md");
	const discover = () =>
		discoverAgents({ cwd, scope: "project", projectTrusted: true });
	try {
		for (const [field, expected] of [
			["", undefined],
			["tools: read,write\n", ["read", "write"]],
			["tools: mcp,codemode\n", ["mcp", "codemode"]],
			["tools: \n", []],
		] as const) {
			await writeFile(path, `---\nname: custom\n${field}---\nInspect.`);
			assert.deepEqual(
				resolveAgent(await discover(), "custom").tools,
				expected,
			);
		}
		await writeFile(path, "---\nname: custom\ntools: *\n---\nInspect.");
		await assert.rejects(discover(), /Invalid agent tool/u);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
