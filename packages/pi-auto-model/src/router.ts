import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./config.ts";
import type { CandidateModel } from "./classifier.ts";

export const ROUTE_ENTRY_TYPE = "auto-model-route";

interface ScopedModelLike {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

/** Models the router may pick from: the session scope, or every available model when unscoped. */
export function selectableModels(
	available: readonly Model<Api>[],
	scoped: readonly ScopedModelLike[],
): CandidateModel[] {
	if (scoped.length === 0) {
		return available.map((model) => ({
			ref: modelKey(model),
			provider: model.provider,
			model: model.id,
		}));
	}
	const availableKeys = new Set(available.map(modelKey));
	return scoped
		.filter((item) => availableKeys.has(modelKey(item.model)))
		.map((item) => ({
			ref: modelKey(item.model),
			provider: item.model.provider,
			model: item.model.id,
			scopedThinkingLevel: item.thinkingLevel,
		}));
}

export function resolveCandidate(
	candidate: CandidateModel,
	available: readonly Model<Api>[],
): Model<Api> | undefined {
	return available.find(
		(model) => model.provider === candidate.provider && model.id === candidate.model,
	);
}

export function formatCandidate(candidate: CandidateModel, thinkingLevel?: ThinkingLevel): string {
	const thinking = candidate.scopedThinkingLevel ?? thinkingLevel;
	return thinking ? `${candidate.ref}:${thinking}` : candidate.ref;
}
