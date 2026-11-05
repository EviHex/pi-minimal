import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultPackageManager, SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Rule = { file: string; when: (c: { cwd: string; extensions: string[] }) => boolean };

// Identity of an extension. Auto-discovered ones all have the source "auto", so use their path.
const idOf = (source: string, path: string) => (source === "auto" ? path : source);

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const dir = join(agentDir, "companion-prompts");
	const rulesFile = join(dir, "rules.ts");
	let sections: Record<string, string> = {};

	// cwd and the loaded extensions change only with a new session or /reload, so evaluate once here.
	pi.on("session_start", async (_event, ctx) => {
		sections = {};
		if (!existsSync(rulesFile)) return;

		const pm = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager: SettingsManager.create(ctx.cwd, agentDir) });
		const enabled = (await pm.resolve(async () => "skip")).extensions.filter((e) => e.enabled).map((e) => idOf(e.metadata.source, e.path));
		// Extensions that registered a tool or command (covers `-e <path>`).
		const registered = [...pi.getAllTools(), ...pi.getCommands()].map((x) => idOf(x.sourceInfo.source, x.sourceInfo.path));
		const c = { cwd: ctx.cwd, extensions: [...new Set([...enabled, ...registered])] };

		let rules: Rule[];
		try {
			// The query string skips the module cache, so edits are picked up.
			rules = (await import(`${pathToFileURL(rulesFile).href}?t=${Date.now()}`)).default;
		} catch (e) {
			ctx.ui.notify(`companion-prompts: ${rulesFile}: ${(e as Error).message}`, "error");
			return;
		}
		for (const { file, when } of rules) {
			try {
				if (when(c)) sections[`companion_${file.replace(/\.md$/, "")}`] = readFileSync(join(dir, file), "utf8").trim();
			} catch (e) {
				ctx.ui.notify(`companion-prompts: ${file}: ${(e as Error).message}`, "error");
			}
		}
	});

	pi.on("before_agent_start", (event) => {
		Object.assign(event.systemPromptOptions.sections, sections);
	});
}
