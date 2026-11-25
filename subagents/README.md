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
  `xhigh`, `max`), a short `label`, and a `group` name as needed. By default it runs in
  the background (returns at once so you can keep steering the main agent, and the result
  arrives as a message when done; when several share a `group`, only the last one wakes
  the agent). Pass `wait: true` to block until it finishes.
- The agent can call `subagent_status` with `{ id }` for a non-blocking snapshot of a
  running sub-agent's recent tool calls and context usage (background sub-agents wake
  the main agent automatically when they finish), and `subagent_steer` with
  `{ id, message }` to inject a steering message while a sub-agent is running, and
  `subagent_stop` with `{ id }` to stop one (it never wakes the agent; resume it later).
- You type `/subagents spawn [--fresh] [--model <provider/id>] [--thinking <level>] <task>`
  (alias: `/sa spawn ...`) to start one in the background yourself (with Tab completion
  for subcommands, flags, models and thinking levels). The main agent is told what you
  asked; the result wakes it up when it arrives.
- Sub-agents can start their own sub-agents.
- `/compact` keeps background sub-agents running; afterwards the agent gets a short note listing them, and their results still wake it up.
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
| `fields` | string[] | `["context", "model", "thinking", "activity", "tools", "tokens", "cost", "elapsed", "summary"]` | Widget columns to display. Valid values: `context`, `model`, `thinking`, `activity`, `tools`, `tokens`, `cost`, `elapsed`, `group`, `summary`. Configurable via `/subagents settings`. |
| `allowNested` | boolean | `true` | Allow sub-agents to spawn nested sub-agents. Enforced both programmatically and in the child task prompt without affecting the prompt cache. Configurable via `/subagents settings`. |

The default guidance (the agent also gets `Available models: …`, a list frozen at session start so the
prompt cache stays valid):

> - Delegation: Use `subagent` for independent parallel tracks, or noisy exploration (docs, broad search, logs, tests) that reduces to a concise report with sources. Sub-agents add cost: handle quick lookups, sequential steps, and routine checks yourself, and prefer one sub-agent over many. Give each a distinct scope, expected output, whether it may edit, and files no one else (you included) edits; don't redo delegated work.
> - Execution: At top level, sub-agents run in the background and wake you with their report so the user can steer—leave `wait` unset even when you need every result. Do other work or end your turn; share a `group` on parallel batches to wake once when all finish. Do not poll, sleep, or guess pending results (if asked, say it is running); synthesize reports for the user rather than copying them. Set `wait: true` only when the user asks you to block. Use `subagent_status`, `subagent_steer` or `subagent_stop` only when the user asks to peek at, redirect or stop a running sub-agent.
> - Context & routing: Fork (default) when history helps—a brief directive suffices, and keeping the same model and thinking level reuses the prompt cache. Use `fresh: true` when history is irrelevant or would bias a requested review (pass paths, facts, constraints). Keep inherited settings by default; pair `fresh` with lower `thinking` (or a lighter model) for retrieval, summaries, or mechanical edits, and higher `thinking` for difficult judgment or debugging. Use `resume` for follow-ups.

```json
{ "pi-minimal": { "subagents": { "guidance": "Use the subagent tool, in the background, for every task that takes more than a few tool calls." } } }
```

## Commands

All commands work under `/subagents` or the short alias `/sa`:

- `/subagents spawn [--fresh] [--model <provider/id>] [--thinking <level>] <task>`:
  start a background sub-agent (fork by default; `--fresh` for an empty conversation;
  `--model` and `--thinking` to override model/thinking, with Tab completion).
- `/subagents minimize`: toggle the widget between the full tree and a one-line summary
  (follows the same configured `fields`).
- `/subagents settings`: interactively toggle which fields appear in the widget (saves to
  `~/.pi/agent/settings.json` under `"pi-minimal"."subagents".fields`).

While any sub-agent is running (or when shown via `/subagents show`), a tree shows above
the editor (`● main agent (done/total)`, or the session name) with `├─` / `└─` branches, including nested
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
- While background sub-agents run and the main agent is idle, the extension keeps
  terminal activity indicators active via standard OSC 7501 (`setProgramStatus`) and
  OSC 9;4 (`setProgress`), and emits `subagents:status` (`{ running, total }`) on
  `pi.events` for other extensions.

## Limits

- Each sub-agent starts a pi: a few seconds, and a new connection to each MCP server.
- Options you gave pi on the command line (`-e`, `--tools`, `--no-extensions`) do not
  reach sub-agents. Settings do.
- The prompt cache works for providers that cache by content (Anthropic). OpenAI also
  routes on the session id, and a sub-agent has its own, so it may miss the cache.
- No limit on how many run at once, no timeout, no way to send a running sub-agent a
  new message.
