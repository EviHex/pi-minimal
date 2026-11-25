import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { enabledMcpServers, evaluateRules, type RuleContext } from "./evaluate.ts";
import { DefaultPackageManager, SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Identity of an extension. Auto-discovered ones all have the source "auto", so use their path.
const extensionId = (source: string, path: string) => (source === "auto" ? path : source);

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const promptsDir = join(agentDir, "dynamic-prompt");
	const rulesFile = join(promptsDir, "rules.ts");
	// System prompt sections of the matching rules: section name -> prompt text.
	let matchedSections: Record<string, string> = {};
	// Always on, so the agent can find and edit the rules. Not "dynamic_prompt_*": that would clash with a rule name.
	const readme = join(dirname(fileURLToPath(import.meta.url)), "README.md");
	const intro = `dynamic_prompt_* sections are conditional prompts from ${rulesFile}. To edit them, read ${readme} first.`;

	// cwd and the loaded extensions change only with a new session or /reload, so evaluate the rules once here.
	pi.on("session_start", async (_event, ctx) => {
		matchedSections = {};
		if (!existsSync(rulesFile)) return;

		// Extensions enabled in the pi config (same logic as `pi config`), including hook-only ones.
		let enabledIds: string[] = [];
		try {
			const packageManager = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager: SettingsManager.create(ctx.cwd, agentDir) });
			const { extensions } = await packageManager.resolve(async () => "skip");
			enabledIds = extensions.filter((ext) => ext.enabled).map((ext) => extensionId(ext.metadata.source, ext.path));
		} catch (error) {
			// Rules on cwd and on registered extensions still work.
			ctx.ui.notify(`dynamic-prompt: cannot read the pi config, c.extensions is incomplete: ${(error as Error).message}`, "error");
		}
		// Extensions that registered a tool or command. This also covers `-e <path>`, which the config does not list.
		const registeredIds = [...pi.getAllTools(), ...pi.getCommands()].map(({ sourceInfo }) => extensionId(sourceInfo.source, sourceInfo.path));
		const context: RuleContext = {
			cwd: ctx.cwd,
			extensions: [...new Set([...enabledIds, ...registeredIds])],
			mcpServers: enabledMcpServers(agentDir, ctx.cwd, ctx.isProjectTrusted()),
		};

		let rules: unknown;
		try {
			// The query string skips the module cache, so edits to rules.ts are picked up.
			rules = (await import(`${pathToFileURL(rulesFile).href}?t=${Date.now()}`)).default;
		} catch (error) {
			ctx.ui.notify(`dynamic-prompt: ${rulesFile}: ${(error as Error).message}`, "error");
			return;
		}

		const result = evaluateRules(rules, context, promptsDir);
		matchedSections = result.sections;
		for (const error of result.errors) ctx.ui.notify(`dynamic-prompt: ${error}`, "error");
	});

	// Add the cached sections to the system prompt of every run.
	pi.on("before_agent_start", (event) => {
		Object.assign(event.systemPromptOptions.sections, { "dynamic-prompt": intro }, matchedSections);
	});
}
