# pi-minimal-companion-prompts

Personal prompts with conditions. `~/.pi/agent/companion-prompts/rules.ts` exports
`{ file | name+text, when }[]`; each prompt (a `.md` file, or an inline `text`) whose
`when(c)` returns true is added to the
system prompt (section `companion_<file name or name>`). See `README.md` for the format.

## Scope

- `c` has only `cwd`, `extensions` and `mcpServers`. No helpers: rules use plain TS (regex,
  `startsWith`, `&&`).
- `c.extensions`: ids (`source`, or the path when the source is `auto`) of the
  extensions enabled in the resolved pi config (`DefaultPackageManager.resolve()`,
  same logic as `pi config`; covers hook-only extensions), plus the ones that
  registered a tool or command (`sourceInfo`; covers `-e <path>`).
- `c.mcpServers`: names in `mcp.json` (user file, plus the project file when
  `ctx.isProjectTrusted()`) that are not `enabled: false`. Read from the files because
  MCP tools are not registered yet at `session_start` (checked: none in `getAllTools()`),
  and pi exports no config loader.
- Not handled: `--no-extensions`; extensions that are enabled but failed to load;
  `-e` extensions that register their tools only after `session_start` started.
- Rules are evaluated once at `session_start`: cwd and the loaded extensions only
  change with a new session or `/reload`. `before_agent_start` only copies the
  cached sections.
- `rules.ts` is loaded with `import()`, which pi's jiti rewrites (so full TS works).
  The `?t=` query skips jiti's cache, which pi reuses on `/new` and `/resume`.
- One always-on section `companion-prompts` (hyphen, so no rule name can clash) tells
  the agent where `rules.ts` and this `README.md` are. About 30 tokens; keep it short.
- No write anywhere. No settings, no commands.
- Risk: `DefaultPackageManager` is a public SDK export, but not an extension API.
  If a pi upgrade breaks it, fix `session_start`.

## Files

- `index.ts` — the extension.
- `package.json` — `pi` manifest and package metadata.

## Conventions

- Keep it minimal. Add code only for a real need.
- Lives in the pi-minimal jj repo (see root `AGENTS.md`).
- After edits, restart pi to load changes.
