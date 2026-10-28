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
| `keyboardShortcut` | string (key id) | `ctrl+alt+p` | Shortcut that toggles plan mode. No pi default uses it. Some terminals need Alt/Option set as Meta, and multiplexers such as tmux may drop modifiers. If it does not work, pick another key. |

```json
{ "pi-minimal": { "plan-mode": { "keyboardShortcut": "ctrl+alt+o" } } }
```
