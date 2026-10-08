export const MODEL_TYPES = ["chat", "image", "classifier"] as const;
export const SECTION_KEY = "model_context";
const PREVIEW_SIZE = 2;

export type ModelType = (typeof MODEL_TYPES)[number];

export interface ModelSummary {
	provider: string;
	id: string;
	name: string;
	input: readonly string[];
	contextWindow?: number;
	reasoning?: boolean;
}

export interface ScopedModelSummary {
	model: ModelSummary;
	thinkingLevel?: string;
}

export interface CatalogPreview {
	type: ModelType;
	models: readonly ModelSummary[] | undefined;
}

export function modelRef(model: ModelSummary): string {
	return `${model.provider}/${model.id}`;
}

function formatModel(model: ModelSummary): string {
	const facts = [model.name, `input: ${model.input.join(", ")}`];
	if (model.contextWindow !== undefined) {
		facts.push(`context: ${model.contextWindow} tokens`);
	}
	if (model.reasoning !== undefined) {
		facts.push(`reasoning: ${model.reasoning ? "yes" : "no"}`);
	}
	return `- ${modelRef(model)} (${facts.join("; ")})`;
}

export function selectExamples(
	models: readonly ModelSummary[],
	excluded: ReadonlySet<string>,
): ModelSummary[] {
	const unique = new Map<string, ModelSummary>();
	for (const model of models) {
		const ref = modelRef(model);
		if (!excluded.has(ref)) unique.set(ref, model);
	}
	const candidates = [...unique.values()].sort((a, b) =>
		modelRef(a).localeCompare(modelRef(b), "en"),
	);
	const selected: ModelSummary[] = [];
	const providers = new Set<string>();
	for (const model of candidates) {
		if (providers.has(model.provider)) continue;
		selected.push(model);
		providers.add(model.provider);
		if (selected.length === PREVIEW_SIZE) return selected;
	}
	for (const model of candidates) {
		if (selected.includes(model)) continue;
		selected.push(model);
		if (selected.length === PREVIEW_SIZE) break;
	}
	return selected;
}

export function buildModelContext(options: {
	scopedModels: readonly ScopedModelSummary[];
	currentModel: ModelSummary | undefined;
	previews: readonly CatalogPreview[];
	codemodeActive: boolean;
}): string {
	if (!options.codemodeActive) return "";
	const { scopedModels, currentModel, previews } = options;
	const lines = [
		"Live model discovery (catalog data, not model-selection recommendations).",
	];
	if (currentModel)
		lines.push(`Current chat model: ${modelRef(currentModel)}.`);
	lines.push("", "Session-scoped chat models:");
	if (scopedModels.length === 0) {
		lines.push(
			"No explicit scope is configured; all available chat models are in scope.",
		);
	} else {
		for (const item of scopedModels) {
			lines.push(
				`${formatModel(item.model)}${item.thinkingLevel ? `; scoped thinking: ${item.thinkingLevel}` : ""}`,
			);
		}
	}
	lines.push(
		"",
		"Available catalog previews (up to two examples per type; chat examples exclude the explicit scope):",
	);
	const scopedRefs = new Set(scopedModels.map((item) => modelRef(item.model)));
	for (const { type, models } of previews) {
		if (models === undefined) {
			lines.push(
				`${type}: availability lookup failed; no preview is asserted.`,
			);
			continue;
		}
		const examples = selectExamples(
			models,
			type === "chat" ? scopedRefs : new Set(),
		);
		const count = new Set(models.map(modelRef)).size;
		lines.push(`${type}: ${count} available catalog entries.`);
		if (examples.length === 0) {
			lines.push(
				type === "chat" && count > 0
					? "No additional examples outside the explicit scope."
					: "No available examples.",
			);
		} else {
			lines.push(...examples.map(formatModel));
		}
	}
	lines.push(
		"",
		"Availability reflects provider credentials and catalog filtering; it is not a guarantee that a request will succeed.",
		"Catalog availability and session scope are different. Additional chat examples do not expand the explicit scope or override model-selection instructions.",
		"Discovering a model does not switch the current model. Codemode can list chat models but cannot run them.",
		"",
	);
	lines.push(
		"To discover more models, call the codemode tool with raw JavaScript (not JSON or a markdown fence):",
		'const entries = await models.getAvailableOfType("chat");',
		"text(entries.map(m => ({ provider: m.provider, id: m.id, name: m.name, input: m.input, contextWindow: m.contextWindow })));",
		'Use "image" or "classifier" instead of "chat" for those types.',
		"Filter by provider with models.getAvailableOfType(type, provider).",
		"Use models.getModelsOfType(type, provider?) for all known entries, including models without credentials; omit the optional provider argument for the complete catalog.",
		"Use models.getModelOfType(type, provider, id) for one entry; provider and id are separate arguments.",
		"Filter or paginate large results before text() to avoid flooding the context.",
	);
	return lines.join("\n");
}
