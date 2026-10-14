import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROMPT = `PLAN MODE is ON. Read and investigate only. Change nothing: no files, repo state, processes, or remote data.
- Allowed: reading files, searching, read-only commands (ls, rg, cat, git/jj log|diff|status), and read-only API/MCP calls (get, list, search, read-only queries).
- Forbidden: anything that writes: edit/write tools, sed -i, writing to files with > or >> or tee (/dev/null or /tmp is fine), rm/mv/cp, installs, commits or checkouts, kill, POST/PUT/PATCH/DELETE requests, and MCP/API calls that create, update, or delete (databases, configs, Datadog dashboards, monitors). Do not delegate such work to subagents.
- If you are not sure a command is read-only, do not run it. Put it in the plan.
- End with a concrete step-by-step plan. The user runs /plan to exit plan mode before you execute it.`;

export default function (pi: ExtensionAPI) {
	let on = false;

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only, prompt-enforced)",
		handler: async (_args, ctx) => {
			on = !on;
			ctx.ui.setStatus("plan-mode", on ? "⏸ plan" : undefined);
			ctx.ui.notify(`Plan mode ${on ? "ON" : "OFF"} (from your next message)`, "info");
		},
	});

	// Each run starts without the section; pi diffs it in or out of the transcript.
	pi.on("before_agent_start", (event) => {
		if (on) event.systemPromptOptions.sections.plan_mode = PROMPT;
	});
}
