import { expect, test } from "bun:test";
import { refreshModelContext } from "../src/index.ts";
import {
	buildModelContext,
	type CatalogPreview,
	MODEL_TYPES,
	type ModelSummary,
	type ModelType,
	SECTION_KEY,
	selectExamples,
} from "../src/prompt.ts";

function model(provider: string, id: string): ModelSummary {
	return {
		provider,
		id,
		name: `${provider} ${id}`,
		input: ["text"],
		contextWindow: 12000,
		reasoning: true,
	};
}

function prompt(
	overrides: Partial<Parameters<typeof buildModelContext>[0]> = {},
) {
	return buildModelContext({
		scopedModels: [],
		currentModel: undefined,
		previews: MODEL_TYPES.map((type) => ({ type, models: [] })),
		codemodeActive: true,
		...overrides,
	});
}

function harness() {
	const catalogs: Record<ModelType, readonly ModelSummary[]> = {
		chat: [model("tenant-provider", "chat-a")],
		image: [model("tenant-provider", "image-a")],
		classifier: [model("tenant-provider", "classifier-a")],
	};
	const calls: ModelType[] = [];
	const notifications: string[] = [];
	const failures = new Set<ModelType>();
	const ctx: Parameters<typeof refreshModelContext>[1] = {
		model: undefined,
		scopedModels: [],
		modelRegistry: {
			async getAvailableOfType(type: ModelType) {
				calls.push(type);
				if (failures.has(type)) throw new Error("private credential detail");
				return catalogs[type];
			},
		},
		ui: {
			notify(message: string, _level: "warning") {
				notifications.push(message);
			},
		},
	};
	return { ctx, catalogs, calls, notifications, failures };
}

const noTools = () => [];
const codemodeTools = () => ["read", "codemode"];

test("examples are live, unique, capped, and prefer distinct providers", () => {
	const candidates = [
		model("z-provider", "z"),
		model("a-provider", "b"),
		model("a-provider", "a"),
		model("a-provider", "a"),
	];
	expect(selectExamples(candidates, new Set())).toEqual([
		candidates[2],
		candidates[0],
	]);
	expect(candidates.map((item) => item.id)).toEqual(["z", "b", "a", "a"]);
});

test("one provider can supply both examples and scoped refs are excluded", () => {
	const candidates = [
		model("custom", "a"),
		model("custom", "b"),
		model("custom", "c"),
	];
	expect(selectExamples(candidates, new Set(["custom/a"]))).toEqual(
		candidates.slice(1),
	);
	expect(selectExamples([], new Set())).toEqual([]);
	expect(selectExamples([candidates[0]], new Set())).toEqual([candidates[0]]);
});

test("scope preserves exact live refs, metadata and thinking levels", () => {
	const scoped = model("dynamic-provider", "new-model");
	const text = prompt({
		currentModel: scoped,
		scopedModels: [{ model: scoped, thinkingLevel: "high" }],
		previews: [
			{ type: "chat", models: [scoped, model("other", "additional")] },
		],
	});
	expect(text).toContain("Current chat model: dynamic-provider/new-model.");
	expect(text).toContain("scoped thinking: high");
	expect(text).toContain("context: 12000 tokens");
	expect(text).toContain("reasoning: yes");
	expect(text).toContain("other/additional");
	expect(text).toContain(
		"Additional chat examples do not expand the explicit scope",
	);
	expect(text.match(/- dynamic-provider\/new-model/g)).toHaveLength(1);
});

test("an empty scope means all available, not no models", () => {
	expect(prompt()).toContain(
		"No explicit scope is configured; all available chat models are in scope.",
	);
});

test("empty catalogs and exhausted additional chat examples are distinguished", () => {
	const scoped = model("custom", "scoped");
	const text = prompt({
		scopedModels: [{ model: scoped }],
		previews: [
			{ type: "chat", models: [scoped] },
			{ type: "image", models: [] },
		],
	});
	expect(text).toContain("chat: 1 available catalog entries.");
	expect(text).toContain("No additional examples outside the explicit scope.");
	expect(text).toContain("image: 0 available catalog entries.");
	expect(text).toContain("No available examples.");
});

test("at most two previews per type, with accurate unique counts", () => {
	const previews: CatalogPreview[] = MODEL_TYPES.map((type) => ({
		type,
		models: [
			model("live-provider", `${type}-a`),
			model("live-provider", `${type}-b`),
			model("live-provider", `${type}-c`),
			model("live-provider", `${type}-a`),
		],
	}));
	const text = prompt({ previews });
	for (const type of MODEL_TYPES) {
		expect(text).toContain(`${type}: 3 available catalog entries.`);
		expect(text).toContain(`live-provider/${type}-a`);
		expect(text).toContain(`live-provider/${type}-b`);
		expect(text).not.toContain(`live-provider/${type}-c`);
	}
});

test("active codemode gets actionable instructions without implying chat execution", () => {
	const text = prompt();
	expect(text).toContain(
		'const entries = await models.getAvailableOfType("chat");',
	);
	expect(text).toContain("text(entries.map");
	expect(text).toContain("models.getModelsOfType(type, provider?)");
	expect(text).toContain("models.getModelOfType(type, provider, id)");
	expect(text).toContain("raw JavaScript");
	expect(text).toContain("cannot run them");
	expect(text).toContain("not a guarantee");
	expect(text).toContain("Filter or paginate");
});

test("inactive codemode produces no model context", () => {
	expect(prompt({ codemodeActive: false })).toBe("");
});

for (const tools of [[], ["read", "bash"]]) {
	test(`without codemode, refresh removes stale context and skips lookups (${tools.join(", ") || "no tools"})`, async () => {
		const { ctx, calls, notifications, failures } = harness();
		for (const type of MODEL_TYPES) failures.add(type);
		const sections: Record<string, string> = {
			[SECTION_KEY]: "stale preview",
			unrelated: "keep this",
		};
		await refreshModelContext(sections, ctx, () => tools);
		expect(sections).toEqual({ unrelated: "keep this" });
		expect(calls).toEqual([]);
		expect(notifications).toEqual([]);
	});
}

test("refresh reads every type and replaces only its own prompt section", async () => {
	const { ctx, calls, notifications } = harness();
	const sections = { [SECTION_KEY]: "stale preview", unrelated: "keep this" };
	await refreshModelContext(sections, ctx, codemodeTools);
	expect(calls).toEqual([...MODEL_TYPES]);
	expect(sections.unrelated).toBe("keep this");
	expect(sections[SECTION_KEY]).not.toContain("stale preview");
	expect(sections[SECTION_KEY]).toContain("tenant-provider/image-a");
	expect(sections[SECTION_KEY]).toContain("tenant-provider/classifier-a");
	expect(notifications).toEqual([]);
});

test("later runs reflect catalog, scope, current model and tool changes", async () => {
	const { ctx, catalogs } = harness();
	const sections: Record<string, string> = {};
	await refreshModelContext(sections, ctx, codemodeTools);
	catalogs.chat = [model("new-tenant", "replacement")];
	catalogs.image = [];
	ctx.scopedModels = [{ model: catalogs.chat[0], thinkingLevel: "low" }];
	ctx.model = catalogs.chat[0];
	await refreshModelContext(sections, ctx, noTools);
	expect(sections).not.toHaveProperty(SECTION_KEY);
	await refreshModelContext(sections, ctx, codemodeTools);
	expect(sections[SECTION_KEY]).toContain("new-tenant/replacement");
	expect(sections[SECTION_KEY]).toContain("scoped thinking: low");
	expect(sections[SECTION_KEY]).not.toContain("tenant-provider/chat-a");
	expect(sections[SECTION_KEY]).not.toContain("tenant-provider/image-a");
	expect(sections[SECTION_KEY]).toContain("call the codemode tool");
});

test("codemode disabled during lookups leaves no context or warnings", async () => {
	const { ctx, failures, notifications } = harness();
	failures.add("image");
	const sections: Record<string, string> = {
		[SECTION_KEY]: "stale preview",
		unrelated: "keep this",
	};
	let activeTools = codemodeTools();
	const pending = refreshModelContext(sections, ctx, () => activeTools);
	activeTools = noTools();
	await pending;
	expect(sections).toEqual({ unrelated: "keep this" });
	expect(notifications).toEqual([]);
});

test("partial failure keeps other previews without asserting availability or leaking errors", async () => {
	const { ctx, failures, notifications } = harness();
	failures.add("image");
	const sections: Record<string, string> = {};
	await refreshModelContext(sections, ctx, codemodeTools);
	expect(sections[SECTION_KEY]).toContain("image: availability lookup failed");
	expect(sections[SECTION_KEY]).not.toContain("image: 0 available");
	expect(sections[SECTION_KEY]).toContain("tenant-provider/chat-a");
	expect(sections[SECTION_KEY]).toContain("tenant-provider/classifier-a");
	expect(sections[SECTION_KEY]).not.toContain("private credential detail");
	expect(notifications).toEqual([
		"Model context: could not list available image models.",
	]);
});

test("stalled lookups time out and are aborted without losing successful previews", async () => {
	const { ctx, notifications, catalogs } = harness();
	let stalledSignal: AbortSignal | undefined;
	ctx.modelRegistry.getAvailableOfType = async (type, _provider, options) => {
		if (type !== "image") return catalogs[type];
		stalledSignal = options?.signal;
		return new Promise<readonly ModelSummary[]>(() => {});
	};
	const sections: Record<string, string> = {};
	await refreshModelContext(sections, ctx, codemodeTools, 10);
	expect(stalledSignal?.aborted).toBe(true);
	expect(sections[SECTION_KEY]).toContain("image: availability lookup failed");
	expect(sections[SECTION_KEY]).toContain("tenant-provider/chat-a");
	expect(notifications).toHaveLength(1);
});

test("complete failure still supplies the scope and discovery instructions", async () => {
	const { ctx, failures } = harness();
	for (const type of MODEL_TYPES) failures.add(type);
	ctx.scopedModels = [{ model: model("custom", "scoped") }];
	const sections: Record<string, string> = {};
	await refreshModelContext(sections, ctx, codemodeTools);
	expect(sections[SECTION_KEY]).toContain("custom/scoped");
	expect(
		sections[SECTION_KEY].match(/availability lookup failed/g),
	).toHaveLength(3);
	expect(sections[SECTION_KEY]).toContain("models.getAvailableOfType");
});
