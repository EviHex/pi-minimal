# @pi-minimal/polyglot

A small language reminder for current Pi. It puts a Markdown prompt in the
native `polyglot_language` system section, without replacing the whole prompt
or interfering with other extensions such as plan-mode.

## Install

```sh
# Load directly from the local pi-minimal checkout:
pi install ~/Code/pi-minimal/polyglot
```

## Languages

Languages use BCP 47 tags, not country flags. Chinese tags specify the script,
not a country or region. Built-ins, in the preferred order:

| Tag | Language |
| --- | --- |
| `en` | English |
| `zh-Hans` | 简体中文 |
| `zh-Hant` | 繁體中文 |
| `fr` | Français |
| `es` | Español |
| `ja` | 日本語 |
| `ko` | 한국어 |
| `ru` | Русский |
| `ar` | العربية |
| `de` | Deutsch |
| `pt` | Português |

Arabic uses Modern Standard Arabic rather than a regional dialect. Language
prompts do not bind a language to a country. Chinese prompts specify simplified
or traditional characters without prescribing mainland or Taiwan vocabulary.

## Usage

- `/lang zh-Hans` — switch to Simplified Chinese and save the choice
- `/lang zh-Hant` — switch to Traditional Chinese and save the choice
- `/lang es` — switch to Spanish and save the choice
- `/lang off` — stop injecting language rules and save that choice
- `/lang` — show the current choice and usage

After `/lang `, Tab completes built-in tags and `off`. Filter by code or native
language name, for example `zh` or `Français`. Custom prompt codes can still be
typed directly.

Tags are case-insensitive and stored as lowercase filenames and config values:
`zh-Hans` becomes `zh-hans`. The help text and table above use the preferred order;
autocomplete offers these tags in that order, followed by `off`. There is no cycling menu.

A successful selection applies to this session and is saved as `defaultLang` in
`<agent-dir>/polyglot.json`. New and resumed sessions read that choice. `off` is
saved too. Without a saved choice, the default is `zh-hans`.

If saving fails, the current selection still works and an error reports that it
was not saved. Invalid selections leave the current language unchanged. A broken
saved setting reports an error and starts with `zh-hans`.

Old saved values `zhs` and `zh` are read as `zh-hans` and `zh-hant` respectively.
Startup does not rewrite the config; the next `/lang <code>` saves the new code.
Use the new tags in commands, and rename any custom Chinese prompt files to match.

## Footer

The footer shows the current language, such as `Polyglot 简体中文`. Custom codes
show the code (`Polyglot yue`). Nothing is shown when the language is `off`.
The status is on by default. To hide it, add this to `settings.json`:

```json
{ "pi-minimal": { "polyglot": { "showStatus": false } } }
```

Settings are read at session start.

## Not included

There is no settings panel, alias matching, language cycling, or
branch-specific history. `/polyglot`, `auto`, `config`, and `refresh` are removed.
Old session language records and obsolete UI configuration fields are ignored.
The next `/lang <code>` saves only `defaultLang`.

## Prompts

Built-in prompts are plain Markdown without frontmatter or flags, stored in
`langs/<code>.md`. A file at
`<agent-dir>/polyglot-languages/<code>.md` overrides the built-in with that filename.
The agent directory comes from Pi's `getAgentDir()` (`~/.pi/agent` by default).

The filename is the language code. Existing custom frontmatter is still stripped,
not interpreted; metadata such as aliases, labels and ordering is unused.

All prompts separate the language used to explain things to the user from the
language required for translations, quotations, code comments and documents.
Unless translation is requested, existing content keeps its language.

Prompts are read each turn, so edits need no refresh command. Empty or unreadable
prompts produce an error and no language section for that turn; no emergency
language packs or silent fallback to a built-in override exist.

This is prompt guidance, not enforcement. It does not translate messages or
restrict tools. Restart Pi after updating the extension itself.

## Check

```sh
npm run check
# For a different installed Pi package directory:
PI_CHECK_HOST=/path/to/@earendil-works/pi-coding-agent npm run check
```

Tests use an installed Pi and temporary files. They cover all 11 language prompts,
saved choices, legacy Chinese codes, autocomplete, errors, custom files and section composition.
They do not change user settings, load user extensions, call a model, install
dependencies, or restart Pi.
