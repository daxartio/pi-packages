import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const Url = Type.String({
	minLength: 1,
	maxLength: 8192,
	pattern: "^https?://",
	description:
		"HTTP(S) URL. Private addresses are blocked by Servo by default.",
});
const Timeout = Type.Optional(
	Type.Integer({
		minimum: 1,
		maximum: 120,
		description: "Page-load timeout in seconds (default: 30).",
	}),
);
const RenderOptions = {
	timeout: Timeout,
	settle: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 10000,
			description: "Extra wait after load in milliseconds (default: 0).",
		}),
	),
};
const Selector = Type.Optional(
	Type.String({
		minLength: 1,
		maxLength: 4096,
		description:
			"CSS selector evaluated in the rendered DOM for Markdown, HTML, text or JSON. Matching outerHTML fragments are extracted without layout stripping. Raw text has no DOM and returns the entire resource with a notice.",
	}),
);
const ExtractionOptions = {
	...RenderOptions,
	selector: Selector,
	visibility: Type.Optional(
		StringEnum(["moderate", "strict", "off"] as const, {
			description:
				"Stateless DOM visibility policy: moderate excludes hidden/display-none/visibility-hidden elements; strict also excludes transparent/zero-size elements; off disables filtering. Full-document HTML defaults off; other extraction defaults moderate. Sessions use upstream heuristics.",
		}),
	),
};
const Concurrency = Type.Optional(Type.Integer({ minimum: 1, maximum: 8 }));
const Filters = {
	include: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), {
			maxItems: 50,
			description: "URL path glob patterns to include, e.g. /docs/**.",
		}),
	),
	exclude: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), {
			maxItems: 50,
			description: "URL path glob patterns to exclude.",
		}),
	),
};

const SessionId = Type.String({
	minLength: 36,
	maxLength: 36,
	pattern:
		"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
	description:
		"Exact UUID returned by servo_fetch_session_open. Do not invent an ID, use a name, or pass 'none'. For requests without a session use servo_fetch instead.",
});

export const SessionOpenParams = Type.Object(
	{
		userAgent: Type.Optional(
			Type.Union(
				[
					Type.String({
						minLength: 1,
						maxLength: 512,
						pattern: "^[^\\r\\n]*$",
					}),
					Type.Null(),
				],
				{
					description:
						"Optional User-Agent fixed for the new session. Omit or pass null to use the SDK default.",
				},
			),
		),
	},
	{ additionalProperties: false },
);

export const SessionListParams = Type.Object(
	{},
	{ additionalProperties: false },
);

export const SessionCloseParams = Type.Object(
	{ sessionId: SessionId },
	{ additionalProperties: false },
);

export const SessionFetchParams = Type.Object(
	{
		url: Url,
		sessionId: SessionId,
		...ExtractionOptions,
	},
	{ additionalProperties: false },
);

export const FetchParams = Type.Object(
	{
		url: Url,
		format: Type.Optional(
			StringEnum(["markdown", "html", "text", "json"] as const, {
				description:
					"Output format (default: markdown). HTML returns selected outerHTML or the full document. Markdown/JSON without selector prefer a single substantial article, otherwise local Readability with body fallback; text returns body text. JSON contains title, HTML content and Markdown textContent.",
			}),
		),
		...ExtractionOptions,
	},
	{ additionalProperties: false },
);

export const BatchParams = Type.Object(
	{
		urls: Type.Array(Url, { minItems: 1, maxItems: 20 }),
		concurrency: Concurrency,
		...ExtractionOptions,
	},
	{ additionalProperties: false },
);

export const MapParams = Type.Object(
	{
		url: Url,
		limit: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 1000,
				description: "Maximum discovered URLs (default: 100).",
			}),
		),
		timeout: Timeout,
		noFallback: Type.Optional(
			Type.Boolean({
				description: "Skip HTML link discovery if no sitemap exists.",
			}),
		),
		...Filters,
	},
	{ additionalProperties: false },
);

export const EvaluateParams = Type.Object(
	{
		url: Url,
		expression: Type.String({
			minLength: 1,
			maxLength: 50000,
			description:
				"JavaScript expression evaluated in the rendered page. Each call loads the URL afresh; no persistent browser session.",
		}),
		...RenderOptions,
	},
	{ additionalProperties: false },
);

export const ScreenshotParams = Type.Object(
	{
		url: Url,
		fullPage: Type.Optional(
			Type.Boolean({
				description:
					"Capture the entire page rather than the viewport (default: false).",
			}),
		),
		...RenderOptions,
	},
	{ additionalProperties: false },
);
