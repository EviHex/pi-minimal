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

- The agent calls the `subagent` tool. It waits for the result, or with
  `run_in_background` it goes on and the result arrives later as a message.
- You type `/spawn <task>` to start one in the background yourself. The main agent is
  told what you asked; the result wakes it up when it arrives.
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

> Use the `subagent` tool to hand a self-contained task to a fork of yourself: it sees
> this whole conversation and has your tools, and its final message comes back to you.
> Use it for independent work that can run in parallel, or for a long investigation
> that would fill your context. Do not use it for a quick lookup. Give each sub-agent
> one precise task and say what it must report.

```json
{ "pi-minimal": { "subagents": { "guidance": "Use the subagent tool, in the background, for every task that takes more than a few tool calls." } } }
```

## Commands

- `/spawn <task>`: start a background sub-agent.
- `/subagents`: pick a sub-agent of this session and watch it live (its text, the tools
  it runs, the start of each result). ↑↓, PgUp, PgDn, Home and End scroll; Escape
  closes.
- `/subagents stop`: stop the running sub-agents.

A line per running sub-agent shows above the editor: its task, its last tool, how many
tools it ran, and for how long.

## Behavior

- A sub-agent is a `pi` process that continues a copy of the session. It loads the
  same settings, extensions, skills and MCP servers as yours, so it has the same tools.
  Its session file is next to yours (`<session>/subagents/<id>.jsonl`): open it with
  `pi --session <file>` to read all of it, or to talk to it.
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
