import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
	text: string;
	status: TodoStatus;
}

/** Theme colors the widget uses (same palette as the sub-agents widget). */
export interface Style {
	accent: (s: string) => string;
	dim: (s: string) => string;
	muted: (s: string) => string;
	warning: (s: string) => string;
	borderMuted: (s: string) => string;
}

export const ENTRY_TYPE = "todo";

const STATUSES = new Set<string>(["pending", "in_progress", "done"]);

/** Strip ANSI escapes, control chars and bidi overrides so model text cannot break the terminal layout. */
function sanitize(value: string): string {
	return value
		.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/(?:\u001b\]|\u009d)[^\u0007\u009c\u001b]*(?:\u0007|\u009c|\u001b\\)?/g, "")
		.replace(/\u001b./g, "")
		.replace(/[\r\n\t\u2028\u2029]/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
		.trim();
}

function isRawItem(value: unknown): value is TodoItem {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return typeof item.text === "string" && typeof item.status === "string" && STATUSES.has(item.status);
}

/** Clean a model-supplied list: drop bad items, keep at most one `in_progress`. */
export function parseItems(raw: unknown): TodoItem[] {
	if (!Array.isArray(raw)) return [];
	const items: TodoItem[] = [];
	let seenActive = false;
	for (const entry of raw) {
		if (!isRawItem(entry)) continue;
		const text = sanitize(entry.text);
		if (!text) continue;
		const status: TodoStatus = entry.status === "in_progress" && seenActive ? "pending" : entry.status;
		if (status === "in_progress") seenActive = true;
		items.push({ text, status });
	}
	return items;
}

/** The latest valid snapshot on a session branch. */
export function replay(entries: Iterable<unknown>): TodoItem[] {
	let latest: TodoItem[] = [];
	for (const raw of entries) {
		const entry = raw as { type?: unknown; customType?: unknown; data?: unknown } | null | undefined;
		if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data;
		if (Array.isArray(data) && data.every((item) => isRawItem(item) && item.text.trim())) {
			latest = data.map((item: TodoItem) => ({ text: item.text, status: item.status }));
		}
	}
	return latest;
}

const count = (items: readonly TodoItem[], status: TodoStatus) => items.filter((i) => i.status === status).length;

/** What the tool returns to the agent: a short focus echo. */
export function formatSummary(items: readonly TodoItem[]): string {
	if (items.length === 0) return "Todo list cleared.";
	const done = count(items, "done");
	if (done === items.length) return `${done}/${items.length} done.`;
	const active = items.find((i) => i.status === "in_progress");
	const next = items.find((i) => i.status === "pending");
	return [
		`${done}/${items.length} done`,
		active && `active: "${active.text}"`,
		next && `next: "${next.text}"`,
	]
		.filter(Boolean)
		.join(" · ");
}

/** Widget lines: a tree, or one line when minimized. `undefined` hides the widget. */
export function renderLines(items: readonly TodoItem[], minimized: boolean, style: Style): string[] | undefined {
	if (items.length === 0) return undefined;
	const done = count(items, "done");
	const allDone = done === items.length;
	const label = `todos (${done}/${items.length})`;
	const header = allDone ? style.dim(`○ ${label}`) : `${style.accent("●")} ${style.muted(label)}`;

	if (minimized) {
		const active = items.find((i) => i.status === "in_progress");
		const focus = allDone
			? style.dim("all done")
			: active
				? `${style.warning("◐")} ${active.text}`
				: style.muted(`${items.length - done} pending`);
		return [`${header} ${style.dim("›")} ${focus}`];
	}

	const rows = items.map((item, i) => {
		const branch = style.borderMuted(i === items.length - 1 ? "└─ " : "├─ ");
		if (item.status === "done") return `${branch}${style.dim(`✓ ${item.text}`)}`;
		if (item.status === "in_progress") return `${branch}${style.warning("◐")} ${item.text}`;
		return `${branch}${style.muted("○")} ${item.text}`;
	});
	return [header, ...rows];
}

export type GuidelinesSetting = "default" | "always" | "off" | string[];

export interface TodoSettings {
	defaultMinimized: boolean;
	hideCompletedOnNextTurn: boolean;
	/** Tool results between reminders while items are unfinished; 0 turns reminders off. */
	reminderInterval: number;
	/** Preset name, or custom prompt lines used as is. Read once at load. */
	guidelines: GuidelinesSetting;
}

export const DEFAULT_SETTINGS: TodoSettings = { defaultMinimized: false, hideCompletedOnNextTurn: true, reminderInterval: 8, guidelines: "default" };

function parseGuidelines(v: unknown): GuidelinesSetting {
	if (v === "default" || v === "always" || v === "off") return v;
	return Array.isArray(v) && v.every((l) => typeof l === "string") ? v : "default";
}

/** `raw` is the `"pi-minimal"."todo"` object of settings.json. Bad values fall back to defaults. */
export function parseTodoSettings(raw: unknown): TodoSettings {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const bool = (key: "defaultMinimized" | "hideCompletedOnNextTurn") => (typeof r[key] === "boolean" ? (r[key] as boolean) : DEFAULT_SETTINGS[key]);
	const n = r.reminderInterval;
	return {
		defaultMinimized: bool("defaultMinimized"),
		hideCompletedOnNextTurn: bool("hideCompletedOnNextTurn"),
		guidelines: parseGuidelines(r.guidelines),
		reminderInterval: typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : DEFAULT_SETTINGS.reminderInterval,
	};
}

/** Merge `patch` under `"pi-minimal"."todo"` in a settings file, keeping everything else. */
export function writeTodoSettings(filePath: string, patch: Partial<TodoSettings>): void {
	let root: Record<string, any> = {};
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) root = parsed;
	} catch {}
	const ns = root["pi-minimal"] && typeof root["pi-minimal"] === "object" ? root["pi-minimal"] : {};
	const prev = ns.todo && typeof ns.todo === "object" ? ns.todo : {};
	root["pi-minimal"] = { ...ns, todo: { ...prev, ...patch } };
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(root, null, 2)}\n`);
}

/** The `"pi-minimal"."todo"` object of a settings file; `{}` when missing or broken. */
export function readTodoRaw(filePath: string): Record<string, unknown> {
	try {
		const todo = JSON.parse(readFileSync(filePath, "utf8"))?.["pi-minimal"]?.todo;
		return todo && typeof todo === "object" ? todo : {};
	} catch {
		return {};
	}
}
