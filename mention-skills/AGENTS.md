# @pi-minimal/mention-skills

Type `$` in the editor to autocomplete skills and prompt templates. Like pi's `@`
for files, nothing is inlined by default: before each LLM call, `$name` gets its file path,
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
- `inlineSkills` / `inlinePrompts`: `before_agent_start` returns one custom message
  (`customType: "mention-skills"`, `display: true`) with a
  `<skill|prompt name location>body</…>` block (frontmatter stripped) per name of the
  prompt that is not attached yet. It is saved in the session and sent to the LLM, so
  the chat shows what the LLM got. "Not attached yet" is checked on
  `buildContextEntries()`, so content removed by compaction is attached again.
  `details` lists `{kind, name}` for the collapsed `[skill] name` line. An
  unreadable file falls back to the path.
- Settings: see `README.md` (single source).

## Limits

- Only prompts that start a run get attachments. Steering messages sent while the
  agent runs keep the path only.
- The agent may skip reading the file (same as `@`).
- After compaction, the summary only has `$name`. Skills are still in pi's skill
  list; prompt templates lose their path.
- Prompt templates get no arguments; `$1`/`$@` in the file stay as they are.
- No frecency, coloring, configurable trigger, or code-block detection.

## Files

- `index.ts` — the extension.
- `check.ts` — self-check of the path rewrite and the attachments (not published).
- `README.md` — usage and settings.
- `package.json` — `pi` manifest; `npm run check` runs `tsc` and `check.ts`.

## Conventions

Lives in the pi-minimal jj repo. Follow the root `AGENTS.md`. Restart pi or
`/reload` to load changes.
