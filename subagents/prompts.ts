/** Default `subagents` section of the system prompt. The `guidance` setting replaces it. */
export const GUIDANCE = `Use the \`subagent\` tool to hand a self-contained task to a fork of yourself: it sees this whole conversation and has your tools, and its final message comes back to you. Use it for independent work that can run in parallel, or for a long investigation that would fill your context. Do not use it for a quick lookup. Give each sub-agent one precise task and say what it must report.`;

export const TOOL_DESCRIPTION = `Start a sub-agent: a fork of you that sees this whole conversation and has your tools. It does the task alone and its final message comes back to you. With run_in_background, the call returns at once and the result arrives later as a message; do not poll or wait for it.`;

/** The first message of a fork, after the copied conversation. */
export const forkPrompt = (task: string) => `You are now a sub-agent: a fork of the agent in the conversation above. That conversation is context only: the parent agent handles its requests, including the one that started you. Do the task below yourself; do not give it to another sub-agent. Nobody can answer questions, so do not ask any. Your final message is all the parent agent gets back: make it complete and concise.

Task:
${task}`;

/** What the main agent sees when the user starts a sub-agent with /spawn. */
export const spawnNote = (id: number, task: string) =>
	`The user started sub-agent #${id} in the background, a fork of this conversation, with this task:\n\n${task}\n\nIts result arrives as a message when it ends.`;
