# pi-subagents

A Pi extension for bounded, isolated subagent runs. Named agents are loaded from trusted roots; calls without `agent` create a validated dynamic DAG. Child artifacts are private and worktrees are accepted only through an approved descriptor/path.

This package owns child processes and does not create, delete, or import `pi-worktree`. `cwd` authorization is not a filesystem sandbox. Install only from a trusted source.

## Install

```sh
pi install ./packages/pi-subagents
```

Restart Pi or run `/reload` after installation.

## Built-in agents

- `default` — general-purpose agent for tasks that do not fit a specialized agent.
- `scout` — read-only codebase investigation.
- `reviewer` (`review`, `code-review`) — code review.
- `dependency-updater` (`deps`, `dependency-update`) — dependency updates.
- `researcher` (`research`, `investigator`) — technical research.
- `system-designer` (`design`, `architect`) — system design.

Agents do not pin a model. The child session uses the orchestrator-selected model; each agent description carries a "Recommended model" hint describing the capability tier the role needs.

Bundled agents do not declare `tools`: child agents inherit the parent's active tools, including built-in tools, extension tools, MCP gateways and namespace proxies. Callable tools with `codemode` or `deferred` exposure are also inherited without automatically declaring them as active. Inactive ordinary tools are not enabled. Role descriptions such as "read-only" guide behavior; they are not tool-level restrictions. Custom definitions can retain a `tools` allowlist, which is intersected with the parent's available tools.

Pass `tools` in a single named-agent call or on each entry in `tasks`/`chain` to narrow that task's access. `[]` disables all tools; requesting tools outside the parent/agent permissions fails before launching the child:

```json
{ "agent": "scout", "task": "Inspect this configuration file", "tools": ["read"] }
{ "agent": "researcher", "task": "Query the configured MCP server", "tools": ["mcp__server"] }
{ "agent": "reviewer", "task": "Review this supplied diff without tools", "tools": [] }
```

### How inheritance works

The extension snapshots `pi.getActiveTools()` and source metadata from `pi.getAllTools()` when the parent delegates. Each child reloads only the extension entry points owning its allowed tools, including `builtin:` extensions. Automatic extension discovery stays disabled: children do not pick up unrelated extensions from another working directory. The same environment and agent configuration directory are used, so MCP adapters reuse their configuration and credential stores, but establish their own connections.

A private launch manifest and child guard verify that requested tools loaded from the expected sources before the task is submitted. Missing tools or non-reloadable inline/SDK sources produce an error rather than silently reducing access. Before each agent run the guard restores the chosen active tools, and tool-call hooks enforce the allowlist, including runtime-supported nested calls. Explicit `tools` lists do not inherit extra codemode/deferred helpers; include those names if needed.

This reloads tool implementations, not the parent's in-memory extension state. Dynamic registrations, custom flags, runtime-only MCP configuration changes, or a different Pi version can prevent a tool from loading. Hook-only extensions and their session state are not cloned. Use the same Pi executable/version for the closest match.

Tool-name allowlists are not a security sandbox. `bash` can modify files; `mcp`, server proxies, and other gateways retain access to their underlying operations. Restrict those gateways themselves when necessary. Parent UI handles child confirmation, selection, and input dialogs; without a parent UI they are cancelled, never automatically approved. Editor dialogs are cancelled, and child UI status/editor mutations are not applied to the parent. Child delegation is bounded to four nesting levels even if `subagent` is inherited.

## Pi commands

- `/subagents` — list the available named agents and their descriptions.

The extension also registers the `subagent` **tool**. Ask Pi to use it, or invoke it through an RPC/tool client. The tool description includes the list of available agents so the orchestrator can pick the right one. It has these forms:

```json
{ "task": "Find the authentication entry points" }
```

Omitting `agent` starts the bounded dynamic workflow. Generated workers use the same tool inheritance rules as named agents. Pass `tools` on the top-level dynamic request to restrict all its workers.

```json
{ "agent": "reviewer", "task": "Review the authentication changes" }
{ "agent": "dependency-updater", "task": "Update TypeScript to the latest compatible version" }
{ "agent": "researcher", "task": "Compare the available queue implementations" }
{ "agent": "system-designer", "task": "Design a multi-tenant job scheduler" }
{ "tasks": [{ "agent": "scout", "task": "Find API routes" }, { "agent": "scout", "task": "Find database access" }] }
{ "chain": [{ "agent": "scout", "task": "Inspect configuration" }, { "agent": "system-designer", "task": "Design improvements based on {previous}" }] }
```

`tasks` runs explicit named-agent jobs in parallel; `chain` runs them in order. Provide only one form per call: top-level `agent`/`task`, `tasks`, or `chain`. If forms are mixed, `tasks` takes precedence over `chain`, and either array overrides the top-level single-task fields. Ignored forms are not executed, so duplicated fields do not start extra agents. A named agent that does not exist is an error and never falls back to dynamic planning. The launcher reuses the parent Pi CLI/runtime when identifiable, otherwise resolves `pi` from PATH. Set `PI_SUBAGENTS_PI` to use a specific executable or JavaScript CLI entry point for child RPC processes.
