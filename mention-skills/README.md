# @pi-minimal/mention-skills

Type `$` in the editor to autocomplete skills and prompt templates. Like pi's `@`
for files, nothing is inlined: before each LLM call, `$name` gets its file path
and the agent reads the file itself.

- You type and see: `use $jj to commit`
- The LLM sees: `use $jj (skill: /path/to/jj/SKILL.md) to commit`

## Install

```sh
pi install ~/Code/pi-minimal/mention-skills
```

## Settings

Put settings in `~/.pi/agent/settings.json` (global) or `.pi/settings.json`
(project), under `"pi-minimal"."mention-skills"`. Merge the keys; do not overwrite
the file. Settings are read at session start (use `/reload`).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `disableSkillCommands` | boolean | `false` | Hide `/skill:*` from the `/` menu. `$` still lists skills, and a typed `/skill:name` still works. |

```json
{ "pi-minimal": { "mention-skills": { "disableSkillCommands": true } } }
```

## Behavior

- Names come from the `skill` and `prompt` commands of pi, rebuilt at every
  session start. A skill wins on a name clash.
- A mention is `$` at line start or after whitespace or `( [ { <`, then `[\w-]+`.
  Unknown names (`$HOME`, `$1`) stay as they are.
- Only the copy sent to the LLM changes. The chat and the session keep `$name`.
- A fixed `mention_skills` system prompt section tells the agent to read the file
  unless it already did, then follow it.

## Limits

- The agent may skip reading the file (same as `@`).
- After compaction, the summary only has `$name`.
- Prompt templates get no arguments. Write them after the name: `$vocabulary word`.
