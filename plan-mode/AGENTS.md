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
- Shortcut: default `ctrl+shift+p` conflicts with pi's `app.model.cycleBackward`.
  Settings and the conflict note are in `README.md` (single source).
- The system prompt section changes from the next user message, not mid-run. While ON, a one-line
  reminder is also appended to every LLM request (`context` event, not stored in the transcript),
  so ON takes effect immediately; OFF stops the reminder at once.
- Next steps if needed (not done yet): block `edit`/`write` in a `tool_call` hook,
  a read-only bash allowlist, a `sandbox-exec` sandbox.

## Files

- `index.ts` — the extension: `/plan` command, shortcut, prompt injection.
- `prompts.ts` — the ON/OFF prompt texts.
- `settings.ts` — settings type, defaults, `loadSettings()`.
- `package.json` — `pi` manifest and package metadata (`index.ts` alone
  would also be discovered).

## Conventions

- Keep it minimal. Add code only for a real need.
- Lives in the pi-minimal jj repo (see root `AGENTS.md`).
- After edits, restart pi to load changes.
