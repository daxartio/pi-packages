import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Article, FetchOptions } from "servo-fetch";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { extractSnapshot, snapshotExpression } from "./extraction.js";
import { type ResourceReader, readResource } from "./http.js";
import {
	jsonResult,
	type OutputDetails,
	screenshotResult,
	textResult,
} from "./output.js";
import {
	BatchParams,
	EvaluateParams,
	FetchParams,
	MapParams,
	ScreenshotParams,
} from "./schema.js";

export type ServoBackend = Pick<
	typeof import("servo-fetch"),
	"map" | "evaluate" | "screenshot" | "shutdown"
>;
export type BackendLoader = () => Promise<ServoBackend>;

interface FetchedPage {
	value: string | Article;
	details: OutputDetails;
}

type BatchPage =
	| {
			url: string;
			ok: true;
			markdown: string;
			source?: OutputDetails["source"];
			extraction?: OutputDetails["extraction"];
			contentType?: string;
			selectorIgnored?: boolean;
	  }
	| { url: string; ok: false; error: string };

function validate<T extends TSchema>(schema: T, params: Static<T>): void {
	if (!Value.Check(schema, params))
		throw new Error("Invalid servo-fetch parameters");
}

function validateUrl(value: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("A valid HTTP(S) URL is required");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP(S) URLs are supported");
	}
	if (url.username || url.password) {
		throw new Error("Credentials in URLs are not supported");
	}
}

function options(
	params: Pick<FetchOptions, "timeout" | "settle">,
	signal?: AbortSignal,
): FetchOptions {
	return { timeout: 30, settle: 0, ...params, signal };
}

export class ServoClient {
	private backend?: Promise<ServoBackend>;
	private generation = 0;
	private stopping?: Promise<void>;
	private lifecycle = new AbortController();

	constructor(
		private readonly load: BackendLoader = () => import("servo-fetch"),
		private readonly read: ResourceReader = readResource,
	) {}

	private requestSignal(
		timeout: number | undefined,
		signal?: AbortSignal,
	): AbortSignal {
		return AbortSignal.any([
			this.lifecycle.signal,
			AbortSignal.timeout((timeout ?? 30) * 1000),
			...(signal ? [signal] : []),
		]);
	}

	private assertActive(generation: number, signal?: AbortSignal): void {
		signal?.throwIfAborted();
		if (this.stopping || generation !== this.generation)
			throw new Error("Servo client was reset; retry the request");
	}

	private async getBackend(signal?: AbortSignal): Promise<ServoBackend> {
		const generation = this.generation;
		this.assertActive(generation, signal);
		this.backend ??= this.load().catch((error: unknown) => {
			this.backend = undefined;
			throw error;
		});
		const backend = await this.backend;
		this.assertActive(generation, signal);
		return backend;
	}

	private async run<T>(
		signal: AbortSignal | undefined,
		operation: (backend: ServoBackend) => Promise<T>,
	): Promise<T> {
		const generation = this.generation;
		const backend = await this.getBackend(signal);
		const result = await operation(backend);
		this.assertActive(generation, signal);
		return result;
	}

	async fetch(
		params: Static<typeof FetchParams>,
		signal?: AbortSignal,
	): Promise<AgentToolResult<OutputDetails>> {
		validate(FetchParams, params);
		validateUrl(params.url);
		const page = await this.fetchPage(params, signal);
		const result =
			typeof page.value === "string"
				? await textResult(page.value)
				: await jsonResult(page.value);
		return { ...result, details: { ...result.details, ...page.details } };
	}

	private async fetchPage(
		params: Static<typeof FetchParams>,
		signal?: AbortSignal,
	): Promise<FetchedPage> {
		const { url, format = "markdown", ...render } = params;
		const generation = this.generation;
		const requestSignal = this.requestSignal(render.timeout, signal);
		this.assertActive(generation, requestSignal);
		const resource = await this.read(url, { signal: requestSignal });
		this.assertActive(generation, requestSignal);
		if (resource.kind === "text") {
			if (format !== "markdown" && format !== "text")
				throw new Error(
					"Raw text resources support only markdown or text; HTML/Readability JSON require an HTML page",
				);
			const selectorIgnored = render.selector !== undefined;
			const warning = selectorIgnored
				? "\n\n[Selector applies only to HTML; returned the complete raw text resource.]"
				: "";
			return {
				value: resource.text + warning,
				details: {
					source: "http",
					contentType: resource.contentType,
					...(selectorIgnored ? { selectorIgnored: true } : {}),
				},
			};
		}
		const snapshot = await this.run(requestSignal, (backend) =>
			backend.evaluate(
				url,
				snapshotExpression({
					format,
					selector: render.selector,
					visibility: render.visibility,
				}),
				options(
					{ timeout: render.timeout ?? 30, settle: render.settle ?? 0 },
					requestSignal,
				),
			),
		);
		const value = extractSnapshot(snapshot, format);
		this.assertActive(generation, requestSignal);
		return { value, details: { source: "servo", extraction: "local-dom" } };
	}

	async batch(
		params: Static<typeof BatchParams>,
		signal?: AbortSignal,
	): Promise<AgentToolResult<OutputDetails>> {
		validate(BatchParams, params);
		for (const url of params.urls) validateUrl(url);
		const { urls, concurrency = 2, ...render } = params;
		const generation = this.generation;
		const batchSignal = AbortSignal.any([
			this.lifecycle.signal,
			...(signal ? [signal] : []),
		]);
		this.assertActive(generation, batchSignal);
		const results: BatchPage[] = new Array(urls.length);
		let next = 0;
		const worker = async () => {
			while (next < urls.length) {
				this.assertActive(generation, batchSignal);
				const index = next++;
				const url = urls[index];
				if (url === undefined) throw new Error("Missing batch URL");
				try {
					const page = await this.fetchPage({ url, ...render }, batchSignal);
					if (typeof page.value !== "string")
						throw new Error("Expected Markdown result");
					results[index] = {
						url,
						ok: true,
						markdown: page.value,
						...page.details,
					};
				} catch (error) {
					this.assertActive(generation, batchSignal);
					results[index] = {
						url,
						ok: false,
						error:
							error instanceof Error ? error.message : "Unknown fetch error",
					};
				}
			}
		};
		const workers = await Promise.allSettled(
			Array.from({ length: Math.min(concurrency, urls.length) }, worker),
		);
		this.assertActive(generation, batchSignal);
		const failure = workers.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
		return jsonResult(results);
	}

	async map(
		params: Static<typeof MapParams>,
		signal?: AbortSignal,
	): Promise<AgentToolResult<OutputDetails>> {
		validate(MapParams, params);
		validateUrl(params.url);
		const { url, limit = 100, ...discovery } = params;
		const results = await this.run(signal, (backend) =>
			backend.map(url, { timeout: 30, ...discovery, limit, signal }),
		);
		return jsonResult(results);
	}

	async evaluate(
		params: Static<typeof EvaluateParams>,
		signal?: AbortSignal,
	): Promise<AgentToolResult<OutputDetails>> {
		validate(EvaluateParams, params);
		validateUrl(params.url);
		const { url, expression, ...render } = params;
		const result = await this.run(signal, (backend) =>
			backend.evaluate(url, expression, options(render, signal)),
		);
		return textResult(result);
	}

	async screenshot(
		params: Static<typeof ScreenshotParams>,
		signal?: AbortSignal,
	): Promise<AgentToolResult<OutputDetails>> {
		validate(ScreenshotParams, params);
		validateUrl(params.url);
		const { url, fullPage = false, ...render } = params;
		const png = await this.run(signal, (backend) =>
			backend.screenshot(url, { ...options(render, signal), fullPage }),
		);
		return screenshotResult(png);
	}

	shutdown(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.generation++;
		this.lifecycle.abort(
			new Error("Servo client was reset; retry the request"),
		);
		this.lifecycle = new AbortController();
		const pending = this.backend;
		this.backend = undefined;
		this.stopping = this.stop(pending).finally(() => {
			this.stopping = undefined;
		});
		return this.stopping;
	}

	private async stop(pending?: Promise<ServoBackend>): Promise<void> {
		if (pending) (await pending).shutdown();
	}
}
