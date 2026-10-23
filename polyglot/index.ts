import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LANGUAGES = [
	["en", "English"],
	["zh-hans", "简体中文"],
	["zh-hant", "繁體中文"],
	["fr", "Français"],
	["es", "Español"],
	["ja", "日本語"],
	["ko", "한국어"],
	["ru", "Русский"],
	["ar", "العربية"],
	["de", "Deutsch"],
	["pt", "Português"],
	["off", "Off (no language reminder)"],
].map(([value, label]) => ({ value, label }));

async function readPrompt(code: string): Promise<string> {
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(code)) throw new Error("Use a language filename, such as zh-hans or fr.");
	const raw = await readFile(join(getAgentDir(), "polyglot-languages", `${code}.md`), "utf8")
		.catch((error) => {
			if (error.code !== "ENOENT") throw error;
			return readFile(new URL(`./langs/${code}.md`, import.meta.url), "utf8");
		});
	const prompt = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
	if (!prompt) throw new Error(`Empty language prompt: ${code}`);
	return prompt;
}

export default function polyglot(pi: ExtensionAPI) {
	let language = "zh-hans";
	const configPath = join(getAgentDir(), "polyglot.json");
	pi.on("session_start", async (_event, ctx) => {
		language = "zh-hans";
		try {
			const raw = await readFile(configPath, "utf8").catch((error) => {
				if (error.code !== "ENOENT") throw error;
				return '{"defaultLang":"zh-hans"}';
			});
			const saved = JSON.parse(raw);
			if (typeof saved?.defaultLang !== "string") throw new Error("Invalid saved language");
			// Preserve choices saved before the Chinese filenames used BCP 47 tags.
			const code = saved.defaultLang === "zhs" ? "zh-hans" : saved.defaultLang === "zh" ? "zh-hant" : saved.defaultLang.toLowerCase();
			if (code !== "off") await readPrompt(code);
			language = code;
		} catch (error) {
			ctx.ui.notify(`Cannot restore language; using zh-hans: ${error}`, "error");
		}
	});

	pi.registerCommand("lang", {
		description: "Set response language, or off to stop language reminders",
		getArgumentCompletions: (prefix) => {
			const query = prefix.trim().toLowerCase();
			const items = LANGUAGES.filter(({ value, label }) => value.startsWith(query) || label.toLowerCase().startsWith(query));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const code = args.trim().toLowerCase();
			if (!code) {
				ctx.ui.notify(`Language: ${language}. Use /lang <code> or /lang off.`, "info");
				return;
			}
			try {
				if (code !== "off") await readPrompt(code);
			} catch (error) {
				ctx.ui.notify(`Cannot select language: ${error}`, "error");
				return;
			}
			language = code;
			try {
				await mkdir(getAgentDir(), { recursive: true });
				await writeFile(configPath, JSON.stringify({ defaultLang: language }) + "\n", "utf8");
				ctx.ui.notify(`Language: ${language}`, "info");
			} catch (error) {
				ctx.ui.notify(`Language: ${language} (active). Could not save choice: ${error}`, "error");
			}
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		delete event.systemPromptOptions.sections.polyglot_language;
		if (language === "off") return;
		try {
			event.systemPromptOptions.sections.polyglot_language = await readPrompt(language);
		} catch (error) {
			ctx.ui.notify(`Language prompt not applied: ${error}`, "error");
		}
	});
}
