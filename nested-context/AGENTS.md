# @pi-minimal/nested-context

Lazy nested `AGENTS.md`/`CLAUDE.md`. On a successful `tool_result` of `read`,
`edit` or `write` (`TOOLS`), the instruction files of the directories
between cwd (excluded: pi loads it) and the tool's `path` are appended to that result,
parents first. See `README.md` for users.

## Decisions

- Tool result, not system prompt: no cache break, no cost until used, works on every
  model. The text sits in a tool result, so it is only as strong as tool output.
- File names mirror `loadContextFileFromDir` in pi (`resource-loader.js`). If pi
  changes the list, copy it.
- No settings: `TOOLS` and `MAX_CHARS` are constants, a fork changes them.
- `tool_result` runs after the tool, so the target exists (`write` has created it). No
  walk up to an existing parent, no directory inputs.
- The handler is synchronous. Two parallel results cannot claim the same file, so no
  locking. Files are read whole (`readFileSync`), then cut to `MAX_CHARS`.
- Every path is real: `root` is `realpathSync.native(ctx.cwd)`, and inputs are resolved against
  `root`, not `ctx.cwd` (same directory, other spelling when cwd has a symlink).
  Containment compares real paths of root and file. `.native` also gives the case on
  disk (macOS), so two spellings share one `seen` key.
- Inputs are cleaned like pi's `resolveToCwd` (`core/tools/path-utils.js`): leading
  `@` removed, `~` expanded. Copy it if pi changes it.
- Skipped on purpose: targets under `node_modules` (packages ship persona prompts as
  `AGENTS.md`), and `getAgentDir()` (pi loads its `AGENTS.md` globally; it is below cwd
  when pi runs in `~` or `~/.pi`).
- A symlink out of cwd is skipped (it would copy any file into the context). A file
  directly in cwd, even through a symlink, is skipped (pi has it).
- The injected text is stored in the session (the tool result content). So `seen` must
  match what the model sees, not what this runtime did. Each result that carries files
  gets `details.nestedContext` (real paths; `details` is never sent to the model, and
  the tool's own details are kept by spread). `rebuild` reads it back from
  `ctx.sessionManager.buildSessionProjection().messages` (current branch, after the
  last compaction) on `session_start` (new, /resume, /reload), `session_compact` and
  `session_tree`. pi emits the last two after the projection is updated. Cost: about
  1 ms on a 30 MB session, only on those events.
- A file read directly by the agent is marked too (result with `details` only), so a
  /tree back to that branch does not add a copy.
- Nested calls (`parentToolCallId`, codemode): their result goes to a script, not the
  model. What they find waits in `pending`, keyed by the outer id (`toolCallId` before
  the first `/`; pi's nested ids are `<outer>/<n>`), and is added to the outer result,
  even when that one is an error: the script may have shown files before it failed.
  Files are claimed in `seen` at once, so parallel calls add nothing twice; if the outer
  result never comes, `rebuild` gives them back later. An instruction file read by a
  script is not "read by the agent", so it is delivered.
- A file that fails to read is claimed (one warning, not one per access) but not marked,
  so `rebuild` (/reload) tries it again. Both the user (`notify`, with the error) and
  the model (a line in the result, with the error code) are told.
- `edit`/`write` are not blocked. Blocking would force a retry on every first write per
  directory. Revisit if agents ignore rules that arrive after the change.

## Not done

Directories outside cwd (needs a root: git/jj root?), `.agents/skills` of nested
directories, shell command parsing (`cat src/x.ts`), `--no-context-files` detection,
ignore globs, notification when a file loads, settings, `ls`/`find`/`grep`.

## Files

- `index.ts` — the extension.
- `test.ts` — `node:test` with a fake `pi`; run by `npm run check`. cwd is reached
  through a symlink, so a path compared before `real()` fails the tests. The fake
  session stores each top-level result with the returned content and details; tests
  replace it to play /tree and compaction, and `restart()` plays /resume.
- `README.md` — usage (single source).
- `package.json` — `pi` manifest and package metadata.

## Conventions

- Keep it minimal. Add code only for a real need.
- Lives in the pi-minimal jj repo (see root `AGENTS.md`).
- After edits, restart pi or `/reload`.
