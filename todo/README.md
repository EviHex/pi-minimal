# @pi-minimal/todo

A declarative todo list. The agent calls the `todo` tool with the full list each time
(`pending`, `in_progress`, `done`); a widget above the editor shows it. The list is saved
on the session branch, so it survives `/reload`, compaction and branch navigation.

```text
● todos (1/4)
├─ ✓ Read code
├─ ◐ Write tests
├─ ○ Run check
└─ ○ Ship
```

- The tool result is a short echo: `1/4 done · active: "Write tests" · next: "Run check"`.
- At most one item is `in_progress`; extra ones become `pending`.
- When items are unfinished and the agent has made `reminderInterval` tool calls without
  updating the list, one line is added to a tool result: `[todo: 1/4 done, active: "..." — call todo if progress changed.]`.
- When every item is done, the widget hides at the start of the next turn.

## Install

Not on npm yet. Clone the repo and install from the folder:

```sh
git clone https://github.com/EviHex/pi-minimal
pi install ./pi-minimal/todo
```

Remove other extensions that register a `todo` tool first: two tools with one name conflict.

## Commands

- `/todo minimize`: toggle between the tree and one line (`● todos (1/4) › ◐ Write tests`).
- `/todo clear`: empty the list. The agent is told with a hidden message added at the end
  of the conversation (the prompt cache stays valid).
- `/todo settings`: change the settings below in a menu. They are saved to `~/.pi/agent/settings.json`.

## Settings

Under `"pi-minimal"."todo"` in `~/.pi/agent/settings.json` (global) or `.pi/settings.json`
(project). Read at session start (use `/reload`). `guidelines` is read when the extension loads.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `defaultMinimized` | boolean | `false` | Start with the one-line widget. |
| `hideCompletedOnNextTurn` | boolean | `true` | Hide the widget when all items are done and a new turn starts. |
| `reminderInterval` | integer | `8` | Tool calls between reminders while items are unfinished. `0` turns them off. |
| `guidelines` | `"default"` \| `"always"` \| `"off"` \| string[] | `"default"` | Prompt lines for the tool. `default`: use `todo` for tasks with 3+ steps, skip trivial ones. `always`: use it on every task that needs tools. `off`: none. An array is used as is. Bad values mean `default`. Needs `/reload`. |

```json
{ "pi-minimal": { "todo": { "defaultMinimized": true, "reminderInterval": 5 } } }
```
