# pi-subagents

A Pi extension for bounded, isolated subagent runs. Named agents are loaded from trusted roots; calls without `agent` create a validated, read-only dynamic DAG. Child artifacts are private and worktrees are accepted only through an approved descriptor/path.

This package owns child processes and does not create, delete, or import `pi-worktree`. `cwd` authorization is not a filesystem sandbox. Install only from a trusted source.

## Install

```sh
pi install ./packages/pi-subagents
```

Restart Pi or run `/reload` after installation.

## Built-in agents

- `scout` — read-only codebase investigation.
- `reviewer` (`review`, `code-review`) — code review with `openai-codex/gpt-5.6-sol`.
- `dependency-updater` (`deps`, `dependency-update`) — dependency updates with `openai-codex/gpt-5.6-luna`.
- `researcher` (`research`, `investigator`) — technical research with `openai-codex/gpt-5.6-terra`.
- `system-designer` (`design`, `architect`) — system design with `openai-codex/gpt-5.6-sol`.

## Pi commands

- `/subagents` — list the available named agents and their descriptions.

The extension also registers the `subagent` **tool**. Ask Pi to use it, or invoke it through an RPC/tool client. It has these forms:

```json
{ "task": "Find the authentication entry points" }
```

Omitting `agent` starts the bounded dynamic workflow. Dynamic workers are read-only (`read`, `grep`, `find`, `ls`).

```json
{ "agent": "reviewer", "task": "Review the authentication changes" }
{ "agent": "dependency-updater", "task": "Update TypeScript to the latest compatible version" }
{ "agent": "researcher", "task": "Compare the available queue implementations" }
{ "agent": "system-designer", "task": "Design a multi-tenant job scheduler" }
{ "tasks": [{ "agent": "scout", "task": "Find API routes" }, { "agent": "scout", "task": "Find database access" }] }
{ "chain": [{ "agent": "scout", "task": "Inspect configuration" }, { "agent": "system-designer", "task": "Design improvements based on {previous}" }] }
```

`tasks` runs explicit named-agent jobs in parallel; `chain` runs them in order. A named agent that does not exist is an error and never falls back to dynamic planning. Set `PI_SUBAGENTS_PI` to use a specific Pi executable for child RPC processes.
