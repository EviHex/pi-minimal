# @pi-minimal/plan-mode

`/plan` toggles plan mode. When on, the system prompt tells the agent to stay
read-only and output a plan. Nothing is blocked: the agent is trusted to obey.

## Install

```sh
pi install ~/Code/pi-minimal/plan-mode
```

## Settings

Put settings in `~/.pi/agent/settings.json` (global) or `.pi/settings.json`
(project), under `"pi-minimal"."plan-mode"`. Merge the keys; do not overwrite
the file. Settings are read at session start (use `/reload`).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `keyboardShortcut` | string (key id) | `ctrl+shift+p` | Shortcut that toggles plan mode. The default is reserved by pi for `app.model.cycleBackward`: unbind that in `keybindings.json`, or pi skips this shortcut. |

```json
{ "pi-minimal": { "plan-mode": { "keyboardShortcut": "ctrl+alt+p" } } }
```
