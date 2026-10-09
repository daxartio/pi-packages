import { Readability } from "@mozilla/readability";
import { convert } from "html-to-text";
import { parseHTML } from "linkedom";
import { NodeHtmlMarkdown } from "node-html-markdown";
import type { Article } from "servo-fetch";

export type Format = "markdown" | "html" | "text" | "json";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_NODES = 50_000;
const ERROR_CODES = [
	"selector_invalid",
	"selector_missing",
	"content_empty",
	"too_large",
	"snapshot_failed",
] as const;
type ErrorCode = (typeof ERROR_CODES)[number];

function failure(code: ErrorCode | "snapshot_invalid", message: string): Error {
	return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** Browser-only expression: one rendered DOM snapshot, without mutating the page. */
export function snapshotExpression(params: {
	format: Format;
	selector?: string;
	visibility?: "moderate" | "strict" | "off";
}): string {
	const visibility =
		params.visibility ??
		(params.format === "html" && params.selector === undefined
			? "off"
			: "moderate");
	return `(() => {
		const selector = ${JSON.stringify(params.selector) ?? "undefined"};
		const visibility = ${JSON.stringify(visibility)};
		const limit = ${MAX_BYTES};
		const fail = (error, message) => JSON.stringify({ok: false, error, message});
		const bytes = value => {
			let size = 0;
			for (let i = 0; i < value.length; i++) {
				const c = value.charCodeAt(i);
				if (c < 128) size++;
				else if (c < 2048) size += 2;
				else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++; }
				else size += 3;
			}
			return size;
		};
		try {
			let roots;
			if (selector !== undefined) {
				let matches;
				try { matches = document.querySelectorAll(selector); }
				catch (_) { return fail('selector_invalid', 'Invalid CSS selector: ' + selector); }
				if (!matches.length) return fail('selector_missing', 'No elements match: ' + selector);
				if (matches.length > 1000) return fail('too_large', 'Selector exceeds 1000 matches');
				const selected = new Set(matches);
				roots = Array.from(matches).filter(node => {
					for (let parent = node.parentElement; parent; parent = parent.parentElement) {
						if (selected.has(parent)) return false;
					}
					return true;
				});
			} else roots = document.documentElement ? [document.documentElement] : [];
			let visited = 0;
			let size = 0;
			const hiddenCache = new Map();
			const hidden = element => {
				if (visibility === 'off') return false;
				const chain = [];
				let parent = element;
				while (parent && !hiddenCache.has(parent)) {
					if (++visited > ${MAX_NODES}) throw new Error('node_limit');
					chain.push(parent);
					parent = parent.parentElement;
				}
				let excluded = parent ? hiddenCache.get(parent) : false;
				while (chain.length) {
					const node = chain.pop();
					const metadata = node.localName === 'head' || (node.closest && node.closest('head'));
					if (!metadata && !excluded) {
						const style = getComputedStyle(node);
						excluded = node.hasAttribute('hidden') || (node.getAttribute('aria-hidden') || '').toLowerCase() === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
						if (!excluded && visibility === 'strict') {
							excluded = Number(style.opacity) === 0 && style.opacity !== '';
							if (!excluded && style.display !== 'contents') {
								const rect = node.getBoundingClientRect();
								excluded = rect.width <= 0 || rect.height <= 0;
							}
						}
					}
					hiddenCache.set(node, excluded);
				}
				return hiddenCache.get(element);
			};
			const copies = [];
			for (const root of roots) {
				const stack = [{node: root, parent: null}];
				while (stack.length) {
					const item = stack.pop();
					const node = item.node;
					if (node.nodeType !== 1 || visibility === 'off') {
						if (++visited > ${MAX_NODES}) throw new Error('node_limit');
					}
					if (node.nodeType === 1 && hidden(node)) continue;
					const copy = node.cloneNode(false);
					const serialized = node.nodeType === 1 ? copy.outerHTML : node.nodeType === 3 ? (copy.textContent || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : node.nodeType === 8 ? '<!--' + copy.textContent + '-->' : '';
					size += bytes(serialized);
					if (size > limit) throw new Error('byte_limit');
					if (item.parent) item.parent.appendChild(copy); else copies.push(copy);
					for (let child = node.lastChild; child; child = child.previousSibling) stack.push({node: child, parent: copy});
				}
			}
			const html = copies.map(node => node.outerHTML || '').join('\\n');
			if (!html) return fail('content_empty', 'No content remains after visibility filtering');
			if (bytes(html) > limit) return fail('too_large', 'Snapshot HTML exceeds 10 MiB');
			const envelope = {ok: true, html, title: document.title || '', url: document.URL || '', baseUri: document.baseURI || '', lang: document.documentElement ? document.documentElement.getAttribute('lang') || '' : '', selected: selector !== undefined};
			if (bytes(html) + bytes(envelope.title) + bytes(envelope.url) + bytes(envelope.baseUri) + bytes(envelope.lang) > limit) return fail('too_large', 'Decoded snapshot exceeds 10 MiB');
			const result = JSON.stringify(envelope);
			return bytes(result) > limit ? fail('too_large', 'Snapshot JSON exceeds 10 MiB') : result;
		} catch (error) {
			if (error.message === 'node_limit') return fail('too_large', 'Snapshot exceeds 50000 traversed nodes');
			if (error.message === 'byte_limit') return fail('too_large', 'Snapshot HTML exceeds 10 MiB');
			return fail('snapshot_failed', 'DOM snapshot failed: ' + error.message);
		}
	})()`;
}

interface Snapshot {
	ok: true;
	html: string;
	title: string;
	url: string;
	baseUri: string;
	lang: string;
	selected: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decode(result: string): Snapshot {
	if (Buffer.byteLength(result, "utf8") > MAX_BYTES)
		throw failure("too_large", "Snapshot JSON exceeds 10 MiB");
	let value: unknown;
	try {
		value = JSON.parse(result);
	} catch {
		throw failure("snapshot_invalid", "Expected a JSON snapshot envelope");
	}
	if (!record(value))
		throw failure("snapshot_invalid", "Expected an object envelope");
	if (
		value.ok === false &&
		Object.keys(value).length === 3 &&
		typeof value.error === "string" &&
		typeof value.message === "string"
	) {
		const code = ERROR_CODES.find((code) => code === value.error);
		if (code) throw failure(code, value.message);
	}
	if (
		value.ok !== true ||
		Object.keys(value).length !== 7 ||
		typeof value.html !== "string" ||
		typeof value.title !== "string" ||
		typeof value.url !== "string" ||
		typeof value.baseUri !== "string" ||
		typeof value.lang !== "string" ||
		typeof value.selected !== "boolean"
	)
		throw failure("snapshot_invalid", "Invalid snapshot envelope fields");
	const snapshot: Snapshot = {
		ok: true,
		html: value.html,
		title: value.title,
		url: value.url,
		baseUri: value.baseUri,
		lang: value.lang,
		selected: value.selected,
	};
	if (
		[
			snapshot.html,
			snapshot.title,
			snapshot.url,
			snapshot.baseUri,
			snapshot.lang,
		].reduce((size, field) => size + Buffer.byteLength(field, "utf8"), 0) >
		MAX_BYTES
	)
		throw failure("too_large", "Decoded snapshot exceeds 10 MiB");
	return snapshot;
}

type LocalDocument = ReturnType<typeof parseHTML>["document"];

function parseContent(html: string, selected: boolean): LocalDocument {
	const { document } = parseHTML(
		selected
			? `<!doctype html><html><head></head><body>${html}</body></html>`
			: html,
	);
	const stack: Array<
		LocalDocument["documentElement"] | LocalDocument["childNodes"][number]
	> = [document.documentElement];
	let count = 0;
	while (stack.length) {
		const node = stack.pop();
		if (!node) continue;
		if (++count > MAX_NODES)
			throw failure("too_large", "Snapshot exceeds 50000 nodes");
		for (const child of node.childNodes) stack.push(child);
	}
	return document;
}

function clean(document: LocalDocument, base: string): void {
	for (const node of document.querySelectorAll(
		"script,style,noscript,template",
	))
		node.remove();
	for (const node of document.querySelectorAll("[href],[src]")) {
		for (const attribute of ["href", "src"]) {
			const value = node.getAttribute(attribute);
			if (typeof value !== "string") continue;
			if (
				/^javascript:/i.test(
					Array.from(value)
						.filter((character) => character.charCodeAt(0) > 32)
						.join(""),
				)
			) {
				node.removeAttribute(attribute);
				continue;
			}
			try {
				const resolved = new URL(value, base);
				if (resolved.protocol === "javascript:")
					node.removeAttribute(attribute);
				else node.setAttribute(attribute, resolved.href);
			} catch {
				// Preserve non-resolvable references rather than inventing a destination.
			}
		}
	}
}

/** Inert local parsing only; SDK Article.textContent is Markdown, not plain text. */
export function extractSnapshot(
	result: string,
	format: Format,
): string | Article {
	const snapshot = decode(result);
	if (format === "html") return snapshot.html;
	const base = snapshot.baseUri || snapshot.url;
	const document = parseContent(snapshot.html, snapshot.selected);
	clean(document, base);
	let content = document.body?.innerHTML || "";
	let title =
		snapshot.title ||
		document.querySelector("h1,h2")?.textContent?.trim() ||
		snapshot.url;
	let byline: string | undefined;
	let excerpt: string | undefined;
	let lang = snapshot.lang || undefined;
	let articleContent = false;
	if (!snapshot.selected && format !== "text") {
		const readable = parseContent(document.documentElement.outerHTML, false);
		const candidates = [...readable.querySelectorAll("article")].filter(
			(node) => (node.textContent?.trim().length ?? 0) >= 100,
		);
		const semanticArticle = candidates.length === 1 ? candidates[0] : undefined;
		if (semanticArticle) {
			content = semanticArticle.outerHTML;
			readable.body.innerHTML = content;
			articleContent = true;
		}
		Object.defineProperties(readable, {
			baseURI: { value: base, configurable: true },
			documentURI: { value: snapshot.url, configurable: true },
		});
		// LinkeDOM implements the DOM subset Readability uses; its ambient Document type is compatible.
		const article = new Readability(readable, {
			charThreshold: 100,
			maxElemsToParse: MAX_NODES,
			disableJSONLD: true,
		}).parse();
		// Short/non-article pages fall back to the cleaned body, never to another fetch.
		if (article?.content && article.textContent?.trim()) {
			articleContent = true;
			if (!semanticArticle) content = article.content;
			title = article.title || title;
			byline = article.byline || undefined;
			excerpt = article.excerpt || undefined;
			lang = article.lang || lang;
		}
	}
	const cleaned = parseContent(content, true);
	clean(cleaned, base);
	content = cleaned.body.innerHTML;
	const output =
		format === "text"
			? convert(content, {
					wordwrap: false,
					selectors: [
						...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
							selector,
							options: { uppercase: false },
						})),
					],
					limits: {
						maxInputLength: MAX_BYTES,
						maxDepth: MAX_NODES,
						maxChildNodes: MAX_NODES,
					},
				})
			: NodeHtmlMarkdown.translate(content, { codeBlockStyle: "fenced" });
	if (!output.trim())
		throw failure(
			"content_empty",
			"No extractable content remains in the snapshot",
		);
	if (
		format === "markdown" &&
		articleContent &&
		title &&
		cleaned.querySelector("h1")?.textContent?.trim() !== title.trim()
	) {
		const heading = cleaned.createElement("h1");
		heading.textContent = title;
		return `${NodeHtmlMarkdown.translate(heading.outerHTML)}\n\n${output.trim()}`;
	}
	if (format !== "json") return output.trim();
	return {
		title,
		content,
		textContent: output.trim(),
		...(byline ? { byline } : {}),
		...(excerpt ? { excerpt } : {}),
		...(lang ? { lang } : {}),
		...(snapshot.url ? { url: snapshot.url } : {}),
	};
}
