import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import {
	type ClientRequest,
	request as httpRequest,
	type IncomingMessage,
} from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { TextDecoder } from "node:util";
import { createBrotliDecompress, createUnzip } from "node:zlib";
import ipaddr from "ipaddr.js";

export type Resource =
	| { kind: "render" }
	| { kind: "text"; text: string; contentType: string };
export interface ResourceOptions {
	signal: AbortSignal;
}
export type ResourceReader = (
	url: string,
	options: ResourceOptions,
) => Promise<Resource>;
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;
export type Requester = (
	url: URL,
	options: RequestOptions,
	response: (message: IncomingMessage) => void,
) => ClientRequest;

interface ReaderOptions {
	allowPrivate?: () => boolean;
	resolve?: Resolver;
	request?: Requester;
	maxBytes?: number;
}

export function isPublicAddress(address: string): boolean {
	return (
		ipaddr.isValid(address) && ipaddr.process(address).range() === "unicast"
	);
}

function parseUrl(value: string | URL): URL {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("Only HTTP(S) URLs are supported");
	if (url.username || url.password)
		throw new Error("Credentials in URLs are not supported");
	return url;
}

async function withAbort<T>(
	operation: () => Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve()
			.then(() => {
				signal.throwIfAborted();
				return operation();
			})
			.then(
				(value) => {
					signal.removeEventListener("abort", abort);
					resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", abort);
					reject(error);
				},
			);
	});
}

function mime(response: IncomingMessage): string {
	return (
		(response.headers["content-type"] ?? "")
			.split(";", 1)[0]
			?.trim()
			.toLowerCase() ?? ""
	);
}

function isHtml(type: string): boolean {
	return (
		type === "text/html" ||
		type === "application/xhtml+xml" ||
		type === "application/pdf"
	);
}

function isText(type: string): boolean {
	return (
		type.startsWith("text/") ||
		/\/(?:json|xml|javascript|x-javascript|yaml|x-yaml|toml)$/.test(type) ||
		/\+(?:json|xml)$/.test(type)
	);
}

export class HttpResourceReader {
	private readonly allowPrivate: () => boolean;
	private readonly resolve: Resolver;
	private readonly request: Requester;
	private readonly maxBytes: number;

	constructor(options: ReaderOptions = {}) {
		this.allowPrivate =
			options.allowPrivate ??
			(() => process.env.SERVO_FETCH_ALLOW_PRIVATE === "1");
		this.resolve =
			options.resolve ??
			((hostname) => lookup(hostname, { all: true, verbatim: true }));
		this.request =
			options.request ??
			((url, options, response) =>
				(url.protocol === "https:" ? httpsRequest : httpRequest)(
					url,
					options,
					response,
				));
		this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
	}

	readonly read: ResourceReader = async (value, { signal }) => {
		signal.throwIfAborted();
		const url = parseUrl(value);
		const head = await this.follow(url, "HEAD", signal);
		const type = mime(head);
		const status = head.statusCode ?? 0;
		head.destroy();
		if (status >= 200 && status < 300 && isHtml(type))
			return { kind: "render" };
		const response = await this.follow(url, "GET", signal);
		try {
			if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300)
				throw new Error(
					`HTTP resource returned status ${response.statusCode ?? 0}`,
				);
			const type = mime(response);
			if (isHtml(type)) return { kind: "render" };
			if (type && !isText(type))
				throw new Error("Unsupported non-text HTTP resource");
			const buffer = await this.readBody(response, signal);
			const charset =
				/charset\s*=\s*["']?([^;\s"']+)/i.exec(
					response.headers["content-type"] ?? "",
				)?.[1] ?? "utf-8";
			const text = new TextDecoder(charset).decode(buffer);
			if (!type && /^\s*(?:<!doctype\s+html|<html\b)/i.test(text))
				return { kind: "render" };
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject binary bodies when MIME is absent.
			if (!type && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
				throw new Error("Unsupported binary HTTP resource");
			return { kind: "text", text, contentType: type || "text/plain" };
		} finally {
			response.destroy();
		}
	};

	private async address(url: URL, signal: AbortSignal): Promise<LookupAddress> {
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		const privateAllowed = this.allowPrivate();
		if (
			!privateAllowed &&
			(hostname.toLowerCase() === "localhost" ||
				hostname.toLowerCase().endsWith(".localhost"))
		)
			throw new Error("Private or reserved HTTP addresses are blocked");
		const family = isIP(hostname);
		const addresses = family
			? [{ address: hostname, family }]
			: await withAbort(() => this.resolve(hostname), signal);
		signal.throwIfAborted();
		if (!addresses.length) throw new Error("HTTP hostname has no addresses");
		if (
			addresses.some(
				(entry) =>
					!isIP(entry.address) ||
					isIP(entry.address) !== entry.family ||
					(!privateAllowed && !isPublicAddress(entry.address)),
			)
		)
			throw new Error("Private or reserved HTTP addresses are blocked");
		const selected =
			addresses.find((entry) => entry.family === 4) ?? addresses[0];
		if (!selected) throw new Error("HTTP hostname has no addresses");
		return selected;
	}

	private async follow(
		initial: URL,
		method: "HEAD" | "GET",
		signal: AbortSignal,
	): Promise<IncomingMessage> {
		let url = initial;
		for (let redirect = 0; redirect <= 5; redirect++) {
			const address = await this.address(url, signal);
			const response = await new Promise<IncomingMessage>((resolve, reject) => {
				const request = this.request(
					url,
					{
						method,
						agent: false,
						family: address.family,
						rejectUnauthorized: true,
						signal,
						headers: {
							"accept-encoding": "identity",
							"user-agent": "pi-servo-fetch/0.1.0",
						},
						lookup(_hostname, options, callback) {
							callback(
								null,
								options.all ? [address] : address.address,
								address.family,
							);
						},
					},
					resolve,
				);
				request.once("error", (error) =>
					reject(signal.aborted ? signal.reason : error),
				);
				request.end();
			});
			response.on("error", () => {});
			if (![301, 302, 303, 307, 308].includes(response.statusCode ?? 0))
				return response;
			const location = response.headers.location;
			response.destroy();
			if (!location) throw new Error("HTTP redirect has no Location header");
			if (redirect === 5) throw new Error("Too many HTTP redirects");
			url = parseUrl(new URL(location, url));
		}
		throw new Error("Too many HTTP redirects");
	}

	private async readBody(
		response: IncomingMessage,
		signal: AbortSignal,
	): Promise<Buffer> {
		const encoding = (response.headers["content-encoding"] ?? "identity")
			.trim()
			.toLowerCase();
		const decoder =
			encoding === "gzip" || encoding === "deflate"
				? createUnzip()
				: encoding === "br"
					? createBrotliDecompress()
					: undefined;
		if (!decoder && encoding !== "identity")
			throw new Error("Unsupported HTTP content encoding");
		let body: Readable = response;
		if (decoder) {
			response.on("error", (error) => decoder.destroy(error));
			body = response.pipe(decoder);
		}
		const chunks: Buffer[] = [];
		let length = 0;
		try {
			for await (const chunk of body) {
				signal.throwIfAborted();
				if (!Buffer.isBuffer(chunk))
					throw new Error("Unexpected HTTP response data");
				length += chunk.length;
				if (length > this.maxBytes)
					throw new Error("HTTP text resource exceeds the size limit");
				chunks.push(chunk);
			}
			signal.throwIfAborted();
			return Buffer.concat(chunks, length);
		} catch (error) {
			signal.throwIfAborted();
			throw error;
		} finally {
			decoder?.destroy();
		}
	}
}

export const readResource: ResourceReader = (url, options) =>
	new HttpResourceReader().read(url, options);
