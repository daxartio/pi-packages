# pi-btw

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Ask a side question without polluting the main conversation. `pi-btw` adds
`/btw <question>` to [Pi Agent](https://github.com/badlogic/pi-mono) — your same
primary model answers in a panel at the bottom of the terminal, using a read-only
clone of the current conversation as context. The answer never enters the
transcript and never touches disk.

## Install

```sh
pi install npm:pi-btw
```

Restart your Pi session.

## Quick start

Type `/btw` followed by your question:

```
/btw why did we switch from sockets to SSE last week?
```

A panel opens at the bottom of the terminal with your question on a banner, a `…`
while the model works, and the answer when it arrives. Prior `/btw` questions from
this session are listed under the banner, so follow-ups have context.

`/btw` uses whatever model is already driving your session — there is nothing to
pick, but Pi needs an active model with working credentials (`/login`).

| Key | Action |
| --- | --- |
| `↑` / `↓` | Scroll the panel whenever content overflows — the hint appears once the answer arrives |
| `x` | Clear this session's `/btw` history — hint shown only when you have prior entries |
| `Esc` | Dismiss the panel, cancelling the call if it is still running |

## What you get

- **Nothing leaks into the main chat** — the answer is drawn in an overlay, never
  emitted as an agent message, never written to the transcript, never written to disk.
- **The side question already knows your work** — it is handed a read-only clone
  of the current conversation branch, so you do not re-explain context.
- **Follow-ups have their own thread** — every `/btw` turn in a session is replayed
  into the next one, so the side conversation remembers itself.
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
| `Usage: /btw <question>` | `/btw` ran with no argument | Put the question on the same line |
| Pressing `X` does nothing | Only lowercase `x` is bound to clear history | Press `x` |
| History gone after restarting Pi | By design — state is process-scoped, never written to disk | Nothing to fix; your main session is unaffected |

## License

MIT — see [LICENSE](LICENSE).
