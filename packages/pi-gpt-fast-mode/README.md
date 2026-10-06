# pi-gpt-fast-mode

A Pi extension that requests Fast mode by adding `service_tier: "priority"` to provider request payloads when enabled. There are no model or provider allowlists, so new models need no extension updates.

The extension does not register models or grant access to them. Whether the parameter is accepted or the priority tier is honored depends on the API and your account. Incompatible APIs may reject the request; the extension does not silently remove the flag or retry. Errors mentioning `service_tier` or the priority tier include a hint to disable `/fast` and retry, while preserving the original API error.

## Usage

- `/fast` toggles Fast mode.
- `ctrl+alt+m` toggles Fast mode by default.
- `⚡ fast` appears in the status bar whenever Fast mode is enabled. It indicates that the flag is being requested, not that the API supports it.

To enable Fast mode by default, add this to global Pi `settings.json`:

```json
{
  "pi-gpt-fast-mode": {
    "enabled": true
  }
}
```

The same setting applies to all providers; no separate provider configuration is needed. Explicit toggles are persisted in `pi-gpt-fast-mode.json` and take precedence over the default.

To customize the shortcut, set `"pi-gpt-fast-mode": ["ctrl+alt+m"]` in global Pi `keybindings.json`. Use `false` or `null` to disable the shortcut.
