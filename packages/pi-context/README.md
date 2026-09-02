# pi-context

Assemble the system prompt from known context sources — the `AGENTS.md` chain
loaded by pi, `SYSTEM.md` (custom prompt) and `APPEND_SYSTEM.md`, skills, and
configured extra files — with persistent defaults, per-session overrides,
review output, and token estimates.

## What it does

- **Session start**: shows a footer status and a one-line notification with the
  number of active context sources and their estimated token cost
  (e.g. `ctx 3/4 ~520tok — /context to review`).
- **`/context`**: opens an interactive picker listing all sources grouped by
  kind (`agents`, `system`, `skill`, `extra`) with per-entry token estimates.
  Arrow keys move, **space** toggles a source, **enter** applies the selection
  to the current session, **ctrl+s** additionally saves the per-kind defaults
  to the config file for all sessions, **esc** cancels. In non-interactive
  contexts it falls back to a plain text review plus the persistent defaults.
- **`/context on|off <id|label>`**: force-enable or disable a single source for
  the current session (overrides the persistent defaults).
- **`/context reset`**: clear per-session overrides.
- **Prompt assembly**: before every agent turn the extension filters
  `systemPromptOptions.contextFiles` / `skills` by the effective plan and
  rebuilds the system prompt via pi's own `buildSystemPrompt`, additionally
  injecting enabled extra files that pi never loads itself. Disabling the
  `system` / `appendSystem` source drops pi's `customPrompt` (SYSTEM.md) /
  `appendSystemPrompt` (APPEND_SYSTEM.md) respectively.

Token estimates use pi's own heuristic (chars / 4). Skill entries estimate the
prompt snippet (`name` + `description` + `location`), not the whole `SKILL.md`.

## Configuration

Persistent defaults live in `~/.pi/agent/pi-context.json` (respects `PI_CODING_AGENT_DIR`):

```json
{
  "sources": { "agents": true, "system": true, "appendSystem": true, "skills": true },
  "extraFiles": ["docs/RULES.md"],
  "startupSummary": true
}
```

- `sources.*` — default inclusion per source kind: `agents` (AGENTS.md /
  CLAUDE.md context files), `system` (SYSTEM.md custom prompt), `appendSystem`
  (APPEND_SYSTEM.md), `skills`. `extra` files are always on once listed in
  `extraFiles`.
- `extraFiles` — additional file paths (absolute or relative to cwd).
- `startupSummary` — set to `false` to hide the session-start notification
  (the footer status still shows).

Per-session overrides (`/context on|off`) are cleared on every new session.

## Development

```bash
bun test        # run tests
bunx tsc --noEmit
```
