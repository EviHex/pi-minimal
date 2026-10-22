import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const dir = join(getAgentDir(), "companion-prompts");
	let prompts: Record<string, string> = {}; // file name without ".md" -> text
	let configured: string[] = []; // source and path of every enabled extension

	// Slow work once per session (and on /reload).
	pi.on("session_start", async (_event, ctx) => {
		prompts = {};
		if (existsSync(dir)) {
			for (const file of readdirSync(dir)) {
				if (file.endsWith(".md")) prompts[file.slice(0, -3)] = readFileSync(join(dir, file), "utf8").trim();
			}
		}
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
		const pm = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager });
		const { extensions } = await pm.resolve(async () => "skip");
		configured = extensions.filter((e) => e.enabled).flatMap((e) => [e.metadata.source, e.path]);
	});

	// Fast work every run. pi diffs a section into the transcript only when its text changes.
	pi.on("before_agent_start", (event) => {
		// Also count extensions that registered a tool or command (covers `-e <path>`).
		const registered = [...pi.getAllTools(), ...pi.getCommands()].flatMap((x) => [x.sourceInfo.source, x.sourceInfo.path]);
		const loaded = [...configured, ...registered];
		for (const [name, text] of Object.entries(prompts)) {
			if (text && loaded.some((id) => id.includes(name))) event.systemPromptOptions.sections[`companion_${name}`] = text;
		}
	});
}
