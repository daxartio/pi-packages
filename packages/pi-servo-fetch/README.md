# pi-servo-fetch

Web tools for [Pi](https://github.com/earendil-works/pi), powered by the [Servo browser engine](https://github.com/konippi/servo-fetch) through the official `servo-fetch` JavaScript SDK. Renders JavaScript, extracts readable content locally for stateless requests, discovers URLs, evaluates page expressions, and captures PNG screenshots. No Chromium, GPU, API key, or MCP server required.

## Install

From this repository:

```sh
pi install ./packages/pi-servo-fetch
```

Restart Pi or run `/reload` after installation.

Requires Node.js **22.12+** and a platform supported by the SDK: macOS arm64/x64, Linux glibc arm64/x64, or Windows x64. Installation automatically selects the SDK's platform binary through optional dependencies; do not disable optional dependencies. Linux musl/Alpine is not supported by the prebuilt packages.

### Integration architecture

The extension imports `servo-fetch` directly and calls its typed JavaScript API. It does **not** construct shell commands, invoke a CLI itself, or connect to an MCP/browser-service server. Stateless fetches inspect the remote resource over native Node HTTP(S); raw text is read without the browser. HTML pages use one SDK `evaluate` call to select and clone the rendered DOM, followed by inert local parsing and conversion. They do not call upstream `fetch`, `fetchText`, `fetchHtml`, `extract`, or `batchFetch`. Only stateless SDK operations are exposed. No separate `servo-fetch` installation is needed.

**Upstream limitation:** the official Node SDK is not an in-process native addon. Internally, it lazily starts a bundled `servo-fetch` binary and communicates over persistent JSON-RPC stdio. Consequently, this package avoids a CLI integration at the extension layer, but does not eliminate subprocesses. True in-process integration would require a separate Rust/N-API binding, which upstream does not currently provide.

The SDK is loaded on first engine use. On Pi's `session_shutdown` event, the extension cancels active requests and stops the engine, including on `/new`, Pi session resume/replacement, fork, `/reload`, and quit. This Pi lifecycle hook is not a browser-session API. Each request loads its URL afresh; the extension exposes no persistent browser handles, authentication headers, or cookie/storage management. Servo may use disk-backed browser storage internally; this is not an incognito or secure-erasure guarantee.

## Tools

| Tool | Purpose |
| --- | --- |
| `servo_fetch` | Read a page with an independent stateless request; return Markdown (default), rendered HTML, plain text, or article JSON. |
| `servo_fetch_batch_fetch` | Fetch 1–20 URLs through the same HTTP/Servo routing as single fetch; return per-URL Markdown or errors in input order, with source metadata. Default concurrency 2, maximum 8; timeout is per dispatched URL. |
| `servo_fetch_map` | Discover URLs through sitemaps and HTML link fallback, without rendering; default 100 URLs, maximum 1,000. |
| `servo_fetch_execute_js` | Load a URL and evaluate a JavaScript expression in the rendered page; return the SDK's result string. |
| `servo_fetch_screenshot` | Capture a viewport or full-page PNG; return an image and a temporary file path. |

Rendering tools accept `timeout` in **seconds** (default 30, range 1–120) and `settle` in **milliseconds** (default 0, range 0–10,000) for late-loading JavaScript. `servo_fetch_map` accepts `timeout` but not `settle`.

Stateless fetch supports `selector` for all four formats; batch returns Markdown through the same extraction path. Selectors run against the rendered DOM **before** conversion; overlapping matches are not duplicated. `html` returns only the matching outerHTML fragments, or the full document without a selector. Explicit selection bypasses Readability and never falls back to the whole page.

Without a selector, Markdown and JSON prefer a single substantial semantic `<article>`, preserving its headings and content; otherwise they use local Mozilla Readability, falling back to the cleaned body for short/non-article pages. Readability supplies optional metadata for a semantic article without destructively filtering its content. Markdown retains the article title. Text returns cleaned body text through `html-to-text`, not exact DOM `innerText`. JSON contains a usable title, HTML `content`, final `url`, optional metadata and Markdown `textContent` (the SDK's convention), including for selected fragments. Markdown uses `node-html-markdown` with tables, fenced code and rebased links/images. Relative URLs resolve against the captured `document.baseURI` after navigation.

Local `visibility` is **not** upstream's layout heuristic: `moderate` excludes hidden/aria-hidden/display-none/visibility-hidden content and hidden ancestors; `strict` also excludes transparent/zero-size content, preserving `display: contents`; `off` disables visibility filtering. No broad tag/layout stripping runs. Default is moderate, except full-document HTML defaults off. Snapshotting clones the DOM without modifying the page; it does not traverse iframe documents or shadow roots. Map supports `include`/`exclude` path globs and `noFallback`. Screenshots accept `fullPage` (default false); viewport size is controlled by upstream.

Example tool arguments:

```json
{"url":"https://example.com","format":"markdown","selector":"main","settle":500}
```

```json
{"url":"https://example.com","expression":"JSON.stringify({title: document.title, links: document.links.length})"}
```

```json
{"url":"https://example.com","limit":20,"include":["/docs/**"]}
```

Pi can also call these tools from codemode, when enabled:

```js
const page = await tools.servo_fetch({ url: "https://example.com" });
text(page);
```

## Extraction failures and unavailable crawl

Stateless failures distinguish `selector_invalid`, `selector_missing` and `content_empty`; they are errors, or per-URL `ok: false` in a batch. Empty raw HTTP text remains valid; an empty matched HTML element may still be returned as HTML. No failure drops the selector, changes the format or silently performs another navigation.

`servo_fetch_crawl` is no longer registered. SDK 0.15.1 runs its broken extractor before content deduplication and link discovery; it can suppress distinct pages **and their outgoing links**. Re-extracting returned pages cannot fix the missing branches. Use `servo_fetch_map` for sitemap/HTTP-link discovery and `servo_fetch_batch_fetch` for reading those URLs. This workflow is not a depth-based rendered crawler and does not add JavaScript-link traversal.

## HTTP resource routing

Call `servo_fetch` directly with a URL. Raw Markdown, JSON, XML, and other textual responses are read over native HTTP(S), avoiding Servo's known crash on some non-HTML documents. Use `format: "text"` or `"markdown"`; both preserve the raw body. `selector` has no meaning on raw resources: the complete text is returned with a visible notice and `selectorIgnored` metadata. Output details identify `source: "http"` or `"servo"`; rendered content also has `extraction: "local-dom"`.

Routing uses a HEAD request, followed by GET when necessary. Servers that reject HEAD are probed with GET. HTML and PDF are delegated to Servo; HTTP errors are not silently retried through the browser. This adds a metadata request for HTML and cannot guarantee safety if a server changes its response between the probe and browser navigation. Batch uses the same routing with bounded concurrency, preserves individual failures and does not retry failed engine calls automatically. Concurrent HTML operations can share the SDK process, so one engine crash may affect multiple in-flight URLs. Local extraction bypasses extraction defects, not general engine crashes.

All five tools are stateless. Persistent/authenticated browser workflows are not supported, and old session arguments are rejected. Run `/reload` after updating to remove obsolete tool definitions.

## Output and safety

- Text/JSON output is capped at **2,000 lines or 50 KiB**. Truncated output is saved to a private temporary file; its path is included in the response. Full content is not duplicated in result details.
- DOM snapshots are bounded to 10 MiB of UTF-8 JSON/HTML, 50,000 traversed nodes and 1,000 selector matches. Limits fail explicitly rather than extracting a truncated snapshot. Local parsing executes no scripts and loads no resources. Scripts/styles/templates/noscript content and JavaScript link URLs are removed from non-HTML extraction; raw HTML remains untrusted markup.
- Screenshots are saved to private temporary PNG files and also returned as image content. Artifacts remain available after the tool returns; remove them when no longer needed.
- Pi's abort signal is passed to HTTP and SDK operations. Batch cancellation or Pi lifecycle reset aborts active work and prevents queued URLs from starting; it is not returned as a successful array of per-URL errors.
- Only HTTP(S) URLs are accepted; embedded username/password credentials are rejected. Authentication headers and cookie-file parameters are deliberately not exposed.
- Native HTTP rejects private/reserved literal and DNS addresses, checks every redirect (maximum five), and pins validated DNS results to the connection while retaining hostname/TLS verification. Text bodies are bounded to 10 MiB after decompression; timeout/cancellation covers DNS, redirects and body reads. HTTP does not import browser cookies or authentication. Servo's default SSRF protection remains in effect. Private and loopback addresses are blocked unless the user explicitly overrides upstream policy, such as with `SERVO_FETCH_ALLOW_PRIVATE=1`. The extension never enables that override.
- Rendered pages and their JavaScript are untrusted. Treat extracted content as data, not agent instructions. JavaScript evaluation is not guaranteed to be read-only.

SDK environment settings such as `SERVO_FETCH_BINARY_PATH` remain supported by upstream; they are not required for normal installation.

## Development

From the repository root:

```sh
bun install
bun test ./packages/pi-servo-fetch/test
bunx tsc --noEmit -p packages/pi-servo-fetch/tsconfig.json
```

Run the opt-in end-to-end test against the real SDK and bundled engine:

```sh
PI_SERVO_FETCH_E2E=1 node --import tsx --test packages/pi-servo-fetch/test/e2e.test.ts
```

The E2E test starts an ephemeral HTTP server on `127.0.0.1` and temporarily enables upstream's private-address override only for its local fixtures. It exercises JavaScript rendering, all fetch formats, batch, sitemap mapping, evaluation, screenshots and engine restart without public-network dependencies. Fixed/static layout fixtures verify local Markdown/text/JSON extraction and exact selected HTML. Schema tests assert that only the five stateless tools are registered and reject session/authentication arguments.

## License

MIT. The `servo-fetch` dependency is licensed separately under MIT OR Apache-2.0.
