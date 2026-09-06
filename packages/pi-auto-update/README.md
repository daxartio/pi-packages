# pi-auto-update

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Automatically update [Pi Agent](https://github.com/badlogic/pi-mono) when a
session starts. `pi-auto-update` runs `pi update --extensions` followed by
`pi update` on every startup, showing progress in the status bar and a
notification when finished.

Based on [eiei114/pi-auto-update](https://github.com/eiei114/pi-auto-update),
trimmed to the essentials.

## Install

```sh
pi install npm:pi-auto-update
```

Restart your Pi session.

## Usage

Nothing to configure — updates run automatically at session startup. To trigger
an update manually:

```
/auto-update-now
```

| Environment variable | Effect |
| --- | --- |
| `PI_OFFLINE=1` | Skip auto-update entirely (offline mode) |
| `PI_AUTO_UPDATE=0` | Disable auto-update |

On Windows the `pi` CLI is invoked through `cmd.exe`, because npm/pnpm install
CLI entrypoints as `.cmd` shims and Pi's exec API does not use a shell.
