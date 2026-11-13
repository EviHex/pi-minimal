# @pi-minimal/nested-context

Pi loads the `AGENTS.md` (or `CLAUDE.md`) of your working directory and its parents
at startup. This extension adds the ones **below** it, lazily: the first time the
agent touches a directory, that directory's instruction file reaches the agent. Nothing
is added to the system prompt, so a project with many nested files costs nothing until
the agent goes there.

```text
project/            <- cwd
├── AGENTS.md       loaded by pi at startup
├── src/
│   ├── AGENTS.md   loaded when the agent reads, edits or writes anything in src/
│   └── api/
│       ├── CLAUDE.md   same, for src/api/ (deepest file is listed last, so it wins)
│       └── users.ts
```

A file **outside** the working directory gets the same, up to the root of its git
repository (the directory with `.git`). That root's own file is included, since pi did
not load it. A file in no git repository gets nothing.

```text
~/notes/            <- cwd
~/work/app/         a git repository
├── AGENTS.md       loaded when the agent touches anything in ~/work/app/
└── lib/
    ├── AGENTS.md   same, for lib/
    └── db.ts
```

## Install

Not on npm yet. Clone the repo and install from the folder:

```sh
git clone https://github.com/EviHex/pi-minimal
pi install ./pi-minimal/nested-context
```

## Settings

None. To change the watched tools (`read`, `edit`, `write`) or the size limit (32,000
characters per file), fork and edit the constants at the top of `index.ts`.

## Behavior

- File names and their order are the same as pi's own: `AGENTS.override.md`,
  `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. One file per directory.
- The text is appended to the tool result, parents first. Each file comes once, as long
  as the model still sees it: after `/tree` to a branch that never loaded it, or after
  compaction dropped it, it comes again at the next access. `/resume` and `/reload`
  remember what the session already has.
- Calls made from a codemode script count too. Their rules are added to the codemode
  result, which is what the model sees, even when the script failed.
- For `edit` and `write` the rules arrive in the result, after the change. Nothing is
  blocked.
- Reading the instruction file itself adds no second copy.
- Paths are read like pi's tools read them: `@src/x.ts` and `~/...` work.
- If a file cannot be read, you get a warning, and the agent is told that its rules
  are not applied.
- A symlink that points outside the project is ignored, and so is a symlink to a file
  that pi loaded at startup.
- Paths are shown relative to the working directory, and absolute (symlinks resolved)
  outside it.
- Skipped: anything under `node_modules` (package files are not your project's rules),
  and pi's agent directory (`~/.pi/agent`) when cwd contains it, since pi loaded its
  `AGENTS.md` at startup.
- A file longer than 32,000 characters is cut, with a note to read the rest.

## Limits

- Outside the working directory, only files in a git repository.
- Only `read`, `edit` and `write` (also from codemode). Shell commands, `ls`/`find`/`grep`
  and MCP tools are not watched.
- A partial read (`offset`/`limit`) of an instruction file counts as seen.
- `pi --no-context-files` is not detected: nested files still load.
- A file that cannot be read (no permission) is reported to you and to the agent once.
  It is tried again after `/reload`.
