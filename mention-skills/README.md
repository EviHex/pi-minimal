# @pi-minimal/mention-skills

Type `$` in the editor to autocomplete skills and prompt templates. Like pi's `@`
for files, nothing is inlined by default: before each LLM call, `$name` gets its file path
and the agent reads the file itself.

- You type and see: `use $jj to commit`
- The LLM sees: `use $jj (skill: /path/to/jj/SKILL.md) to commit`

## Install

```sh
pi install npm:@pi-minimal/mention-skills
```

## Settings

Put settings in `~/.pi/agent/settings.json` (global) or `.pi/settings.json`
(project), under `"pi-minimal"."mention-skills"`. Merge the keys; do not overwrite
the file. Settings are read at session start (use `/reload`).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `disableSkillCommands` | boolean | `false` | Hide `/skill:*` from the `/` menu. `$` still lists skills, and a typed `/skill:name` still works. |
| `inlineSkills` | boolean | `false` | Attach the skill content after the message that first mentions it, so the agent does not need to read the file. It shows in the chat as `[skill] name`; expand it to read. |
| `inlinePrompts` | boolean | `false` | Same for prompt templates. |

```json
{ "pi-minimal": { "mention-skills": { "disableSkillCommands": true, "inlineSkills": true } } }
```

## Behavior

- Names come from your skills and prompt templates. A skill wins on a name clash.
- A mention is `$` at line start or after whitespace or `( [ { <`, then `[\w-]+`.
  Unknown names (`$HOME`, `$1`) stay as they are.
- Like `@` for files, the agent decides when to read the file. With `inlineSkills` or
  `inlinePrompts`, the content is attached once. It is attached again only after a
  compaction removed it.

## Limits

- Prompt templates get no arguments. Write them after the name: `$vocabulary word`.
