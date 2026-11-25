# @pi-minimal/subagents

Sub-agents that are forks of the conversation. A sub-agent sees everything the main
agent saw, with the same system prompt, the same tools and the same model. Its first
request starts with the same text as the main agent's last one, so the provider's prompt
cache serves it: you pay full price only for the new task.

```text
main agent:  [system prompt + tools][conversation ...............]
sub-agent:   [system prompt + tools][conversation ...............][task]
              \_______________ read from the prompt cache _______/
```

- The agent calls the `subagent` tool. By default it forks this conversation; with
  `fresh: true` it starts with an empty conversation instead, and with `resume: <id>` it
  continues a finished or stopped sub-agent with its existing context. Pass `model`
  (`provider/id` or `id`), `thinking` (`off`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max`), a short `label`, and a `group` name as needed. It waits for the
  result, or with `run_in_background` it goes on and the result arrives later as a
  message (when several background sub-agents share a `group`, only the last one wakes
  the agent).
- The agent can call `subagent_status` with `{ id }` for a non-blocking snapshot of a
  running sub-agent's recent tool calls and context usage (background sub-agents wake
  the main agent automatically when they finish).
- You type `/subagents spawn [--fresh] [--model <provider/id>] [--thinking <level>] <task>`
  (alias: `/sa spawn ...`) to start one in the background yourself (with Tab completion
  for subcommands, flags, models and thinking levels). The main agent is told what you
  asked; the result wakes it up when it arrives.
- Sub-agents can start their own sub-agents.
- Escape stops the main agent and every sub-agent. No result wakes the agent up after
  that.

## Install

Not on npm yet. Clone the repo and install from the folder:

```sh
git clone https://github.com/EviHex/pi-minimal
pi install ./pi-minimal/subagents
```

Remove other sub-agent extensions first: two tools named `subagent` conflict.

## Settings

Put settings in `~/.pi/agent/settings.json` (global) or `.pi/settings.json`
(project), under `"pi-minimal"."subagents"`. Merge the keys; do not overwrite the
file. Settings are read at session start (use `/reload`).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `guidance` | string | see below | The `subagents` section of the system prompt: when and how much the agent uses sub-agents. `""` removes the section. |

The default guidance:

> Use the `subagent` tool to hand a self-contained task to a sub-agent with your tools;
> its final message comes back to you. By default it forks this conversation (sees
> everything above and reuses the prompt cache); pass `fresh: true` for an empty
> conversation when the history above is not needed, and include all context in `task`.
> Pass `model` (provider/id or id) and/or `thinking` (off, minimal, low, medium, high,
> xhigh, max) to override the current model or thinking level; changing the model misses
> the prompt cache on a fork, so it pairs best with `fresh: true`. Pass `label` for a
> short status label when `task` is long, and `resume: <id>` to continue a finished or
> stopped sub-agent with its existing context. Each sub-agent runs in its own process
> (in-memory state like the parent's todo list is not shared; files in the working
> directory are). To run several sub-agents in parallel
> and collect all results together, call `subagent` concurrently in the foreground
> (e.g. `Promise.allSettled` in `codemode`). Use `run_in_background` when you want to
> return control to the user immediately: do not poll or wait for a background
> sub-agent—end your turn and its result will arrive as a message and wake you up when
> done (use `subagent_status` only for a quick non-blocking progress peek). Do not use
> sub-agents for a quick lookup. Give each sub-agent one precise task and say what it
> must report.

```json
{ "pi-minimal": { "subagents": { "guidance": "Use the subagent tool, in the background, for every task that takes more than a few tool calls." } } }
```

## Commands

All commands work under `/subagents` or the short alias `/sa`:

- `/subagents` (or `/sa`): pick a sub-agent of this session and watch it live (its
  text, the tools it runs, context window usage, the start of each result). ↑↓, PgUp,
  PgDn, Home and End scroll; Escape closes.
- `/subagents spawn [--fresh] [--model <provider/id>] [--thinking <level>] <task>`:
  start a background sub-agent (fork by default; `--fresh` for an empty conversation;
  `--model` and `--thinking` to override model/thinking, with Tab completion).
- `/subagents stop`: stop the running sub-agents.
- `/subagents show` / `/subagents hide`: show (even after all sub-agents finish) or hide
  the tree widget above the editor.

While any sub-agent is running (or when shown via `/subagents show`), a tree shows above
the editor (`● Sub-agents (done/total)` with `├─` / `└─` branches, including nested
sub-agents): each entry shows its status (`◐`/`✓`/`✗`/`○`), label, last tool, tool
count, context window usage, elapsed time, and latest summary line.

## Behavior

- A sub-agent is a `pi` process that continues a copy of the session (or an empty
  session when `fresh` is set). It loads the same settings, extensions, skills and MCP
  servers as yours, so it has the same tools. Because it is a separate process, it does
  not share in-memory state (such as the parent's todo list or plan mode toggle), but it
  does share the working directory on disk and external services. Its session file is
  next to yours (`<session>/subagents/<id>.jsonl`): open it with `pi --session <file>`
  to read all of it, or to talk to it.
- The copy stops before the turn that is running: the sub-agent does not see the
  tool call that started it, only its task.
- Escape while the agent works stops every sub-agent, and the agent gets one line per
  stopped sub-agent, without a new turn. While the agent is idle, Escape does nothing
  to them: use `/subagents stop`.
- A sub-agent of a sub-agent always runs in the foreground (a sub-agent ends when its
  own run ends). Sub-agents nest 3 levels deep at most.
- When a sub-agent's extension would change the prompt (for example plan mode, which
  each pi keeps in memory), the sub-agent keeps yours.

## Limits

- Each sub-agent starts a pi: a few seconds, and a new connection to each MCP server.
- Options you gave pi on the command line (`-e`, `--tools`, `--no-extensions`) do not
  reach sub-agents. Settings do.
- The prompt cache works for providers that cache by content (Anthropic). OpenAI also
  routes on the session id, and a sub-agent has its own, so it may miss the cache.
- No limit on how many run at once, no timeout, no way to send a running sub-agent a
  new message.
