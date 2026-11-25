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
- Shortcut: default `ctrl+alt+p`. No pi default uses it (`ctrl+shift+p` is pi's
  `app.model.cycleBackward`, so it was dropped). Settings and terminal notes are in
  `README.md` (single source).
- The system prompt section changes from the next user message, not mid-run. While ON, a one-line
  reminder is also appended to every LLM request (`context` event, not stored in the transcript),
  so ON takes effect immediately; OFF stops the reminder at once.
- Static prompt size (measured): ON section 776 chars (~195 tokens), OFF line 48 chars (~12 tokens),
  per-request reminder 85 chars (~22 tokens, not cached, only while ON).
- Tests: `loadSettings` only (fake pi). Wiring in `index.ts` (command, shortcut, hooks) has no
  automated test; real-pi smoke test: not done.
- Next steps if needed (not done yet): block `edit`/`write` in a `tool_call` hook,
  a read-only bash allowlist, a `sandbox-exec` sandbox.

## Files

- `test.ts` — `node:test` for `loadSettings` (run by `npm run check`; not published).
- `index.ts` — the extension: `/plan` command, shortcut, prompt injection.
- `prompts.ts` — the ON/OFF prompt texts.
- `settings.ts` — settings type, defaults, `loadSettings()`.
- `package.json` — `pi` manifest and package metadata (`index.ts` alone
  would also be discovered).

## Conventions

- Keep it minimal. Add code only for a real need.
- Lives in the pi-minimal jj repo (see root `AGENTS.md`).
- After edits, run `/reload` to load changes.
