import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, matchesKey, Text, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Child } from "./child.ts";

const oneLine = (text: string, max: number) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const duration = (ms: number) => {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/** The widget above the editor: one line per running child. */
export function widgetLines(children: Child[], theme: Theme, now: number): string[] {
	return children
		.filter((child) => child.status === "running")
		.map(
			(child) =>
				`${theme.fg("accent", "●")} #${child.id} ${oneLine(child.task, 60)}` +
				theme.fg("dim", ` · ${child.activity} · ${child.tools} tools · ${duration(now - child.startedAt)}`),
		);
}

/** One line about a child: what the tool result and the result message start with. */
export const headline = (child: Child) =>
	`Sub-agent #${child.id} ${child.status === "done" ? "finished" : child.status} after ${duration((child.endedAt ?? Date.now()) - child.startedAt)}.`;

/** A result in the chat: the first line and a short preview, or everything as Markdown when expanded. */
export function resultView(text: string, expanded: boolean, theme: Theme): Component {
	const [first, ...rest] = text.trim().split("\n");
	const box = new Container();
	box.addChild(new Text(theme.fg("accent", first), 0, 0));
	const body = rest.join("\n").trim();
	if (!body) return box;
	if (expanded) {
		box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
		return box;
	}
	const lines = body.split("\n");
	const preview = lines.slice(0, 3).map((line) => theme.fg("dim", line));
	if (lines.length > 3) preview.push(theme.fg("muted", `… ${lines.length - 3} more lines, ${keyHint("app.tools.expand", "to expand")}`));
	box.addChild(new Text(preview.join("\n"), 0, 0));
	return box;
}

type Message = Child["messages"][number];

type Part = Extract<Message, { role: "assistant" }>["content"][number];
type ToolResult = Extract<Message, { role: "toolResult" }>;

/** A part of an answer in a viewer: its text, or one line per tool call. */
function partLines(part: Part, theme: Theme): string[] {
	if (part.type === "text") return part.text.trim() ? [part.text.trim()] : [];
	return part.type === "toolCall" ? [theme.fg("muted", `→ ${part.name} ${oneLine(JSON.stringify(part.arguments), 200)}`)] : [];
}

/** A tool result in a viewer: its first 3 lines. */
function resultLines(result: ToolResult, theme: Theme): string[] {
	const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
	return text ? text.split("\n").slice(0, 3).map((line) => theme.fg(result.isError ? "error" : "dim", `  ${oneLine(line, 200)}`)) : [];
}

function messageLines(message: Message, theme: Theme): string[] {
	if (message.role === "user") return [theme.fg("accent", `▶ ${typeof message.content === "string" ? message.content : "(message)"}`)];
	if (message.role === "assistant") return message.content.flatMap((part) => partLines(part, theme));
	return message.role === "toolResult" ? resultLines(message, theme) : [];
}

/** What a viewer shows of a child: its task (not the fork prompt around it), its messages, how it ended. */
export function transcript(child: Child, theme: Theme): string[] {
	const end = {
		running: theme.fg("dim", `… ${child.activity}`),
		done: [],
		failed: theme.fg("error", `failed: ${child.output}`),
		stopped: theme.fg("warning", "stopped"),
	}[child.status];
	return [theme.fg("accent", `▶ ${child.task}`), "", ...child.messages.slice(1).flatMap((m) => messageLines(m, theme)), end].flat();
}

/** A scrollable, live view of one child. It follows the end until the user scrolls up. */
export class Viewer implements Component {
	private top: number | undefined; // undefined: follow the end
	private max = 0;
	private height = 10;
	private child: Child;
	private tui: TUI;
	private theme: Theme;
	private close: () => void;

	constructor(child: Child, tui: TUI, theme: Theme, close: () => void) {
		this.child = child;
		this.tui = tui;
		this.theme = theme;
		this.close = close;
	}

	render(width: number): string[] {
		const { child, theme } = this;
		this.height = Math.max(5, Math.floor(this.tui.terminal.rows * 0.8) - 2);
		const body = transcript(child, theme).flatMap((line) => wrapTextWithAnsi(line, width));
		this.max = Math.max(0, body.length - this.height);
		const top = Math.min(this.top ?? this.max, this.max);
		const head = `${theme.fg("accent", `#${child.id} ${child.status}`)} ${theme.fg("dim", `· pi --session ${child.file}`)}`;
		const foot = theme.fg("dim", "↑↓ PgUp PgDn Home End · Esc closes");
		return [head, ...body.slice(top, top + this.height), foot].map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		const top = this.top ?? this.max;
		const moves: [string, number][] = [
			["up", top - 1],
			["down", top + 1],
			["pageUp", top - this.height],
			["pageDown", top + this.height],
			["home", 0],
			["end", this.max],
		];
		if (matchesKey(data, "escape") || data === "q") return this.close();
		const move = moves.find(([key]) => matchesKey(data, key as never));
		if (!move) return;
		const next = Math.max(0, Math.min(move[1], this.max));
		this.top = next >= this.max ? undefined : next;
		this.tui.requestRender();
	}

	invalidate(): void {}
}
