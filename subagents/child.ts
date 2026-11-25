import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

type Message = Extract<JsonAgentSessionEvent, { type: "message_end" }>["message"];

export type Status = "running" | "done" | "failed" | "stopped";

/** Snapshot of a child (and its nested children) for the tree widget and parent IPC. */
export interface ChildSnapshot {
	id: number;
	label: string;
	mode: string;
	model: string;
	thinking: string;
	status: Status;
	activity: string;
	tools: number;
	contextTokens: number;
	contextWindow: number;
	cost: number;
	group?: string;
	summary: string;
	startedAt: number;
	endedAt?: number;
	children: ChildSnapshot[];
}

/** A sub-agent: one `pi --mode rpc` process that continues a forked or fresh session file. */
export interface Child {
	id: number;
	task: string;
	/** Short display label (defaults to `task`). */
	label: string;
	/** Launch mode: fork, fresh, or resume. */
	mode: string;
	/** Model used (`provider/id`). */
	model: string;
	/** Thinking level used. */
	thinking: string;
	/** Optional group name: background children in a group only wake the parent when the last one ends. */
	group?: string;
	/** Its session file. `pi --session <file>` opens it. */
	file: string;
	status: Status;
	/** What it does now, for the widget: the last tool it started. */
	activity: string;
	tools: number;
	/** Last reported total context tokens and model context window. */
	contextTokens: number;
	contextWindow: number;
	/** Cumulative model cost in USD reported by usage.cost.total. */
	cost: number;
	/** Latest short summary line from assistant text. */
	summary: string;
	/** Live snapshot of sub-agents started by this child (reported over stdout JSONL). */
	children: ChildSnapshot[];
	/** The messages it added after the fork (its task, its answers, tool results). */
	messages: Message[];
	/** Its final text when done or stopped, the error when failed. */
	output: string;
	startedAt: number;
	endedAt?: number;
	/** Whether this child runs in the background (delivers result as a message on completion). */
	background?: boolean;
	/** Rebind the change listener (used when a reloaded extension adopts a running child). */
	setOnChange(fn: () => void): void;
	/** Send a steering message while the child is running. Throws if not running. */
	steer(message: string): void;
	/** Ask it to stop (SIGTERM, which also stops its own sub-agents). No effect once it ended. */
	stop(): void;
	/** Resolves when the process has exited. Never rejects. */
	done: Promise<Child>;
}

export const snapshot = (
	child: Pick<
		Child,
		"id" | "label" | "mode" | "model" | "thinking" | "status" | "activity" | "tools" | "contextTokens" | "contextWindow" | "cost" | "group" | "summary" | "startedAt" | "endedAt" | "children"
	>,
): ChildSnapshot => ({
	id: child.id,
	label: child.label,
	mode: child.mode,
	model: child.model,
	thinking: child.thinking,
	status: child.status,
	activity: child.activity,
	tools: child.tools,
	contextTokens: child.contextTokens,
	contextWindow: child.contextWindow,
	cost: child.cost,
	group: child.group,
	summary: child.summary,
	startedAt: child.startedAt,
	endedAt: child.endedAt,
	children: child.children,
});

export interface Invocation {
	command: string;
	args: string[];
}

/**
 * How to run pi again, as this process was started. Copied from pi's subagent example
 * (examples/extensions/subagent): Bun-compiled binaries report a virtual script as argv[1].
 */
export function piInvocation(args: string[], script = process.argv[1], exec = process.execPath): Invocation {
	const bunVirtual = script?.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(script ?? "");
	if (script && !bunVirtual && existsSync(script)) return { command: exec, args: [script, ...args] };
	if (!/^(node|bun)(\.exe)?$/.test(basename(exec).toLowerCase())) return { command: exec, args };
	return { command: "pi", args };
}

type ChildEvent =
	| JsonAgentSessionEvent
	| { type: "subagent_children"; children: ChildSnapshot[] }
	| { type: "agent_settled" }
	| { type: "response"; command?: string; success?: boolean; error?: string };

/** Apply one event of a child's JSONL stream. False when it changes nothing a viewer shows. */
export function apply(child: Child, event: ChildEvent): boolean {
	if (event.type === "subagent_children" && Array.isArray(event.children)) {
		child.children = event.children;
		return true;
	}
	if (event.type === "message_update") {
		const ev = event.assistantMessageEvent as { type?: string } | undefined;
		const next = ev?.type === "text_delta" ? "writing" : ev?.type === "thinking_delta" ? "thinking" : undefined;
		if (!next || child.activity === next) return false;
		child.activity = next;
		return true;
	}
	if (event.type === "tool_execution_start") {
		child.activity = event.toolName;
		child.tools++;
		return true;
	}
	if (event.type !== "message_end" || !event.message || !["user", "assistant", "toolResult"].includes(event.message.role)) return false;
	child.messages.push(event.message);
	if (isAssistant(event.message)) {
		child.activity = "thinking";
		const u = event.message.usage;
		if (u) {
			child.contextTokens = u.totalTokens || u.input + u.cacheRead + u.cacheWrite + u.output;
			if (u.cost?.total) child.cost = (child.cost ?? 0) + u.cost.total;
		}
		const line = textOf(event.message).split("\n").find((l) => l.trim());
		if (line) child.summary = line.trim();
	}
	return true;
}

export interface Exit {
	code: number | null;
	signal: string | null;
	error?: Error;
	stderr: string;
}

const exitFailure = ({ code, signal, error, stderr }: Exit) => {
	if (error) return error.message;
	if (code === 0) return undefined;
	return `${code === null ? `killed by ${signal}` : `exit code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
};

type Assistant = Extract<Message, { role: "assistant" }>;
const isAssistant = (message: Message | undefined): message is Assistant => message?.role === "assistant";
const modelError = (last?: Assistant) => (last?.stopReason === "error" ? (last.errorMessage ?? "model error") : undefined);
const textOf = (last: Assistant) => last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();

/** How a child ended: a stop keeps any last text; a crash, RPC or model error fails it; else done with its last text. */
export function outcome(messages: Message[], exit: Exit, stopping: boolean, rpcError?: string): Pick<Child, "status" | "output"> {
	const last = messages.findLast(isAssistant);
	const text = last ? textOf(last) : "";
	if (stopping) return { status: "stopped", output: text };
	const failure = exitFailure(exit) ?? rpcError ?? modelError(last);
	if (failure) return { status: "failed", output: failure };
	return { status: "done", output: text };
}

/** SIGTERM: a pi then stops its own sub-agents. SIGKILL after 5 s if it hangs. */
function terminate(proc: ChildProcess) {
	proc.kill("SIGTERM");
	// shortcut: SIGKILL leaves the child's own sub-agents running, only when the child hangs on exit.
	setTimeout(() => proc.exitCode === null && proc.signalCode === null && proc.kill("SIGKILL"), 5000).unref();
}

const parse = (line: string): ChildEvent | undefined => {
	try {
		return JSON.parse(line);
	} catch {
		return undefined; // not an event
	}
};

export interface ChildMeta {
	label?: string;
	mode?: string;
	model?: string;
	thinking?: string;
	group?: string;
	contextWindow?: number;
	/** Initial prompt sent as an RPC `prompt` command on stdin. */
	prompt?: string;
}

/** Start a child. `onChange` runs after each event that changes what a viewer shows. */
export function startChild(
	id: number,
	task: string,
	file: string,
	pi: Invocation,
	cwd: string,
	env: NodeJS.ProcessEnv,
	onChange: () => void,
	meta: ChildMeta = {},
): Child {
	const proc = spawn(pi.command, pi.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
	proc.stdin.on("error", () => {}); // ignore EPIPE if child exits early
	let stopping = false;
	let stderr = "";
	let rpcError: string | undefined;
	let notify = onChange;
	const send = (cmd: object) => proc.stdin.writable && proc.stdin.write(`${JSON.stringify(cmd)}\n`);
	const child: Child = {
		id,
		task,
		label: meta.label?.trim() || task,
		mode: meta.mode ?? "",
		model: meta.model ?? "",
		thinking: meta.thinking ?? "",
		group: meta.group?.trim() || undefined,
		file,
		status: "running",
		activity: "starting",
		tools: 0,
		contextTokens: 0,
		contextWindow: meta.contextWindow ?? 0,
		cost: 0,
		summary: "",
		children: [],
		messages: [],
		output: "",
		startedAt: Date.now(),
		setOnChange(fn: () => void) {
			notify = fn;
		},
		steer(message: string) {
			if (child.status !== "running" || stopping || !proc.stdin.writable) {
				throw new Error(`Sub-agent #${id} is not running.`);
			}
			send({ type: "steer", message });
		},
		stop() {
			if (child.status !== "running" || stopping) return;
			stopping = true;
			terminate(proc);
		},
		done: undefined as never,
	};

	if (meta.prompt !== undefined) send({ type: "prompt", message: meta.prompt });

	// JSONL split on LF only: readline also splits on U+2028/U+2029, which are valid inside JSON strings.
	let buffer = "";
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (data: string) => {
		const lines = (buffer + data).split("\n");
		buffer = lines.pop() ?? "";
		for (const event of lines.map(parse)) {
			if (!event) continue;
			if (event.type === "agent_settled") {
				proc.stdin.end();
				continue;
			}
			if (event.type === "response" && event.success === false) {
				rpcError = event.error || "RPC command failed";
				if (event.command === "prompt") proc.stdin.end();
				continue;
			}
			if (apply(child, event)) notify();
		}
	});
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (data: string) => (stderr = (stderr + data).slice(-2000)));

	child.done = new Promise((resolve) => {
		const end = (code: number | null, signal: string | null, error?: Error) => {
			if (child.status !== "running") return;
			Object.assign(child, outcome(child.messages, { code, signal, error, stderr }, stopping, rpcError));
			child.activity = child.status;
			child.endedAt = Date.now();
			notify();
			resolve(child);
		};
		proc.on("error", (error) => end(null, null, error));
		proc.on("close", (code, signal) => end(code, signal));
	});
	return child;
}
