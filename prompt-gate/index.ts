import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DefaultPackageManager, SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// What a rule's `when` receives.
type RuleContext = { cwd: string; extensions: string[]; mcpServers: string[] };
// One entry of the array that rules.ts exports. The prompt is a markdown file or an inline text.
type Rule = { when: (context: RuleContext) => boolean } & ({ file: string } | { name: string; text: string });

// Identity of an extension. Auto-discovered ones all have the source "auto", so use their path.
const extensionId = (source: string, path: string) => (source === "auto" ? path : source);

// Names of the MCP servers enabled in mcp.json. A project entry overrides the user one with the same name.
function enabledMcpServers(agentDir: string, cwd: string, projectTrusted: boolean): string[] {
	const read = (file: string): Record<string, { enabled?: boolean }> => {
		try {
			return JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {};
		} catch {
			return {}; // Missing file. pi itself reports an invalid mcp.json.
		}
	};
	const servers = { ...read(join(agentDir, "mcp.json")) };
	if (projectTrusted) {
		for (const [name, config] of Object.entries(read(join(cwd, ".pi", "mcp.json")))) servers[name] = { ...servers[name], ...config };
	}
	return Object.keys(servers).filter((name) => servers[name].enabled !== false);
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const promptsDir = join(agentDir, "prompt-gate");
	const rulesFile = join(promptsDir, "rules.ts");
	// System prompt sections of the matching rules: section name -> prompt text.
	let matchedSections: Record<string, string> = {};
	// Always on, so the agent can find and edit the rules. Not "gate_*": that would clash with a rule name.
	const readme = join(dirname(fileURLToPath(import.meta.url)), "README.md");
	const intro = `gate_* sections are conditional prompts from ${rulesFile}. To edit them, read ${readme} first.`;

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
		const context: RuleContext = {
			cwd: ctx.cwd,
			extensions: [...new Set([...enabledIds, ...registeredIds])],
			mcpServers: enabledMcpServers(agentDir, ctx.cwd, ctx.isProjectTrusted()),
		};

		let rules: Rule[];
		try {
			// The query string skips the module cache, so edits to rules.ts are picked up.
			rules = (await import(`${pathToFileURL(rulesFile).href}?t=${Date.now()}`)).default;
		} catch (error) {
			ctx.ui.notify(`prompt-gate: ${rulesFile}: ${(error as Error).message}`, "error");
			return;
		}

		// A broken rule is reported and skipped; the other rules still apply.
		for (const rule of rules) {
			try {
				if (!rule.when(context)) continue;
				const [name, text] =
					"file" in rule ? [rule.file.replace(/\.md$/, ""), readFileSync(join(promptsDir, rule.file), "utf8")] : [rule.name, rule.text];
				matchedSections[`gate_${name}`] = text.trim();
			} catch (error) {
				ctx.ui.notify(`prompt-gate: ${"file" in rule ? rule.file : rule.name}: ${(error as Error).message}`, "error");
			}
		}
	});

	// Add the cached sections to the system prompt of every run.
	pi.on("before_agent_start", (event) => {
		Object.assign(event.systemPromptOptions.sections, { "prompt-gate": intro }, matchedSections);
	});
}
