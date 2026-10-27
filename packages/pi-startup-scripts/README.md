# pi-startup-scripts

Run custom commands once at the beginning of a Pi session and use their stdout as system context. Useful for project inventories and other agent preparation scripts.

## Install

```sh
pi install ./packages/pi-startup-scripts
```

## Configuration

Create `~/.pi/agent/pi-startup-scripts.json`. The directory is resolved with Pi's `getAgentDir()`, respecting `PI_CODING_AGENT_DIR`; `PI_HOME` is not a separate override. A missing file means no commands are configured. Configuration changes apply to new sessions; the global toggle also takes effect immediately in the current session.

```json
{
	"enabled": true,
	"timeoutMs": 300000,
	"includeEmpty": false,
	"scripts": [
		{
			"command": [
				"$HOME/bin/project-inventory",
				"${projectPath}",
				"--name",
				"${projectName}"
			],
			"prompt": "Use this inventory of ${projectName} to locate relevant code."
		},
		{
			"command": ["python3", "$HOME/bin/project-notes.py", "${projectPath}"],
			"prompt": "Additional project notes:",
			"timeoutMs": 60000,
			"includeEmpty": true
		}
	]
}
```

- `enabled`: optional boolean at the top level and per script; defaults to `true` independently at both levels. A globally disabled plugin executes no scripts, even if a script explicitly has `enabled: true`.
- `scripts`: ordered array of script definitions; required, can be empty.
- `command`: non-empty string array, `[executable, ...args]`. Arguments are passed literally, without a shell. Use an executable script or an explicit interpreter. Executables can be absolute paths, paths relative to the project directory, or names on `PATH`. Every command runs with the project directory as its working directory and inherits Pi's environment. Stdin is closed.
- `prompt`: optional instructions placed before stdout. Can be set globally and overridden per script; defaults to an empty string.
- `timeoutMs`: positive integer, globally or per script. Default: `300000` (five minutes) **per command**. Maximum: `2147483647`.
- `includeEmpty`: globally or per script, default `false`. Empty or whitespace-only stdout omits the entire section, including its prompt. Set `true` to retain the section even without output.

Templates are replaced in every command element and in prompts:

| Template           | Value                                          |
| ------------------ | ---------------------------------------------- |
| `${projectPath}`   | Absolute current project directory (`ctx.cwd`) |
| `${projectName}`   | Last component of that directory               |
| `$HOME`, `${HOME}` | Current user's home directory                  |

Replacement is single-pass. Other shell syntax, environment variables, glob patterns and `~` are not expanded. Paths containing spaces remain a single argument.

## Toggle commands

```text
/startup-scripts toggle
/startup-scripts toggle 1
```

`toggle` switches the entire plugin on/off and saves `enabled` in the JSON configuration. Switching off immediately removes script context from subsequent model turns and bypasses the startup-error input gate. Existing output remains in session history and HTML exports. Switching back on reuses the saved result without rerunning commands; if this session started disabled and has never executed scripts, enabling runs them once.

`toggle <number>` changes one script's `enabled` flag for **new sessions**. Numbers are 1-based positions in the `scripts` array, including disabled scripts. This does not rerun commands, remove previously captured output, or acknowledge current errors. All scripts and the plugin are enabled by default. Toggles preserve prompts and other configuration fields and save atomically.

## Session lifecycle and errors

Commands run sequentially, including commands after a failure. At the end, failures are reported together in one error notification. A nonzero exit, signal, missing executable, timeout or output exceeding 1 MiB (combined stdout and stderr per command) is a failure. Invalid configuration blocks startup before any commands execute. Stderr is drained but is not added to model context or error notifications; diagnostics identify the script number and failure reason, without exposing command arguments or stderr.

If anything fails, ordinary agent input is blocked in interactive, RPC and print modes. Review the errors, then explicitly run:

```text
/startup-scripts continue
```

Resubmit your prompt afterward. Successful scripts' output is kept; failed scripts' output is excluded. The command acknowledges errors without retrying scripts. Other extension commands remain available and manage their own behavior.

The execution marker, successful context and acknowledgement are stored as custom session entries. Resume, reload, compaction and branch navigation do not rerun scripts. An interrupted execution requires acknowledgement rather than an automatic retry. A new session runs the current configuration again; forked sessions inherit any saved startup entries copied by Pi.

Captured context is appended to the system prompt for each enabled agent turn from the saved result. Scripts themselves are never rerun for individual messages. The same output is saved once as a visible `pi-startup-scripts:output` message, so it appears in the session and standard HTML exports. That display message is filtered out of model conversation context to avoid duplicating the system context. Reloading an older session with saved script output adds its missing visible message without rerunning scripts. No configuration file is created automatically except when saving a toggle.

## Safety

Only configure trusted commands. They execute with Pi's permissions and inherited environment. Their stdout and configured prompts are stored in the session and sent to the model: do not emit credentials or other sensitive data. On Unix, timeout/output-limit termination kills the command's process group, including ordinary descendants; on Windows only the direct child is terminated.

## Development

```sh
bun run --filter pi-startup-scripts test
bun run --filter pi-startup-scripts typecheck
```
