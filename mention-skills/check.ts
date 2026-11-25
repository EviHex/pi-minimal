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
function session(settings: object, extra: object[] = [], hostItems: object[] = []) {
	const handlers: Record<string, Function> = {};
	let factory: Function | undefined;
	mentionSkills({
		on: (event: string, handler: Function) => (handlers[event] = handler),
		registerMessageRenderer() {},
		getSettings: () => ({ "pi-minimal": { "mention-skills": settings } }),
		getCommands: () => [
			{ name: "skill:jj", source: "skill", sourceInfo: { path: skill } },
			{ name: "vocab", source: "prompt", sourceInfo: { path: prompt } },
			{ name: "gone", source: "prompt", sourceInfo: { path: missing } },
			...extra,
		],
	} as any);
	handlers.session_start({}, { ui: { addAutocompleteProvider: (f: Function) => (factory = f) } });
	// The provider wraps a fake host provider that answers `/` with these items and records its calls.
	const calls: string[] = [];
	const host = {
		triggerCharacters: ["/"],
		getSuggestions: async (lines: string[], _l: number, col: number) => {
			calls.push("get");
			return { items: hostItems, prefix: lines[0].slice(0, col) };
		},
		applyCompletion: () => (calls.push("apply"), { lines: ["host"], cursorLine: 0, cursorCol: 0 }),
	};
	return {
		provider: factory!(host),
		calls,
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

// A skill wins a name clash, whatever the order of the commands.
const clash = { name: "skill:jj", source: "skill", sourceInfo: { path: skill } };
const rival = { name: "jj", source: "prompt", sourceInfo: { path: prompt } };
for (const extra of [[clash, rival], [rival, clash]]) assert.equal(session({}, extra).context("$jj"), `$jj (skill: ${skill})`);

// A custom message without details does not break the attachment check.
const bare = { type: "custom_message", customType: "mention-skills" };
assert.equal(both.attach(text, [bare]).content, `${skillBlock}\n\n${promptBlock}`);

// Autocomplete provider.
const slash = [{ value: "skill:jj" }, { value: "help" }];
const open = session({}, [], slash).provider;
const off = session({ disableSkillCommands: true }, [], slash).provider;
const suggest = (p: any, line: string) => p.getSuggestions([line], 0, line.length, {});
assert.ok(open.triggerCharacters.includes("$") && open.triggerCharacters.includes("/"));
assert.deepEqual((await suggest(open, "use $j")).items.map((i: any) => i.value), ["$jj"]);
assert.equal((await suggest(open, "use $j")).prefix, "$j");
assert.equal(await suggest(open, "use $zzz"), null);
assert.equal((await suggest(open, "/")).items.length, 2);
assert.deepEqual((await suggest(off, "/")).items, [{ value: "help" }]);
const plain = session({}, [], [{ value: "x" }]);
assert.equal((await suggest(plain.provider, "src/a")).items.length, 1);
assert.deepEqual(plain.calls, ["get"]); // a non-$ prefix goes to the host
const applied = open.applyCompletion(["use $j more"], 0, 6, { value: "$jj" }, "$j");
assert.deepEqual(applied, { lines: ["use $jj  more"], cursorLine: 0, cursorCol: 8 });
assert.equal(open.applyCompletion(["a"], 0, 1, { value: "b" }, "a").lines[0], "host");
console.log("mention-skills check: passed");
