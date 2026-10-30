# @pi-minimal/companion-prompts

Personal prompts per extension. A prompt file is added to the system prompt only
when its extension is loaded. Disable the extension and its prompt disappears,
so your `AGENTS.md` never holds instructions for a missing extension.

## Install

Not on npm yet. Clone the repo and install from the folder:

```sh
git clone https://github.com/EviHex/pi-minimal
pi install ./pi-minimal/companion-prompts
```

## Usage

Prompt files live in `~/.pi/agent/companion-prompts/`. Each file names one
extension in its frontmatter with `extension:`; the text below it is the prompt.

```md
---
extension: npm:@gotgenes/pi-subagents
---
Always run sub-agents in the background (`run_in_background: true`).
```

- The `extension:` value is the extension `source` in `settings.json`, for example
  `npm:pi-lens`. Auto-discovered extensions in `~/.pi/agent/extensions/` all have the
  source `auto`; use their file path instead. The file name does not matter.
- The match is exact. A package by another author with a similar name does not match.
- The prompt goes in a `companion_<file name>` system prompt section, once. Keep it short.
- Files are read at session start (use `/reload` after a change).

### Files this extension creates

At session start, for each enabled extension that has no file yet, the extension
**creates a stub** in `~/.pi/agent/companion-prompts/`: a file with only the
`extension:` line and no text. Fill in the text to use it; empty files are ignored.
It never changes or deletes an existing file. Stubs for removed extensions stay until
you delete them.

## Settings

None.
