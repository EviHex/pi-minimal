import type { GuidelinesSetting, TodoItem } from "./core.ts";

export const TOOL_DESCRIPTION =
	"Create or replace the session todo list rendered to the user. Send the full list each call; pass [] to clear. Keep at most one item in_progress at a time.";

export const PROMPT_SNIPPET = "Track multi-step progress with a declarative todo list";

const DEFAULT_GUIDELINES = [
	"Use `todo` for tasks with 3+ steps or several parts; skip it for trivial ones. Keep at most one item `in_progress`.",
	"Mark an item `done` right after finishing it, before the next step or the end of your turn: never batch updates or leave the last item `in_progress`. Do not repeat the full list in chat.",
];

const ALWAYS_GUIDELINES = [
	"Use `todo` on EVERY task that needs tools, even a small one. Create the list before your first tool call and keep at most one item `in_progress`. Only pure chat with no tool call can skip it.",
	"Mark an item `done` right after finishing it, before the next step or the end of your turn: never batch updates or leave the last item `in_progress`. Do not repeat the full list in chat.",
];

/** Prompt lines for a `guidelines` setting: a preset name, or custom lines as is. */
export function resolveGuidelines(setting: GuidelinesSetting): string[] {
	if (Array.isArray(setting)) return setting;
	return setting === "always" ? ALWAYS_GUIDELINES : setting === "off" ? [] : DEFAULT_GUIDELINES;
}

export const CLEAR_NOTICE =
	"The user cleared the todo list with /todo clear. The list is now empty; do not carry over previous items unless asked.";

/** One line appended to a tool result when the list has gone stale. */
export function formatReminder(items: readonly TodoItem[]): string {
	const done = items.filter((i) => i.status === "done").length;
	const active = items.find((i) => i.status === "in_progress");
	return `[todo: ${done}/${items.length} done${active ? `, active: "${active.text}"` : ""} — call todo if progress changed.]`;
}

const SUBCOMMANDS = [
	{ name: "minimize", description: "Toggle between the tree and a one-line summary" },
	{ name: "clear", description: "Clear the todo list" },
	{ name: "settings", description: "Change todo settings" },
];

/** Tab completion for `/todo`. */
export function todoCompletions(prefix: string) {
	if (/\s/.test(prefix.trimStart())) return null;
	const q = prefix.trimStart().toLowerCase();
	const items = SUBCOMMANDS.filter((c) => c.name.startsWith(q)).map((c) => ({ value: c.name, label: c.name, description: c.description }));
	return items.length ? items : null;
}
