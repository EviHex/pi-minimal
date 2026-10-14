import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

const PROMPT_PLAN_MODE_ON = `PLAN MODE is ON. Read and investigate only. Change nothing: no files, repo state, processes, or remote data.
- Allowed: reading files, searching, read-only commands (ls, rg, cat, git/jj log|diff|status), and read-only API/MCP calls (get, list, search, read-only queries).
- Forbidden: anything that writes: edit/write tools, sed -i, writing to files with > or >> or tee (/dev/null or /tmp is fine), rm/mv/cp, installs, commits or checkouts, kill, POST/PUT/PATCH/DELETE requests, and MCP/API calls that create, update, or delete (databases, configs, Datadog dashboards, monitors). Do not delegate such work to subagents.
- If you are not sure a command is read-only, do not run it. Put it in the plan.
- The user runs /plan to exit plan mode before you execute it.`;

const PROMPT_PLAN_MODE_OFF = "Plan mode is OFF. You may read and write freely.";

/** What the user can configure in settings.json, under "pi-minimal"."plan-mode" */
interface PlanModeSettings {
	/** Keyboard shortcut to toggle plan mode. */
	keyboardShortcut: KeyId;
}

const DEFAULT_SETTINGS: PlanModeSettings = {
	keyboardShortcut: "ctrl+shift+p"
};

function loadSettings(pi: ExtensionAPI): PlanModeSettings {
	const file = pi.getSettings() as { "pi-minimal"?: { "plan-mode"?: Partial<PlanModeSettings> } };
	return { ...DEFAULT_SETTINGS, ...file["pi-minimal"]?.["plan-mode"] };
}

export default function (pi: ExtensionAPI) {
	let on = false;
	let used = false; // only sessions that used /plan at least once get a section in the prompt.

	const togglePlanMode = (ctx: ExtensionContext) => {
		on = !on;
		used ||= on;
		ctx.ui.setStatus("plan-mode", on ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined);
		ctx.ui.notify(`Plan mode ${on ? "ON" : "OFF"} (from your next message)`, "info");
	};

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only, prompt-enforced)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	// Read at session_start: settings are not available while the extension loads.
	pi.on("session_start", () => {
		const { keyboardShortcut } = loadSettings(pi);
		pi.registerShortcut(keyboardShortcut, { description: "Toggle plan mode", handler: togglePlanMode });
	});

	// pi diffs the section into the transcript only when its text changes.
	pi.on("before_agent_start", (event) => {
		if (used) event.systemPromptOptions.sections.plan_mode = on ? PROMPT_PLAN_MODE_ON : PROMPT_PLAN_MODE_OFF;
	});
}