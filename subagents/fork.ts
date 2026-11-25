import type { ContextWithSystemEvent, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";

type Message = ContextWithSystemEvent["messages"][number];

/**
 * The part of the branch a fork gets: all of it, except the turn still running. That turn is the last
 * assistant message when one of its tool calls has no result yet (the call that starts the fork, or a
 * call still running when /spawn is used). A provider rejects a tool call without a result.
 */
export function forkBranch(branch: SessionEntry[]): SessionEntry[] {
	const answered = new Set<string>();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") answered.add(message.toolCallId);
		if (message.role !== "assistant") continue;
		const running = message.content.some((part) => part.type === "toolCall" && !answered.has(part.id));
		return running ? branch.slice(0, i) : branch;
	}
	return branch;
}

/** The session file of a fork, in pi's JSONL format: a new header, then the forked branch. */
export function forkFileText(
	header: SessionHeader | null,
	cwd: string,
	branch: SessionEntry[],
	id: string,
	parentSession: string | undefined,
): string {
	const head: SessionHeader = { type: "session", version: header?.version, id, timestamp: new Date().toISOString(), cwd, parentSession };
	return [head, ...forkBranch(branch)].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

export interface SubagentRecord {
	id: number;
	file: string;
	task: string;
	label: string;
	model: string;
	thinking: string;
}

/** Restore prior sub-agent records saved in the session branch (survives /reload and --resume). */
export function restoreRecords(branch: SessionEntry[]): SubagentRecord[] {
	const byId = new Map<number, SubagentRecord>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== "subagents") continue;
		const d = entry.data as Partial<SubagentRecord> | undefined;
		if (typeof d?.id === "number" && typeof d.file === "string") {
			byId.set(d.id, {
				id: d.id,
				file: d.file,
				task: d.task ?? "",
				label: d.label ?? d.task ?? "",
				model: d.model ?? "",
				thinking: d.thinking ?? "",
			});
		}
	}
	return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Read the last assistant text from a saved sub-agent session JSONL (used after /reload or --resume). */
export function lastAssistantText(text: string): string {
	let last = "";
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
			const joined = entry.message.content
				.flatMap((p: { type?: string; text?: string }) => (p.type === "text" && p.text ? [p.text] : []))
				.join("\n")
				.trim();
			if (joined) last = joined;
		} catch {
			// skip truncated tail line
		}
	}
	return last;
}

/**
 * Clean a saved session JSONL before resuming it: drop any truncated JSON tail line and cut an
 * unfinished tool-call turn (same rule as `forkBranch`) so the provider will accept the next prompt.
 */
export function sanitizeSessionText(text: string): string {
	const lines = text.split("\n").filter((l) => l.trim());
	const parsed: object[] = [];
	for (const line of lines) {
		try {
			parsed.push(JSON.parse(line));
		} catch {
			break; // truncated tail from a crash
		}
	}
	if (!parsed.length) return text;
	const [head, ...entries] = parsed;
	return [head, ...forkBranch(entries as SessionEntry[])].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

/**
 * Runs in the fork. Before its first request, pi compares the prompt and tools it would build now with
 * the ones in the transcript, and adds a system message for each difference (an extension that keeps
 * state in memory, such as plan mode; a file changed on disk). The fork must follow the parent's prompt,
 * and APIs without mid-conversation system messages (Google, Bedrock) move that message to the top,
 * which breaks the prompt cache. So drop the system messages made after `forkedAt` and before the first
 * other new message. System messages the fork adds later (a tool it activates) stay.
 */
export function dropForkDrift(messages: Message[], forkedAt: number): Message[] {
	const start = messages.findIndex((message) => message.timestamp > forkedAt);
	if (start <= 0) return messages; // 0: the fork compacted, its new prompt checkpoint leads.
	let end = start;
	while (end < messages.length && messages[end].role === "system") end++;
	return end === start ? messages : [...messages.slice(0, start), ...messages.slice(end)];
}
