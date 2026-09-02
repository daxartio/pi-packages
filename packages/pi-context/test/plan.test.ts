import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildSystemPromptOptions, Skill } from "@earendil-works/pi-coding-agent";
import { loadConfig, normalizeConfig, saveSourceDefaults } from "../src/config.js";
import { discoverContextFiles, estimateTokensFromText } from "../src/discovery.js";
import {
	applyConfig,
	applyDraft,
	buildPlan,
	collectEntries,
	emptyOverrides,
	formatPlanReview,
	formatStatus,
	rebuildSystemPrompt,
} from "../src/plan.js";

function makeSkill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: { path: `/skills/${name}/SKILL.md`, source: "user", scope: "user", origin: "default" },
		disableModelInvocation: false,
	} as unknown as Skill;
}

function makeOptions(overrides: Partial<BuildSystemPromptOptions> = {}): BuildSystemPromptOptions {
	return {
		cwd: "/project",
		contextFiles: [{ path: "/project/AGENTS.md", content: "a".repeat(400) }],
		skills: [makeSkill("first-step", "Always use first before working on a repository.")],
		...overrides,
	};
}

describe("estimateTokensFromText", () => {
	test("estimates chars/4 rounded up", () => {
		expect(estimateTokensFromText("")).toBe(0);
		expect(estimateTokensFromText("abcd")).toBe(1);
		expect(estimateTokensFromText("abcde")).toBe(2);
	});
});

describe("normalizeConfig", () => {
	test("falls back to defaults for garbage", () => {
		expect(normalizeConfig(undefined).sources).toEqual({ agents: true, system: true, appendSystem: true, skills: true });
		expect(normalizeConfig(null).extraFiles).toEqual([]);
		expect(normalizeConfig("nope").sources.skills).toBe(true);
	});

	test("accepts partial source flags and extra files", () => {
		const config = normalizeConfig({ sources: { skills: false }, extraFiles: ["docs/RULES.md", 42] });
		expect(config.sources).toEqual({ agents: true, system: true, appendSystem: true, skills: false });
		expect(config.extraFiles).toEqual(["docs/RULES.md"]);
	});
});

describe("discoverContextFiles", () => {
	test("finds configured extra files only; SYSTEM.md is pi's job", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-context-"));
		try {
			const project = join(root, "repo", "pkg");
			mkdirSync(project, { recursive: true });
			writeFileSync(join(root, "repo", "SYSTEM.md"), "repo system");
			writeFileSync(join(project, "EXTRA.md"), "extra");

			const files = discoverContextFiles({ cwd: project, extraFiles: ["EXTRA.md", "MISSING.md"] });

			expect(files.map((file) => file.path)).toEqual([join(project, "EXTRA.md")]);
			expect(files[0]?.kind).toBe("extra");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("collectEntries + applyConfig", () => {
	test("flattens context files, discovered files, skills, and pi's prompt files", () => {
		const options = makeOptions({ customPrompt: "c".repeat(80), appendSystemPrompt: "a".repeat(40) });
		const discovered = [
			{ path: "/project/EXTRA.md", kind: "extra" as const, label: "EXTRA.md", content: "s".repeat(100), tokens: 25 },
		];
		const entries = collectEntries(options, discovered);
		expect(entries.map((e) => e.id)).toEqual([
			"file:/project/AGENTS.md",
			"file:/project/EXTRA.md",
			"skill:first-step",
			"prompt:system",
			"prompt:appendSystem",
		]);
		expect(entries[0]?.tokens).toBe(100);
		expect(entries[0]?.kind).toBe("agents");
		expect(entries[1]?.kind).toBe("extra");
		expect(entries[3]?.kind).toBe("system");
		expect(entries[3]?.tokens).toBe(20);
		expect(entries[4]?.kind).toBe("appendSystem");
	});

	test("dedupes discovered files already loaded by pi", () => {
		const options = makeOptions();
		const discovered = [
			{ path: "/project/AGENTS.md", kind: "agents" as const, label: "AGENTS.md", content: "dup", tokens: 1 },
		];
		const entries = collectEntries(options, discovered);
		expect(entries.filter((e) => e.path === "/project/AGENTS.md")).toHaveLength(1);
	});

	test("defaults disable a whole kind; session overrides re-enable a single entry", () => {
		const options = makeOptions();
		const entries = collectEntries(options, []);
		const config = normalizeConfig({ sources: { agents: false } });
		const overrides = emptyOverrides();
		overrides.forceOn.add("file:/project/AGENTS.md");
		const plan = buildPlan(applyConfig(entries, config, overrides));
		const agents = plan.entries.find((e) => e.kind === "agents");
		expect(agents?.enabled).toBe(true);
		expect(agents?.origin).toBe("session-on");
	});

	test("session-off wins over defaults", () => {
		const entries = collectEntries(makeOptions(), []);
		const overrides = emptyOverrides();
		overrides.forceOff.add("skill:first-step");
		const plan = buildPlan(applyConfig(entries, normalizeConfig(undefined), overrides));
		expect(plan.entries.find((e) => e.kind === "skill")?.enabled).toBe(false);
	});
});

describe("rebuildSystemPrompt", () => {
	const build = (options: BuildSystemPromptOptions) =>
		`files=${(options.contextFiles ?? []).map((f) => f.path).sort().join(",")} skills=${(options.skills ?? []).map((s) => s.name).join(",")}`;

	test("returns undefined when nothing changes", () => {
		const options = makeOptions();
		const plan = buildPlan(applyConfig(collectEntries(options, []), normalizeConfig(undefined), emptyOverrides()));
		expect(rebuildSystemPrompt(options, plan, build)).toBeUndefined();
	});

	test("drops disabled files and skills", () => {
		const options = makeOptions();
		const overrides = emptyOverrides();
		overrides.forceOff.add("skill:first-step");
		overrides.forceOff.add("file:/project/AGENTS.md");
		const plan = buildPlan(applyConfig(collectEntries(options, []), normalizeConfig(undefined), overrides));
		expect(rebuildSystemPrompt(options, plan, build)).toBe("files= skills=");
	});

	test("adds enabled discovered extra files that pi never loaded", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-context-"));
		try {
			const extraPath = join(root, "EXTRA.md");
			writeFileSync(extraPath, "extra rules");
			const options = makeOptions();
			const discovered = [
				{ path: extraPath, kind: "extra" as const, label: "EXTRA.md", content: "extra rules", tokens: 3 },
			];
			const plan = buildPlan(applyConfig(collectEntries(options, discovered), normalizeConfig(undefined), emptyOverrides()));
			const prompt = rebuildSystemPrompt(options, plan, build);
			expect(prompt).toContain(extraPath);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("drops customPrompt/appendSystemPrompt when their kinds are disabled", () => {
		const options = makeOptions({ customPrompt: "CUSTOM", appendSystemPrompt: "APPEND" });
		const overrides = emptyOverrides();
		overrides.forceOff.add("prompt:system");
		overrides.forceOff.add("prompt:appendSystem");
		const plan = buildPlan(applyConfig(collectEntries(options, []), normalizeConfig(undefined), overrides));
		const buildFull = (o: BuildSystemPromptOptions) =>
			`custom=${o.customPrompt ?? "-"} append=${o.appendSystemPrompt ?? "-"}`;
		expect(rebuildSystemPrompt(options, plan, buildFull)).toBe("custom=- append=-");
	});

	test("keeps customPrompt/appendSystemPrompt when enabled", () => {
		const options = makeOptions({ customPrompt: "CUSTOM", appendSystemPrompt: "APPEND" });
		const plan = buildPlan(applyConfig(collectEntries(options, []), normalizeConfig(undefined), emptyOverrides()));
		expect(rebuildSystemPrompt(options, plan, () => "x")).toBeUndefined();
	});

	test("config default system:false disables the customPrompt entry", () => {
		const options = makeOptions({ customPrompt: "CUSTOM" });
		const plan = buildPlan(applyConfig(collectEntries(options, []), normalizeConfig({ sources: { system: false } }), emptyOverrides()));
		expect(plan.entries.find((e) => e.kind === "system")?.enabled).toBe(false);
		expect(plan.entries.find((e) => e.kind === "agents")?.enabled).toBe(true);
	});
});

describe("applyDraft", () => {
	test("previews enabled changes without touching config or overrides", () => {
		const plan = buildPlan(applyConfig(collectEntries(makeOptions(), []), normalizeConfig(undefined), emptyOverrides()));
		const draft = new Map([["skill:first-step", false]]);
		const preview = applyDraft(plan.entries, draft);
		expect(preview.entries.find((e) => e.id === "skill:first-step")?.enabled).toBe(false);
		expect(preview.entries.find((e) => e.id === "file:/project/AGENTS.md")?.enabled).toBe(true);
		// original plan untouched
		expect(plan.entries.find((e) => e.id === "skill:first-step")?.enabled).toBe(true);
	});
});

describe("saveSourceDefaults", () => {
	test("persists source flags, keeping other fields", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-context-cfg-"));
		try {
			const path = join(root, "pi-context.json");
			saveSourceDefaults({ agents: true, system: false, appendSystem: true, skills: true }, path);
			const saved = loadConfig(path);
			expect(saved.sources).toEqual({ agents: true, system: false, appendSystem: true, skills: true });
			expect(saved.startupSummary).toBe(true);
			// existing extraFiles are preserved on a second save
			writeFileSync(path, JSON.stringify({ ...saved, extraFiles: ["X.md"] }));
			saveSourceDefaults({ agents: false, system: true, appendSystem: false, skills: false }, path);
			const resaved = loadConfig(path);
			expect(resaved.sources).toEqual({ agents: false, system: true, appendSystem: false, skills: false });
			expect(resaved.extraFiles).toEqual(["X.md"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("formatting", () => {
	test("formatStatus shows enabled/total and tokens", () => {
		const plan = buildPlan(applyConfig(collectEntries(makeOptions(), []), normalizeConfig(undefined), emptyOverrides()));
		expect(formatStatus(plan)).toBe(`ctx 2/2 ~${plan.enabledTokens}tok`);
	});

	test("formatPlanReview groups by kind and marks state", () => {
		const overrides = emptyOverrides();
		overrides.forceOff.add("skill:first-step");
		const plan = buildPlan(applyConfig(collectEntries(makeOptions(), []), normalizeConfig(undefined), overrides));
		const review = formatPlanReview(plan);
		expect(review).toContain("agents:");
		expect(review).toContain("skill:");
		expect(review).toContain("[x] AGENTS.md");
		expect(review).toContain("[ ] first-step");
		expect(review).toContain("(session-off)");
	});
});
