import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadSettings } from "./settings.ts";

const fakePi = (settings: unknown) => ({ getSettings: () => settings }) as Parameters<typeof loadSettings>[0];

describe("loadSettings", () => {
	it("defaults to ctrl+alt+p when no key is set", () => {
		assert.equal(loadSettings(fakePi({})).keyboardShortcut, "ctrl+alt+p");
	});
	it("defaults when the plan-mode key is partial", () => {
		assert.equal(loadSettings(fakePi({ "pi-minimal": { "plan-mode": {} } })).keyboardShortcut, "ctrl+alt+p");
	});
	it("uses a custom shortcut", () => {
		const pi = fakePi({ "pi-minimal": { "plan-mode": { keyboardShortcut: "ctrl+alt+o" } } });
		assert.equal(loadSettings(pi).keyboardShortcut, "ctrl+alt+o");
	});
});
