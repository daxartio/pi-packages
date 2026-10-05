# pi-subagents

A Pi extension for bounded, isolated subagent runs. Named agents are loaded from trusted roots; calls without `agent` create a validated, read-only dynamic DAG. Child artifacts are private and worktrees are accepted only through an approved descriptor/path.

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

## Pi commands

- `/subagents` — list the available named agents and their descriptions.

The extension also registers the `subagent` **tool**. Ask Pi to use it, or invoke it through an RPC/tool client. The tool description includes the list of available agents so the orchestrator can pick the right one. It has these forms:

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

`tasks` runs explicit named-agent jobs in parallel; `chain` runs them in order. Provide only one form per call: top-level `agent`/`task`, `tasks`, or `chain`. If forms are mixed, `tasks` takes precedence over `chain`, and either array overrides the top-level single-task fields. Ignored forms are not executed, so duplicated fields do not start extra agents. A named agent that does not exist is an error and never falls back to dynamic planning. Set `PI_SUBAGENTS_PI` to use a specific Pi executable for child RPC processes.
