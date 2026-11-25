import { readFileSync } from "node:fs";
import { join } from "node:path";

// What a rule's `when` receives.
export type RuleContext = { cwd: string; extensions: string[]; mcpServers: string[] };
// One entry of the array that rules.ts exports. The prompt is a markdown file or an inline text.
export type Rule = { when: (context: RuleContext) => boolean } & ({ file: string } | { name: string; text: string });

// Names of the MCP servers enabled in mcp.json. A project entry overrides the user one with the same name.
export function enabledMcpServers(agentDir: string, cwd: string, projectTrusted: boolean): string[] {
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

// Section name -> prompt text of the matching rules. A broken rule is reported and skipped; the others still apply.
export function evaluateRules(rules: unknown, context: RuleContext, promptsDir: string): { sections: Record<string, string>; errors: string[] } {
	const sections: Record<string, string> = {};
	const errors: string[] = [];
	if (!Array.isArray(rules)) return { sections, errors: ["default export must be an array"] };
	for (const rule of rules as Rule[]) {
		const label = "file" in rule ? rule.file : rule.name;
		try {
			if (!rule.when(context)) continue;
			const [name, text] = "file" in rule ? [rule.file.replace(/\.md$/, ""), readFileSync(join(promptsDir, rule.file), "utf8")] : [rule.name, rule.text];
			if (!text.trim()) continue;
			const key = `dynamic_prompt_${name}`;
			if (key in sections) errors.push(`${label}: duplicate section ${key}; the last one wins`);
			sections[key] = text.trim();
		} catch (error) {
			errors.push(`${label}: ${(error as Error).message}`);
		}
	}
	return { sections, errors };
}
