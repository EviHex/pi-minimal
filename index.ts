import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROMPT_PLAN_MODE_ON = `PLAN MODE is ON. Read and investigate only. Change nothing: no files, repo state, processes, or remote data.
- Allowed: reading files, searching, read-only commands (ls, rg, cat, git/jj log|diff|status), and read-only API/MCP calls (get, list, search, read-only queries).
- Forbidden: anything that writes: edit/write tools, sed -i, writing to files with > or >> or tee (/dev/null or /tmp is fine), rm/mv/cp, installs, commits or checkouts, kill, POST/PUT/PATCH/DELETE requests, and MCP/API calls that create, update, or delete (databases, configs, Datadog dashboards, monitors). Do not delegate such work to subagents.
- If you are not sure a command is read-only, do not run it. Put it in the plan.
- The user runs /plan to exit plan mode before you execute it.`;

const PROMPT_PLAN_MODE_OFF = "Plan mode is OFF. You may read and write freely.";

export default function (pi: ExtensionAPI) {
	let on = false;
	let used = false; // only sessions that used /plan at least once get a section in the prompt.

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only, prompt-enforced)",
		handler: async (_args, ctx) => {
			on = !on;
			used ||= on;
			ctx.ui.setStatus("plan-mode", on ? "⏸ plan" : undefined);
			ctx.ui.notify(`Plan mode ${on ? "ON" : "OFF"} (from your next message)`, "info");
		},
	});

	// pi diffs the section into the transcript only when its text changes.
	pi.on("before_agent_start", (event) => {
		if (used) {
			event.systemPromptOptions.sections.plan_mode = on ? PROMPT_PLAN_MODE_ON : PROMPT_PLAN_MODE_OFF;
		}
	});
}