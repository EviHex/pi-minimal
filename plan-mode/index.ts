import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROMPT_PLAN_MODE_OFF, PROMPT_PLAN_MODE_ON } from "./prompts.js";
import { loadSettings } from "./settings.js";

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
		description: "Toggle read-only plan mode (prompt-enforced)",
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