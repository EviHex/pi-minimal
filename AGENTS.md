# pi-minimal

Collection of small, single-purpose pi extensions. Each subfolder is its own npm
package (`@pi-minimal/<name>`) with its own `package.json`, `AGENTS.md` and
`npm run check`. The root `package.json` is an npm workspace: run `npm install` and
`npm run check` at the root (or `npm run check -w <name>` for one package).

- `plan-mode/` — `/plan` toggles a read-only instruction in the system prompt.
- `dynamic-prompt/` — adds a prompt file to the system prompt only when its rule
  in `rules.ts` matches (loaded extensions, cwd).
- `polyglot/` — `/lang` selects a saved language reminder, with tag completion.
- `mention-skills/` — `$` autocompletes skills and prompt templates; the agent gets
  their file paths.
- `nested-agent-md/` — the `AGENTS.md`/`CLAUDE.md` of a subdirectory reach the agent the
  first time it touches that directory.
- `subagents/` — `subagent` tool and `/spawn`: forks of the conversation, with the parent's
  tools and model, that reuse its prompt cache.
- `todo/` — `todo` tool and `/todo`: a declarative todo list widget above the editor,
  persisted to the session branch.

## What qualifies as a package

- **Sane defaults.** Works after install with no configuration. The package `README.md` `## Settings` table lists every key: type, default, meaning, whether a change needs `/reload`. Users change settings with `/<name> settings` or by editing `settings.json`; an agent must find the options from the README alone. A menu is optional.
- **One thing well.** One sentence states the problem. Few tools and commands, each serving it.
- **Minimal implementation.** No runtime dependency beyond pi peer dependencies. No feature without a real need. First check that pi itself, one config line or one prompt cannot do the job; never copy what pi provides.
- **Minimal context cost.** Static prompt text is paid on every request: keep it short and state its approximate size in the package `AGENTS.md`. Tools, tool descriptions and system sections stay identical for the whole session (prompt cache). Runtime notices go at the tail of the conversation, never into the prefix. A value read at load time says "applies after /reload" in the README. Do not call `pi.getSettings()` during extension load: it is not ready.
- **Coexists.** Works alone, needs no other package here, edits only what it owns: its own system prompt section (never return a whole replacement prompt), its own settings keys, its own UI.
- **Safe without UI.** Check `ctx.hasUI` before work that needs a UI or a process that outlives the turn.
- **Peek/redirect tools** (status, steer, stop) say in their guidance that the agent uses them only when the user asks.
- **Disqualified:** needs a daemon, network service or database; adds features "just in case"; copies pi functionality.

## Publishing

A package is published when its `package.json` has all of this (copy from `mention-skills`):

- `license: "MIT"` and a `LICENSE` file in the package folder (copy the root one).
- `files`: only what the extension needs at run time (sources, `README.md`, `LICENSE`,
  data folders). Not `AGENTS.md`, `tsconfig.json`, or tests.
- `publishConfig: { "access": "public" }`. Scoped packages are private without it.
- `repository` with `url: "git+https://github.com/EviHex/pi-minimal.git"` and `directory`.
- `peerDependencies` on pi packages, with `*` or a minimum version.
- A `README.md` with `## Install` and `## Settings`. Until the first publish, `## Install`
  says "Not on npm yet" and shows the clone command. Update the table in the root
  `README.md` at the same time.

Check the file list with `npm pack -w <name> --dry-run`. Bump the version before each
publish: `npm publish -w <name>`.

Once a package is published at version `1.0.0` or higher, other people may use it.
Keep it backward compatible: do not rename or remove settings keys, commands, tool
names or parameters, and do not change their meaning or defaults in a way that breaks
existing setups. If a break cannot be avoided, keep reading the old form (with a
warning) or bump the major version and document the migration in the `README.md`.

## Conventions

- This repo is open source and general purpose. In code, prompts, docs and
  examples, never name the maintainer's company, and never assume who the user is.
- Keep each extension minimal. No shared library between them: copy 3 lines
  instead of adding a dependency.
- Settings live in `settings.json` under `"pi-minimal"."<name>"`. An extension
  writes settings only when the user explicitly saves in its settings command, and only
  merges its own keys. Opening a menu or starting pi never rewrites the file. Mutable user
  state goes to a separate file or a session entry.
- No default keyboard shortcut may silently override a pi built-in; document
  conflicts in the extension's `AGENTS.md`.
- Consistent look: fixed UI words are lowercase; reuse the other packages' widget style (see
  their `AGENTS.md`). Colour tokens are documented per package.
- Renaming or removing a package: before the change, list the places that mention the old
  name (install docs, rules or matchers keyed on a package path, user config templates) and
  fix them in the same change.
- Tests: pure logic lives in modules covered by `node:test`. Wiring in `index.ts` needs a
  smoke test in a real pi (load, `/reload`, the commands); say in the package `AGENTS.md` if
  it was not done.
- Package `AGENTS.md` records decisions and reasons, plus the size of static prompt text. No
  change log: delete outdated lines when behaviour changes.
- Conventional commits, always `jj ... -m`.
