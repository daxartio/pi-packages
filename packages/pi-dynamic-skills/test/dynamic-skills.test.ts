import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BuildSystemPromptOptions,
	loadSkillsFromDir,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import {
	applyContextPlan,
	buildPlan,
	collectEntries,
} from "../../pi-context/src/plan.js";
import { filterDynamicSkills } from "../src/index.js";
import { evaluateRule, parseCompatibility } from "../src/rules.js";

let workspace: string;
let skillDirectory: string;
let cwd: string;

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), "pi-dynamic-skills-"));
	skillDirectory = join(workspace, "skills");
	cwd = join(workspace, "project");
	await mkdir(skillDirectory);
	await mkdir(cwd);
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

async function createSkill(
	name: string,
	compatibility?: unknown,
): Promise<Skill> {
	const directory = join(skillDirectory, name);
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "SKILL.md"),
		`---\nname: ${name}\ndescription: Test skill ${name}.\n${compatibility === undefined ? "" : `compatibility: ${JSON.stringify(compatibility)}\n`}---\nInstructions.\n`,
	);
	const loaded = loadSkillsFromDir({ dir: directory, source: "test" });
	expect(loaded.skills).toHaveLength(1);
	return loaded.skills[0];
}

function expression(rule: unknown): string {
	return `pi-dynamic-skills: ${JSON.stringify(rule)}`;
}

async function matches(rule: unknown, directory = cwd): Promise<boolean> {
	const parsed = parseCompatibility(expression(rule));
	if (!parsed) throw new Error("Expected a valid test expression");
	return evaluateRule(parsed, directory, "linux");
}

function options(skills: Skill[]): BuildSystemPromptOptions {
	return { cwd, skills };
}

describe("compatibility grammar", () => {
	test("ignores absent, prose, foreign, invalid and oversized compatibility", () => {
		for (const compatibility of [
			undefined,
			null,
			true,
			{},
			"",
			"Requires Git",
			"other: {}",
			"pi-dynamic-skills: not-json",
			expression({}),
			expression({ unknown: ".git" }),
			expression({ exists: ".git", file: "Cargo.toml" }),
			expression({ exists: "" }),
			expression({ exists: "\0" }),
			expression({ file: false }),
			expression({ platform: "unknown" }),
			expression({ all: [] }),
			expression({ any: [] }),
			expression({ not: null }),
			expression({ all: [{ exists: ".git" }, { unknown: true }] }),
			expression({ exists: "a".repeat(500) }),
		]) {
			expect(parseCompatibility(compatibility)).toBeUndefined();
		}
	});

	test("accepts surrounding whitespace and rejects excessive nesting", () => {
		expect(parseCompatibility(`  ${expression({ exists: ".git" })}\n`)).toEqual(
			{ operator: "exists", path: ".git" },
		);
		let nested: unknown = { exists: ".git" };
		for (let depth = 0; depth < 18; depth++) nested = { not: nested };
		expect(parseCompatibility(expression(nested))).toBeUndefined();
	});
});

describe("environment predicates", () => {
	test("checks paths, types, missing paths, absolute paths and symlinks", async () => {
		await mkdir(join(cwd, ".git"));
		await writeFile(join(cwd, "Cargo.toml"), "");
		await symlink(join(cwd, "Cargo.toml"), join(cwd, "manifest"));
		await symlink(join(cwd, "missing"), join(cwd, "broken"));
		expect(await matches({ exists: ".git" })).toBe(true);
		expect(await matches({ directory: ".git" })).toBe(true);
		expect(await matches({ file: ".git" })).toBe(false);
		expect(await matches({ file: "Cargo.toml" })).toBe(true);
		expect(await matches({ directory: "Cargo.toml" })).toBe(false);
		expect(await matches({ exists: "missing" })).toBe(false);
		expect(await matches({ exists: "Cargo.toml/child" })).toBe(false);
		expect(await matches({ file: join(cwd, "Cargo.toml") })).toBe(true);
		expect(await matches({ file: "manifest" })).toBe(true);
		expect(await matches({ exists: "broken" })).toBe(false);
	});

	test("supports Git worktree markers and ancestor lookup", async () => {
		await writeFile(join(cwd, ".git"), "gitdir: ../repo/.git/worktrees/test");
		const nested = join(cwd, "src", "nested");
		await mkdir(nested, { recursive: true });
		expect(await matches({ exists: ".git" })).toBe(true);
		expect(await matches({ exists: ".git" }, nested)).toBe(false);
		expect(await matches({ ancestor: ".git" }, nested)).toBe(true);
		expect(
			await matches(
				{ ancestor: "nonexistent-marker-pi-dynamic-skills" },
				nested,
			),
		).toBe(false);
	});

	test("combines all, any, not and platform", async () => {
		expect(
			await matches({
				all: [{ platform: "linux" }, { not: { exists: "missing" } }],
			}),
		).toBe(true);
		expect(
			await matches({ all: [{ platform: "linux" }, { exists: "missing" }] }),
		).toBe(false);
		expect(
			await matches({ any: [{ exists: "missing" }, { platform: "linux" }] }),
		).toBe(true);
		expect(
			await matches({ any: [{ platform: "darwin" }, { platform: "win32" }] }),
		).toBe(false);
	});
});

describe("prompt filtering", () => {
	test("filters only false rules and preserves skill objects and unrelated options", async () => {
		const plain = await createSkill("plain");
		const prose = await createSkill("prose", "Requires Git");
		const malformed = await createSkill(
			"malformed",
			expression({ all: [{ exists: "missing" }, { unknown: true }] }),
		);
		const active = await createSkill("active", expression({ directory: "." }));
		const inactive = await createSkill(
			"inactive",
			expression({ exists: ".git" }),
		);
		const prompt = {
			...options([plain, prose, malformed, active, inactive]),
			customPrompt: "Custom",
			appendSystemPrompt: "Append",
			contextFiles: [{ path: "AGENTS.md", content: "Context" }],
		};
		expect(await filterDynamicSkills(prompt)).toBe(0);
		expect(prompt.skills).toEqual([plain, prose, malformed, active]);
		expect(prompt.skills?.[3]).toBe(active);
		expect(prompt.customPrompt).toBe("Custom");
		expect(prompt.appendSystemPrompt).toBe("Append");
		expect(prompt.contextFiles).toEqual([
			{ path: "AGENTS.md", content: "Context" },
		]);
	});

	test("reevaluates filesystem, cwd and edited frontmatter from fresh prompt options", async () => {
		const git = await createSkill("git", expression({ exists: ".git" }));
		const first = options([git]);
		await filterDynamicSkills(first);
		expect(first.skills).toEqual([]);
		await mkdir(join(cwd, ".git"));
		const second = options([git]);
		await filterDynamicSkills(second);
		expect(second.skills).toEqual([git]);
		await rm(join(cwd, ".git"), { recursive: true });
		const third = options([git]);
		await filterDynamicSkills(third);
		expect(third.skills).toEqual([]);
		await createSkill("git", expression({ directory: "." }));
		const fourth = { cwd: skillDirectory, skills: [git] };
		await filterDynamicSkills(fourth);
		expect(fourth.skills).toEqual([git]);
	});

	test("keeps skills on read, frontmatter parse and filesystem evaluation errors", async () => {
		const unreadable = await createSkill("unreadable");
		await rm(unreadable.filePath);
		const invalid = await createSkill("invalid");
		await writeFile(invalid.filePath, "---\ncompatibility: [\n---\n");
		await symlink("loop", join(cwd, "loop"));
		const loop = await createSkill(
			"loop",
			expression({ not: { exists: "loop" } }),
		);
		const prompt = options([unreadable, invalid, loop]);
		expect(await filterDynamicSkills(prompt)).toBe(3);
		expect(prompt.skills).toEqual([unreadable, invalid, loop]);
	});

	test("does not discover or insert skills into empty or absent lists", async () => {
		await createSkill("eligible", expression({ directory: "." }));
		const absent: BuildSystemPromptOptions = { cwd };
		expect(await filterDynamicSkills(absent)).toBe(0);
		expect(absent.skills).toBeUndefined();
		const empty = options([]);
		await filterDynamicSkills(empty);
		expect(empty.skills).toEqual([]);
	});

	test("reads folded YAML compatibility and preserves disable-model-invocation", async () => {
		const skill = await createSkill("folded");
		await writeFile(
			skill.filePath,
			'---\nname: folded\ndescription: A folded rule.\ndisable-model-invocation: true\ncompatibility: >-\n  pi-dynamic-skills:\n  {"directory":"."}\n---\nInstructions.\n',
		);
		const loaded = loadSkillsFromDir({
			dir: skill.baseDir,
			source: "test",
		}).skills;
		const prompt = options(loaded);
		expect(await filterDynamicSkills(prompt)).toBe(0);
		expect(prompt.skills).toHaveLength(1);
		expect(prompt.skills?.[0].disableModelInvocation).toBe(true);
	});

	test("does not restore skills after pi-context disables the entire group", async () => {
		const enabled = await createSkill(
			"enabled",
			expression({ directory: "." }),
		);
		const prompt = options([enabled]);
		applyContextPlan(
			prompt,
			buildPlan(
				collectEntries(prompt, []).map((entry) => ({
					...entry,
					enabled: false,
				})),
			),
		);
		await filterDynamicSkills(prompt);
		expect(prompt.skills).toEqual([]);
	});

	for (const dynamicFirst of [true, false]) {
		test(`composes with pi-context in ${dynamicFirst ? "dynamic-first" : "context-first"} order`, async () => {
			const manualOff = await createSkill(
				"manual-off",
				expression({ directory: "." }),
			);
			const dynamicOff = await createSkill(
				"dynamic-off",
				expression({ exists: "missing" }),
			);
			const enabled = await createSkill("enabled");
			const prompt = options([manualOff, dynamicOff, enabled]);
			const applyManual = () => {
				const entries = collectEntries(prompt, []).map((entry) => ({
					...entry,
					enabled: entry.label !== manualOff.name,
				}));
				applyContextPlan(prompt, buildPlan(entries));
			};
			if (dynamicFirst) await filterDynamicSkills(prompt);
			applyManual();
			if (!dynamicFirst) await filterDynamicSkills(prompt);
			expect(prompt.skills).toEqual([enabled]);
		});
	}
});
