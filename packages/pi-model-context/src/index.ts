import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildModelContext,
	MODEL_TYPES,
	type ModelSummary,
	type ModelType,
	type ScopedModelSummary,
	SECTION_KEY,
} from "./prompt.ts";

interface ModelContext {
	model: ModelSummary | undefined;
	scopedModels: readonly ScopedModelSummary[];
	modelRegistry: {
		getAvailableOfType(
			type: ModelType,
			provider?: string,
			options?: { signal?: AbortSignal },
		): Promise<readonly ModelSummary[]>;
	};
	ui: {
		notify(message: string, level: "warning"): void;
	};
}

async function lookupModels(
	ctx: ModelContext,
	type: ModelType,
	timeoutMs: number,
): Promise<readonly ModelSummary[]> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error("Model catalog lookup timed out"));
		}, timeoutMs);
	});
	try {
		return await Promise.race([
			ctx.modelRegistry.getAvailableOfType(type, undefined, {
				signal: controller.signal,
			}),
			deadline,
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function refreshModelContext(
	sections: Record<string, string>,
	ctx: ModelContext,
	getActiveTools: () => readonly string[],
	lookupTimeoutMs = 5000,
): Promise<void> {
	delete sections[SECTION_KEY];
	if (!getActiveTools().includes("codemode")) return;
	const results = await Promise.allSettled(
		MODEL_TYPES.map((type) => lookupModels(ctx, type, lookupTimeoutMs)),
	);
	if (!getActiveTools().includes("codemode")) return;
	const previews = MODEL_TYPES.map((type, index) => {
		const result = results[index];
		return {
			type,
			models: result?.status === "fulfilled" ? result.value : undefined,
		};
	});
	sections[SECTION_KEY] = buildModelContext({
		scopedModels: ctx.scopedModels,
		currentModel: ctx.model,
		previews,
		codemodeActive: true,
	});
	const failed = previews.filter((preview) => preview.models === undefined);
	if (failed.length > 0) {
		ctx.ui.notify(
			`Model context: could not list available ${failed.map((preview) => preview.type).join(", ")} models.`,
			"warning",
		);
	}
}

export default function modelContext(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event, ctx) =>
		refreshModelContext(event.systemPromptOptions.sections, ctx, () =>
			pi.getActiveTools(),
		),
	);
}
