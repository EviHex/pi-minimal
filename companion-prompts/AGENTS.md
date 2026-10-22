# pi-minimal-companion-prompts

Personal prompts per extension. Put `<name>.md` in `~/.pi/agent/companion-prompts/`.
When an extension is loaded, the file is added to the system prompt as a
`companion_<name>` section. When it is not loaded, nothing is added.

## Scope

- "Loaded" means: the extension is enabled in the resolved pi config
  (`DefaultPackageManager.resolve()`, same logic as `pi config`; this also covers
  extensions that only use hooks), or it registered a tool or command
  (`sourceInfo`; this also covers `-e <path>`).
- Match: `<name>` is a substring of the extension source or path (for example
  `pi-lens` matches `npm:pi-lens`). Use long, specific names: `mcp.md` can match
  more than one extension.
- Not handled: `--no-extensions`; extensions that are enabled but failed to load.
- Files and config are read at `session_start`. Use `/reload` after a change.
- It is a system prompt section, so there is one copy in the context and the
  prompt cache stays valid. Keep the files short.
- Risk: `DefaultPackageManager` is a public SDK export, but not an extension API.
  If a pi upgrade breaks it, fix `session_start`.
- No settings, no commands.

## Files

- `index.ts` — the extension.
- `package.json` — `pi` manifest and package metadata.

## Conventions

- Keep it minimal. Add code only for a real need.
- Lives in the pi-minimal jj repo (see root `AGENTS.md`).
- After edits, restart pi to load changes.
