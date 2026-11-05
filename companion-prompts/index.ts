import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultPackageManager, SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// What a rule's `when` receives.
type RuleContext = { cwd: string; extensions: string[] };
// One entry of the array that rules.ts exports.
type Rule = { file: string; when: (context: RuleContext) => boolean };

// Identity of an extension. Auto-discovered ones all have the source "auto", so use their path.
const extensionId = (source: string, path: string) => (source === "auto" ? path : source);

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const promptsDir = join(agentDir, "companion-prompts");
	const rulesFile = join(promptsDir, "rules.ts");
	// System prompt sections of the matching rules: section name -> prompt text.
	let matchedSections: Record<string, string> = {};

	// cwd and the loaded extensions change only with a new session or /reload, so evaluate the rules once here.
	pi.on("session_start", async (_event, ctx) => {
		matchedSections = {};
		if (!existsSync(rulesFile)) return;

		// Extensions enabled in the pi config (same logic as `pi config`), including hook-only ones.
		const packageManager = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager: SettingsManager.create(ctx.cwd, agentDir) });
		const { extensions } = await packageManager.resolve(async () => "skip");
		const enabledIds = extensions.filter((ext) => ext.enabled).map((ext) => extensionId(ext.metadata.source, ext.path));
		// Extensions that registered a tool or command. This also covers `-e <path>`, which the config does not list.
		const registeredIds = [...pi.getAllTools(), ...pi.getCommands()].map(({ sourceInfo }) => extensionId(sourceInfo.source, sourceInfo.path));
		const context: RuleContext = { cwd: ctx.cwd, extensions: [...new Set([...enabledIds, ...registeredIds])] };

		let rules: Rule[];
		try {
			// The query string skips the module cache, so edits to rules.ts are picked up.
			rules = (await import(`${pathToFileURL(rulesFile).href}?t=${Date.now()}`)).default;
		} catch (error) {
			ctx.ui.notify(`companion-prompts: ${rulesFile}: ${(error as Error).message}`, "error");
			return;
		}

		// A broken rule is reported and skipped; the other rules still apply.
		for (const { file, when } of rules) {
			try {
				if (!when(context)) continue;
				const sectionName = `companion_${file.replace(/\.md$/, "")}`;
				matchedSections[sectionName] = readFileSync(join(promptsDir, file), "utf8").trim();
			} catch (error) {
				ctx.ui.notify(`companion-prompts: ${file}: ${(error as Error).message}`, "error");
			}
		}
	});

	// Add the cached sections to the system prompt of every run.
	pi.on("before_agent_start", (event) => {
		Object.assign(event.systemPromptOptions.sections, matchedSections);
	});
}
