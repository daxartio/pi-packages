import type {
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	matchesKey,
	type OverlayOptions,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { BtwExecResult } from "./btw.js";
import {
	assistantMessageText,
	type BtwTurn,
	userMessageText,
} from "./btw-messages.js";

const BTW_MAX_HEIGHT_RATIO = 0.85;
const BTW_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "bottom-center",
	width: "100%",
	maxHeight: `${BTW_MAX_HEIGHT_RATIO * 100}%`,
	margin: { left: 0, right: 0, bottom: 0 },
};

export interface BtwChatParams {
	history: BtwTurn[];
	onSubmit: (
		question: string,
		controller: AbortController,
	) => Promise<BtwExecResult>;
	onTurn: (turn: BtwTurn) => void;
	onClearHistory: () => void;
}

export interface ShowBtwOverlayParams extends BtwChatParams {
	ctx: { ui: Pick<ExtensionCommandContext["ui"], "custom"> };
	question?: string;
}

export class BtwOverlayController implements Component, Focusable {
	private readonly input: Input;
	private history: BtwTurn[];
	private request?: { question: string; controller: AbortController };
	private failure?: { question: string; error: string };
	private scrollOffset = 0;
	private trimmed = false;
	private closed = false;

	constructor(
		private readonly params: BtwChatParams,
		private readonly theme: Pick<Theme, "fg" | "bg">,
		private readonly tui: Pick<TUI, "requestRender"> & {
			terminal: Pick<TUI["terminal"], "rows">;
		},
		private readonly done: () => void,
	) {
		this.history = [...params.history];
		this.input = new Input({
			placeholder: "Ask a side question…",
			placeholderStyle: (text) => theme.fg("dim", text),
		});
		this.input.onSubmit = (question) => void this.submit(question);
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	async submit(text: string): Promise<void> {
		const question = text.trim();
		if (!question || this.request || this.closed) return;
		const request = { question, controller: new AbortController() };
		this.request = request;
		this.failure = undefined;
		this.trimmed = false;
		this.scrollOffset = 0;
		this.input.setValue("");
		this.tui.requestRender();

		try {
			const result = await this.params.onSubmit(question, request.controller);
			if (this.closed || request.controller.signal.aborted) return;
			switch (result.kind) {
				case "success": {
					const turn = {
						userMessage: result.userMessage,
						assistantMessage: result.assistantMessage,
					};
					this.params.onTurn(turn);
					this.history.push(turn);
					this.trimmed = result.trimmed ?? false;
					break;
				}
				case "error":
					this.failure = { question, error: result.error };
					break;
				case "aborted":
					break;
			}
		} catch (error) {
			if (!this.closed && !request.controller.signal.aborted) {
				this.failure = {
					question,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		} finally {
			this.request = undefined;
			if (!this.closed) this.tui.requestRender();
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.request?.controller.abort();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, Key.escape)) {
			this.dispose();
			this.done();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp)) {
			this.scrollOffset += matchesKey(data, Key.pageUp) ? this.bodyHeight() : 1;
		} else if (matchesKey(data, Key.down) || matchesKey(data, Key.pageDown)) {
			this.scrollOffset = Math.max(
				0,
				this.scrollOffset -
					(matchesKey(data, Key.pageDown) ? this.bodyHeight() : 1),
			);
		} else if (matchesKey(data, Key.ctrl("l"))) {
			if (!this.request) {
				this.params.onClearHistory();
				this.history = [];
				this.failure = undefined;
				this.trimmed = false;
				this.scrollOffset = 0;
			}
		} else {
			this.input.handleInput(data);
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const body: string[] = [];
		for (const turn of this.history) {
			body.push(
				...this.questionLines(userMessageText(turn.userMessage), width),
				...this.bodyLines(assistantMessageText(turn.assistantMessage), width),
				"",
			);
		}
		if (this.trimmed)
			body.push(
				...this.bodyLines("context trimmed to fit budget", width, "warning"),
			);
		if (this.request) {
			body.push(
				...this.questionLines(this.request.question, width),
				...this.bodyLines("…", width, "warning"),
			);
		} else if (this.failure) {
			body.push(
				...this.questionLines(this.failure.question, width),
				...this.bodyLines(this.failure.error, width, "error"),
			);
		} else if (body.length === 0) {
			body.push(
				...this.bodyLines(
					"This chat uses the main conversation as context. Messages stay here.",
					width,
					"muted",
				),
			);
		}

		const banner = truncateToWidth("  /btw · side chat", width, "…", false);
		const padded =
			banner + " ".repeat(Math.max(0, width - visibleWidth(banner)));
		const header = this.theme.bg(
			"customMessageBg",
			this.theme.fg("customMessageText", padded),
		);
		const hints = [
			this.request ? "Waiting… · Enter to send when ready" : "Enter to send",
			"↑/↓ to scroll",
		];
		if (!this.request && this.history.length > 0)
			hints.push("Ctrl+L to clear history");
		hints.push("Esc to close");
		const footer = truncateToWidth(
			this.theme.fg("dim", hints.join(" · ")),
			width,
			"…",
			false,
		);
		const input = width >= 3 ? this.input.render(width) : [">".slice(0, width)];
		const maxRows = this.maxRows();
		if (maxRows <= 5) return [...input, footer].slice(0, maxRows);

		const bodyHeight = this.bodyHeight();
		const excess = Math.max(0, body.length - bodyHeight);
		this.scrollOffset = Math.min(this.scrollOffset, excess);
		const start = excess - this.scrollOffset;
		return [
			header,
			"",
			...body.slice(start, start + bodyHeight),
			"",
			...input,
			footer,
		];
	}

	invalidate(): void {
		this.input.invalidate();
	}

	private maxRows(): number {
		return Math.max(
			1,
			Math.floor(this.tui.terminal.rows * BTW_MAX_HEIGHT_RATIO),
		);
	}

	private bodyHeight(): number {
		return Math.max(1, this.maxRows() - 5);
	}

	private questionLines(question: string, width: number): string[] {
		return this.bodyLines(`/btw ${question}`, width, "accent", 2);
	}

	private bodyLines(
		text: string,
		width: number,
		color?: "accent" | "muted" | "warning" | "error",
		padding = 4,
	): string[] {
		const pad = " ".repeat(Math.min(padding, Math.max(0, width - 1)));
		return text.split("\n").flatMap((line) => {
			const styled = color ? this.theme.fg(color, line || " ") : line || " ";
			return wrapTextWithAnsi(styled, Math.max(1, width - pad.length)).map(
				(wrapped) => pad + wrapped,
			);
		});
	}
}

export async function showBtwOverlay(
	params: ShowBtwOverlayParams,
): Promise<void> {
	let controller: BtwOverlayController | undefined;
	try {
		await params.ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				controller = new BtwOverlayController(params, theme, tui, done);
				if (params.question) void controller.submit(params.question);
				return controller;
			},
			{ overlay: true, overlayOptions: BTW_OVERLAY_OPTIONS },
		);
	} finally {
		controller?.dispose();
	}
}
