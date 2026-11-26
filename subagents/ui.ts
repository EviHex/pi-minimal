import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { Child, ChildSnapshot, Status } from "./child.ts";

export const WIDGET_FIELDS = ["id", "context", "model", "thinking", "activity", "tools", "tokens", "cost", "elapsed", "group", "summary"] as const;
export type WidgetField = (typeof WIDGET_FIELDS)[number];
export const DEFAULT_FIELDS: WidgetField[] = ["context", "model", "thinking", "activity", "tools", "tokens", "cost", "elapsed", "summary"];

export const FIELD_META: Record<WidgetField, { label: string; description: string }> = {
	id: { label: "Sub-agent ID", description: "Show numeric #id prefix on each sub-agent" },
	context: { label: "Context mode", description: "Show context:fork, context:fresh, or context:resume" },
	model: { label: "Model", description: "Show short model name (e.g. claude-opus-4-6)" },
	thinking: { label: "Thinking level", description: "Show thinking level (e.g. think:med)" },
	activity: { label: "Current activity", description: "Show active tool or phase while running" },
	tools: { label: "Tool count", description: "Show number of tool calls made" },
	tokens: { label: "Context usage", description: "Show context window tokens and percentage" },
	cost: { label: "Session cost", description: "Show cumulative USD cost when reported" },
	elapsed: { label: "Elapsed time", description: "Show wall-clock duration" },
	group: { label: "Batch group", description: "Show [group] badge for grouped background runs" },
	summary: { label: "Last summary", description: "Show latest assistant summary line" },
};

/** Parse whether nested sub-agents are allowed (defaults to true unless explicitly false). */
export function parseAllowNested(raw: unknown): boolean {
	return raw !== false;
}

/** Parse and validate configured widget fields; falls back to DEFAULT_FIELDS when unset or invalid. */
export function parseWidgetFields(raw: unknown): WidgetField[] {
	if (!Array.isArray(raw)) return [...DEFAULT_FIELDS];
	const valid = new Set<string>(WIDGET_FIELDS);
	const seen = new Set<WidgetField>();
	for (const item of raw) {
		if (typeof item === "string" && valid.has(item)) seen.add(item as WidgetField);
	}
	return [...seen];
}

/** Merge keys into settings.json under "pi-minimal"."subagents" without disturbing unrelated settings. Throws, and writes nothing, when the file exists but cannot be read or is not a JSON object. */
export function writeSubagentSettings(filePath: string, patch: Record<string, unknown>): void {
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(readFileSync(filePath, "utf8"));
		if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not a JSON object");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot update ${filePath}: ${(error as Error).message}`);
		data = {};
	}
	const pm = data["pi-minimal"] && typeof data["pi-minimal"] === "object" && !Array.isArray(data["pi-minimal"])
		? { ...(data["pi-minimal"] as Record<string, unknown>) }
		: {};
	const cur = pm.subagents && typeof pm.subagents === "object" && !Array.isArray(pm.subagents)
		? { ...(pm.subagents as Record<string, unknown>) }
		: {};
	pm.subagents = { ...cur, ...patch };
	data["pi-minimal"] = pm;
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

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
	if (!window) return theme.fg("mdCode", text);
	const ratio = tokens / window;
	const color = ratio >= 0.85 ? "error" : ratio >= 0.6 ? "warning" : "mdCode";
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

const THINKING_COLOR: Record<string, Parameters<Theme["fg"]>[0]> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

const colorThinking = (level: string, theme: Theme) =>
	level ? theme.fg(THINKING_COLOR[level] ?? "thinkingMedium", `think:${shortThinking(level)}`) : "";

const FIELD_RENDERERS: Record<Exclude<WidgetField, "id" | "summary">, (node: ChildSnapshot, theme: Theme, now: number, active: boolean) => string> = {
	context: (n, t, _now, a) => (n.mode ? t.fg(a ? "syntaxOperator" : "dim", `context:${n.mode}`) : ""),
	group: (n, t, _now, a) => (n.group ? t.fg(a ? "toolTitle" : "dim", `[${n.group}]`) : ""),
	model: (n, t, _now, a) => (n.model ? t.fg(a ? "syntaxKeyword" : "dim", shortModel(n.model)) : ""),
	thinking: (n, t, _now, a) => (n.thinking ? (a ? colorThinking(n.thinking, t) : t.fg("dim", `think:${shortThinking(n.thinking)}`)) : ""),
	activity: (n, t, _now, a) => (a && n.activity ? t.fg("syntaxFunction", n.activity) : ""),
	tools: (n, t, _now, a) => (a ? t.fg("muted", `${n.tools} tools`) : ""),
	tokens: (n, t, _now, a) => {
		const text = formatContext(n.contextTokens ?? 0, n.contextWindow ?? 0);
		if (!text) return "";
		return a ? colorContext(n.contextTokens ?? 0, n.contextWindow ?? 0, t) : t.fg("dim", text);
	},
	cost: (n, t, _now, a) => (n.cost > 0 ? t.fg(a ? "syntaxString" : "dim", `$${n.cost.toFixed(2)}`) : ""),
	elapsed: (n, t, now) => t.fg("dim", duration((n.endedAt ?? now) - n.startedAt)),
};

const META_ORDER: Exclude<WidgetField, "id" | "summary">[] = ["context", "group", "model", "thinking", "activity", "tools", "tokens", "cost", "elapsed"];

function renderNode(node: ChildSnapshot, path: string, prefix: string, isLast: boolean, theme: Theme, now: number, show: Set<WidgetField>, out: string[]) {
	const active = node.status === "running";
	const sep = theme.fg("dim", " › ");
	const branch = theme.fg("borderMuted", `${prefix}${isLast ? "└─ " : "├─ "}`);
	const { glyph, color } = STATUS_STYLE[node.status];
	const label = oneLine(node.label, 48).toLowerCase();
	const statusTag = !active && node.status !== "done" ? [theme.fg("dim", node.status)] : [];
	const parts = [...statusTag, ...META_ORDER.filter((f) => show.has(f)).map((f) => FIELD_RENDERERS[f](node, theme, now, active))].filter(Boolean);
	const meta = parts.join(sep);
	const summary = show.has("summary") && node.summary ? theme.fg("dim", ` — ${oneLine(node.summary, 44)}`) : "";
	const icon = theme.fg(active ? color : "dim", glyph);
	const id = show.has("id") ? `${theme.fg(active ? "muted" : "dim", `#${path}`)} ` : "";
	const name = active ? label : theme.fg("dim", label);
	out.push(`${branch}${icon} ${id}${name}${meta ? `${sep}${meta}` : ""}${summary}`);
	const nextPrefix = `${prefix}${isLast ? "   " : "│  "}`;
	(node.children ?? []).forEach((kid, idx, kids) => renderNode(kid, `${path}.${kid.id}`, nextPrefix, idx === kids.length - 1, theme, now, show, out));
}

function minimizedSummary(children: Child[], theme: Theme, now: number, show: Set<WidgetField>, rootCost: number): string {
	const sep = theme.fg("dim", " › ");
	const running = children.filter((c) => c.status === "running").length;
	const failed = children.filter((c) => c.status === "failed").length;
	const totalTools = children.reduce((sum, c) => sum + (c.tools ?? 0), 0);
	const totalCost = rootCost + children.reduce((sum, c) => sum + (c.cost ?? 0), 0);
	const maxElapsed = Math.max(0, ...children.map((c) => (c.endedAt ?? now) - c.startedAt));
	const parts = [
		show.has("activity") && running > 0 ? theme.fg("warning", `${running} running`) : "",
		show.has("activity") && failed > 0 ? theme.fg("error", `${failed} failed`) : "",
		show.has("tools") && totalTools > 0 ? theme.fg("muted", `${totalTools} tools`) : "",
		show.has("cost") && totalCost > 0 ? theme.fg("syntaxString", `$${totalCost.toFixed(2)}`) : "",
		show.has("elapsed") ? theme.fg("dim", duration(maxElapsed)) : "",
	].filter(Boolean);
	return parts.length ? sep + parts.join(sep) : "";
}

type TreeEntry = { kind: "node"; node: ChildSnapshot } | { kind: "group"; name: string; members: ChildSnapshot[] };

function groupTreeEntries(nodes: ChildSnapshot[]): TreeEntry[] {
	const entries: TreeEntry[] = [];
	const groups = new Map<string, { kind: "group"; name: string; members: ChildSnapshot[] }>();
	for (const node of nodes) {
		if (!node.group) {
			entries.push({ kind: "node", node });
			continue;
		}
		let entry = groups.get(node.group);
		if (!entry) {
			entry = { kind: "group", name: node.group, members: [] };
			groups.set(node.group, entry);
			entries.push(entry);
		}
		entry.members.push(node);
	}
	return entries;
}

const humanizeGroup = (name: string) => name.replace(/[-_]+/g, " ");

function renderGroup(name: string, members: ChildSnapshot[], isLast: boolean, theme: Theme, now: number, show: Set<WidgetField>, out: string[]) {
	const active = members.some((m) => m.status === "running");
	const branch = theme.fg("borderMuted", isLast ? "└─ " : "├─ ");
	const done = members.filter((m) => m.status === "done").length;
	const title = `◈ group: ${humanizeGroup(name).toLowerCase()}`;
	const count = `(${done}/${members.length})`;
	const header = active ? `${theme.fg("text", title)} ${theme.fg("muted", count)}` : theme.fg("dim", `${title} ${count}`);
	out.push(`${branch}${header}`);
	const nextPrefix = isLast ? "   " : "│  ";
	members.forEach((m, idx) => renderNode({ ...m, group: undefined }, `${m.id}`, nextPrefix, idx === members.length - 1, theme, now, show, out));
}

/** The widget above the editor: a Todos-style tree (or minimized one-line summary) of visible sub-agents. */
export function widgetLines(children: Child[], theme: Theme, now: number, fields: WidgetField[] = DEFAULT_FIELDS, minimized = false, root?: { name?: string; cost?: number }): string[] {
	if (!children.length) return [];
	const show = new Set<WidgetField>(fields);
	const done = children.filter((c) => c.status === "done").length;
	const rootCost = root?.cost ?? 0;
	const title = root?.name?.trim() ? oneLine(root.name.trim(), 48).toLowerCase() : "main agent";
	const cost = !minimized && show.has("cost") && rootCost > 0 ? `${theme.fg("dim", " › ")}${theme.fg("syntaxString", `$${rootCost.toFixed(2)}`)}` : "";
	const header = `${theme.fg("accent", "●")} ${title} ${theme.fg("muted", `(${done}/${children.length})`)}${cost}`;
	if (minimized) return [`${header}${minimizedSummary(children, theme, now, show, rootCost)}`];
	const lines = [header];
	const nodes: ChildSnapshot[] = children.map((c) => ({
		id: c.id,
		label: c.label || c.task,
		mode: c.mode ?? "",
		model: c.model ?? "",
		thinking: c.thinking ?? "",
		status: c.status,
		activity: c.activity,
		tools: c.tools,
		contextTokens: c.contextTokens ?? 0,
		contextWindow: c.contextWindow ?? 0,
		cost: c.cost ?? 0,
		group: c.group,
		summary: c.summary ?? "",
		startedAt: c.startedAt,
		endedAt: c.endedAt,
		children: c.children ?? [],
	}));
	const entries = groupTreeEntries(nodes);
	entries.forEach((entry, idx) => {
		const isLast = idx === entries.length - 1;
		if (entry.kind === "group") renderGroup(entry.name, entry.members, isLast, theme, now, show, lines);
		else renderNode(entry.node, `${entry.node.id}`, "", isLast, theme, now, show, lines);
	});
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

/** Reply of `subagent_stop`: the session path and resume hint stay, as in the stop notice. */
export function stopReply(child: Child): string {
	const state = child.status === "running" ? "Stopping" : `Already ${child.status}:`;
	return `${state} sub-agent #${child.id}${child.status === "running" ? "; it will not wake you" : ""}. Session: ${child.file} · Use resume: ${child.id} to continue.`;
}
