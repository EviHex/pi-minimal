import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Identity of an extension. Auto-discovered ones all have the source "auto", so use their path.
const idOf = (source: string, path: string) => (source === "auto" ? path : source);

// File format: optional "---" block with one line "extension: <id>", then the prompt text.
function parse(file: string): { id?: string; text: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(file);
	if (!m) return { text: file.trim() };
	return { id: /^extension:\s*(.+?)\s*$/m.exec(m[1])?.[1], text: m[2].trim() };
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const dir = join(agentDir, "companion-prompts");
	let prompts: { name: string; id: string; text: string }[] = [];
	let configured: string[] = []; // ids of the enabled extensions

	// Slow work once per session (and on /reload).
	pi.on("session_start", async (_event, ctx) => {
		const pm = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager: SettingsManager.create(ctx.cwd, agentDir) });
		const { extensions } = await pm.resolve(async () => "skip");
		configured = [...new Set(extensions.filter((e) => e.enabled).map((e) => idOf(e.metadata.source, e.path)))];

		mkdirSync(dir, { recursive: true });
		prompts = [];
		for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
			const { id, text } = parse(readFileSync(join(dir, file), "utf8"));
			if (id) prompts.push({ name: file.slice(0, -3), id, text });
		}

		// A stub for each enabled extension that has no file yet, so you see what to fill in.
		for (const id of configured) {
			if (prompts.some((p) => p.id === id)) continue;
			const slug = id.replace(`${agentDir}/`, "").replace(/^npm:/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
			const path = join(dir, `${slug}.md`);
			if (!existsSync(path)) writeFileSync(path, `---\nextension: ${id}\n---\n`);
		}
	});

	// Fast work every run. pi diffs a section into the transcript only when its text changes.
	pi.on("before_agent_start", (event) => {
		// Also count extensions that registered a tool or command (covers `-e <path>`).
		const registered = [...pi.getAllTools(), ...pi.getCommands()].map((x) => idOf(x.sourceInfo.source, x.sourceInfo.path));
		const loaded = new Set([...configured, ...registered]);
		for (const { name, id, text } of prompts) {
			if (text && loaded.has(id)) event.systemPromptOptions.sections[`companion_${name}`] = text;
		}
	});
}
