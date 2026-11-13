import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "./index.ts";

type Handler = (event: object, ctx: object) => unknown;
/** What a tool_result handler returns when it changes the result. */
type Patched = { content?: { text: string }[]; details?: { nestedContext?: string[] } } | undefined;
/** A tool result as pi stores it in the session. */
type Message = { role: "toolResult"; content: unknown[]; details?: unknown };
/** Event fields a test can set. */
type Extra = { toolCallId?: string; parentToolCallId?: string; isError?: boolean };

/**
 * A fake pi: collects the handlers, then calls them like pi would. cwd is a temp directory
 * reached through a symlink, so tests fail if a path is compared before it is made real.
 * `agentDir`, relative to cwd, is set as pi's agent dir before the extension loads.
 *
 * `history` plays the session: every top-level result is stored in it, with the content and
 * details the extension returned. Tests edit it to play /tree and compaction.
 */
function setup(agentDir?: string) {
	const dir = mkdtempSync(join(tmpdir(), "nested-context-"));
	const cwd = `${dir}-link`;
	symlinkSync(dir, cwd);
	if (agentDir) mkdirSync(join(cwd, agentDir)); // It always exists in real pi.

	let history: Message[] = [];
	const notes: string[] = [];
	const ctx = {
		cwd,
		ui: { notify: (message: string) => notes.push(message) },
		sessionManager: { buildSessionProjection: () => ({ messages: history }) },
	};

	let handlers: Record<string, Handler> = {};
	/** Load a new extension instance and start a session, like pi does on /new, /resume and /reload. */
	const restart = () => {
		handlers = {};
		if (agentDir) process.env.PI_CODING_AGENT_DIR = join(cwd, agentDir);
		extension({ on: (name: string, fn: Handler) => (handlers[name] = fn) } as never);
		delete process.env.PI_CODING_AGENT_DIR;
		handlers.session_start({}, ctx);
	};
	restart();

	let id = 0;
	/**
	 * Fire a tool_result like pi does after a tool call. `extra` overrides event fields. A nested
	 * call (`parentToolCallId`) gets the id `<parent>/<n>`, like pi gives it.
	 */
	const call = (toolName: string, path: string, extra: Extra = {}) => {
		const toolCallId = extra.parentToolCallId ? `${extra.parentToolCallId}/${++id}` : `call${++id}`;
		const event = { toolName, toolCallId, input: { path }, content: [{ type: "text", text: "ok" }], isError: false, ...extra };
		const result = handlers.tool_result(event, ctx) as Patched;
		if (!extra.parentToolCallId) history.push({ role: "toolResult", content: result?.content ?? event.content, details: result?.details });
		return result;
	};
	/** Only the text added to the result (block 2), or `undefined` if nothing was added. */
	const added = (toolName: string, path: string, extra?: Extra) =>
		call(toolName, path, extra)?.content?.[1]?.text;
	/** Create a file (and its directories) under cwd. */
	const file = (path: string, text: string) => {
		mkdirSync(join(cwd, path, ".."), { recursive: true });
		writeFileSync(join(cwd, path), text);
	};
	/** Fire a session event, with `messages` as what the model sees now. */
	const emit = (name: "session_compact" | "session_tree", messages: Message[]) => {
		history = messages;
		handlers[name]({}, ctx);
	};

	return { cwd, notes, file, call, added, emit, restart, history: () => [...history] };
}

test("injects the chain root-most first, skips cwd, and only once", () => {
	const t = setup();
	t.file("AGENTS.md", "ROOT");
	t.file("a/AGENTS.md", "A");
	t.file("a/b/AGENTS.md", "B");
	t.file("a/b/x.ts", "");
	t.file("a/b/y.ts", "");
	const text = t.added("read", "a/b/x.ts")!;
	assert.match(text, /path="a\/AGENTS.md" scope="a\/">\nA\n/);
	assert.ok(text.indexOf("\nA\n") < text.indexOf("\nB\n"));
	assert.doesNotMatch(text, /ROOT/);
	assert.equal(t.added("read", "a/b/y.ts"), undefined);
	// An absolute path written with the symlinked spelling of cwd works too.
	t.file("c/AGENTS.md", "C");
	t.file("c/x.ts", "");
	assert.match(t.added("read", join(t.cwd, "c/x.ts"))!, /\nC\n/);
});

test("AGENTS.md wins over CLAUDE.md; CLAUDE.md is used alone", () => {
	const t = setup();
	t.file("a/AGENTS.md", "AG");
	t.file("a/CLAUDE.md", "CL");
	t.file("b/CLAUDE.md", "CL-B");
	t.file("a/x", "");
	t.file("b/x", "");
	const a = t.added("read", "a/x")!;
	assert.match(a, /AG/);
	assert.doesNotMatch(a, /CL/);
	assert.match(t.added("read", "b/x")!, /CL-B/);
});

test("reading the file itself adds no copy, now or later, and is marked", () => {
	const t = setup();
	t.file("a/AGENTS.md", "A");
	t.file("a/x", "");
	const result = t.call("read", "a/AGENTS.md");
	assert.equal(result?.content, undefined);
	assert.equal(result?.details?.nestedContext?.length, 1);
	assert.equal(t.added("read", "a/x"), undefined);
});

test("ignores symlinks that leave the project or point at the root file", () => {
	const t = setup();
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
	writeFileSync(join(outside, "secret.md"), "SECRET");
	t.file("AGENTS.md", "ROOT");
	t.file("a/x", "");
	symlinkSync(join(outside, "secret.md"), join(t.cwd, "a/AGENTS.md"));
	t.file("b/x", "");
	symlinkSync(join(t.cwd, "AGENTS.md"), join(t.cwd, "b/CLAUDE.md"));
	assert.equal(t.call("read", "a/x"), undefined);
	assert.equal(t.call("read", "b/x"), undefined);
	t.file("c/x", "");
	symlinkSync(join(outside, "secret.md"), join(t.cwd, "c/AGENTS.md"));
	t.file("c/CLAUDE.md", "FALLBACK");
	assert.match(t.added("read", "c/x")!, /FALLBACK/);
});

test("paths outside cwd do nothing", () => {
	const t = setup();
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-")));
	writeFileSync(join(outside, "AGENTS.md"), "OUT");
	assert.equal(t.call("read", join(outside, "x")), undefined);
	assert.equal(t.call("read", "../../etc/passwd"), undefined);
});

test("a big file is cut, with a note", () => {
	const t = setup();
	t.file("a/AGENTS.md", `${"x".repeat(32_000)}TAIL`);
	t.file("a/x", "");
	const text = t.added("read", "a/x")!;
	assert.match(text, /x\n\[truncated/);
	assert.doesNotMatch(text, /TAIL/);
});

test("failed calls and other tools are left alone and do not use up the file", () => {
	const t = setup();
	t.file("a/AGENTS.md", "A");
	t.file("a/x", "");
	assert.equal(t.call("read", "a/x", { isError: true }), undefined);
	assert.equal(t.call("bash", "a/x"), undefined);
	assert.ok(t.added("read", "a/x"));
});

test("skips node_modules", () => {
	const t = setup();
	t.file("node_modules/pkg/AGENTS.md", "PERSONA");
	t.file("node_modules/pkg/index.js", "");
	assert.equal(t.call("read", "node_modules/pkg/index.js"), undefined);
});

test("accepts @path and ~/path like pi's tools", () => {
	const t = setup();
	t.file("a/AGENTS.md", "A");
	t.file("a/x", "");
	t.file("b/AGENTS.md", "B");
	t.file("b/x", "");
	assert.match(t.added("read", "@a/x")!, /\nA\n/);
	const home = process.env.HOME;
	process.env.HOME = t.cwd; // homedir() reads HOME.
	try {
		assert.match(t.added("read", "~/b/x")!, /\nB\n/);
	} finally {
		process.env.HOME = home;
	}
});

test("skips the agent dir: pi loaded its AGENTS.md at startup", () => {
	const t = setup("agent");
	t.file("agent/AGENTS.md", "GLOBAL");
	t.file("agent/settings.json", "{}");
	assert.equal(t.call("read", "agent/settings.json"), undefined);
});

test("/tree and compaction: inject again only if the model no longer sees the file", () => {
	const t = setup();
	t.file("a/AGENTS.md", "A");
	t.file("a/x", "");
	assert.ok(t.added("read", "a/x"));
	const withFile = t.history();

	t.emit("session_tree", []); // A branch that never read a/.
	assert.ok(t.added("read", "a/x"));
	t.emit("session_tree", withFile); // Back to a branch that has it.
	assert.equal(t.added("read", "a/x"), undefined);

	t.emit("session_compact", []); // Compaction dropped the old results.
	assert.ok(t.added("read", "a/x"));
	t.emit("session_compact", withFile); // Compaction kept them.
	assert.equal(t.added("read", "a/x"), undefined);
});

test("/resume: a new runtime on an old session does not inject again", () => {
	const t = setup();
	t.file("a/AGENTS.md", "A");
	t.file("a/x", "");
	assert.ok(t.added("read", "a/x"));
	t.restart();
	assert.equal(t.added("read", "a/x"), undefined);
});

test("codemode: nested reads reach the model through the outer result", () => {
	const t = setup();
	t.file("a/AGENTS.md", "A");
	t.file("a/x", "");
	t.file("a/y", "");
	t.file("b/AGENTS.md", "B");
	// The script reads two files of a/ and the instruction file of b/ itself.
	assert.equal(t.call("read", "a/x", { parentToolCallId: "outer" }), undefined);
	assert.equal(t.call("read", "a/y", { parentToolCallId: "outer" }), undefined);
	assert.equal(t.call("read", "b/AGENTS.md", { parentToolCallId: "outer" }), undefined);
	// The outer codemode result reaches the model, even when the script failed afterwards.
	const result = t.call("codemode", "", { toolCallId: "outer", isError: true });
	const text = result?.content?.[1]?.text ?? "";
	assert.equal(text.match(/\nA\n/g)?.length, 1);
	assert.match(text, /\nB\n/);
	assert.equal(result?.details?.nestedContext?.length, 2);
	assert.equal(t.added("read", "a/x"), undefined);
});

test("a file that cannot be read: the user and the model are told, once", () => {
	const t = setup();
	t.file("a/AGENTS.md", "A");
	t.file("a/x", "");
	chmodSync(join(t.cwd, "a/AGENTS.md"), 0);
	assert.match(t.added("read", "a/x")!, /"a\/AGENTS.md" has rules for "a\/", but reading it failed \(EACCES\)/);
	assert.match(t.notes[0], /did not get the rules of a\/AGENTS.md/);
	assert.equal(t.added("read", "a/x"), undefined);
	// Not marked as seen in the session: after /reload it is tried again.
	t.restart();
	chmodSync(join(t.cwd, "a/AGENTS.md"), 0o644);
	assert.ok(t.added("read", "a/x"));
});
