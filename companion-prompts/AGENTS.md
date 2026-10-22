# pi-minimal-companion-prompts

Personal prompts per extension. Each file in `~/.pi/agent/companion-prompts/`
names one extension in its frontmatter; the text is added to the system prompt
(section `companion_<file name>`) only when that extension is loaded.

```md
---
extension: npm:@gotgenes/pi-subagents
---
Always run sub-agents in the background.
```

## Scope

- Matching is exact on the `extension:` id, never on the file name. The id is the
  `source` in `settings.json` (for example `npm:pi-lens`). Auto-discovered
  extensions all have the source `auto`, so their id is the file path.
- "Loaded" means: enabled in the resolved pi config (`DefaultPackageManager.resolve()`,
  same logic as `pi config`; this covers extensions that only use hooks), or it
  registered a tool or command (`sourceInfo`; this covers `-e <path>`).
- At `session_start`, a stub (frontmatter only, empty text) is created for each
  enabled extension that has no file yet. This is the only write; existing files
  are never changed. Stubs stay after an extension is removed; delete them by hand.
- Files without `extension:` and files with empty text are ignored.
- Not handled: `--no-extensions`; extensions that are enabled but failed to load.
- Files are read at `session_start`. Use `/reload` after a change.
- System prompt section: one copy in the context, the prompt cache stays valid.
  Keep the files short.
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
