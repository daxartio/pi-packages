import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	type CandidateFacts,
	type CandidateModel,
	type Classification,
	classifyPrompt,
} from "./classifier.ts";
import {
	type AutoModelConfig,
	getConfigPath,
	loadConfig,
	type ThinkingLevel,
	toggleConfig,
} from "./config.ts";
import {
	formatCandidate,
	modelKey,
	resolveCandidate,
	selectableModels,
} from "./router.ts";

const STATUS_KEY = "auto-model";
const ACCEPT_SHORTCUT = "ctrl+alt+a" as Parameters<
	ExtensionAPI["registerShortcut"]
>[0];
const MAX_ERROR_LENGTH = 300;
/** The offer dialog auto-dismisses after this long; the pending offer itself never expires. */
const OFFER_DIALOG_TIMEOUT_MS = 2 * 60 * 1000;

interface PendingOffer {
	classification: Classification;
	candidate: CandidateModel;
	targetThinkingLevel: ThinkingLevel | undefined;
	currentRef: string;
	currentThinkingLevel: string;
}

function conciseError(value: unknown): string {
	const message = value instanceof Error ? value.message : String(value);
	return message.length <= MAX_ERROR_LENGTH
		? message
		: `${message.slice(0, MAX_ERROR_LENGTH)}…`;
}

function thinkingCapSupported(
	model: Model<Api>,
	level: ThinkingLevel,
): boolean {
	if (level === "off") return true;
	if (!model.reasoning) return false;
	return model.thinkingLevelMap?.[level] !== null;
}

function defaultThinkingFor(model: Model<Api>): ThinkingLevel {
	return model.reasoning ? "medium" : "off";
}

export default function autoModel(pi: ExtensionAPI): void {
	const configPath = getConfigPath(getAgentDir());
	let config: AutoModelConfig | undefined;
	let routing = false;
	let pending: PendingOffer | undefined;
	/** Candidate refs the user approved with "Always" during this session. */
	const autoAccept = new Set<string>();

	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(
			STATUS_KEY,
			config?.enabled ? ctx.ui.theme.fg("dim", "auto:model") : undefined,
		);
	};

	const clearPending = () => {
		pending = undefined;
	};

	const pickThinkingLevel = (
		model: Model<Api>,
		classification: Classification,
	): ThinkingLevel => {
		const wanted = classification.thinkingLevel ?? defaultThinkingFor(model);
		return thinkingCapSupported(model, wanted)
			? wanted
			: defaultThinkingFor(model);
	};

	/** Switch to the candidate, restoring the previous model when activation fails. */
	const applyCandidate = async (
		ctx: ExtensionContext,
		candidate: CandidateModel,
		thinkingLevel: ThinkingLevel | undefined,
		restoreRef: string,
	): Promise<boolean> => {
		const available = ctx.modelRegistry.getAvailable();
		const target = resolveCandidate(candidate, available);
		if (!target) {
			ctx.ui.notify(`Auto model: ${candidate.ref} is not available.`, "error");
			return false;
		}
		let switched = false;
		try {
			switched = await pi.setModel(target);
		} catch {
			switched = false;
		}
		if (!switched) {
			ctx.ui.notify(
				`Auto model: could not activate ${candidate.ref} (authentication?).`,
				"error",
			);
			return false;
		}
		const current = ctx.model;
		if (!current || modelKey(current) !== candidate.ref) {
			const restore = available.find((model) => modelKey(model) === restoreRef);
			if (restore) await pi.setModel(restore).catch(() => false);
			ctx.ui.notify(
				"Auto model: switch did not stick, restored the previous model.",
				"warning",
			);
			return false;
		}
		if (thinkingLevel) pi.setThinkingLevel(thinkingLevel);
		return true;
	};

	const acceptPending = async (
		ctx: ExtensionContext,
		remember: boolean,
	): Promise<void> => {
		const offer = pending;
		if (!offer) {
			ctx.ui.notify("No pending auto-model suggestion.", "info");
			return;
		}
		clearPending();
		const switched = await applyCandidate(
			ctx,
			offer.candidate,
			offer.targetThinkingLevel,
			offer.currentRef,
		);
		if (!switched) return;
		if (remember) autoAccept.add(offer.candidate.ref);
		ctx.ui.notify(
			`Auto model: switched to ${formatCandidate(offer.candidate, offer.targetThinkingLevel)} — new requests will use it.`,
			"info",
		);
	};

	/** Show the suggestion dialog without blocking the session: on timeout the offer stays pending. */
	const offerPrompt = async (
		ctx: ExtensionContext,
		offer: PendingOffer,
	): Promise<void> => {
		const targetLabel = formatCandidate(
			offer.candidate,
			offer.targetThinkingLevel,
		);
		const currentLabel = `${offer.currentRef}:${offer.currentThinkingLevel}`;
		const reason = offer.classification.reason
			? `\nReason: ${offer.classification.reason}`
			: "";
		const choice = await ctx.ui.select(
			`Auto model suggests ${targetLabel} (current: ${currentLabel})${reason}`,
			[
				`Switch to ${targetLabel}`,
				`Always switch to ${offer.candidate.ref} this session`,
				"Keep current model",
			],
			{ timeout: OFFER_DIALOG_TIMEOUT_MS },
		);
		if (pending !== offer) return; // superseded or dismissed meanwhile
		if (choice?.startsWith("Always")) {
			await acceptPending(ctx, true);
		} else if (choice?.startsWith("Switch")) {
			await acceptPending(ctx, false);
		} else if (choice) {
			clearPending();
			ctx.ui.notify("Auto model: keeping current model.", "info");
		}
		// Timeout/dismiss keeps the offer pending; the session continues with the current model.
	};

	const routePrompt = async (
		prompt: string,
		images: unknown[] | undefined,
		ctx: ExtensionContext,
	): Promise<void> => {
		if (!config?.enabled || routing) return;
		if (prompt.trim() === "") return;
		routing = true;
		try {
			const activeConfig = config;
			const available = ctx.modelRegistry.getAvailable();
			const candidates = selectableModels(available, ctx.scopedModels).map(
				(candidate) => ({
					...candidate,
					hint: activeConfig.modelHints?.[candidate.ref],
				}),
			);
			if (candidates.length < 2) return; // nothing to choose between
			const candidateFacts: (CandidateFacts | undefined)[] = candidates.map(
				(candidate) => {
					const model = resolveCandidate(candidate, available);
					if (!model) return undefined;
					return {
						reasoning: model.reasoning,
						contextWindow: model.contextWindow,
						input: model.input,
						cost: { input: model.cost?.input, output: model.cost?.output },
					};
				},
			);

			const classifierModel = ctx.model; // the chat's current model classifies its own prompt
			if (!classifierModel) return;
			const currentRef = modelKey(classifierModel);
			const currentThinking = String(ctx.thinkingLevel ?? "unknown");

			let classification: Classification;
			try {
				classification = await classifyPrompt(
					(model, context, options) =>
						ctx.modelRegistry.complete(model as Model<Api>, context, options),
					{
						model: classifierModel,
						prompt,
						imageCount: images?.length ?? 0,
						config: activeConfig,
						candidates,
						candidateFacts,
						currentRef,
						currentThinkingLevel: currentThinking,
						classifierThinkingLevel:
							activeConfig.classifierThinkingLevel ?? "off",
						signal: ctx.signal,
					},
				);
			} catch (error: unknown) {
				ctx.ui.notify(
					`Auto model classifier failed (keeping current model): ${conciseError(error)}`,
					"warning",
				);
				return;
			}

			const candidate = candidates[classification.index];
			if (!candidate) return;
			const target = resolveCandidate(candidate, available);
			if (!target) {
				ctx.ui.notify(
					`Auto model: suggested ${candidate.ref}, but it is unavailable.`,
					"warning",
				);
				return;
			}
			const targetThinking = pickThinkingLevel(target, classification);
			const sameModel = candidate.ref === currentRef;
			const sameThinking = String(targetThinking) === currentThinking;

			if (!sameModel && autoAccept.has(candidate.ref)) {
				const switched = await applyCandidate(
					ctx,
					candidate,
					targetThinking,
					currentRef ?? "",
				);
				if (switched) {
					ctx.ui.notify(
						`Auto model: switched to ${formatCandidate(candidate, targetThinking)} (remembered choice) — new requests will use it.`,
						"info",
					);
				}
				return;
			}

			if (sameModel && sameThinking) return; // current setup already matches the recommendation

			pending = {
				classification,
				candidate,
				targetThinkingLevel: targetThinking,
				currentRef: currentRef ?? "unknown",
				currentThinkingLevel: currentThinking,
			};

			if (ctx.hasUI) {
				await offerPrompt(ctx, pending);
			} else {
				ctx.ui.notify(
					`Auto model suggests ${formatCandidate(candidate, targetThinking)} — /automodel accept to switch, /automodel dismiss to ignore.`,
					"info",
				);
			}
		} finally {
			routing = false;
		}
	};

	pi.registerShortcut(ACCEPT_SHORTCUT, {
		description: "Accept the pending auto-model suggestion (switch model)",
		handler: async (ctx) => {
			await acceptPending(ctx, false);
		},
	});

	pi.registerCommand("automodel", {
		description: "Toggle auto model routing, or use status/accept/dismiss",
		getArgumentCompletions: (prefix) =>
			["status", "accept", "dismiss"]
				.filter((item) => item.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (command === "") {
				try {
					const toggled = await toggleConfig(configPath);
					config = toggled.config;
					updateStatus(ctx);
					ctx.ui.notify(
						toggled.created
							? `Auto model config created at ${configPath}. Auto model enabled.`
							: `Auto model ${config.enabled ? "enabled" : "disabled"}.`,
						"info",
					);
				} catch (error: unknown) {
					ctx.ui.notify(
						`Could not toggle auto model: ${conciseError(error)}`,
						"error",
					);
				}
				return;
			}
			if (command === "accept") {
				await acceptPending(ctx, false);
				return;
			}
			if (command === "dismiss") {
				if (pending) {
					clearPending();
					ctx.ui.notify("Auto model suggestion dismissed.", "info");
				} else {
					ctx.ui.notify("No pending auto-model suggestion.", "info");
				}
				return;
			}
			if (command !== "status") {
				ctx.ui.notify(
					"Usage: /automodel [status|accept|dismiss] (no arguments toggles routing).",
					"info",
				);
				return;
			}
			const current = ctx.model ? modelKey(ctx.model) : "none";
			const lines = [
				`enabled: ${config?.enabled ?? false}`,
				`classifier: current chat model (thinking: ${config?.classifierThinkingLevel ?? "off"})`,
				`current model: ${current} (thinking: ${ctx.thinkingLevel ?? "unknown"})`,
				`scoped models: ${ctx.scopedModels.length === 0 ? "all available" : ctx.scopedModels.map((item) => modelKey(item.model)).join(", ")}`,
				`pending suggestion: ${pending ? formatCandidate(pending.candidate, pending.targetThinkingLevel) : "none"}`,
				`auto-accepted this session: ${autoAccept.size === 0 ? "none" : [...autoAccept].join(", ")}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await loadConfig(configPath);
		config = loaded.config;
		routing = false;
		clearPending();
		autoAccept.clear();
		if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
		if (!config) {
			ctx.ui.notify(
				`pi-auto-model: no config at ${configPath}. Run /automodel to create it and enable routing.`,
				"info",
			);
		}
		updateStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		clearPending();
		routing = false;
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Fire and forget: the current model's turn is never blocked by classification.
		void routePrompt(event.prompt, event.images, ctx);
	});
}
