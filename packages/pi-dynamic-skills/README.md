# pi-dynamic-skills

A Pi extension that includes skills in the system prompt only when their environment rules match. Compatible with Pi >= 0.87.1.

```sh
pi install npm:pi-dynamic-skills
# Or from this repository:
pi install ./packages/pi-dynamic-skills
```

## Skill format

[Agent Skills](https://agentskills.io/specification) defines `compatibility` as an optional string of at most 500 characters. This extension recognizes only strings prefixed with `pi-dynamic-skills:` followed by a JSON expression. Quote the YAML string, or use a folded scalar:

```yaml
---
name: git-workflow
description: Work with Git history and branches.
compatibility: 'pi-dynamic-skills: {"exists":".git"}'
---
```

This enables the skill when `.git` exists in Pi's working directory (including Git worktrees, where `.git` is a file).

```yaml
compatibility: >-
  pi-dynamic-skills: {"all":[{"ancestor":".git"},{"any":[{"file":"Cargo.toml"},{"file":"package.json"}]},{"not":{"platform":"win32"}}]}
```

## Expressions

Each expression is an object with exactly one operator:

| Expression                         | Meaning                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `{"exists":".git"}`                | A path exists (file or directory).                                              |
| `{"file":"Cargo.toml"}`            | A path is a regular file.                                                       |
| `{"directory":"src"}`              | A path is a directory.                                                          |
| `{"ancestor":".git"}`              | A path exists in the working directory or any parent up to the filesystem root. |
| `{"platform":"linux"}`             | Match Node's `process.platform`, e.g. `linux`, `darwin`, `win32`.               |
| `{"all":[expression, expression]}` | All expressions match; array must be nonempty.                                  |
| `{"any":[expression, expression]}` | At least one expression matches; array must be nonempty.                        |
| `{"not":expression}`               | Negate an expression.                                                           |

Paths are relative to Pi's working directory, **not** the skill directory. Absolute paths are also accepted. For `ancestor`, paths are resolved against each ancestor. No glob, environment-variable or `~` expansion occurs. Symlinks are followed; broken symlinks count as missing. Expressions are limited to 500 characters and 16 nesting levels. No JavaScript, shell commands, network requests, or environment variables are evaluated.

## Defaults and interoperability

- Missing `compatibility`, ordinary prose, other prefixes, malformed JSON, unknown operators, invalid operands and oversized/deep rules are ignored: the skill remains eligible. The entire expression is validated before evaluation.
- A valid expression returning `false` removes the skill from the current system-prompt skill list.
- Read/parse/evaluation errors leave the affected skill eligible. Interactive sessions receive a count-only warning without file contents or error details.
- Rules and skill frontmatter are reread before each agent request. A newly matching skill returns on the next request because Pi supplies a fresh prompt-options list. No `/reload` is necessary for edits to existing skill rules or environment markers; discovery of new skills still follows Pi's normal reload behavior.
- This extension only filters the incoming structured list; it never rediscovers or reinserts skills. `pi-context` can disable all skills or individual skills regardless of extension load order. Enabling a skill in `pi-context` does not bypass a false compatibility rule.
- This controls skill **discovery in the system prompt**, not authorization. It does not erase skill text already loaded in conversation history, block explicit `/skill:name` invocations, or prevent reading skill files through tools. Existing `disable-model-invocation` settings are preserved.

## Development

```sh
bun test ./packages/pi-dynamic-skills/test/
bun run typecheck
```
