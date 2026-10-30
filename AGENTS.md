# pi-minimal

Collection of small, single-purpose pi extensions. Each subfolder is its own npm
package (`@pi-minimal/<name>`) with its own `package.json`, `AGENTS.md` and
`npm run check`. The root `package.json` is an npm workspace: run `npm install` and
`npm run check` at the root (or `npm run check -w <name>` for one package).

- `plan-mode/` — `/plan` toggles a read-only instruction in the system prompt.
- `companion-prompts/` — adds a per-extension prompt file to the system prompt only
  when that extension is loaded.
- `polyglot/` — `/lang` selects a saved language reminder, with tag completion.
- `mention-skills/` — `$` autocompletes skills and prompt templates; the agent gets
  their file paths.

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

## Conventions

- Keep each extension minimal. No shared library between them: copy 3 lines
  instead of adding a dependency.
- Settings live in `settings.json` under `"pi-minimal"."<name>"`. Extensions only
  read them, never write.
- No default keyboard shortcut may silently override a pi built-in; document
  conflicts in the extension's `AGENTS.md`.
- Conventional commits, always `jj ... -m`.
