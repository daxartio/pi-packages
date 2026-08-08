# pi-worktree

A Pi extension that manages package-owned Git worktrees. It journals transitions under the repository common Git directory and only removes records it created. Returned descriptors are versioned plain data for optional child-agent handoff; this package does not import `pi-subagents`.

Default dirty policy is `reject`; `ignore` preserves source changes outside the new worktree. Managed worktrees are always created in the canonical package-owned `.pi-worktrees` pool next to the primary repository. Install only from trusted sources.

## Install

```sh
pi install ./packages/pi-worktree
```

Restart Pi or run `/reload` after installation.

## Pi commands

- `/worktree` — displays guidance for the managed-worktree tool.

The extension registers the `worktree` **tool**. Ask Pi to use it, or invoke it through an RPC/tool client.

```json
{ "action": "create", "name": "auth-review" }
{ "action": "create", "name": "ignore-local-changes", "dirtyPolicy": "ignore" }
{ "action": "list", "limit": 50 }
{ "action": "status", "id": "auth-review-0123456789ab" }
{ "action": "remove", "id": "auth-review-0123456789ab" }
{ "action": "remove", "id": "auth-review-0123456789ab", "force": true }
{ "action": "cleanup" }
{ "action": "cleanup", "dryRun": false, "olderThanMs": 86400000 }
```

`create` returns a `WorktreeDescriptorV1` containing `cwd`, `branch`, `baseCommit`, and `repositoryId`; pass its `cwd` to another compatible tool only after explicit workspace authorization. `remove` accepts managed IDs only. Forced removal and non-dry-run cleanup require interactive confirmation. `cleanup` is dry-run by default. `snapshot` is currently rejected; use `reject` (default) or `ignore`.
