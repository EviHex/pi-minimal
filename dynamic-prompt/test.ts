import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { enabledMcpServers, evaluateRules, type RuleContext } from "./evaluate.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "dp-"));
const ctx: RuleContext = { cwd: "/x", extensions: [], mcpServers: [] };

test("mcp: user servers, enabled:false dropped, missing or invalid file ignored", () => {
	const dir = tmp();
	assert.deepEqual(enabledMcpServers(dir, dir, true), []);
	writeFileSync(join(dir, "mcp.json"), "{ not json");
	assert.deepEqual(enabledMcpServers(dir, dir, true), []);
	writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { a: {}, b: { enabled: false } } }));
	assert.deepEqual(enabledMcpServers(dir, dir, true), ["a"]);
});

test("mcp: project file overrides user entry only when trusted", () => {
	const agent = tmp();
	const proj = tmp();
	writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { a: {}, b: { enabled: false } } }));
	mkdirSync(join(proj, ".pi"));
	writeFileSync(join(proj, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { a: { enabled: false }, b: { enabled: true }, c: {} } }));
	assert.deepEqual(enabledMcpServers(agent, proj, true), ["b", "c"]);
	assert.deepEqual(enabledMcpServers(agent, proj, false), ["a"]);
});

test("rules: matching inline and file rules become sections; non-matching skipped", () => {
	const dir = tmp();
	writeFileSync(join(dir, "f.md"), "\nfile text\n");
	const { sections, errors } = evaluateRules(
		[{ file: "f.md", when: () => true }, { name: "n", text: " inline ", when: () => true }, { name: "off", text: "t", when: () => false }],
		ctx,
		dir,
	);
	assert.deepEqual(sections, { dynamic_prompt_f: "file text", dynamic_prompt_n: "inline" });
	assert.deepEqual(errors, []);
});

test("rules: a throwing rule and a missing file are reported; others still apply", () => {
	const { sections, errors } = evaluateRules(
		[{ name: "bad", text: "t", when: () => { throw new Error("boom"); } }, { file: "nope.md", when: () => true }, { name: "ok", text: "t", when: () => true }],
		ctx,
		tmp(),
	);
	assert.deepEqual(Object.keys(sections), ["dynamic_prompt_ok"]);
	assert.equal(errors.length, 2);
	assert.match(errors[0], /^bad: boom$/);
	assert.match(errors[1], /^nope\.md: /);
});

test("rules: duplicate section key is reported; last wins", () => {
	const dir = tmp();
	writeFileSync(join(dir, "x.md"), "from file");
	const { sections, errors } = evaluateRules([{ file: "x.md", when: () => true }, { name: "x", text: "inline", when: () => true }], ctx, dir);
	assert.deepEqual(sections, { dynamic_prompt_x: "inline" });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /duplicate section dynamic_prompt_x/);
});

test("rules: empty text is skipped; non-array export is an error", () => {
	const dir = tmp();
	writeFileSync(join(dir, "e.md"), " \n");
	const r = evaluateRules([{ file: "e.md", when: () => true }, { name: "e2", text: "  ", when: () => true }], ctx, dir);
	assert.deepEqual(r, { sections: {}, errors: [] });
	assert.deepEqual(evaluateRules({ a: 1 }, ctx, dir).errors, ["default export must be an array"]);
});
