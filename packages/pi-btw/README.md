# pi-btw

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Ask a side question without polluting the main conversation. `pi-btw` adds
`/btw` to [Pi Agent](https://github.com/badlogic/pi-mono) — a side chat opens over
the main conversation, with its own input and history. Your same primary model
answers using a read-only clone of the current conversation as context. The side
chat never enters the main transcript and never touches disk.

## Install

```sh
pi install npm:pi-btw
```

Restart your Pi session.

## Quick start

Type `/btw` with no arguments:

```
/btw
```

A panel opens over the main chat. Write a question in its input and press Enter.
A `…` appears while the model works; the answer stays in the panel. Keep asking
follow-up questions without closing it. Prior questions **and answers** from this
session are visible in the same scrollable conversation.

You can still send the first question directly:

```
/btw why did we switch from sockets to SSE last week?
```

While a reply is pending, you can type your next question. Press Enter after the
reply arrives to send it — requests are not queued or run concurrently.

`/btw` uses whatever model is already driving your session — there is nothing to
pick, but Pi needs an active model with working credentials (`/login`).

| Key | Action |
| --- | --- |
| `Enter` | Send the question from the panel's input when no reply is pending |
| `↑` / `↓`, `PageUp` / `PageDown` | Scroll the conversation; the input stays visible |
| `Ctrl+L` | Clear this session's `/btw` history when no reply is pending |
| `Esc` | Close the panel immediately, cancelling only the side call if it is still running |

## What you get

- **Nothing leaks into the main chat** — the answer is drawn in an overlay, never
  emitted as an agent message, never written to the transcript, never written to disk.
- **The side question already knows your work** — it is handed a read-only clone
  of the current conversation branch, so you do not re-explain context.
- **Follow-ups have their own thread** — ask multiple questions in one panel;
  every successful `/btw` turn in a session is replayed into the next one, so the
  side conversation remembers itself. Reopening `/btw` restores that history.
- **`Esc` cancels only the side question** — cancelling it never interrupts what
  the main session is doing.
- **Survives `/new`, `/fork`, `/resume`, `/reload`** — history is held in the
  running Pi process and clears when Pi exits.
- **Correct after compaction** — the context snapshot is rebuilt whenever the
  conversation is compacted or re-branched, so a later `/btw` never answers off a
  stale view.
- **No tools, plain text** — a side question cannot edit a file or run a command.

## Requirements

- **An interactive terminal.** `/btw` refuses to run without a UI — it is not
  available under `pi --print` or RPC.
- **An active primary model with resolvable credentials.** Any provider works.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/btw requires interactive mode` | Running under `pi --print …` or RPC | Run Pi interactively |
| `/btw requires an active model` | No primary model configured | Set one with `/login`, or edit Pi's own `~/.pi/agent/models.json` |
| `/btw model (…) has no API key available.` | Credentials for the active model do not resolve | Re-authenticate that provider |
| Enter does nothing while `…` is displayed | A side reply is still pending | Wait for it, then press Enter again; your draft stays in the input |
| Pressing `x` does not clear history | Printable characters now belong to the chat input | Press `Ctrl+L` when no reply is pending |
| History gone after restarting Pi | By design — state is process-scoped, never written to disk | Nothing to fix; your main session is unaffected |

## License

MIT — see [LICENSE](LICENSE).
