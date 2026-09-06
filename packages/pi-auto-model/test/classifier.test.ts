import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import {
	buildClassifierSystemPrompt,
	classifyPrompt,
	describeCandidateFacts,
	parseClassificationResponse,
	type CandidateModel,
} from "../src/classifier.ts";
import type { AutoModelConfig } from "../src/config.ts";

const candidates: CandidateModel[] = [
	{ ref: "openai/gpt-5.6-mini", provider: "openai", model: "gpt-5.6-mini" },
	{ ref: "anthropic/claude-sonnet-4-5", provider: "anthropic", model: "claude-sonnet-4-5" },
	{
		ref: "anthropic/claude-opus-4-5",
		provider: "anthropic",
		model: "claude-opus-4-5",
		scopedThinkingLevel: "high",
	},
];

const config: AutoModelConfig = {
	version: 1,
	enabled: true,
	classifierThinkingLevel: "low",
};

describe("parseClassificationResponse", () => {
	test("parses a well-formed line", () => {
		const result = parseClassificationResponse("2|high|multi-file refactor", candidates);
		expect(result.index).toBe(1);
		expect(result.thinkingLevel).toBe("high");
		expect(result.reason).toBe("multi-file refactor");
	});

	test("ignores trailing lines", () => {
		const result = parseClassificationResponse("1|low|trivial\nextra noise", candidates);
		expect(result.index).toBe(0);
		expect(result.thinkingLevel).toBe("low");
	});

	test("forces the scoped thinking level for pinned candidates", () => {
		const result = parseClassificationResponse("3|off|anything", candidates);
		expect(result.index).toBe(2);
		expect(result.thinkingLevel).toBe("high");
	});

	test("keeps thinking undefined when the level is invalid", () => {
		const result = parseClassificationResponse("1|bogus|reason", candidates);
		expect(result.thinkingLevel).toBeUndefined();
	});

	test("rejects an out-of-range index", () => {
		expect(() => parseClassificationResponse("9|low|reason", candidates)).toThrow();
	});

	test("rejects a non-numeric index", () => {
		expect(() => parseClassificationResponse("simple|low|reason", candidates)).toThrow();
	});
});

describe("buildClassifierSystemPrompt", () => {
	test("lists candidates with 1-based indexes and pinned thinking", () => {
		const prompt = buildClassifierSystemPrompt(config, candidates, "openai/gpt-5.6-mini", "low");
		expect(prompt).toContain("1. openai/gpt-5.6-mini");
		expect(prompt).toContain("3. anthropic/claude-opus-4-5 (thinking fixed by scope: high)");
		expect(prompt).toContain("Current model: openai/gpt-5.6-mini (thinking: low)");
	});

	test("renders facts and hints next to candidates", () => {
		const hinted = candidates.map((candidate) =>
			candidate.ref === "anthropic/claude-sonnet-4-5"
				? { ...candidate, hint: "best for everyday coding" }
				: candidate,
		);
		const prompt = buildClassifierSystemPrompt(config, hinted, undefined, undefined, [
			{ reasoning: true, contextWindow: 400_000, input: ["text", "image"], cost: { input: 1, output: 5 } },
			undefined,
			undefined,
		]);
		expect(prompt).toContain("1. openai/gpt-5.6-mini (reasoning, input: text+image, context: 400k, cost $1/$5 per Mtok)");
		expect(prompt).toContain("2. anthropic/claude-sonnet-4-5 (best for everyday coding)");
	});

	test("describeCandidateFacts handles missing facts", () => {
		expect(describeCandidateFacts(undefined)).toBe("");
		expect(describeCandidateFacts({ reasoning: false })).toBe("non-reasoning");
	});

	test("appends extra instructions", () => {
		const withExtra = { ...config, extraInstructions: "Prefer sonnet for Rust work." };
		const prompt = buildClassifierSystemPrompt(withExtra, candidates);
		expect(prompt).toContain("Prefer sonnet for Rust work.");
	});
});

describe("classifyPrompt", () => {
	const classifierModel = {
		provider: "openai",
		id: "gpt-5.6-mini",
		maxTokens: 8192,
	} as unknown as Model<Api>;

	function fakeComplete(captured: { systemPrompt?: string }) {
		return async (_model: Model<Api>, context: Context) => {
			captured.systemPrompt = context.systemPrompt;
			return {
				stopReason: "stop",
				content: [{ type: "text", text: "1|low|trivial" }],
			} as unknown as AssistantMessage;
		};
	}

	test("passes candidate facts into the classifier system prompt", async () => {
		const captured: { systemPrompt?: string } = {};
		const result = await classifyPrompt(fakeComplete(captured), {
			model: classifierModel,
			prompt: "fix a typo",
			imageCount: 0,
			config,
			candidates,
			candidateFacts: [
				{ reasoning: false, contextWindow: 200_000, cost: { input: 0.1, output: 0.4 } },
				undefined,
				undefined,
			],
			currentRef: "openai/gpt-5.6-mini",
			currentThinkingLevel: "low",
		});
		expect(result.index).toBe(0);
		expect(captured.systemPrompt).toContain("context: 200k");
		expect(captured.systemPrompt).toContain("cost $0.1/$0.4 per Mtok");
	});
});
