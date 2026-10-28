# pi-minimal

Small yet powerful [pi](https://pi.dev) extensions. Each one does one thing, costs little context, and is easy to fork.

## What "minimal" means here

A minimal extension:

1. **Adds little to the agent context.** The extensions add minimal overhead to agent context (a line or two at most).
2. **Prioritize simplicity over feature count.** Each extension does one thing well, no feature exists "just in case".
3. **Minimal implementation.** Features are implemented in the simplest way possible, easy to fork and customize to suit your needs.

## Published extensions

Extensions with installation commands are public. 

Others are still in development or being tested, and could be published or deleted in the future. You're welcome to install from source or fork them.

| Package                                    | What it does                                                                    | Install                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------- |
| [`plan-mode`](./plan-mode)                 | `/plan` toggles a read-only instruction in the system prompt.                   | `pi install npm:@pi-minimal/plan-mode`      |
| [`mention-skills`](./mention-skills)       | `$` autocompletes skills and prompt templates. The agent gets their file paths. | `pi install npm:@pi-minimal/mention-skills` |
| [`polyglot`](./polyglot)                   | `/lang` selects a saved language reminder.                                      | From source (not yet published)             |
| [`companion-prompts`](./companion-prompts) | Adds a prompt file to the system prompt only when a given extension is loaded.  | From source (not yet published)             |

To try one without installing it: `pi -e npm:@pi-minimal/<extension-name>`.

## Settings

Extensions come with sane defaults. Let your agent explain settings to you and configure the plugins for you.

All settings are in pi's `settings.json` (`~/.pi/agent/settings.json` or `.pi/settings.json`), under `"pi-minimal"` and the extension name:

*e.g.*
```json
{ "pi-minimal": { "plan-mode": { "keyboardShortcut": "ctrl+alt+o" } } }
```

Each extension lists its keys in the `## Settings` section of its own README.

The repo is an npm workspace. Conventions are in [`AGENTS.md`](./AGENTS.md).

## Contributions

You're welcome to submit issues or proof-of-concept pull requests. 

## License

[MIT](./LICENSE)
