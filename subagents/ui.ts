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

const shortTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);

export function formatContext(tokens: number, window: number): string {
	if (!tokens) return "";
	return window ? `${shortTokens(tokens)}/${shortTokens(window)} (${Math.round((tokens / window) * 100)}%)` : shortTokens(tokens);
}

function colorContext(tokens: number, window: number, theme: Theme): string {
	const text = formatContext(tokens, window);
	if (!text) return "";
	if (!window) return theme.fg("muted", text);
	const ratio = tokens / window;
	const color = ratio >= 0.85 ? "error" : ratio >= 0.6 ? "warning" : "muted";
	return theme.fg(color, text);
}

const STATUS_STYLE: Record<Status, { glyph: string; color: "warning" | "success" | "error" | "muted" }> = {
	running: { glyph: "◐", color: "warning" },
	done: { glyph: "✓", color: "success" },
	failed: { glyph: "✗", color: "error" },
	stopped: { glyph: "○", color: "muted" },
};

const shortModel = (model: string) => model.split("/").at(-1) ?? model;
const shortThinking = (level: string) => (level === "medium" ? "med" : level === "minimal" ? "min" : level);

const colorThinking = (level: string, theme: Theme) =>
	level ? theme.fg("syntaxType", `think:${shortThinking(level)}`) : "";

function renderNode(node: ChildSnapshot, path: string, prefix: string, isLast: boolean, theme: Theme, now: number, out: string[]) {
	const sep = theme.fg("dim", " › ");
	const branch = theme.fg("borderMuted", `${prefix}${isLast ? "└─ " : "├─ "}`);
	const { glyph, color } = STATUS_STYLE[node.status];
	const icon = theme.fg(color, glyph);
	const label = oneLine(node.label, 48);
	const elapsed = theme.fg("dim", duration((node.endedAt ?? now) - node.startedAt));
	const model = node.model ? theme.fg("syntaxKeyword", shortModel(node.model)) : "";
	const think = colorThinking(node.thinking ?? "", theme);
	const ctx = colorContext(node.contextTokens ?? 0, node.contextWindow ?? 0, theme);
	const parts =
		node.status === "running"
			? [model, think, theme.fg("muted", node.activity), theme.fg("dim", `${node.tools} tools`), ctx, elapsed]
			: [node.status !== "done" ? theme.fg(color, node.status) : "", model, think, ctx, elapsed];
	const meta = parts.filter(Boolean).join(sep);
	const summary = node.summary ? theme.fg("dim", ` — ${oneLine(node.summary, 44)}`) : "";
	const id = theme.fg(node.status === "running" ? "muted" : "dim", `#${path}`);
	const name = node.status === "running" ? label : theme.fg("muted", label);
	out.push(`${branch}${icon} ${id} ${name}${sep}${meta}${summary}`);
	const nextPrefix = `${prefix}${isLast ? "   " : "│  "}`;
	const kids = node.children ?? [];
	kids.forEach((kid, idx) => renderNode(kid, `${path}.${kid.id}`, nextPrefix, idx === kids.length - 1, theme, now, out));
}

/** The widget above the editor: a Todos-style tree shown while any sub-agent is running (or when `forceShow` is true). */
export function widgetLines(children: Child[], theme: Theme, now: number, forceShow = false): string[] {
	if (!children.length || (!forceShow && !children.some((c) => c.status === "running"))) return [];
	const done = children.filter((c) => c.status === "done").length;
	const lines = [`${theme.fg("accent", "●")} Sub-agents ${theme.fg("muted", `(${done}/${children.length})`)}`];
	const nodes: ChildSnapshot[] = children.map((c) => ({
		id: c.id,
		label: c.label || c.task,
		model: c.model ?? "",
		thinking: c.thinking ?? "",
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

const childHeader = (child: Child) => {
	const tag = child.label && child.label !== child.task ? ` [${oneLine(child.label, 40)}]` : "";
	const spec = [child.model, child.thinking].filter(Boolean).join(", ");
	return `Sub-agent #${child.id}${tag}${spec ? ` (${spec})` : ""}`;
};

/** One line about a child: what the tool result and the result message start with. */
export function headline(child: Child, now = Date.now()): string {
	const status = { done: "finished", stopped: "stopped by user", failed: "failed", running: "running" }[child.status];
	const prep = child.status === "running" ? "for" : "after";
	return `${childHeader(child)} ${status} ${prep} ${duration((child.endedAt ?? now) - child.startedAt)}.`;
}

/** Format a finished or in-progress status report for the main agent. */
export function statusReport(child: Child, now = Date.now()): string {
	const meta = [
		child.status === "running" ? `Activity: ${child.activity}` : "",
		`${child.tools} tools`,
		formatContext(child.contextTokens, child.contextWindow),
		`Session: ${child.file}`,
		child.status === "stopped" ? `Use resume: ${child.id} to continue.` : "",
	]
		.filter(Boolean)
		.join(" · ");
	if (child.status !== "running") return [headline(child, now), child.output, meta].filter(Boolean).join("\n\n");
	const recent = child.messages
		.slice(1)
		.flatMap((m) =>
			m.role === "assistant"
				? m.content.flatMap((p) =>
						p.type === "toolCall"
							? [`→ ${p.name} ${oneLine(JSON.stringify(p.arguments), 120)}`]
							: p.type === "text" && p.text.trim()
								? [oneLine(p.text, 160)]
								: [],
					)
				: [],
		)
		.slice(-5);
	return [headline(child, now), recent.length ? `Recent:\n${recent.join("\n")}` : "", meta].filter(Boolean).join("\n\n");
}

function headlineColor(line: string): "success" | "error" | "warning" | "accent" {
	if (/ finished after /.test(line)) return "success";
	if (/ failed after /.test(line)) return "error";
	if (/ stopped /.test(line)) return "warning";
	return "accent";
}

/** A result in the chat: the first line and a short preview, or everything as Markdown when expanded. */
export function resultView(text: string, expanded: boolean, theme: Theme): Component {
	const [first, ...rest] = text.trim().split("\n");
	const box = new Container();
	box.addChild(new Text(theme.fg(headlineColor(first), first), 0, 0));
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
	return part.type === "toolCall"
		? [`${theme.fg("syntaxFunction", `→ ${part.name}`)} ${theme.fg("dim", oneLine(JSON.stringify(part.arguments), 200))}`]
		: [];
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
		this.height = Math.max(5, Math.floor(this.tui.terminal.rows * 0.8) - 4);
		const body = transcript(child, theme).flatMap((line) => wrapTextWithAnsi(line, width));
		this.max = Math.max(0, body.length - this.height);
		const top = Math.min(this.top ?? this.max, this.max);
		const { glyph, color } = STATUS_STYLE[child.status];
		const sep = theme.fg("dim", " · ");
		const modelStr = child.model ? theme.fg("syntaxType", `${child.model}${child.thinking ? ` (${child.thinking})` : ""}`) : "";
		const ctx = colorContext(child.contextTokens ?? 0, child.contextWindow ?? 0, theme);
		const meta = [modelStr, ctx, theme.fg("dim", `pi --session ${child.file}`)].filter(Boolean).join(sep);
		const head = `${theme.fg(color, `${glyph} #${child.id} ${child.status}`)}${sep}${meta}`;
		const rule = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
		const foot = theme.fg("muted", "↑↓ PgUp PgDn Home End · Esc/q closes");
		return [head, rule, ...body.slice(top, top + this.height), rule, foot].map((line) => truncateToWidth(line, width));
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
