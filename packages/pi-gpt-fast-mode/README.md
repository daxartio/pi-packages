# pi-gpt-fast-mode

A Pi extension that requests Fast mode (`service_tier: "priority"`) for supported GPT models through `openai`, `openai-codex`, and `github-copilot`.

## Supported models

- `gpt-5.4`, `gpt-5.4-mini`
- `gpt-5.5`, `gpt-5.6`
- `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
- `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`
- `gpt-6.1-sol`

The extension does not register models or grant access to them. Model availability and whether the priority tier is honored depend on the provider and your account. In particular, sending the parameter to GitHub Copilot does not guarantee faster responses. Non-GPT Copilot models are not modified.

## Usage

- `/fast` toggles Fast mode.
- `ctrl+alt+m` toggles Fast mode by default.
- `⚡ fast` appears in the status bar when Fast mode is enabled for a supported model.

To enable Fast mode by default, add this to global Pi `settings.json`:

```json
{
  "pi-gpt-fast-mode": {
    "enabled": true
  }
}
```

The same setting applies to GitHub Copilot; no separate provider configuration is needed. Explicit toggles are persisted in `pi-gpt-fast-mode.json` and take precedence over the default.

To customize the shortcut, set `"pi-gpt-fast-mode": ["ctrl+alt+m"]` in global Pi `keybindings.json`. Use `false` or `null` to disable the shortcut.
