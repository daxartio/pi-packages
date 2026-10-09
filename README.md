# pi-packages

A Bun/TypeScript monorepo with extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

## Packages

- [`pi-auto-model`](packages/pi-auto-model) — suggests a model and thinking level for each prompt; switching requires confirmation.
- [`pi-auto-update`](packages/pi-auto-update) — runs Pi and extension updates at session start.
- [`pi-btw`](packages/pi-btw) — answers side questions with the current model without changing the main conversation.
- [`pi-codex-goal`](packages/pi-codex-goal) — adds Codex-style goal tracking and continuation.
- [`pi-context`](packages/pi-context) — assembles the system prompt from context files and skills with per-session controls.
- [`pi-export-browser`](packages/pi-export-browser) — exports the current session to HTML and opens it in a browser.
- [`pi-gpt-fast-mode`](packages/pi-gpt-fast-mode) — toggles supported GPT models into Fast mode.
- [`pi-model-context`](packages/pi-model-context) — adds live scoped models, catalog previews, and codemode discovery instructions to the agent context.
- [`pi-review`](packages/pi-review) — provides a standalone `/review` command.
- [`pi-servo-fetch`](packages/pi-servo-fetch) — adds stateless Servo-powered web rendering with local extraction, URL discovery, JavaScript evaluation, and screenshots through the official JavaScript SDK.
- [`pi-subagents`](packages/pi-subagents) — runs bounded isolated subagent sessions.
- [`pi-todo`](packages/pi-todo) — adds a persistent todo-list overlay.
- [`pi-worktree`](packages/pi-worktree) — manages package-owned Git worktrees.

## Install

From a local checkout:

```sh
pi install ./packages/<package-name>
```

See each package README for package-specific setup.

## Development

```sh
bun install
bun run typecheck
```

Run a package's own `test` script when it defines one.

## License

MIT
