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
