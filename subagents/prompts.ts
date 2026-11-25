export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelRef {
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
}

export interface SpawnArgs {
	fresh: boolean;
	model?: string;
	thinking?: string;
	task: string;
}

/** Default `subagents` section of the system prompt. The `guidance` setting replaces it. */
export const GUIDANCE = `- Delegation: Use \`subagent\` for independent parallel tracks, or noisy exploration (docs, broad search, logs, tests) that reduces to a concise report with sources. Sub-agents add cost: handle quick lookups, sequential steps, and routine checks yourself, and prefer one sub-agent over many. Give each a distinct scope, expected output, whether it may edit, and files no one else (you included) edits; don't redo delegated work.
- Execution: At top level, sub-agents run in the background and wake you with their report so the user can steer—leave \`wait\` unset even when you need every result. Do other work or end your turn; share a \`group\` on parallel batches to wake once when all finish. Do not poll, sleep, or guess pending results (if asked, say it is running); synthesize reports for the user rather than copying them. Set \`wait: true\` only when the user asks you to block. Use \`subagent_status\`, \`subagent_steer\` or \`subagent_stop\` only when the user asks to peek at, redirect or stop a running sub-agent.
- Context & routing: Fork (default) when history helps—a brief directive suffices, and keeping the same model and thinking level reuses the prompt cache. Use \`fresh: true\` when history is irrelevant or would bias a requested review (pass paths, facts, constraints). Keep inherited settings by default; pair \`fresh\` with lower \`thinking\` (or a lighter model) for retrieval, summaries, or mechanical edits, and higher \`thinking\` for difficult judgment or debugging. Use \`resume\` for follow-ups.`;

export const TOOL_DESCRIPTION = `Start or resume a sub-agent with your tools; only its final report returns. Default: background fork, delivered later as a message.`;

/** Frozen list of models the agent may pass to `model`: enabled models first, then the current provider's, then the rest. */
export function formatModelShortlist(models: ModelRef[], enabledModels: string[] = [], currentProvider?: string, max = 15): string {
	const full = (m: ModelRef) => `${m.provider}/${m.id}`;
	const byName = (a: ModelRef, b: ModelRef) => full(a).localeCompare(full(b));
	const enabled = enabledModels.flatMap((e) => models.filter((m) => [full(m), m.id].some((n) => n.toLowerCase() === e.trim().toLowerCase())));
	const rest = [...models].sort(byName);
	const ordered = [...enabled, ...rest.filter((m) => m.provider === currentProvider), ...rest];
	return [...new Set(ordered.map(full))].slice(0, max).join(", ");
}

/** Reminder sent after `/compact`, which summarizes away the "started in the background" tool results. */
export function compactNote(running: { id: number; label?: string; task: string; group?: string }[]): string {
	if (!running.length) return "";
	const line = (c: (typeof running)[number]) => `- #${c.id}${c.group ? ` [${c.group}]` : ""} ${(c.label || c.task).replace(/\s+/g, " ").trim().slice(0, 100)}`;
	return `Context was compacted. These background sub-agents are still running; each result still arrives as a message when it ends:\n${running.map(line).join("\n")}`;
}

export const STATUS_TOOL_DESCRIPTION = `Non-blocking snapshot of a sub-agent by its #id: shows current activity, recent tool calls/text, context usage, or the final result if finished. Does not wait—background sub-agents wake you automatically when they finish.`;

export const STOP_TOOL_DESCRIPTION = `Stop a running sub-agent by its #id; it will not wake you. Use \`subagent\` with \`resume\` to continue it later.`;

export const STEER_TOOL_DESCRIPTION = `Send a steering message to a currently running sub-agent by its #id (delivered after its current tool finishes). Use \`subagent\` with \`resume\` instead if the sub-agent has already ended.`;

const BLOCKED_AND_OUTPUT_RULES =
	"If you are blocked on a decision or missing info only the parent can supply, stop and state the exact question in your final message so the parent can resume you with the answer. Your final message is all the parent agent gets back: make it complete and concise.";

const DEFAULT_NESTING_RULE = "Do the task below yourself; do not give it to another sub-agent.";

export type ChildMode = "fork" | "fresh" | "resume";

export interface ChildPromptOptions {
	depth?: number;
	maxDepth?: number;
	allowNested?: boolean;
}

const MODE_INTRO: Record<ChildMode, string> = {
	fork: "You are now a sub-agent: a fork of the agent in the conversation above. That conversation is context only—the parent already handled every request in it, including spawning you. Do ONLY the Task below yourself; never re-spawn yourself or re-delegate the task.",
	fresh: "You are a sub-agent.",
	resume: "You are resuming your previous sub-agent session above.",
};

function nestingRule(opts?: ChildPromptOptions): string {
	if (opts?.depth === undefined || opts?.maxDepth === undefined) return DEFAULT_NESTING_RULE;
	const depth = `Depth ${opts.depth}/${opts.maxDepth}`;
	if (opts.allowNested === false || opts.depth >= opts.maxDepth) return `${depth}: the \`subagent\` tool is disabled here—complete this task directly.`;
	return `${depth}. Own this task; delegate only a small, self-contained noisy lookup (never the whole task). Nested calls block automatically (parallel within one message)—ignore the background/wait/group guidance above.`;
}

/** The first message of a sub-agent (forked, fresh, or resumed). Sits after the cached prefix. */
export const childPrompt = (task: string, mode: ChildMode = "fork", opts?: ChildPromptOptions) =>
	`${MODE_INTRO[mode]} ${nestingRule(opts)} ${BLOCKED_AND_OUTPUT_RULES}\n\nTask:\n${task}`;

/** Parse `/spawn [--fresh] [--model <model>] [--thinking <level>] <task>`. */
export function parseSpawnArgs(args: string): SpawnArgs {
	let rest = args.trim();
	const out: SpawnArgs = { fresh: false, task: "" };
	const readValue = (flag: string, key: "model" | "thinking"): boolean => {
		if (rest.startsWith(`${flag}=`)) {
			const token = rest.split(/\s+/, 1)[0];
			out[key] = token.slice(flag.length + 1) || undefined;
			rest = rest.slice(token.length).trimStart();
			return true;
		}
		if (rest !== flag && !rest.startsWith(`${flag} `) && !rest.startsWith(`${flag}\t`)) return false;
		const after = rest.slice(flag.length).trimStart();
		if (!after) {
			rest = "";
			return true;
		}
		const val = after.split(/\s+/, 1)[0];
		out[key] = val;
		rest = after.slice(val.length).trimStart();
		return true;
	};
	while (rest.startsWith("--")) {
		const flag = rest.split(/\s+/, 1)[0];
		if (flag === "--fresh") {
			out.fresh = true;
			rest = rest.slice(flag.length).trimStart();
		} else if (!readValue("--model", "model") && !readValue("--thinking", "thinking")) {
			break;
		}
	}
	out.task = rest;
	return out;
}

/** Resolve an optional thinking level, defaulting to `current`. */
export function resolveThinking(spec: string | undefined, current: string): string {
	const wanted = spec?.trim().toLowerCase();
	if (!wanted) return current;
	if ((THINKING_LEVELS as readonly string[]).includes(wanted)) return wanted;
	throw new Error(`Unknown thinking level "${spec?.trim()}". Expected one of: ${THINKING_LEVELS.join(", ")}.`);
}

/** Resolve an optional `provider/id`, `id`, or bare model name against available models, defaulting to `current`. */
export function resolveModel(spec: string | undefined, current: ModelRef | undefined, available: ModelRef[]): ModelRef {
	const wanted = spec?.trim();
	if (!wanted) {
		if (!current) throw new Error("No model is selected.");
		return current;
	}
	const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
	const pick = (matches: ModelRef[]) => matches.find((m) => m.provider === current?.provider) ?? matches[0];
	const byFull = available.find((m) => eq(`${m.provider}/${m.id}`, wanted));
	if (byFull) return byFull;
	const byId = available.filter((m) => eq(m.id, wanted));
	if (byId.length) return pick(byId);
	const byBare = available.filter((m) => eq(m.id.split("/").at(-1) ?? m.id, wanted));
	if (byBare.length) return pick(byBare);
	const q = wanted.toLowerCase();
	const hints = available.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(q));
	const list = (hints.length ? hints : available).slice(0, 8).map((m) => `${m.provider}/${m.id}`);
	throw new Error(`Unknown model "${wanted}".${list.length ? ` Available: ${list.join(", ")}` : ""}`);
}

function modelItems(head: string, query: string, models: ModelRef[]) {
	const q = query.toLowerCase();
	const items = models
		.filter((m) => `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(q))
		.map((m) => {
			const full = `${m.provider}/${m.id}`;
			return { value: `${head}${full} `, label: full, description: m.name };
		});
	return items.length ? items : null;
}

function thinkingItems(head: string, query: string) {
	const q = query.toLowerCase();
	const items = THINKING_LEVELS.filter((level) => level.startsWith(q)).map((level) => ({
		value: `${head}${level} `,
		label: level,
	}));
	return items.length ? items : null;
}

const FLAGS = [
	{ flag: "--fresh", description: "Start with an empty conversation" },
	{ flag: "--model", description: "Choose model (provider/id)" },
	{ flag: "--thinking", description: "Choose thinking level (off..max)" },
];

function flagItems(head: string, token: string, used: Set<string>) {
	const items = FLAGS.filter((f) => !used.has(f.flag) && f.flag.startsWith(token)).map((f) => ({
		value: `${head}${f.flag} `,
		label: f.flag,
		description: f.description,
	}));
	return items.length ? items : null;
}

/** Argument completions for `/spawn [--fresh] [--model <provider/id>] [--thinking <level>] <task>`. */
export function spawnCompletions(argumentText: string, models: ModelRef[]) {
	const used = new Set<string>();
	const tokens = [...argumentText.matchAll(/\S+/g)];
	const trailingSpace = /\s$/.test(argumentText) || !tokens.length;
	const active = trailingSpace ? { text: "", start: argumentText.length } : { text: tokens.at(-1)![0], start: tokens.at(-1)!.index! };
	const committed = trailingSpace ? tokens : tokens.slice(0, -1);

	for (let i = 0; i < committed.length; i++) {
		const t = committed[i][0];
		if (t === "--fresh") used.add("--fresh");
		else if (t.startsWith("--model=")) used.add("--model");
		else if (t.startsWith("--thinking=")) used.add("--thinking");
		else if (t === "--model" || t === "--thinking") {
			used.add(t);
			if (i + 1 === committed.length) {
				const head = argumentText.slice(0, active.start);
				return t === "--model" ? modelItems(head, active.text, models) : thinkingItems(head, active.text);
			}
			i++;
		} else return null;
	}
	const head = argumentText.slice(0, active.start);
	if (active.text.startsWith("--model=")) return modelItems(`${head}--model=`, active.text.slice("--model=".length), models);
	if (active.text.startsWith("--thinking=")) return thinkingItems(`${head}--thinking=`, active.text.slice("--thinking=".length));
	return flagItems(head, active.text, used);
}

const SUBCOMMANDS = [
	{ name: "spawn", value: "spawn ", description: "Start a background sub-agent [--fresh] [--model] [--thinking] <task>" },
	{ name: "minimize", value: "minimize", description: "Toggle the widget between full tree and one-line summary" },
	{ name: "settings", value: "settings", description: "Configure visible widget fields interactively" },
];

/** Argument completions for `/subagents` and `/sa`. */
export function subagentsCompletions(argumentText: string, models: ModelRef[]) {
	const spawnMatch = argumentText.match(/^(\s*spawn\s+)([\s\S]*)$/);
	if (spawnMatch) {
		const items = spawnCompletions(spawnMatch[2], models);
		return items ? items.map((item) => ({ ...item, value: `${spawnMatch[1]}${item.value}` })) : null;
	}
	if (/\s/.test(argumentText.trimStart())) return null;
	const q = argumentText.trimStart().toLowerCase();
	const items = SUBCOMMANDS.filter((c) => c.name.startsWith(q)).map((c) => ({ value: c.value, label: c.name, description: c.description }));
	return items.length ? items : null;
}

/** What the main agent sees when the user starts a sub-agent with /subagents spawn. */
export const spawnNote = (id: number, task: string, fresh = false) =>
	`The user started sub-agent #${id} in the background, ${fresh ? "with a fresh context" : "a fork of this conversation"}, with this task:\n\n${task}\n\nIts result arrives as a message when it ends.`;
