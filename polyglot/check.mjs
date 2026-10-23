import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function check() {
	const root = dirname(fileURLToPath(import.meta.url));
	const require = createRequire(import.meta.url);
	let host = process.env.PI_CHECK_HOST;
	if (host) host = join(host, "dist/index.js");
	else {
		try {
			host = require.resolve("@earendil-works/pi-coding-agent");
		} catch {
			const install = join(homedir(), ".pi/agent/install");
			const version = (await readFile(join(install, "current-version"), "utf8")).trim();
			host = join(install, "releases", version, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
		}
	}
	const hostRequire = createRequire(host);
	const { createJiti } = hostRequire("jiti");
	const jiti = createJiti(import.meta.url, {
		fsCache: false,
		alias: { "@earendil-works/pi-coding-agent": host },
	});
	const pi = await jiti.import(host);
	const originalDir = process.env.PI_CODING_AGENT_DIR;
	const dir = await mkdtemp(join(root, ".polyglot-check-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const polyglot = await jiti.import(join(root, "index.ts"), { default: true });
		const handlers = new Map();
		const commands = new Map();
		const notices = [];
		const ctx = { ui: { notify: (text, type) => notices.push({ text, type }) } };
		polyglot({
			on: (event, handler) => handlers.set(event, [handler]),
			registerCommand: (name, options) => commands.set(name, options),
		});
		assert.deepEqual([...commands.keys()], ["lang"]);
		assert.deepEqual([...handlers.keys()], ["session_start", "before_agent_start"]);
		const command = (args) => commands.get("lang").handler(args, ctx);
		const configPath = join(dir, "polyglot.json");
		const saved = async () => JSON.parse(await readFile(configPath, "utf8"));
		const start = () => handlers.get("session_start")[0]({}, ctx);
		async function prompt() {
			const event = { systemPromptOptions: { sections: { polyglot_language: "stale", plan_mode: "Plan instructions" } } };
			assert.equal(await handlers.get("before_agent_start")[0](event, ctx), undefined);
			assert.equal(event.systemPromptOptions.sections.plan_mode, "Plan instructions");
			assert.equal(event.systemPromptOptions.forceSystemPrompt, undefined);
			return event.systemPromptOptions.sections.polyglot_language;
		}

		await start();
		assert.equal(notices.length, 0); // A missing config is normal.
		assert.match(await prompt(), /简体中文/);
		const languages = [
			["en", "English"], ["zh-hans", "简体中文"], ["zh-hant", "繁體中文"],
			["fr", "Français"], ["es", "Español"], ["ja", "日本語"], ["ko", "한국어"],
			["ru", "Русский"], ["ar", "العربية"], ["de", "Deutsch"], ["pt", "Português"],
		];
		assert.deepEqual((await readdir(join(root, "langs"))).sort(), languages.map(([code]) => `${code}.md`).sort());
		const complete = commands.get("lang").getArgumentCompletions;
		assert.deepEqual(complete("").map(({ value }) => value), [...languages.map(([code]) => code), "off"]);
		assert.deepEqual(complete(" ZH ").map(({ value }) => value), ["zh-hans", "zh-hant"]);
		assert.deepEqual(complete("Français"), [{ value: "fr", label: "Français" }]);
		assert.deepEqual(complete("of").map(({ value }) => value), ["off"]);
		assert.equal(complete("unknown"), null);
		for (const [code, text] of languages) {
			await command(code);
			assert.equal((await saved()).defaultLang, code);
			const body = await prompt();
			assert.ok(body.includes(text));
			assert.equal(body, (await readFile(join(root, "langs", `${code}.md`), "utf8")).trim());
			assert.match(body, /task's language requirements|遵循任務要求|遵循任务要求/);
			assert.ok(!body.startsWith("---"));
			assert.ok(!/[\u{1F1E6}-\u{1F1FF}]/u.test(body)); // No country flags.
			await start();
			assert.equal(await prompt(), body); // Every language choice survives restart.
		}
		await command("zh-Hant");
		assert.equal((await saved()).defaultLang, "zh-hant");
		assert.match(await prompt(), /繁體中文/);
		await command("fr");
		await command("");
		assert.match(notices.at(-1).text, /Language: fr/);
		for (const code of ["unknown", "../en", "/etc/passwd", "🇨🇳", "config"]) {
			await command(code);
			assert.equal(notices.at(-1).type, "error");
			assert.match(await prompt(), /Français/); // Invalid selection leaves the language alone.
		}
		await command("off");
		assert.equal((await saved()).defaultLang, "off");
		assert.equal(await prompt(), undefined);
		await start();
		assert.equal(await prompt(), undefined); // Off also survives session restarts.
		await command("fr");
		await start();
		assert.match(await prompt(), /Français/);
		await writeFile(configPath, JSON.stringify({ defaultLang: "zhs", showStatus: false }));
		await start(); // Legacy saved codes migrate in memory; no config rewrite at startup.
		assert.match(await prompt(), /简体中文/);
		await command("");
		assert.match(notices.at(-1).text, /Language: zh-hans/);
		assert.equal((await saved()).defaultLang, "zhs");
		await writeFile(configPath, JSON.stringify({ defaultLang: "zh" }));
		await start();
		assert.match(await prompt(), /繁體中文/);
		await writeFile(configPath, JSON.stringify({ defaultLang: "zh-Hans" }));
		await start();
		assert.match(await prompt(), /简体中文/);
		for (const value of ["{broken", "null", '{"defaultLang":42}', '{"defaultLang":"missing"}']) {
			await writeFile(configPath, value);
			await start();
			assert.match(notices.at(-1).text, /Cannot restore/);
			assert.match(await prompt(), /简体中文/);
		}
		await rm(configPath);
		await mkdir(configPath); // Real write failure; choice remains active, then retry succeeds.
		await command("fr");
		assert.match(notices.at(-1).text, /active.*Could not save/);
		assert.equal(notices.at(-1).type, "error");
		assert.match(await prompt(), /Français/);
		await rm(configPath, { recursive: true });
		await command("zh-hans");
		assert.equal((await saved()).defaultLang, "zh-hans");

		const custom = join(dir, "polyglot-languages");
		await mkdir(custom);
		const path = join(custom, "zh-hans.md");
		await writeFile(path, "---\r\nlabel: ignored\r\n---\r\n\r\nCustom Chinese");
		assert.equal(await prompt(), "Custom Chinese");
		await writeFile(path, "Edited without refresh");
		assert.equal(await prompt(), "Edited without refresh");
		await writeFile(join(custom, "yue.md"), "Cantonese prompt");
		await command(" YUE ");
		assert.equal(await prompt(), "Cantonese prompt");
		await writeFile(path, "---\nlabel: empty\n---\n");
		await command("zh-hans");
		assert.equal(notices.at(-1).type, "error");
		assert.equal(await prompt(), "Cantonese prompt");
		await rm(join(custom, "yue.md"));
		assert.equal(await prompt(), undefined);
		assert.match(notices.at(-1).text, /not applied/);
		await rm(path);
		await command("zh-hans");
		await mkdir(path); // A broken custom file must not silently fall back to built-in.
		assert.equal(await prompt(), undefined);
		assert.equal(notices.at(-1).type, "error");
		await rm(path, { recursive: true });

		// Actual Pi composition: a later extension's sections must not be overridden.
		const manager = pi.SessionManager.inMemory(root);
		const runner = new pi.ExtensionRunner([
			{ path: "polyglot", handlers },
			{ path: "later", handlers: new Map([["before_agent_start", [(event) => {
				event.systemPromptOptions.sections.plan_mode = "Plan instructions";
			}] ]]) },
		], pi.createExtensionRuntime(), root, manager, {});
		const result = await runner.emitBeforeAgentStart(
			{ messageType: "user", prompt: "hello" }, { cwd: root, sections: {} },
		);
		assert.match(result.systemPromptOptions.sections.polyglot_language, /简体中文/);
		assert.equal(result.systemPromptOptions.sections.plan_mode, "Plan instructions");
		assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined);
		console.log(`polyglot --check: passed (Pi ${pi.VERSION}; commands, prompts, saved choice, off, errors, section composition)`);
	} finally {
		if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalDir;
		await rm(dir, { recursive: true, force: true });
	}
}

if (process.argv.includes("--check")) await check();
