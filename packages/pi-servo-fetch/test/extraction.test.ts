import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	extractSnapshot,
	type Format,
	snapshotExpression,
} from "../src/extraction.js";

const finalUrl = "https://example.com/redirected/page";
const baseUri = "https://cdn.example.com/assets/";

function envelope(
	html: string,
	selected = true,
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		ok: true,
		html,
		title: "Page title",
		url: finalUrl,
		baseUri,
		lang: "en",
		selected,
		...extra,
	});
}

function browser(html: string) {
	const { document } = parseHTML(
		`<!doctype html><html lang="en"><head><title>Page title</title><meta name="author" content="Writer"><base href="${baseUri}"></head><body>${html}</body></html>`,
	);
	Object.defineProperties(document, {
		URL: { value: finalUrl },
		baseURI: { value: baseUri },
	});
	const getComputedStyle = (node: typeof document.documentElement) => ({
		display:
			node.style.display || (node.localName === "head" ? "none" : "block"),
		visibility: node.style.visibility || "visible",
		opacity: node.style.opacity || "1",
	});
	for (const node of document.querySelectorAll("*")) {
		Object.defineProperty(node, "getBoundingClientRect", {
			value: () => ({
				width: node.hasAttribute("data-zero") ? 0 : 100,
				height: 20,
			}),
		});
	}
	return {
		document,
		snapshot(params: Parameters<typeof snapshotExpression>[0]): string {
			// Execute only our generated browser expression, never page scripts.
			const result: unknown = new Function(
				"document",
				"getComputedStyle",
				`return ${snapshotExpression(params)}`,
			)(document, getComputedStyle);
			if (typeof result !== "string")
				throw new Error("Expected string snapshot");
			return result;
		},
	};
}

function article(result: string) {
	const value = extractSnapshot(result, "json");
	if (typeof value === "string") throw new Error("Expected Article");
	return value;
}

const rich = `<h1>Mixed Case Heading</h1><p>Hello <a href="guide">guide</a> and <a href="/root">root</a>.</p><img src="image.png" alt="Example image"><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Alpha</td><td>42</td></tr></tbody></table><pre><code class="language-js">const x = 1;\nconsole.log(x);</code></pre><ul><li>First item</li><li>Second item</li></ul>`;

test("selected Markdown retains headings, rebased links/images, GFM tables, fenced code and lists", () => {
	const markdown = extractSnapshot(envelope(rich), "markdown");
	expect(typeof markdown).toBe("string");
	expect(markdown).toContain("# Mixed Case Heading");
	expect(markdown).toContain("[guide](https://cdn.example.com/assets/guide)");
	expect(markdown).toContain("[root](https://cdn.example.com/root)");
	expect(markdown).toContain(
		"![Example image](https://cdn.example.com/assets/image.png)",
	);
	expect(markdown).toMatch(/\| Name\s+\| Value \|/);
	expect(markdown).toContain("```");
	expect(markdown).toContain("const x = 1;");
	expect(markdown).toContain("First item");
});

test("plain text preserves heading case and code without word wrapping", () => {
	const long = "word ".repeat(100);
	const text = extractSnapshot(envelope(`${rich}<p>${long}</p>`), "text");
	expect(text).toContain("Mixed Case Heading");
	expect(text).not.toContain("MIXED CASE HEADING");
	expect(text).toContain("const x = 1;\nconsole.log(x);");
	expect(text).toContain(long.trim());
	expect(text).toContain("First item");
});

test("redirect URL is used without baseURI and selected JSON contains useful exact fragments", () => {
	const value = article(
		envelope(
			'<aside id="choice"><h2>Chosen</h2><a href="next">Go</a></aside><p>Other chosen root</p>',
			true,
			{ baseUri: "" },
		),
	);
	expect(value.title).toBe("Page title");
	expect(value.content).toContain('id="choice"');
	expect(value.content).toContain('href="https://example.com/redirected/next"');
	expect(value.textContent).toContain("## Chosen");
	expect(value.textContent).toContain("Other chosen root");
	expect(value.url).toBe(finalUrl);
	expect(value.lang).toBe("en");
	const untitled = article(
		envelope("<h1>Selected title</h1><p>Content</p>", true, { title: "" }),
	);
	expect(untitled.title).toBe("Selected title");
});

test("live selectors distinguish invalid/missing and remove overlapping roots without changing DOM IDs", () => {
	const page = browser(
		'<section id="one"><p id="nested">First</p></section><section id="two">Second</section>',
	);
	const original = page.document.documentElement.outerHTML;
	const snapshot = page.snapshot({
		format: "markdown",
		selector: "#one, #nested, #two",
	});
	const html = extractSnapshot(snapshot, "html");
	expect(html).toBe(
		'<section id="one"><p id="nested">First</p></section>\n<section id="two">Second</section>',
	);
	expect(extractSnapshot(snapshot, "markdown")).toBe("First\n\nSecond");
	expect(() =>
		extractSnapshot(page.snapshot({ format: "text", selector: "[" }), "text"),
	).toThrow("selector_invalid");
	expect(() =>
		extractSnapshot(
			page.snapshot({ format: "text", selector: "#absent" }),
			"text",
		),
	).toThrow("selector_missing");
	expect(page.document.documentElement.outerHTML).toBe(original);
});

test("visibility moderate filters explicit hidden styles/ancestors, off disables it, strict adds opacity/geometry", () => {
	const page = browser(
		'<main id="main"><p>Visible</p><p hidden>Hidden attr</p><p aria-hidden="true">Aria</p><p style="display:none">Display</p><p style="visibility:collapse">Collapse</p><p style="visibility:hidden">Visibility</p><p style="opacity:0">Transparent</p><p data-zero>Zero size</p><div data-zero style="display:contents"><p>Contents child</p></div></main><aside hidden><p id="hidden-child">Hidden ancestor</p></aside>',
	);
	const before = page.document.documentElement.outerHTML;
	const moderate = extractSnapshot(
		page.snapshot({ format: "text", selector: "#main" }),
		"text",
	);
	expect(moderate).toContain("Visible");
	for (const excluded of [
		"Hidden attr",
		"Aria",
		"Display",
		"Collapse",
		"Visibility",
	])
		expect(moderate).not.toContain(excluded);
	expect(moderate).toContain("Transparent");
	expect(moderate).toContain("Zero size");
	const strict = extractSnapshot(
		page.snapshot({ format: "text", selector: "#main", visibility: "strict" }),
		"text",
	);
	expect(strict).not.toContain("Transparent");
	expect(strict).not.toContain("Zero size");
	expect(strict).toContain("Contents child");
	expect(() =>
		extractSnapshot(
			page.snapshot({ format: "text", selector: "#hidden-child" }),
			"text",
		),
	).toThrow("content_empty");
	expect(
		extractSnapshot(
			page.snapshot({
				format: "text",
				selector: "#hidden-child",
				visibility: "off",
			}),
			"text",
		),
	).toBe("Hidden ancestor");
	const off = extractSnapshot(
		page.snapshot({ format: "text", selector: "#main", visibility: "off" }),
		"text",
	);
	expect(off).toContain("Hidden attr");
	expect(page.document.documentElement.outerHTML).toBe(before);
});

test("full HTML defaults off, explicit filtering retains head metadata, HTML stays raw", () => {
	const page = browser(
		'<p hidden>Hidden</p><script>throw new Error("not run")</script><a href="javascript:alert(1)">Raw</a>',
	);
	const raw = extractSnapshot(page.snapshot({ format: "html" }), "html");
	expect(raw).toBe(page.document.documentElement.outerHTML);
	expect(raw).toContain("javascript:alert(1)");
	expect(raw).toContain("<script>");
	const filtered = extractSnapshot(
		page.snapshot({ format: "html", visibility: "strict" }),
		"html",
	);
	expect(filtered).not.toContain("<p hidden>");
	expect(filtered).toContain("<title>Page title</title>");
	expect(filtered).toContain('<meta name="author" content="Writer">');
	expect(filtered).toContain(`<base href="${baseUri}">`);
});

test("full Markdown/JSON uses Readability with metadata and body fallback for non-articles", () => {
	const page = browser(
		`<article><h1>Story</h1>${"<p>A substantial readable paragraph with facts, details, and context for the reader.</p>".repeat(15)}</article>`,
	);
	const value = article(page.snapshot({ format: "json" }));
	expect(value.title).toBeTruthy();
	expect(value.content).toContain("substantial readable paragraph");
	expect(value.byline).toBe("Writer");
	expect(value.textContent).toContain("substantial readable paragraph");
	const markdown = extractSnapshot(
		page.snapshot({ format: "markdown" }),
		"markdown",
	);
	expect(markdown).toContain(`# ${value.title}`);
	expect(markdown).toContain("substantial readable paragraph");
	const short = browser('<div><a href="tiny">Tiny link</a></div>');
	expect(
		extractSnapshot(short.snapshot({ format: "markdown" }), "markdown"),
	).toContain("[Tiny link](https://cdn.example.com/assets/tiny)");
});

test("a single substantial semantic article takes precedence over unrelated page chrome", () => {
	const page = browser(
		`<div><h2>Repository stats</h2>${"<p>Unrelated sidebar detail, this is long page chrome that must not replace the actual article.</p>".repeat(50)}</div><article><h1>Documentation</h1><h2><a href="/reference">Command Reference</a></h2>${"<p>Quickstart: install and run the application. This substantial article is the document content.</p>".repeat(10)}</article>`,
	);
	for (const format of ["markdown", "json"] as const) {
		const output = extractSnapshot(page.snapshot({ format }), format);
		const body = typeof output === "string" ? output : output.textContent;
		expect(body).toContain("Quickstart");
		expect(body).toContain("## [Command Reference]");
		expect(body).not.toContain("Unrelated sidebar");
	}
});

test("local parsing is inert and cleans scripts/styles/templates and javascript URLs for every non-HTML format", () => {
	const html =
		'<h1>Safe</h1><script>throw new Error("executed")</script><style>STYLE_SECRET</style><noscript>NOSCRIPT_SECRET</noscript><template>TEMPLATE_SECRET</template><a href="java&#10;script:alert(1)">Link</a><img src="javascript:alert(1)"><p>Body</p>';
	for (const format of ["markdown", "text", "json"] satisfies Format[]) {
		const value = extractSnapshot(envelope(html), format);
		const output =
			typeof value === "string"
				? value
				: `${value.content}\n${value.textContent}`;
		for (const removed of [
			"executed",
			"STYLE_SECRET",
			"NOSCRIPT_SECRET",
			"TEMPLATE_SECRET",
			"javascript:",
			"alert(1)",
		])
			expect(output).not.toContain(removed);
		expect(output).toContain("Safe");
	}
});

test("empty non-HTML conversions fail explicitly but empty selected div HTML is valid", () => {
	const page = browser('<div id="empty"></div>');
	const result = page.snapshot({ format: "html", selector: "#empty" });
	expect(extractSnapshot(result, "html")).toBe('<div id="empty"></div>');
	for (const format of ["markdown", "text", "json"] satisfies Format[])
		expect(() => extractSnapshot(result, format)).toThrow("content_empty");
});

test("envelopes are checked strictly, including error codes and unknown/incorrect fields", () => {
	for (const result of [
		"not json",
		"null",
		"[]",
		"{}",
		envelope("<p>x</p>", true, { selected: "yes" }),
		envelope("<p>x</p>", true, { html: 42 }),
		envelope("<p>x</p>", true, { unexpected: true }),
		JSON.stringify({ ok: false, error: "unknown", message: "Bad" }),
		JSON.stringify({ ok: false, error: "too_large" }),
	]) {
		expect(() => extractSnapshot(result, "html")).toThrow("snapshot_invalid");
	}
	expect(() =>
		extractSnapshot(
			JSON.stringify({
				ok: false,
				error: "too_large",
				message: "Detailed limit",
			}),
			"html",
		),
	).toThrow("too_large: Detailed limit");
});

test("match, traversal and UTF-8 byte limits fail without truncation", () => {
	const matches = browser("<i>x</i>".repeat(1001));
	expect(() =>
		extractSnapshot(
			matches.snapshot({ format: "html", selector: "i" }),
			"html",
		),
	).toThrow("1000 matches");
	const many = browser("<i></i>".repeat(50_001));
	expect(() =>
		extractSnapshot(many.snapshot({ format: "html" }), "html"),
	).toThrow("50000 traversed nodes");
	expect(() =>
		extractSnapshot(envelope("<i></i>".repeat(50_001)), "markdown"),
	).toThrow("50000 nodes");
	const huge = "é".repeat(5 * 1024 * 1024);
	expect(() => extractSnapshot(envelope(huge), "html")).toThrow("too_large");
	const oversized = browser(`<p id="huge">${huge}</p>`);
	expect(() =>
		extractSnapshot(
			oversized.snapshot({ format: "html", selector: "#huge" }),
			"html",
		),
	).toThrow("too_large");
	const jsonOverhead = browser(
		`<p id="quotes">${'"'.repeat(6 * 1024 * 1024)}</p>`,
	);
	expect(() =>
		extractSnapshot(
			jsonOverhead.snapshot({ format: "html", selector: "#quotes" }),
			"html",
		),
	).toThrow("Snapshot JSON exceeds");
});
