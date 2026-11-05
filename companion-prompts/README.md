# @pi-minimal/companion-prompts

Personal prompts with conditions. A rule decides when a prompt file is added to the
system prompt: for example, only when a given extension is loaded, or only under
a given directory. Your `AGENTS.md` never holds instructions that do not apply.

## Install

Not on npm yet. Clone the repo and install from the folder:

```sh
git clone https://github.com/EviHex/pi-minimal
pi install ./pi-minimal/companion-prompts
```

## Usage

Everything lives in `~/.pi/agent/companion-prompts/`: one `rules.ts` file, and the
prompt files (`.md`) it names.

```ts
// ~/.pi/agent/companion-prompts/rules.ts
import { homedir } from "node:os";

const work = `${homedir()}/work`;

export default [
	// Fork-proof: match the extension by a regex.
	{ file: "subagents.md", when: (c) => c.extensions.some((e) => /pi-subagents/.test(e)) },
	// Only under ~/work (not ~/work-backup).
	{ file: "work.md", when: (c) => c.cwd === work || c.cwd.startsWith(`${work}/`) },
];
```

`when(c)` gets:

- `c.cwd`: the session's working directory.
- `c.extensions`: the extensions loaded in this session, as their `source` in
  `settings.json` (for example `npm:pi-lens`). Auto-discovered extensions in
  `~/.pi/agent/extensions/` all have the source `auto`, so they appear as their file
  path. The list holds the extensions enabled in your pi config (`pi config`), plus
  the ones that registered a tool or a command (covers `-e <path>`).

Combine conditions with `&&`, `||` and `!`. Reuse a condition as a plain function.

A matching prompt goes in a `<companion_<file name>>` system prompt section, once.
Keep it short.

Rules are evaluated at session start. Use `/reload` after a change. `rules.ts` is
loaded like a pi extension, so TypeScript works as is.

An error (in `rules.ts`, a `when()`, or a missing `.md` file) is shown as a notification. A
rule that throws is skipped; the other rules still apply.

## Settings

None.
