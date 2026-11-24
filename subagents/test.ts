import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { apply, outcome, piInvocation, startChild } from "./child.ts";
import { dropForkDrift, forkBranch, forkFileText, sanitizeSessionText } from "./fork.ts";
import { childPrompt, parseSpawnArgs, resolveModel, resolveThinking, spawnCompletions, spawnNote, subagentsCompletions } from "./prompts.ts";
import { formatContext, headline, resultView, transcript, Viewer, widgetLines } from "./ui.ts";

// Minimal session entries: only the fields the code reads.
const user = (id: string, ts = 1) => ({ type: "message", id, message: { role: "user", content: "hi", timestamp: ts } });
const assistant = (id: string, calls: string[] = []) => ({
	type: "message",
	id,
	message: { role: "assistant", content: calls.map((c) => ({ type: "toolCall", id: c, name: "bash", arguments: {} })), timestamp: 1 },
});
const result = (id: string, call: string) => ({ type: "message", id, message: { role: "toolResult", toolCallId: call, content: [], timestamp: 1 } });
const branch = (...entries: object[]) => entries as never[];

test("forkBranch keeps a finished branch whole", () => {
	const b = branch(user("u1"), assistant("a1", ["c1"]), result("r1", "c1"), assistant("a2"));
	assert.deepEqual(forkBranch(b), b);
});

test("forkBranch cuts the running turn: the assistant message with an unanswered tool call", () => {
	const b = branch(user("u1"), assistant("a1", ["c1", "c2"]), result("r1", "c1"));
	assert.deepEqual(forkBranch(b).map((e: { id: string }) => e.id), ["u1"]);
});

test("forkBranch keeps a branch that ends with tool results (the next request is not sent yet)", () => {
	const b = branch(user("u1"), assistant("a1", ["c1"]), result("r1", "c1"));
	assert.deepEqual(forkBranch(b), b);
});

test("forkFileText writes a new header, then the forked entries", () => {
	const header = { type: "session", version: 3, id: "parent", timestamp: "t", cwd: "/p" } as const;
	const lines = forkFileText(header, "/p", branch(user("u1"), assistant("a1", ["c1"])), "child", "/s/parent.jsonl")
		.trimEnd()
		.split("\n")
		.map((l) => JSON.parse(l));
	assert.equal(lines.length, 2);
	assert.deepEqual({ ...lines[0], timestamp: "x" }, { type: "session", version: 3, id: "child", timestamp: "x", cwd: "/p", parentSession: "/s/parent.jsonl" });
	assert.equal(lines[1].id, "u1");
});

test("forkFileText works without a parent header (in-memory session)", () => {
	const [head] = forkFileText(null, "/p", [], "child", undefined).trimEnd().split("\n").map((l) => JSON.parse(l));
	assert.equal(head.id, "child");
	assert.equal(head.cwd, "/p");
});

const sys = (ts: number) => ({ role: "system", content: "", timestamp: ts });
const msg = (role: string, ts: number) => ({ role, content: "x", timestamp: ts });

test("dropForkDrift removes the prompt patch the child adds before its task", () => {
	const m = [sys(1), msg("user", 2), msg("assistant", 3), sys(20), sys(21), msg("user", 22), msg("assistant", 23)] as never[];
	assert.deepEqual(
		dropForkDrift(m, 10).map((x: { timestamp: number }) => x.timestamp),
		[1, 2, 3, 22, 23],
	);
});

test("dropForkDrift keeps system messages the child adds later (tool activations)", () => {
	const m = [sys(1), msg("user", 22), sys(30), msg("assistant", 31)] as never[];
	assert.equal(dropForkDrift(m, 10), m);
});

test("dropForkDrift keeps a leading system message (the child compacted)", () => {
	const m = [sys(30), msg("compactionSummary", 30), msg("user", 31)] as never[];
	assert.equal(dropForkDrift(m, 10), m);
});

/** A fake pi: prints JSONL events, like `pi --mode json`, then exits with `code`. */
function fakePi(events: object[], code = 0, stall = false) {
	const out = events.map((e) => JSON.stringify(e)).join("\n");
	const script = `process.stdout.write(${JSON.stringify(out + "\n")}); ${stall ? "setInterval(() => {}, 1000);" : `process.exitCode = ${code};`}`;
	return { command: process.execPath, args: ["-e", script] };
}
const cwd = mkdtempSync(join(tmpdir(), "subagents-"));
const answer = { role: "assistant", content: [{ type: "text", text: "the answer" }], stopReason: "stop", timestamp: 1 };

test("startChild reports the last assistant text and the tools it ran", async () => {
	const pi = fakePi([
		{ type: "session", id: "x" },
		{ type: "tool_execution_start", toolName: "bash" },
		{ type: "message_end", message: answer },
	]);
	const child = await startChild(1, "task", "/f", pi, cwd, {}, () => {}).done;
	assert.equal(child.status, "done");
	assert.equal(child.output, "the answer");
	assert.equal(child.tools, 1);
	assert.equal(child.messages.length, 1);
});

test("startChild marks a model error as failed, with its message", async () => {
	const error = { role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded", timestamp: 1 };
	const child = await startChild(1, "task", "/f", fakePi([{ type: "message_end", message: error }]), cwd, {}, () => {}).done;
	assert.equal(child.status, "failed");
	assert.equal(child.output, "overloaded");
});

test("startChild marks a crash as failed", async () => {
	const child = await startChild(1, "task", "/f", fakePi([], 3), cwd, {}, () => {}).done;
	assert.equal(child.status, "failed");
	assert.match(child.output, /exit code 3/);
});

test("stop() ends a running child as stopped", async () => {
	const child = startChild(1, "task", "/f", fakePi([], 0, true), cwd, {}, () => {});
	child.stop();
	assert.equal((await child.done).status, "stopped");
});

test("widgetLines renders a Todos-style tree including nested sub-agents, context usage and summary", () => {
	const theme = { fg: (_c: string, t: string) => t } as never;
	const kid = { id: 1, label: "sub task", status: "running", activity: "grep", tools: 2, contextTokens: 20_000, contextWindow: 200_000, summary: "", startedAt: 55_000, children: [] };
	const running = { id: 2, task: "look\nat it", status: "running", activity: "bash", tools: 3, contextTokens: 50_000, contextWindow: 200_000, summary: "checking tests", startedAt: 0, children: [kid] } as never;
	const done = { id: 1, task: "first", status: "done", contextTokens: 10_000, contextWindow: 200_000, summary: "all good", startedAt: 0, endedAt: 10_000, children: [] } as never;
	assert.deepEqual(widgetLines([done], theme, 65_000), []);
	assert.equal(widgetLines([done], theme, 65_000, true).length, 2);
	assert.deepEqual(widgetLines([done, running], theme, 65_000), [
		"● Sub-agents (1/2)",
		"├─ ✓ #1 first · 10k/200k (5%) · 10s — all good",
		"└─ ◐ #2 look at it · bash · 3 tools · 50k/200k (25%) · 1m05s — checking tests",
		"   └─ ◐ #2.1 sub task · grep · 2 tools · 20k/200k (10%) · 10s",
	]);
	assert.equal(formatContext(0, 200_000), "");
	assert.equal(formatContext(500, 0), "500");
});

test("Viewer follows the end, scrolls up, and closes on Escape", () => {
	const theme = { fg: (_c: string, t: string) => t } as never;
	const text = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });
	const messages = [{ role: "user" }, ...Array.from({ length: 20 }, (_, i) => text(`line ${i}`))];
	const child = { id: 1, task: "t", file: "/f", status: "done", messages } as never;
	let closed = false;
	const tui = { terminal: { rows: 10 }, requestRender() {} } as never; // body rows: max(5, 10 * 0.8 - 2) = 6
	const viewer = new Viewer(child, tui, theme, () => (closed = true));
	const body = () => viewer.render(80).slice(1, -1);
	assert.deepEqual(body().at(-1), "line 19");
	viewer.handleInput("\x1b[A"); // up
	assert.deepEqual(body().at(-1), "line 18");
	viewer.handleInput("\x1b[F"); // end: follows again
	assert.deepEqual(body().at(-1), "line 19");
	viewer.handleInput("\x1b");
	assert.ok(closed);
});

const exit = (code: number | null, more = {}) => ({ code, signal: code === null ? "SIGKILL" : null, stderr: "", ...more });

test("outcome: a stop wins over everything and keeps any last assistant text", () => {
	assert.deepEqual(outcome([], exit(null), true), { status: "stopped", output: "" });
	assert.deepEqual(outcome([answer] as never, exit(null), true), { status: "stopped", output: "the answer" });
});

test("outcome: a crash fails, with the signal or code and the end of stderr", () => {
	assert.deepEqual(outcome([answer] as never, exit(null), false), { status: "failed", output: "killed by SIGKILL" });
	assert.deepEqual(outcome([], exit(1, { stderr: "boom\n" }), false), { status: "failed", output: "exit code 1: boom" });
	assert.deepEqual(outcome([], exit(null, { error: new Error("ENOENT") }), false), { status: "failed", output: "ENOENT" });
});

test("outcome: done with no answer gives an empty output", () => {
	assert.deepEqual(outcome([], exit(0), false), { status: "done", output: "" });
	const error = { role: "assistant", content: [], stopReason: "error" };
	assert.deepEqual(outcome([error] as never, exit(0), false), { status: "failed", output: "model error" });
});

test("piInvocation reruns the script, a compiled binary, or pi from PATH", () => {
	const script = join(cwd, "cli.js");
	writeFileSync(script, "");
	assert.deepEqual(piInvocation(["-p"], script, "/bin/node"), { command: "/bin/node", args: [script, "-p"] });
	assert.deepEqual(piInvocation(["-p"], "/$bunfs/root/pi", "/opt/pi"), { command: "/opt/pi", args: ["-p"] });
	assert.deepEqual(piInvocation(["-p"], "", "/usr/bin/node"), { command: "pi", args: ["-p"] });
});

const plain = { fg: (_c: string, t: string) => t } as never;

test("transcript shows the task, text, tool calls, the start of tool results, and how it ended", () => {
	const messages = [
		{ role: "user", content: "fork prompt" },
		{ role: "assistant", content: [{ type: "thinking" }, { type: "text", text: " ok " }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] },
		{ role: "toolResult", content: [{ type: "text", text: "1\n2\n3\n4" }], isError: false },
		{ role: "toolResult", content: [], isError: false },
		{ role: "user", content: [{ type: "text", text: "steer" }] },
	];
	const child = { task: "the task", status: "failed", output: "boom", messages } as never;
	assert.deepEqual(transcript(child, plain), ["▶ the task", "", "ok", '→ bash {"command":"ls"}', "  1", "  2", "  3", "▶ (message)", "failed: boom"]);
	assert.deepEqual(transcript({ ...(child as object), status: "running", activity: "bash", messages: [] } as never, plain).at(-1), "… bash");
	assert.deepEqual(transcript({ ...(child as object), status: "done", messages: [] } as never, plain), ["▶ the task", ""]);
});

test("resultView: headline only, short preview, or all of it when expanded", () => {
	initTheme(); // keyHint and the Markdown theme read the global theme
	const lines = (text: string, expanded = false) => resultView(text, expanded, plain).render(80).map((l) => l.trimEnd());
	assert.deepEqual(lines("Sub-agent #1 stopped after 3s."), ["Sub-agent #1 stopped after 3s."]);
	assert.deepEqual(lines("head\n\na\nb"), ["head", "a", "b"]);
	assert.equal(lines("head\n\n1\n2\n3\n4\n5").length, 5); // 3 lines and a "2 more lines" hint
	assert.ok(lines("head\n\n1\n2\n3\n4\n5", true).some((l) => l.includes("5")));
});

test("startChild runs the command in cwd with the given env", async () => {
	const pi = { command: process.execPath, args: ["-e", `require("fs").writeFileSync("out.txt", process.env.X)`] };
	await startChild(1, "task", "/f", pi, cwd, { X: "1" }, () => {}).done;
	assert.equal(readFileSync(join(cwd, "out.txt"), "utf8"), "1");
});

test("startChild fails when the command cannot start", async () => {
	const child = await startChild(1, "task", "/f", { command: join(cwd, "missing"), args: [] }, cwd, {}, () => {}).done;
	assert.equal(child.status, "failed");
	assert.match(child.output, /ENOENT/);
});

test("apply counts tool starts, tracks nested subagent_children snapshots, and keeps the child's messages", () => {
	const child = { activity: "starting", tools: 0, contextTokens: 0, summary: "", children: [] as object[], messages: [] as object[] } as never as Parameters<typeof apply>[0];
	assert.equal(apply(child, { type: "tool_execution_start", toolName: "bash" } as never), true);
	assert.deepEqual([child.activity, child.tools], ["bash", 1]);
	assert.equal(
		apply(child, {
			type: "subagent_children",
			children: [{ id: 1, label: "sub", status: "running", activity: "read", tools: 0, contextTokens: 0, contextWindow: 0, summary: "", startedAt: 0, children: [] }],
		}),
		true,
	);
	assert.equal(child.children.length, 1);
	assert.equal(apply(child, { type: "message_end", message: { role: "toolResult" } } as never), true);
	assert.equal(child.activity, "bash");
	assert.equal(apply(child, { type: "message_end", message: { ...answer, usage: { totalTokens: 42_000 } } } as never), true);
	assert.equal(child.activity, "thinking");
	assert.equal(child.contextTokens, 42_000);
	assert.equal(child.summary, "the answer");
	assert.equal(apply(child, { type: "message_end", message: { role: "system" } } as never), false);
	assert.equal(apply(child, { type: "turn_end" } as never), false);
	assert.equal(child.messages.length, 2);
});

test("forkBranch cuts a branch whose first entry is the running turn", () => {
	assert.deepEqual(forkBranch(branch(assistant("a1", ["c1"]))), []);
});

test("dropForkDrift: a message at forkedAt is the parent's; the patch can follow the first message, or end the list", () => {
	assert.deepEqual(dropForkDrift([sys(1), sys(10), msg("user", 22)] as never[], 10).length, 3);
	assert.deepEqual(dropForkDrift([sys(1), sys(20), msg("user", 22)] as never[], 10).map((x: { timestamp: number }) => x.timestamp), [1, 22]);
	assert.deepEqual(dropForkDrift([sys(1), msg("user", 2), sys(20)] as never[], 10).map((x: { timestamp: number }) => x.timestamp), [1, 2]);
});

test("widgetLines cuts a long task and counts time from the start", () => {
	const theme = { fg: (_c: string, t: string) => t } as never;
	const child = { id: 1, task: "x".repeat(61), status: "running", activity: "a", tools: 0, startedAt: 1000, children: [] } as never;
	assert.deepEqual(widgetLines([child], theme, 61_000), [
		"● Sub-agents (0/1)",
		`└─ ◐ #1 ${"x".repeat(51)}… · a · 0 tools · 1m00s`,
	]);
});

test("headline says how a child ended, its label/model/thinking when set, and how long it ran", () => {
	assert.equal(headline({ id: 2, status: "done", startedAt: 1000, endedAt: 6000 } as never), "Sub-agent #2 finished after 5s.");
	assert.equal(headline({ id: 2, status: "failed", startedAt: 1000, endedAt: 1000 } as never), "Sub-agent #2 failed after 0s.");
	assert.equal(
		headline({ id: 3, task: "long task", label: "Opus review", model: "anthropic/opus", thinking: "high", status: "stopped", startedAt: 0, endedAt: 4000 } as never),
		"Sub-agent #3 [Opus review] (anthropic/opus, high) stopped by user after 4s.",
	);
});

test("resultView: the hint only past 3 lines, with the count", () => {
	initTheme();
	const lines = (text: string, expanded = false) => resultView(text, expanded, plain).render(80).map((l) => l.trimEnd());
	assert.deepEqual(lines("h\n\n1\n2\n3"), ["h", "1", "2", "3"]);
	assert.match(lines("h\n\n1\n2\n3\n4").at(-1)!, /1 more lines/);
	assert.equal(lines("h\n\n1\n2\n3\n4", true)[1], "1");
});

test("Viewer: a short transcript shows from the start; Home, PgDn, PgUp, Down move", () => {
	const text = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });
	const many = Array.from({ length: 40 }, (_, i) => text(`line ${i}`));
	const tui = { terminal: { rows: 20 }, requestRender() {} } as never; // body rows: 20 * 0.8 - 2 = 14
	const short = new Viewer({ id: 1, task: "t", file: "/f", status: "done", messages: [{ role: "user" }, text("only")] } as never, tui, plain, () => {});
	assert.deepEqual(short.render(80).slice(1, -1), ["▶ t", "", "only"]);
	const viewer = new Viewer({ id: 1, task: "t", file: "/f", status: "done", messages: [{ role: "user" }, ...many] } as never, tui, plain, () => {});
	const body = () => viewer.render(80).slice(1, -1);
	assert.equal(body().length, 14);
	viewer.handleInput("\x1b[H"); // home
	assert.equal(body()[0], "▶ t");
	viewer.handleInput("\x1b[B"); // down
	assert.equal(body()[0], "");
	viewer.handleInput("\x1b[6~"); // page down
	assert.equal(body()[0], "line 13");
	viewer.handleInput("\x1b[5~"); // page up
	assert.equal(body()[0], "");
	viewer.handleInput("x"); // not a key it uses
	assert.equal(body()[0], "");
});

test("piInvocation knows the Windows path of a Bun binary", () => {
	assert.deepEqual(piInvocation(["-p"], "B:/~BUN/root/pi.exe", "C:/pi.exe"), { command: "C:/pi.exe", args: ["-p"] });
});

test("startChild keeps the end of stderr for a crash", async () => {
	const pi = { command: process.execPath, args: ["-e", "process.stderr.write('a'); process.stderr.write('b'); process.exitCode = 2"] };
	const child = await startChild(1, "task", "/f", pi, cwd, {}, () => {}).done;
	assert.equal(child.output, "exit code 2: ab");
});

test("widgetLines prefers label over task and truncates labels past 52 characters", () => {
	const theme = { fg: (_c: string, t: string) => t } as never;
	const child = { id: 1, task: "x".repeat(52), label: "x".repeat(52), status: "running", activity: "a", tools: 0, startedAt: 0, children: [] } as never;
	assert.ok(widgetLines([child], theme, 0)[1].includes(`${"x".repeat(52)} ·`));
	const labeled = { id: 2, task: "very long task", label: "short", status: "running", activity: "a", tools: 0, startedAt: 0, children: [] } as never;
	assert.equal(widgetLines([labeled], theme, 0)[1], "└─ ◐ #2 short · a · 0 tools · 0s");
});

test("Viewer: scrolling back down to the end follows new lines again", () => {
	const text = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });
	const messages = [{ role: "user" }, ...Array.from({ length: 20 }, (_, i) => text(`line ${i}`))];
	const tui = { terminal: { rows: 10 }, requestRender() {} } as never;
	const viewer = new Viewer({ id: 1, task: "t", file: "/f", status: "done", messages } as never, tui, plain, () => {});
	viewer.render(80);
	viewer.handleInput("\x1b[A"); // up
	viewer.handleInput("\x1b[B"); // down, back at the end
	messages.push(text("new"));
	assert.equal(viewer.render(80).at(-2), "new");
});

test("parseSpawnArgs parses --fresh, --model and --thinking in any order, only as leading flags", () => {
	assert.deepEqual(parseSpawnArgs("  do the thing  "), { fresh: false, task: "do the thing" });
	assert.deepEqual(parseSpawnArgs("--fresh do the thing"), { fresh: true, task: "do the thing" });
	assert.deepEqual(parseSpawnArgs("  --fresh   "), { fresh: true, task: "" });
	assert.deepEqual(parseSpawnArgs("--freshness check"), { fresh: false, task: "--freshness check" });
	assert.deepEqual(parseSpawnArgs("--model anthropic/haiku do x"), { fresh: false, model: "anthropic/haiku", task: "do x" });
	assert.deepEqual(parseSpawnArgs("--fresh --model=openai/gpt-5 --thinking high do x"), {
		fresh: true,
		model: "openai/gpt-5",
		thinking: "high",
		task: "do x",
	});
	assert.deepEqual(parseSpawnArgs("--thinking=low --model openai/gpt-5 --fresh do x"), {
		fresh: true,
		model: "openai/gpt-5",
		thinking: "low",
		task: "do x",
	});
	assert.deepEqual(parseSpawnArgs("--model"), { fresh: false, task: "" });
	assert.deepEqual(parseSpawnArgs("--thinking"), { fresh: false, task: "" });
	assert.deepEqual(parseSpawnArgs("--model haiku"), { fresh: false, model: "haiku", task: "" });
});

test("resolveThinking defaults to current, normalizes case, and rejects unknown levels", () => {
	assert.equal(resolveThinking(undefined, "medium"), "medium");
	assert.equal(resolveThinking("  ", "medium"), "medium");
	assert.equal(resolveThinking("HIGH", "medium"), "high");
	assert.equal(resolveThinking("xhigh", "low"), "xhigh");
	assert.equal(resolveThinking("max", "low"), "max");
	assert.throws(() => resolveThinking("ultra", "low"), /Unknown thinking level/);
});

test("resolveModel defaults to current, matches provider/id, id, or bare name, and suggests models on error", () => {
	const models = [
		{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
		{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku" },
		{ provider: "bedrock", id: "claude-haiku-4-5", name: "Bedrock Haiku" },
		{ provider: "gw", id: "anthropic/claude-opus-4-5", name: "GW Opus" },
	];
	assert.equal(resolveModel(undefined, models[0], models), models[0]);
	assert.throws(() => resolveModel(undefined, undefined, models), /No model/);
	assert.equal(resolveModel("bedrock/claude-haiku-4-5", models[0], models), models[2]);
	assert.equal(resolveModel("BEDROCK/CLAUDE-HAIKU-4-5", models[0], models), models[2]);
	assert.equal(resolveModel("claude-haiku-4-5", models[0], models), models[1]); // prefers current provider
	assert.equal(resolveModel("claude-haiku-4-5", models[2], models), models[2]);
	assert.equal(resolveModel("claude-opus-4-5", models[0], models), models[3]); // matches bare name after slash
	assert.throws(() => resolveModel("opus", models[0], models), /Unknown model "opus"\. Available: gw\/anthropic\/claude-opus-4-5/);
});

test("spawnCompletions completes flags, models and thinking levels before the task, and stops once the task starts", () => {
	const models = [
		{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku" },
		{ provider: "openai", id: "gpt-5", name: "GPT-5" },
	];
	assert.deepEqual(
		spawnCompletions("", models)?.map((i) => i.value),
		["--fresh ", "--model ", "--thinking "],
	);
	assert.deepEqual(
		spawnCompletions("--fresh ", models)?.map((i) => i.value),
		["--fresh --model ", "--fresh --thinking "],
	);
	assert.deepEqual(
		spawnCompletions("--model ", models)?.map((i) => i.value),
		["--model anthropic/claude-haiku-4-5 ", "--model openai/gpt-5 "],
	);
	assert.deepEqual(
		spawnCompletions("--fresh --model hai", models)?.map((i) => i.value),
		["--fresh --model anthropic/claude-haiku-4-5 "],
	);
	assert.deepEqual(
		spawnCompletions("--model=gpt", models)?.map((i) => i.value),
		["--model=openai/gpt-5 "],
	);
	assert.deepEqual(
		spawnCompletions("--thinking ", models)?.map((i) => i.value),
		["--thinking off ", "--thinking minimal ", "--thinking low ", "--thinking medium ", "--thinking high ", "--thinking xhigh ", "--thinking max "],
	);
	assert.deepEqual(
		spawnCompletions("--fresh --thinking=m", models)?.map((i) => i.value),
		["--fresh --thinking=minimal ", "--fresh --thinking=medium ", "--fresh --thinking=max "],
	);
	assert.deepEqual(
		spawnCompletions("--model openai/gpt-5 --thinking high ", models)?.map((i) => i.value),
		["--model openai/gpt-5 --thinking high --fresh "],
	);
	assert.equal(spawnCompletions("--fresh --model openai/gpt-5 --thinking high ", models), null);
	assert.equal(spawnCompletions("check tests", models), null);
	assert.equal(spawnCompletions("--fresh check --model ", models), null);
});

test("childPrompt supports fork, fresh, and resume modes, and spawnNote reflects mode", () => {
	assert.match(childPrompt("x"), /conversation above/);
	assert.doesNotMatch(childPrompt("x", "fresh"), /conversation above/);
	assert.match(childPrompt("do x", "fresh"), /Task:\ndo x$/);
	assert.match(childPrompt("continue", "resume"), /resuming your previous sub-agent session/);
	assert.match(spawnNote(1, "t"), /fork of this conversation/);
	assert.match(spawnNote(1, "t", true), /fresh context/);
});

test("subagentsCompletions completes subcommands and delegates `spawn ...` to spawnCompletions", () => {
	const models = [{ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku" }];
	assert.deepEqual(
		subagentsCompletions("", models)?.map((i) => i.label),
		["spawn", "stop", "show", "hide"],
	);
	assert.deepEqual(
		subagentsCompletions("sh", models)?.map((i) => i.value),
		["show"],
	);
	assert.deepEqual(
		subagentsCompletions("spawn --model hai", models)?.map((i) => i.value),
		["spawn --model anthropic/claude-haiku-4-5 "],
	);
	assert.equal(subagentsCompletions("stop ", models), null);
});

test("sanitizeSessionText drops truncated tail lines and unfinished tool-call turns", () => {
	const head = { type: "session", version: 3, id: "c", timestamp: "t", cwd: "/p" };
	const raw = [JSON.stringify(head), JSON.stringify(user("u1")), JSON.stringify(assistant("a1", ["c1"])), '{"truncated":'].join("\n") + "\n";
	const clean = sanitizeSessionText(raw)
		.trimEnd()
		.split("\n")
		.map((l) => JSON.parse(l));
	assert.equal(clean.length, 2);
	assert.equal(clean[0].id, "c");
	assert.equal(clean[1].id, "u1");
});
