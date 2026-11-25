# @pi-minimal/subagents

A sub-agent is a `pi --mode rpc --session <copy>` process (prompt and optional `steer`
commands are sent over stdin JSONL; stdin closes when `agent_settled` arrives). By
default it forks the parent's branch with one new user message (`childPrompt(task, "fork")`); with
`fresh: true` (or `/spawn --fresh`) the copied session file has only the header and
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
- `forkPrompt` says the conversation above is context only: without it a fork followed the
  last user message ("call the subagent tool") and forked again, down to `MAX_DEPTH`.
- Background only at depth 0: print mode exits when its run ends, which would stop the
  children. A child's sub-agents run in the foreground, in parallel when the model calls
  several at once.
- Delivery: `pi.sendMessage(customType "subagent", triggerTurn: true)` (steer while the
  parent streams). A stopped child gets `triggerTurn: false`: the model learns it, nothing
  wakes up. Nothing is sent after `session_shutdown`.
- Compaction with live children: `/compact` runs `session.abort()` first, but pi 1.6 `abort()`
  only flags an *active* run, so an idle parent never emits `agent_settled` with `aborted` and
  `stopAll()` is skipped. Verified 2026-11-25 with three background children and two manual
  `/compact`s: the children kept running, and each result was appended after the compaction
  entry, so the next turn still saw it. A `/compact` during a live turn does abort it, and a
  `wait: true` child dies through the tool's abort signal.
- `/compact` calls `abort()` first, so a live turn emits `agent_settled` aborted just like Escape; `session_before_compact` follows right after. `agent_settled` waits 50 ms and skips `stopAll()` if compaction started (`compacting`); `session_compact` sends a hidden `subagent` note listing running children (`compactNote`), because the summary drops the "started in background" results. Extensions cannot append `customInstructions` (the hook result is only `cancel`/`compaction`). Known gap: `/compact` on a too-small session still aborts a live turn and stops children.
- Escape: `agent_settled` with `aborted` stops every running child. No idle Escape:
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

## Not done

- Persistence across `/reload` and `--resume`: at depth 0, each launch appends a
  `customType: "subagents"` entry (`pi.appendEntry`) with `{ id, file, task, label,
  model, thinking }`; `session_start` restores them (`restoreRecords`) so `#id` stays
  monotonic and `resume` keeps working after a reload.
- Terminal status: when the main agent settles while background sub-agents are still
  running, `syncTerminalStatus` (queued after pi's `ProgramStatusReporter`) keeps
  `tui.terminal.setProgramStatus({ state: "working", ... })` (OSC 7501) and
  `setProgress(true)` (OSC 9;4) active, and clears them once all children end. Also
  emits `pi.events.emit("subagents:status", { running, total })`.
- Not done: concurrency limit, timeout on runs, CLI flag passthrough, idle Escape.

## Files

- `index.ts` — tool, commands, events, delivery, widget refresh.
- `fork.ts` — `forkBranch`, `forkFileText`, `dropForkDrift` (pure).
- `child.ts` — `startChild` (spawn, JSONL events), `apply`, `outcome`, `piInvocation`
  (copied from pi's `examples/extensions/subagent`).
- `ui.ts` — widget lines, `statusReport`, `resultView` (tool result and result messages).
- `prompts.ts` — default guidance, tool description, fork prompt, `/spawn` note.
- `test.ts` — `node:test`; children are `node -e` scripts that print JSONL like pi.

## Checks

- `npm run check -w subagents`. `index.ts` is checked by hand: a parent in `--mode json`
  (foreground, nested) or `--mode rpc` (background, `abort`) with a copy of the agent dir
  whose settings load this package (`PI_CODING_AGENT_DIR`, children inherit it).
- Mutation survivors left: equivalent `??`/`||` swaps, the Bun branch of `piInvocation`
  (only differs inside Bun), and the SIGKILL fallback (5 s; marked `shortcut:`).

## Conventions

- Keep it minimal. Add code only for a real need.
- Lives in the pi-minimal jj repo (see root `AGENTS.md`).
- After edits, restart pi or `/reload`.
