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
export const GUIDANCE = `Use the \`subagent\` tool to hand a self-contained task to a sub-agent with your tools; its final message comes back to you. By default it forks this conversation (sees everything above and reuses the prompt cache); pass \`fresh: true\` for an empty conversation when the history above is not needed, and include all context in \`task\`. Pass \`model\` (provider/id or id) and/or \`thinking\` (off, minimal, low, medium, high, xhigh, max) to override the current model or thinking level; changing the model misses the prompt cache on a fork, so it pairs best with \`fresh: true\`. Pass \`label\` for a short status label when \`task\` is long, and \`resume: <id>\` to continue a finished or stopped sub-agent with its existing context. Each sub-agent runs in its own process (in-memory state like the parent's todo list is not shared; files in the working directory are). To run several sub-agents in parallel and collect all results together, call \`subagent\` concurrently in the foreground (e.g. \`Promise.allSettled\` in \`codemode\`); use \`run_in_background\` only when you want to return immediately and be woken later by a message. Do not use sub-agents for a quick lookup. Give each sub-agent one precise task and say what it must report.`;

export const TOOL_DESCRIPTION = `Start or resume a sub-agent with your tools. By default it forks this conversation; pass \`fresh: true\` for an empty conversation, or \`resume: <id>\` to continue a finished/stopped sub-agent. Optionally pass \`model\`, \`thinking\`, and a short \`label\`. Its final message comes back to you. With \`run_in_background\`, the call returns at once and the result arrives later as a message; do not poll or wait for it.`;

const RULES =
	"Do the task below yourself; do not give it to another sub-agent. If you are blocked on a decision or missing info only the parent can supply, stop and state the exact question in your final message so the parent can resume you with the answer. Your final message is all the parent agent gets back: make it complete and concise.";

export type ChildMode = "fork" | "fresh" | "resume";

const MODE_INTRO: Record<ChildMode, string> = {
	fork: "You are now a sub-agent: a fork of the agent in the conversation above. That conversation is context only: the parent agent handles its requests, including the one that started you.",
	fresh: "You are a sub-agent.",
	resume: "You are resuming your previous sub-agent session above.",
};

/** The first message of a sub-agent (forked, fresh, or resumed). */
export const childPrompt = (task: string, mode: ChildMode = "fork") => `${MODE_INTRO[mode]} ${RULES}\n\nTask:\n${task}`;

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
	{ name: "stop", value: "stop", description: "Stop all running sub-agents" },
	{ name: "show", value: "show", description: "Show the sub-agents tree widget" },
	{ name: "hide", value: "hide", description: "Hide the sub-agents tree widget" },
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
