// Self-check: `node check.ts` (run by `npm run check`).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mentionSkills from "./index.ts";

const dir = mkdtempSync(join(tmpdir(), "mention-skills-"));
const skill = join(dir, "SKILL.md");
const prompt = join(dir, "vocab.md");
const missing = join(dir, "missing.md");
writeFileSync(skill, "---\nname: jj\n---\nUse jj.\n");
writeFileSync(prompt, "Explain words.\n");

// Starts a session with these settings and returns its event handlers.
function session(settings: object) {
	const handlers: Record<string, Function> = {};
	mentionSkills({
		on: (event: string, handler: Function) => (handlers[event] = handler),
		registerMessageRenderer() {},
		getSettings: () => ({ "pi-minimal": { "mention-skills": settings } }),
		getCommands: () => [
			{ name: "skill:jj", source: "skill", sourceInfo: { path: skill } },
			{ name: "vocab", source: "prompt", sourceInfo: { path: prompt } },
			{ name: "gone", source: "prompt", sourceInfo: { path: missing } },
		],
	} as any);
	handlers.session_start({}, { ui: { addAutocompleteProvider() {} } });
	return {
		// The text the LLM sees for a user message.
		context: (text: string) => handlers.context({ messages: [{ role: "user", content: text }] }).messages[0].content,
		// The custom message attached to a prompt, given the entries already in the context.
		attach: (text: string, entries: object[] = []) =>
			handlers.before_agent_start(
				{ messageType: "user", prompt: text, systemPromptOptions: { sections: {} } },
				{ sessionManager: { buildContextEntries: () => entries } },
			)?.message,
	};
}

const skillBlock = `<skill name="jj" location="${skill}">\nUse jj.\n</skill>`;
const promptBlock = `<prompt name="vocab" location="${prompt}">\nExplain words.\n</prompt>`;
const text = "use $jj and $vocab, $HOME";

// The LLM always gets the paths; unknown names stay as they are.
assert.equal(session({}).context(text), `use $jj (skill: ${skill}) and $vocab (prompt: ${prompt}), $HOME`);
assert.equal(session({}).attach(text), undefined);

// Each setting attaches only its own kind.
assert.deepEqual(session({ inlineSkills: true }).attach(text), {
	customType: "mention-skills",
	content: skillBlock,
	display: true,
	details: [{ kind: "skill", name: "jj" }],
});
const both = session({ inlineSkills: true, inlinePrompts: true });
assert.equal(both.attach(`${text} $jj`).content, `${skillBlock}\n\n${promptBlock}`);

// Content already in the context is not attached again.
const earlier = { type: "custom_message", customType: "mention-skills", details: [{ kind: "skill", name: "jj" }] };
assert.equal(both.attach(text, [earlier]).content, promptBlock);

// An unreadable file keeps the path only.
assert.equal(session({ inlinePrompts: true }).attach("$gone"), undefined);
console.log("mention-skills check: passed");
