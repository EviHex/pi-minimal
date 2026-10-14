# pi-minimal-plan-mode

`/plan` toggles plan mode. When on, a `plan_mode` section is added to the system
prompt telling the agent to stay read-only and output a plan. When toggled
off, the section becomes a short "Plan mode is OFF" line, so the agent knows it
may now make changes. That is all.

## Scope

- Prompt-only. Nothing is blocked: the agent is trusted to obey. This prevents
  slips, not a determined or confused agent.
- State is in memory: it resets on restart, /reload, and session switch
  (/new, /resume, /fork).
- Shortcut: default `ctrl+shift+p`, which pi reserves for `app.model.cycleBackward`;
  unbind that in `keybindings.json` or pi skips ours. Change it in settings.json:
  `"pi-minimal": { "plan-mode": { "keyboardShortcut": "ctrl+alt+p" } }`.
- Toggling takes effect from the next user message, not mid-run.
- Next steps if needed (not done yet): block `edit`/`write` in a `tool_call` hook,
  a read-only bash allowlist, a `sandbox-exec` sandbox.

## Files

- `index.ts` — the whole extension.
- `package.json` — `pi` manifest and package metadata (`index.ts` alone
  would also be discovered).

## Conventions

- Keep it minimal. Add code only for a real need.
- Own colocated jj repo. Conventional commits, always `-m`.
- After edits, restart pi to load changes.
