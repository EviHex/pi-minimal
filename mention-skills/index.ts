import { readFileSync } from "node:fs";
import { type ExtensionAPI, getMarkdownTheme, keyHint, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { Box, fuzzyFilter, Markdown, Text } from "@earendil-works/pi-tui";

const PROMPT =
	"When the user writes `$name (skill: path)` or `$name (prompt: path)`, they chose that skill or prompt template. Read the file before you act, unless you already read it or its content is attached, and follow it.";

const MENTION = /(^|[\s([{<])\$([\w-]+)/g;
// Attached file content is a custom message of this type: saved in the session, sent to the LLM, shown in the chat.
const ATTACHMENT = "mention-skills";

type Kind = "skill" | "prompt";
type Target = { kind: Kind; path: string; description?: string };
type Attached = { kind: Kind; name: string }[];
type Settings = { disableSkillCommands?: boolean; inlineSkills?: boolean; inlinePrompts?: boolean };

export default function mentionSkills(pi: ExtensionAPI) {
	let settings: Settings = {};
	let names = new Map<string, Target>();

	const shouldInline = (kind: Kind) => (kind === "skill" ? settings.inlineSkills : settings.inlinePrompts) === true;

	const readBody = (path: string) => {
		try {
			return stripFrontmatter(readFileSync(path, "utf-8")).trim();
		} catch {
			return undefined; // Unreadable: the path alone still works.
		}
	};

	// Adds the file path next to each known $name. Unknown names ($HOME, $1) stay as they are.
	const annotate = (text: string) =>
		text.replace(MENTION, (all, lead: string, name: string) => {
			const target = names.get(name);
			return target ? `${lead}$${name} (${target.kind}: ${target.path})` : all;
		});

	pi.on("session_start", (_event, ctx) => {
		const all = pi.getSettings() as { "pi-minimal"?: { "mention-skills"?: Settings } };
		settings = all["pi-minimal"]?.["mention-skills"] ?? {};
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
					if (settings.disableSkillCommands !== true || !result?.prefix.startsWith("/")) return result;
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

	pi.registerMessageRenderer<Attached>(ATTACHMENT, (message, { expanded }, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		if (expanded && typeof message.content === "string") {
			// The tags are for the LLM. On screen, an opening tag becomes a heading and a closing tag goes away.
			const markdown = message.content
				.replace(/^<(skill|prompt) name="([^"]+)".*>$/gm, "**[$1] $2**")
				.replace(/^<\/(skill|prompt)>$/gm, "");
			box.addChild(new Markdown(markdown, 0, 0, getMarkdownTheme()));
			return box;
		}
		const labels = (message.details ?? []).map(({ kind, name }) => `${theme.fg("customMessageLabel", theme.bold(`[${kind}]`))} ${name}`);
		box.addChild(new Text(`${labels.join("  ")} (${keyHint("app.tools.expand", "to expand")})`, 0, 0));
		return box;
	});

	pi.on("before_agent_start", (event, ctx) => {
		// Fixed text, so the prompt cache stays valid.
		event.systemPromptOptions.sections.mention_skills = PROMPT;
		if (event.messageType !== "user") return;

		// Skip names whose content is still in the context (an attachment before the last compaction is gone).
		const inContext = new Set<string>();
		for (const entry of ctx.sessionManager.buildContextEntries())
			if (entry.type === "custom_message" && entry.customType === ATTACHMENT)
				for (const { name } of entry.details as Attached) inContext.add(name);

		const attached: Attached = [];
		const blocks: string[] = [];
		for (const [, , name] of event.prompt.matchAll(MENTION)) {
			const target = names.get(name);
			if (!target || !shouldInline(target.kind) || inContext.has(name)) continue;
			inContext.add(name);
			const body = readBody(target.path);
			if (body === undefined) continue;
			attached.push({ kind: target.kind, name });
			blocks.push(`<${target.kind} name="${name}" location="${target.path}">\n${body}\n</${target.kind}>`);
		}
		if (blocks.length > 0) return { message: { customType: ATTACHMENT, content: blocks.join("\n\n"), display: true, details: attached } };
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
