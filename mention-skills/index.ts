import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

const PROMPT =
	"When the user writes `$name (skill: path)` or `$name (prompt: path)`, they chose that skill or prompt template. Read the file before you act, unless you already read it, and follow it.";

type Target = { kind: "skill" | "prompt"; path: string; description?: string };

export default function (pi: ExtensionAPI) {
	let disableSkillCommands = false;
	let names = new Map<string, Target>();

	// Adds the file path next to each known $name. Unknown names ($HOME, $1) stay as they are.
	const annotate = (text: string) =>
		text.replace(/(^|[\s([{<])\$([\w-]+)/g, (all, lead: string, name: string) => {
			const target = names.get(name);
			return target ? `${lead}$${name} (${target.kind}: ${target.path})` : all;
		});

	pi.on("session_start", (_event, ctx) => {
		const settings = pi.getSettings() as { "pi-minimal"?: { "mention-skills"?: { disableSkillCommands?: boolean } } };
		disableSkillCommands = settings["pi-minimal"]?.["mention-skills"]?.disableSkillCommands === true;
		names = new Map();
		const commands = pi.getCommands();
		// Prompts first, then skills, so a skill wins on a name clash.
		for (const c of commands)
			if (c.source === "prompt") names.set(c.name, { kind: "prompt", path: c.sourceInfo.path, description: c.description });
		for (const c of commands)
			if (c.source === "skill")
				names.set(c.name.slice("skill:".length), { kind: "skill", path: c.sourceInfo.path, description: c.description });

		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: [...(current.triggerCharacters ?? []), "$"],
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const match = (lines[cursorLine] ?? "").slice(0, cursorCol).match(/(?:^|[\s([{<])\$([\w-]*)$/);
				if (!match) {
					const result = await current.getSuggestions(lines, cursorLine, cursorCol, options);
					if (!disableSkillCommands || !result?.prefix.startsWith("/")) return result;
					// Hide /skill:* from the slash menu; $ still lists skills.
					const items = result.items.filter((item) => !item.value.startsWith("skill:"));
					return items.length > 0 ? { ...result, items } : null;
				}
				const items = [...names].map(([name, t]) => ({
					value: `$${name}`,
					label: `$${name}`,
					description: `${t.kind}${t.description ? ` · ${t.description}` : ""}`,
				}));
				const hits = fuzzyFilter(items, match[1], (item) => item.value.slice(1));
				return hits.length > 0 ? { items: hits, prefix: `$${match[1]}` } : null;
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				if (!prefix.startsWith("$")) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				const line = lines[cursorLine] ?? "";
				const before = line.slice(0, cursorCol - prefix.length) + item.value + " ";
				const next = [...lines];
				next[cursorLine] = before + line.slice(cursorCol);
				return { lines: next, cursorLine, cursorCol: before.length };
			},
			shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
				current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true,
		}));
	});

	// Fixed text, so the prompt cache stays valid.
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.mention_skills = PROMPT;
	});

	// Runs on a copy of the whole history before each LLM call. The session and the UI keep the short `$name`.
	pi.on("context", (event) => {
		for (const message of event.messages) {
			if (message.role !== "user") continue;
			if (typeof message.content === "string") message.content = annotate(message.content);
			else for (const block of message.content) if (block.type === "text") block.text = annotate(block.text);
		}
		return { messages: event.messages };
	});
}
