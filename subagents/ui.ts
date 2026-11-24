import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, matchesKey, Text, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Child, ChildSnapshot, Status } from "./child.ts";

const oneLine = (text: string, max: number) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const duration = (ms: number) => {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

const shortTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);

export function formatContext(tokens: number, window: number): string {
	if (!tokens) return "";
	return window ? `${shortTokens(tokens)}/${shortTokens(window)} (${Math.round((tokens / window) * 100)}%)` : shortTokens(tokens);
}

const STATUS_ICON: Record<Status, { glyph: string; color: "accent" | "success" | "error" | "warning" }> = {
	running: { glyph: "◐", color: "accent" },
	done: { glyph: "✓", color: "success" },
	failed: { glyph: "✗", color: "error" },
	stopped: { glyph: "○", color: "warning" },
};

function renderNode(node: ChildSnapshot, path: string, prefix: string, isLast: boolean, theme: Theme, now: number, out: string[]) {
	const branch = theme.fg("dim", `${prefix}${isLast ? "└─ " : "├─ "}`);
	const { glyph, color } = STATUS_ICON[node.status];
	const icon = theme.fg(color, glyph);
	const label = oneLine(node.label, 52);
	const elapsed = duration((node.endedAt ?? now) - node.startedAt);
	const ctx = formatContext(node.contextTokens ?? 0, node.contextWindow ?? 0);
	const parts =
		node.status === "running"
			? [node.activity, `${node.tools} tools`, ctx, elapsed]
			: [node.status !== "done" ? node.status : "", ctx, elapsed];
	const meta = ` · ${parts.filter(Boolean).join(" · ")}`;
	const summary = node.summary ? theme.fg("muted", ` — ${oneLine(node.summary, 48)}`) : "";
	const title = node.status === "running" ? `#${path} ${label}` : theme.fg("dim", `#${path} ${label}`);
	out.push(`${branch}${icon} ${title}${theme.fg("dim", meta)}${summary}`);
	const nextPrefix = `${prefix}${isLast ? "   " : "│  "}`;
	const kids = node.children ?? [];
	kids.forEach((kid, idx) => renderNode(kid, `${path}.${kid.id}`, nextPrefix, idx === kids.length - 1, theme, now, out));
}

/** The widget above the editor: a Todos-style tree shown while any sub-agent is running (or when `forceShow` is true). */
export function widgetLines(children: Child[], theme: Theme, now: number, forceShow = false): string[] {
	if (!children.length || (!forceShow && !children.some((c) => c.status === "running"))) return [];
	const done = children.filter((c) => c.status === "done").length;
	const lines = [`${theme.fg("accent", "●")} Sub-agents ${theme.fg("dim", `(${done}/${children.length})`)}`];
	const nodes: ChildSnapshot[] = children.map((c) => ({
		id: c.id,
		label: c.label || c.task,
		status: c.status,
		activity: c.activity,
		tools: c.tools,
		contextTokens: c.contextTokens ?? 0,
		contextWindow: c.contextWindow ?? 0,
		summary: c.summary ?? "",
		startedAt: c.startedAt,
		endedAt: c.endedAt,
		children: c.children ?? [],
	}));
	nodes.forEach((node, idx) => renderNode(node, `${node.id}`, "", idx === nodes.length - 1, theme, now, lines));
	return lines;
}

/** One line about a child: what the tool result and the result message start with. */
export function headline(child: Child): string {
	const status = { done: "finished", stopped: "stopped by user", failed: "failed", running: "running" }[child.status];
	const tag = child.label && child.label !== child.task ? ` [${oneLine(child.label, 40)}]` : "";
	const spec = [child.model, child.thinking].filter(Boolean).join(", ");
	const info = spec ? ` (${spec})` : "";
	return `Sub-agent #${child.id}${tag}${info} ${status} after ${duration((child.endedAt ?? Date.now()) - child.startedAt)}.`;
}

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
		const ctx = formatContext(child.contextTokens ?? 0, child.contextWindow ?? 0);
		const info = [child.model && `${child.model}${child.thinking ? ` (${child.thinking})` : ""}`, ctx, `pi --session ${child.file}`]
			.filter(Boolean)
			.join(" · ");
		const head = `${theme.fg("accent", `#${child.id} ${child.status}`)} ${theme.fg("dim", `· ${info}`)}`;
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
