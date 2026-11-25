# @pi-minimal/todo

Declarative todo list: the `todo` tool takes the full list (idempotent snapshot), and
`pi.appendEntry("todo", items)` saves it. `replay` restores the latest valid snapshot from
the branch on `session_start`, `session_compact` and `session_tree`. See `README.md` for users.

## Decisions

- One session state, no per-session map: a pi process has one foreground session, and
  sub-agents are separate processes.
- No keyboard shortcut: `/todo minimize` does the job without a conflict risk.
- Widget text is lowercase for the fixed words (`todos`, `pending`, `all done`), like
  `@pi-minimal/subagents`. Item text is shown as written.
- Colors: the sub-agents palette (`accent` dot, `muted` count, `warning` for `in_progress`,
  `borderMuted` tree lines, `dim` for done rows).
- `/todo clear` sends a hidden custom message (`display: false`, `triggerTurn: false`) at the
  tail, so earlier messages (the cached prefix) do not change.
- Reminder: a counter of tool results (not nested calls) since the last `todo` call; at
  `reminderInterval` one text block is appended to the result. Only the tail changes.
- Static prompt text is two short lines: it is part of every request. `guidelines` setting
  (`resolveGuidelines`): preset `default`/`always`/`off`, or a custom array. It is read at
  extension load (`pi.getSettings()` throws before bind, so `index.ts` reads the global and
  project `settings.json` files itself) and pi reads `promptGuidelines` from the tool
  definition when it builds the tool registry, so it is fixed per load: a change needs
  `/reload`. Never change it mid-session (prompt cache).
- Settings are written only by `/todo settings` (`writeTodoSettings`, merge under
  `"pi-minimal"."todo"`); everything else only reads them. This is the one exception to
  the repo rule "extensions never write settings", because the user asks for it in a menu.

## Files

- `core.ts` — pure: types, `parseItems`, `replay`, `formatSummary`, `renderLines`, settings.
- `prompts.ts` — tool text, guidelines, clear notice, reminder, `/todo` completions.
- `index.ts` — tool, command, widget, events (checked by hand, not by tests).
- `test.ts` — `node:test` for `core.ts` and `prompts.ts`.

## Checks

`npm run check -w todo`. For `index.ts`, run pi with the package and call `/todo` and the tool.
