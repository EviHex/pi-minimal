# @pi-minimal/mention-skills

Type `$` in the editor to autocomplete skills and prompt templates. Like pi's `@`
for files, nothing is inlined: before each LLM call, `$name` gets its file path,
and the agent reads the file itself.

- You type and see: `use $jj to commit`
- The LLM sees: `use $jj (skill: /path/to/jj/SKILL.md) to commit`
- A fixed `mention_skills` system prompt section tells the agent to read the file
  unless it already did, then follow it.

## Behavior

- Names come from `pi.getCommands()` (`skill` and `prompt` sources), rebuilt on
  every `session_start` (also `/reload`, `/new`, `/resume`). A skill wins on a name
  clash.
- A mention is `$` at line start or after whitespace or `( [ { <`, followed by
  `[\w-]+`. `$jj,` matches `jj`. Unknown names (`$HOME`, `$1`) are left alone.
- The `context` event edits pi's copy of all user text blocks on every LLM call.
  Session history and the chat UI keep the short `$name`. Output is the same for
  the same input, so the prompt cache stays valid.
- Settings: see `README.md` (single source).

## Limits

- The agent may skip reading the file (same as `@`).
- After compaction, the summary only has `$name`. Skills are still in pi's skill
  list; prompt templates lose their path.
- Prompt templates get no arguments; `$1`/`$@` in the file stay as they are.
- No frecency, coloring, configurable trigger, or code-block detection.

## Files

- `index.ts` — the extension.
- `README.md` — usage and settings.
- `package.json` — `pi` manifest; `npm run check` runs `tsc`.

## Conventions

Lives in the pi-minimal jj repo. Follow the root `AGENTS.md`. Restart pi or
`/reload` to load changes.
