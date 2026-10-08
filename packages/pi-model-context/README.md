# pi-model-context

A Pi extension that tells the agent about live session-scoped models and how to discover the rest of the model catalog.

Requires **Pi 1.1.0 or newer**.

## Install

From the repository root:

```sh
pi install ./packages/pi-model-context
```

Run `/reload` in an existing session after installing.

## What the agent sees

Before each agent run with active `codemode`, the extension refreshes one structured system-prompt section containing:

- The current chat model.
- Every session-scoped chat model, including catalog metadata and scoped thinking levels.
- Up to two available examples per type: `chat`, `image`, and `classifier`, plus each type's available catalog count.
- Instructions for discovering additional entries through `codemode`.

There are **no hardcoded model or provider names**, rankings, or model-selection recommendations. Scope comes from `ctx.scopedModels`; previews come from `ctx.modelRegistry.getAvailableOfType()`, the same registry API used by codemode. The extension does not execute codemode, make chat completions, switch models, or expand the scope.

Examples prefer distinct providers and use stable provider/ID ordering. Chat examples exclude explicitly scoped models. When there are no additional models, the preview says so instead of repeating the scope. An empty scope means all available chat models are in scope.

Availability reflects credentials and provider catalog filtering, not a guarantee that every request will succeed. Each type's lookup has a five-second deadline and is aborted on timeout. Failed lookups are labeled as failures rather than empty catalogs; successful types and scope remain visible. The extension shows a generic warning without putting credential error details into the prompt.

## Codemode discovery

If `codemode` is active, the agent gets executable discovery guidance. If it is inactive or unavailable, the extension adds nothing to the context, removes its previous section, and skips catalog lookups and warnings. Add `"+codemode"` to the existing `defaultTools` array in Pi settings and reload to enable it.

These snippets are raw JavaScript inputs to the `codemode` tool:

```js
const entries = await models.getAvailableOfType("chat");
text(entries.map(m => ({
  provider: m.provider,
  id: m.id,
  name: m.name,
  input: m.input,
  contextWindow: m.contextWindow,
})));
```

Replace `"chat"` with `"image"` or `"classifier"` for other types. The optional second argument filters by provider.

```js
const catalog = await models.getModelsOfType("chat");
text({ total: catalog.length, entries: catalog.slice(0, 20) });
```

`getModelsOfType()` includes entries without credentials. Filter or paginate large catalogs before printing. `models.getModelOfType(type, provider, id)` returns one catalog entry; provider and ID are separate arguments. Codemode lists chat models but cannot execute chat completions.

## Development

From the repository root:

```sh
bun install
bun test ./packages/pi-model-context/test
bunx tsc --noEmit -p packages/pi-model-context/tsconfig.json
```
