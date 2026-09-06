# pi-auto-model

A Pi extension that suggests the best-suited model and thinking level from your current
`scoped-models` for each prompt. **Nothing ever switches without your decision.**

Inspired by [pi-auto-model](https://github.com/janvitos/pi-auto-model) and
[pi-automode](https://github.com/czottmann/pi-automode), with a different core flow:
the chat always starts on your default model, and a switch happens only after you
explicitly accept a suggestion.

## How it works

1. You send a prompt. It is processed by the **current (default) model** as usual —
   classification never blocks the turn.
2. In parallel, the **current chat model** classifies its own prompt (as a side call
   with minimal thinking) and picks the best model + thinking level from the session's
   `scoped-models` (or from all available models when no scope is configured). Next to
   every candidate the classifier sees objective facts pulled from Pi's model catalogue
   (reasoning support, input types, context window, price per Mtok) plus any
   `modelHints` you wrote for it. The routing goal is the fewest expected total tokens
   to finish the request: a weak model that stalls and needs rescuing costs more than a
   strong model that solves it in one pass.
3. If the suggestion matches the current setup, nothing happens. Otherwise you get a
   dialog:
   - **Switch and resend** — switch model/thinking and re-send the same prompt, so the
     new model answers it.
   - **Always switch this session** — same, plus remember this model: later prompts
     routed to it switch and resend immediately (still only after your first explicit
     approval).
   - **Keep current model** — ignore the suggestion.
4. If the dialog times out or is dismissed, the offer stays pending:
   `/automodel accept` applies it later, `/automodel dismiss` drops it.

If the classifier fails, times out, or suggests an unavailable model, the extension
warns and keeps the current model. When switching fails (e.g. missing credentials),
the previous model is restored.

Scoped models with a pinned thinking level (`provider/model:high` in `--models` /
`enabledModels`) keep that level; the classifier only chooses the model for them.

## Install

```bash
pi -e /path/to/pi-packages/packages/pi-auto-model
```

## Configure

Create `~/.pi/agent/auto-model.json`:

```json
{
  "version": 1,
  "enabled": true,
  "classifierThinkingLevel": "low",
  "extraInstructions": "Prefer Claude models for Rust work.",
  "modelHints": {
    "openai/gpt-5.6-mini": "fast and cheap; quick questions, lookups, small edits",
    "anthropic/claude-sonnet-4-5": "default workhorse for everyday coding and debugging",
    "anthropic/claude-opus-4-5": "architecture, migrations, security, hairy root-cause hunts"
  }
}
```

- The classifier is always the **current chat model** — no separate model to configure.
- `classifierThinkingLevel` — thinking level for the classifier side call
  (default `"off"`, keeping routing cheap).
- `extraInstructions` — optional free-form hints appended to the classifier prompt.
- `modelHints` — optional per-model descriptions (`"provider/model": "when to use it"`)
  shown to the classifier next to each candidate, after the objective catalogue facts
  (reasoning, input types, context window, price).

Routing is off until the config exists.

## Commands

```text
/automodel status   Show config, current scope, and pending suggestion
/automodel on       Enable routing (persisted)
/automodel off      Disable routing (persisted)
/automodel accept   Accept the pending suggestion: switch model and resend the prompt
/automodel dismiss  Drop the pending suggestion
```

## Notes

- Routing runs once per prompt; it never fires twice in a row (the resent prompt is
  answered directly by the switched model).
- Switching the model manually clears any pending suggestion implicitly — the next
  prompt is classified against your new model.
- The classifier request uses a short timeout, a bounded token budget, and no cache
  retention. The prompt is classified as data; instructions inside it about model
  selection are ignored.

## Development

```bash
bun test ./test
bunx tsc --noEmit
```

## License

MIT
