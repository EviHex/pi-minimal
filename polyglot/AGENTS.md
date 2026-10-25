# @pi-minimal/polyglot

`/lang <code>` selects a language reminder; `/lang off` removes it.
The extension owns only the `polyglot_language` system section. Never return a
whole system prompt: that can hide other extensions' sections from the model.

## Scope

- Eleven built-in Markdown prompts in `langs/`, with no flags or frontmatter.
- Completion order: en, zh-Hans, zh-Hant, fr, es, ja, ko, ru, ar, de, pt, off.
- Custom files in `<agent-dir>/polyglot-languages/` override built-ins by filename.
- The selected language is mutable user state in `<agent-dir>/polyglot.json`,
  separate from static extension settings. Keep saving it after `/lang` changes.
- New/resumed sessions restore that state; legacy saved zhs/zh map to
  zh-hans/zh-hant. No branch-specific history.
- Footer status `Polyglot <native name>` (key `polyglot`), hidden when off.
  Disable with `"pi-minimal": { "polyglot": { "showStatus": false } }` in settings.json.
- `session_before_compact` appends a note to the messages being summarized so summaries omit language preferences (relies on Pi sharing `preparation`; undocumented).
- No tools, shortcuts, settings UI, aliases or language cycling.
- Prompt files reload before each run. Restart Pi after changing the extension.

## Files and checks

- `index.ts` — loading, saved choice, command/completion and section injection.
- `langs/*.md` — language instructions.
- `check.mjs` — `npm run check`, using an already-installed Pi and temporary state.
  It never installs dependencies or modifies user settings.
- `package.json` — scoped npm package and Pi manifest.

Lives in the pi-minimal jj repository. Follow the root conventions.
