import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	DEFAULT_SETTINGS,
	ENTRY_TYPE,
	formatSummary,
	parseItems,
	parseTodoSettings,
	renderLines,
	replay,
	type Style,
	type TodoItem,
	writeTodoSettings,
} from "./core.ts";
import { CLEAR_NOTICE, formatReminder, PROMPT_GUIDELINES, todoCompletions, TOOL_DESCRIPTION } from "./prompts.ts";

// Each color wraps its text in a tag, so tests can see which color a part gets.
const tag = (name: string) => (s: string) => `<${name}>${s}</${name}>`;
const tagged: Style = { accent: tag("a"), dim: tag("d"), muted: tag("m"), warning: tag("w"), borderMuted: tag("b") };
const plain: Style = { accent: (s) => s, dim: (s) => s, muted: (s) => s, warning: (s) => s, borderMuted: (s) => s };

const item = (text: string, status: TodoItem["status"]): TodoItem => ({ text, status });
const four = [item("Read code", "done"), item("Write tests", "in_progress"), item("Run check", "pending"), item("Ship", "pending")];

describe("parseItems", () => {
	it("strips terminal control sequences and keeps the case of the text", () => {
		assert.deepEqual(
			parseItems([
				{ text: "\x1b[31mRead\x1b[0m\tcode\nnow", status: "done" },
				{ text: "Write \u202eTests", status: "in_progress" },
				{ text: "  Ship IT  ", status: "pending" },
			]),
			[item("Read code now", "done"), item("Write Tests", "in_progress"), item("Ship IT", "pending")],
		);
	});

	it("drops blank or malformed items and non-arrays", () => {
		assert.deepEqual(parseItems(null), []);
		assert.deepEqual(parseItems("bad"), []);
		assert.deepEqual(
			parseItems([null, { text: "  ", status: "pending" }, { text: "x", status: "deleted" }, { text: 1, status: "pending" }, { text: "ok", status: "pending" }]),
			[item("ok", "pending")],
		);
	});

	it("keeps at most one in_progress", () => {
		assert.deepEqual(parseItems([item("a", "in_progress"), item("b", "in_progress")]), [item("a", "in_progress"), item("b", "pending")]);
	});
});

describe("replay", () => {
	it("returns the latest valid snapshot as a copy, skipping corrupt and unrelated entries", () => {
		const branch = [
			null,
			{ type: "message", customType: ENTRY_TYPE, data: [item("wrong type", "done")] },
			{ type: "custom", customType: ENTRY_TYPE, data: [item("old", "pending")] },
			{ type: "custom", customType: "other", data: [item("ignore", "done")] },
			{ type: "custom", customType: ENTRY_TYPE, data: [item("x", "done")] },
			{ type: "custom", customType: ENTRY_TYPE, data: "corrupt" },
			{ type: "custom", customType: ENTRY_TYPE, data: [item("  ", "pending")] },
			{ type: "custom", customType: ENTRY_TYPE, data: [{ text: "bad", status: "nope" }] },
		];
		const state = replay(branch);
		assert.deepEqual(state, [item("x", "done")]);
		state[0].text = "mutated";
		assert.equal((branch[4]?.data as TodoItem[])[0].text, "x");
	});

	it("an empty snapshot clears the list; no snapshot gives an empty list", () => {
		assert.deepEqual(replay([]), []);
		assert.deepEqual(replay([{ type: "custom", customType: ENTRY_TYPE, data: [item("a", "pending")] }, { type: "custom", customType: ENTRY_TYPE, data: [] }]), []);
	});
});

describe("formatSummary", () => {
	it("echoes progress, the active item and the next one", () => {
		assert.equal(formatSummary(four), '1/4 done · active: "Write tests" · next: "Run check"');
	});
	it("omits missing parts", () => {
		assert.equal(formatSummary([item("a", "done"), item("b", "pending")]), '1/2 done · next: "b"');
		assert.equal(formatSummary([item("a", "done"), item("b", "in_progress")]), '1/2 done · active: "b"');
		assert.equal(formatSummary([item("a", "pending")]), '0/1 done · next: "a"');
	});
	it("says when all is done or the list is empty", () => {
		assert.equal(formatSummary([item("a", "done"), item("b", "done")]), "2/2 done.");
		assert.equal(formatSummary([]), "Todo list cleared.");
	});
});

describe("renderLines", () => {
	it("hides an empty list", () => {
		assert.equal(renderLines([], false, plain), undefined);
		assert.equal(renderLines([], true, plain), undefined);
	});

	it("renders a tree with lowercase header and item text as written", () => {
		assert.deepEqual(renderLines(four, false, plain), ["● todos (1/4)", "├─ ✓ Read code", "├─ ◐ Write tests", "├─ ○ Run check", "└─ ○ Ship"]);
	});

	it("colors the parts of the tree", () => {
		assert.deepEqual(renderLines([item("Read", "done"), item("Write", "in_progress"), item("Run", "pending")], false, tagged), [
			"<a>●</a> <m>todos (1/3)</m>",
			"<b>├─ </b><d>✓ Read</d>",
			"<b>├─ </b><w>◐</w> Write",
			"<b>└─ </b><m>○</m> Run",
		]);
	});

	it("dims the whole header when all items are done", () => {
		assert.deepEqual(renderLines([item("a", "done")], false, tagged), ["<d>○ todos (1/1)</d>", "<b>└─ </b><d>✓ a</d>"]);
	});

	it("minimized: one line with the active item", () => {
		assert.deepEqual(renderLines(four, true, plain), ["● todos (1/4) › ◐ Write tests"]);
		assert.deepEqual(renderLines(four, true, tagged), ["<a>●</a> <m>todos (1/4)</m> <d>›</d> <w>◐</w> Write tests"]);
	});

	it("minimized: pending count without an active item, and `all done`", () => {
		assert.deepEqual(renderLines([item("a", "done"), item("B", "pending"), item("C", "pending")], true, plain), ["● todos (1/3) › 2 pending"]);
		assert.deepEqual(renderLines([item("a", "done")], true, plain), ["○ todos (1/1) › all done"]);
		assert.deepEqual(renderLines([item("a", "done")], true, tagged), ["<d>○ todos (1/1)</d> <d>›</d> <d>all done</d>"]);
	});

	it("uses lowercase fixed words only: no capitalized label in any mode", () => {
		const all = [...(renderLines(four, false, plain) ?? []), ...(renderLines(four, true, plain) ?? []), ...(renderLines([item("a", "pending")], true, plain) ?? [])].join("\n");
		assert.ok(!/Todos|Pending|All done/.test(all));
		assert.match(all, /todos/);
	});
});

describe("settings", () => {
	it("parses with defaults and rejects bad values", () => {
		assert.deepEqual(parseTodoSettings(undefined), DEFAULT_SETTINGS);
		assert.deepEqual(parseTodoSettings({ defaultMinimized: true, hideCompletedOnNextTurn: false, reminderInterval: 0 }), {
			defaultMinimized: true,
			hideCompletedOnNextTurn: false,
			reminderInterval: 0,
		});
		assert.deepEqual(parseTodoSettings({ defaultMinimized: "yes", hideCompletedOnNextTurn: 1, reminderInterval: -1 }), DEFAULT_SETTINGS);
		assert.equal(parseTodoSettings({ reminderInterval: 2.5 }).reminderInterval, DEFAULT_SETTINGS.reminderInterval);
	});

	it("writes under pi-minimal.todo without disturbing other settings", () => {
		const file = join(mkdtempSync(join(tmpdir(), "todo-")), "sub", "settings.json");
		writeTodoSettings(file, { reminderInterval: 5 });
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "pi-minimal": { todo: { reminderInterval: 5 } } });
		writeFileSync(file, JSON.stringify({ theme: "dark", "pi-minimal": { subagents: { guidance: "x" }, todo: { defaultMinimized: true } } }));
		writeTodoSettings(file, { reminderInterval: 12 });
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
			theme: "dark",
			"pi-minimal": { subagents: { guidance: "x" }, todo: { defaultMinimized: true, reminderInterval: 12 } },
		});
	});

	it("recovers from a corrupt settings file", () => {
		const file = join(mkdtempSync(join(tmpdir(), "todo-")), "settings.json");
		writeFileSync(file, "{not json");
		writeTodoSettings(file, { defaultMinimized: true });
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "pi-minimal": { todo: { defaultMinimized: true } } });
	});
});

describe("prompts", () => {
	it("formats a one-line reminder", () => {
		assert.equal(formatReminder(four), '[todo: 1/4 done, active: "Write tests" — call todo if progress changed.]');
		assert.equal(formatReminder([item("a", "pending")]), "[todo: 0/1 done — call todo if progress changed.]");
	});

	it("keeps static text short and mentions the key rules", () => {
		assert.equal(PROMPT_GUIDELINES.length, 2);
		assert.match(PROMPT_GUIDELINES.join(" "), /3\+ steps/);
		assert.match(PROMPT_GUIDELINES.join(" "), /in_progress/);
		assert.match(TOOL_DESCRIPTION, /pass \[\] to clear/);
		assert.match(CLEAR_NOTICE, /\/todo clear/);
	});

	it("completes subcommands", () => {
		assert.deepEqual(todoCompletions("")?.map((c) => c.value), ["minimize", "clear", "settings"]);
		assert.deepEqual(todoCompletions("m")?.map((c) => c.value), ["minimize"]);
		assert.equal(todoCompletions("x"), null);
		assert.equal(todoCompletions("clear now"), null);
	});
});
