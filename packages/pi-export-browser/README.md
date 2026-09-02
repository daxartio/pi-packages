# pi-export-browser

A Pi extension that exports the current session to a timestamped HTML file in the system temp directory and opens it in the default browser.

## Usage

```
/browse
```

That's it — the session is rendered with pi's own HTML exporter, written to
`$TMPDIR/pi-session-<id>-<timestamp>.html`, and opened with the platform
browser opener (`open` on macOS, `xdg-open` on Linux, `start` on Windows).

The export includes everything the built-in `/export` includes:

- the full effective system prompt (with the `<system-reminder>` tail pi appends);
- all currently active tool definitions (name, description, JSON schema);
- the whole message tree of the current session branch, with stats and theme.

Each invocation creates a new timestamped file, so exports never overwrite
each other and nothing is written into the current working directory.

## Why not override `/export`?

Pi's built-in `/export` command is handled by the TUI before extension
commands are dispatched, so an extension cannot replace it. `/browse` is the
browser-opening counterpart: same HTML rendering, but a temp output path plus
an automatic browser open.

## Fallback renderer

The full-featured HTML template lives in pi internals and is resolved via a
deep import. If a future pi update moves that module, the extension degrades
to a minimal built-in renderer (still including system prompt and tools)
instead of failing, so `/browse` keeps working.
