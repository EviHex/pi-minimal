# @pi-minimal/subagents

A sub-agent is a `pi --mode rpc --session <copy>` process (prompt and optional `steer`
commands are sent over stdin JSONL; stdin closes when `agent_settled` arrives). By
default it forks the parent's branch with one new user message (`childPrompt(task, "fork")`); with
`fresh: true` (or `/sa spawn --fresh`) the copied session file has only the header and
starts empty with `childPrompt(task, "fresh")`; with `resume: <id>` it cleans any
truncated tail or unfinished tool-call turn in the prior child's `.jsonl`
(`sanitizeSessionText`) and continues it with `childPrompt(task, "resume")`. Both
`fresh` and `resume` leave `PI_MINIMAL_SUBAGENT_FORKED_AT` unset so `dropForkDrift` is
inactive. See `README.md` for users.

## Glossary

- **parent**: the pi that starts a sub-agent. **child**: the sub-agent process (`Child`).
- **fork point**: the end of the copied branch (`forkBranch`): the whole branch, minus the
  last assistant message when one of its tool calls has no result yet.
- **depth**: `PI_MINIMAL_SUBAGENT_DEPTH`, 0 in the user's pi. **forkedAt**:
  `PI_MINIMAL_SUBAGENT_FORKED_AT`, set only in a child.
- **drift**: system messages pi adds in a child before its task because the child's prompt
  or tools differ from the transcript's (`dropForkDrift`).

## Decisions

- Process, not an in-process `AgentSession`: the child loads exactly what the CLI loads
  (settings packages, built-in codemode/MCP/tool_search, `replaceable` rules), so it has the
  parent's tools without copying them. An in-process session would also need a fresh
  resource loader (MCP reconnects either way: its state lives in the factory closure) and
  shares per-session-id state with the parent. A process also gives Escape a clean meaning:
  SIGTERM; pi's print mode then disposes, `session_shutdown` stops the child's own children.
- Cache: pi 1.6 stores the prompt and tool declarations as `role: "system"` messages in the
  transcript, and a session only adds a system message when something differs. So a copied
  branch plus the same model gives the same request prefix. Checked with a real run: the
  child's first request read the parent's whole prefix from the cache (`cacheRead` 16192,
  `input` 4).
- `dropForkDrift` (`context_with_system`, child only): Anthropic and OpenAI keep a
  mid-conversation system message in place (the cache still hits; checked with plan mode on),
  but Google and Bedrock collapse every system message to the top (`collapseSystemMessages`
  in pi-ai). It also keeps the parent's prompt when an extension keeps state in memory
  (plan mode). Only the messages before the child's first non-system message are dropped:
  later ones (tool_search activations) are the child's own.
- The tool is registered in every child, even at `MAX_DEPTH` (it refuses there): tools are
  part of the cached prefix. Same for the `subagents` prompt section.
- `childPrompt` says the conversation above is context only: without it a fork followed the
  last user message ("call the subagent tool") and forked again, down to `MAX_DEPTH`.
- Tools: `subagent`, `subagent_status`, `subagent_steer`, `subagent_stop`. Background is the
  default; `wait: true` blocks. It is only at depth 0 with a UI: print mode exits when its run
  ends, which would stop the children. A child's sub-agents run in the foreground, in
  parallel when the model calls several at once.
- Groups: children sharing `group` wake the agent once, when the last one ends (`deliverLater`
  sets `triggerTurn: false` for the others).
- Commands: `/sa` (alias `/subagents`) with `spawn`, `minimize`, `settings`. Settings are
  `fields` (widget columns) and `allowNested` (children may spawn), both written by
  `/sa settings` under `"pi-minimal"."subagents"`; `guidelines` is the third key (below).
  Settings are read at `session_start`.
- Usage levels (`guidelines`: `off | manual | default | often | always | string[]`): the
  `subagents` section is `<usage line>` + `MECHANICS` + `Available models`. One ordered
  `LEVELS` table in `prompts.ts` gives the valid values, the menu order and the usage
  texts; `parseGuidelines` parses once into `"off" | level | { custom }` (bad value:
  `default`; empty custom text: `off`). Usage comes first because it is the part users
  change and the model should read it before the facts; `MECHANICS` is neutral and the same
  at every level, so a custom text cannot drop the facts. Custom text is labelled `(set by
  the user)`. `off` removes the section only. The section is built once at `session_start`
  and only assigned in `before_agent_start` (prompt cache); `/sa settings` writes the file
  and never touches the live section, so changes need `/reload`. Custom text is edited in
  `settings.json` only (no editor in the menu).
- The "use `subagent_status`, `_steer`, `_stop` only when the user asks" rule lives in those
  tool descriptions, not in the section: a custom or `off` section cannot drop it. The `wait`
  rule lives in the `wait` parameter description only.
- Legacy `guidance` (string, the old whole-section override) is read only when `guidelines`
  is absent: `""` means `off`, other text means custom. The package is 0.x: no separate
  path, and it is documented as deprecated.
- `writeSubagentSettings` (like todo's) starts from `{}` only for a missing file (ENOENT). A
  malformed or unreadable file throws, and the menu notifies: wiping the user's other
  settings was the old behaviour.
- The active group title and the root title have no colour (terminal default), like child
  names; counts are `muted`.
- Delivery: `pi.sendMessage(customType "subagent", triggerTurn: true)` (steer while the
  parent streams). A stopped child gets `triggerTurn: false`: the model learns it, nothing
  wakes up. Nothing is sent after `session_shutdown`.
- `/compact` calls `abort()`, so a live turn emits `agent_settled` with `aborted`, like Escape.
  `session_before_compact` sets `compacting`; `agent_settled` waits 50 ms and calls `stopAll()`
  only if the flag is unset. `session_compact_failed` clears it. `session_compact` sends a
  hidden `subagent` message listing the running children (`compactNote`), because the summary
  drops the "started in background" results. An idle parent never emits `agent_settled`
  aborted, so its children are never stopped. Known limits: a `/compact` that fails before
  `session_before_compact` fires, during a live turn, still stops the children; the 50 ms
  wait is a timing assumption.
- Escape: `agent_settled` with `aborted` (and no `compacting`) stops every running child. No idle Escape:
  `onTerminalInput` sees keys before dialogs, so Escape that closes a dialog would stop them.
- Fork file: `forkFileText` writes a new header (`parentSession` = parent file) and the cut
  branch. New session id: a shared id would share pi-ai per-session state, and OpenAI's
  `prompt_cache_key` is the only loss.
- Session files: `<parent session file without .jsonl>/subagents/<id>.jsonl`, or
  `$TMPDIR/pi-subagents` for an in-memory parent. Never deleted.
- Model & thinking: `--provider` and `--model` from `resolveModel` (defaults to
  `ctx.model`, or an explicit `provider/id` / `id` from `modelRegistry.getAvailable()`;
  ids can contain `/`), `--thinking` from `resolveThinking` (defaults to
  `pi.getThinkingLevel()`).
- JSONL is split on `\n` only (`readline` also splits on U+2028/U+2029).

## Also in place

- Persistence across `/reload` and `--resume`: at depth 0, each launch appends a
  `customType: "subagents"` entry (`pi.appendEntry`) with `{ id, file, task, label,
  model, thinking }`; `session_start` restores them (`restoreRecords`) so `#id` stays
  monotonic and `resume` keeps working.
- Interrupted children: pi stops its children when it closes, so nobody tells the agent on
  `/resume`. At depth 0, each end writes `pi.appendEntry("subagents", { id, ended: status })`:
  in `deliverLater`'s handler (which skips after `closing`, so a close leaves no entry) and
  after the foreground `await child.done`; not in `launch`, because children adopted after
  `/reload` end in the new instance. At `session_start`, after the `/reload` adoption, a
  record with no end entry, no live child and a session file that does not end with an
  assistant message with `stopReason: "stop"` (that rule, and a missing file, spare sessions
  made before end entries existed) is interrupted: one `sendMessage` (`display: true`,
  `triggerTurn: false`; run in a real pi in rpc mode: the message and the end entry are
  written at `session_start`, once; the tui order was only read in the source) and an
  `interrupted` end entry, so it is said once.
  `subagent_status` reads the same entries (`priorReport`). Known gap: a child that ended
  during the `/reload` gap is adopted with its result undelivered (as before).
- Resume collision: a resume gets a new id but reuses the old `file`, so `launch` refuses when
  any running child uses that file (`liveOnFile`), by file and not by id. It names the running #id.
- Terminal status: while background children run and the main agent is idle,
  `syncTerminalStatus` (queued after pi's `ProgramStatusReporter`) keeps OSC 7501 and OSC 9;4
  active, and clears them when all end. It also emits `pi.events.emit("subagents:status",
  { running, total })`.
- Static prompt text at `default`: the section without models (usage 280 + `MECHANICS` 870
  = about 1150 chars) plus the four tool descriptions (about 650 chars) is about 450 tokens
  (chars/4), plus the parameter descriptions and the model shortlist. `manual` is about 140
  chars shorter, `always` about 80 shorter, `often` the same as `default`.
- Not done: concurrency limit, timeout on runs, CLI flag passthrough, idle Escape.

## Files

- `index.ts` — tool, commands, events, delivery, widget refresh.
- `fork.ts` — `forkBranch`, `forkFileText`, `dropForkDrift` (pure).
- `child.ts` — `startChild` (spawn, JSONL events), `apply`, `outcome`, `piInvocation`
  (copied from pi's `examples/extensions/subagent`).
- `ui.ts` — widget lines, settings writer, `statusReport`, `resultView` (tool result and result messages).
- `prompts.ts` — `LEVELS`, `parseGuidelines`, `subagentsSection`, tool descriptions, child prompt, `/sa spawn` note.
- `test.ts` — `node:test`; children are `node -e` scripts that print JSONL like pi.

## Checks

- `npm run check -w subagents`. `index.ts` is checked by hand: a parent in `--mode json`
  (foreground, nested) or `--mode rpc` (background, `abort`) with a copy of the agent dir
  whose settings load this package (`PI_CODING_AGENT_DIR`, children inherit it).
- Not run in a live pi: the `guidelines` menu item and the section in a real prompt (only the
  parsing, section text and writer are unit-tested).
- Mutation survivors left: equivalent `??`/`||` swaps, the Bun branch of `piInvocation`
  (only differs inside Bun), and the SIGKILL fallback (5 s; marked `shortcut:`).

## Conventions

- Keep it minimal. Add code only for a real need.
- Lives in the pi-minimal jj repo (see root `AGENTS.md`).
- After edits, restart pi or `/reload`.
