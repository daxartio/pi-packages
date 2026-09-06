import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { formatCandidate, modelKey, selectableModels } from "../src/router.ts";

function fakeModel(provider: string, id: string): Model<Api> {
	return { provider, id, name: id } as unknown as Model<Api>;
}

describe("selectableModels", () => {
	const available = [fakeModel("openai", "gpt-5.6-mini"), fakeModel("anthropic", "claude-sonnet-4-5")];

	test("returns all available models when no scope is configured", () => {
		const candidates = selectableModels(available, []);
		expect(candidates.map((c) => c.ref)).toEqual(["openai/gpt-5.6-mini", "anthropic/claude-sonnet-4-5"]);
	});

	test("limits candidates to the scope and keeps pinned thinking levels", () => {
		const scoped = [
			{ model: fakeModel("anthropic", "claude-sonnet-4-5"), thinkingLevel: "high" as const },
			{ model: fakeModel("google", "gemini-3-pro") }, // not available -> dropped
		];
		const candidates = selectableModels(available, scoped);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.ref).toBe("anthropic/claude-sonnet-4-5");
		expect(candidates[0]?.scopedThinkingLevel).toBe("high");
	});
});

describe("formatCandidate", () => {
	test("prefers the scope-pinned thinking level", () => {
		const candidate = {
			ref: "a/b",
			provider: "a",
			model: "b",
			scopedThinkingLevel: "high" as const,
		};
		expect(formatCandidate(candidate, "low")).toBe("a/b:high");
	});

	test("falls back to the classified thinking level", () => {
		expect(formatCandidate({ ref: "a/b", provider: "a", model: "b" }, "medium")).toBe("a/b:medium");
		expect(formatCandidate({ ref: "a/b", provider: "a", model: "b" })).toBe("a/b");
	});
});

describe("modelKey", () => {
	test("builds provider/id refs", () => {
		expect(modelKey(fakeModel("openai", "gpt-5.6"))).toBe("openai/gpt-5.6");
	});
});
