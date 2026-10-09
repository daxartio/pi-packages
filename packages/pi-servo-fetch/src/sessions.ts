import { randomUUID } from "node:crypto";
import type { Session, SessionFetchOptions } from "servo-fetch";

export type BrowserSession = Pick<Session, "fetch" | "close">;
export const MAX_SESSIONS = 8;

interface SessionEntry {
	ready: Promise<BrowserSession>;
	controller: AbortController;
	state: "opening" | "open" | "closing";
	closing?: Promise<void>;
}

export class BrowserSessions {
	private readonly entries = new Map<string, SessionEntry>();
	private clearing?: Promise<void>;

	async open(
		create: () => Promise<BrowserSession>,
		signal?: AbortSignal,
	): Promise<string> {
		signal?.throwIfAborted();
		if (this.clearing)
			throw new Error("Browser sessions are being cleared; retry the request");
		if (this.entries.size >= MAX_SESSIONS)
			throw new Error(
				`At most ${MAX_SESSIONS} browser sessions can be open; close one first`,
			);
		const sessionId = randomUUID();
		const entry: SessionEntry = {
			ready: Promise.resolve().then(create),
			controller: new AbortController(),
			state: "opening",
		};
		this.entries.set(sessionId, entry);
		try {
			await entry.ready;
			signal?.throwIfAborted();
			entry.controller.signal.throwIfAborted();
			entry.state = "open";
			return sessionId;
		} catch (error) {
			try {
				await this.closeEntry(sessionId, entry);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"Failed to open and clean up browser session",
				);
			}
			throw error;
		}
	}

	list(): { sessionId: string; state: SessionEntry["state"] }[] {
		return [...this.entries].map(([sessionId, entry]) => ({
			sessionId,
			state: entry.state,
		}));
	}

	async fetch(
		sessionId: string,
		url: string,
		options: SessionFetchOptions,
	): Promise<string> {
		const entry = this.require(sessionId);
		if (entry.state !== "open") throw new Error("Browser session is not open");
		const signal = AbortSignal.any([
			entry.controller.signal,
			...(options.signal ? [options.signal] : []),
		]);
		signal.throwIfAborted();
		const session = await entry.ready;
		signal.throwIfAborted();
		const result = await session.fetch(url, { ...options, signal });
		signal.throwIfAborted();
		return result;
	}

	close(sessionId: string): Promise<void> {
		return this.closeEntry(sessionId, this.require(sessionId));
	}

	clear(): Promise<void> {
		this.clearing ??= this.clearEntries().finally(() => {
			this.clearing = undefined;
		});
		return this.clearing;
	}

	private require(sessionId: string): SessionEntry {
		const entry = this.entries.get(sessionId);
		if (!entry)
			throw new Error(
				"Unknown or closed browser session; use servo_fetch_session_list to find an active UUID or servo_fetch_session_open to create one. For stateless requests use servo_fetch.",
			);
		return entry;
	}

	private closeEntry(sessionId: string, entry: SessionEntry): Promise<void> {
		if (!entry.closing) {
			entry.state = "closing";
			entry.controller.abort(new Error("Browser session closed"));
			entry.closing = entry.ready
				.then(
					(session) => session.close(),
					() => undefined,
				)
				.finally(() => {
					this.entries.delete(sessionId);
				});
		}
		return entry.closing;
	}

	private async clearEntries(): Promise<void> {
		const results = await Promise.allSettled(
			[...this.entries].map(([id, entry]) => this.closeEntry(id, entry)),
		);
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length)
			throw new AggregateError(
				failures.map((result) => result.reason),
				"Failed to close browser sessions",
			);
	}
}
