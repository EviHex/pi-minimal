import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, getAgentDir, getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	DEFAULT_SETTINGS,
	ENTRY_TYPE,
	formatSummary,
	type GuidelinesSetting,
	parseItems,
	parseTodoSettings,
	readTodoRaw,
	renderLines,
	replay,
	type Style,
	type TodoItem,
	type TodoSettings,
	writeTodoSettings,
} from "./core.ts";
import { CLEAR_NOTICE, formatReminder, PROMPT_SNIPPET, resolveGuidelines, TOOL_DESCRIPTION, todoCompletions } from "./prompts.ts";

const WIDGET_KEY = "todo";

const Params = Type.Object({
	items: Type.Array(
		Type.Object({
			text: Type.String({ description: "Short, imperative task label" }),
			status: StringEnum(["pending", "in_progress", "done"] as const),
		}),
		{ description: "Complete current task list (replaces previous state; pass [] to clear)" },
	),
});

const style = (theme: Theme): Style => ({
	accent: (s) => theme.fg("accent", s),
	dim: (s) => theme.fg("dim", s),
	muted: (s) => theme.fg("muted", s),
	warning: (s) => theme.fg("warning", s),
	borderMuted: (s) => theme.fg("borderMuted", s),
});

const unfinished = (items: readonly TodoItem[]) => items.some((i) => i.status !== "done");

export default function (pi: ExtensionAPI) {
	let items: TodoItem[] = [];
	let settings: TodoSettings = DEFAULT_SETTINGS;
	let minimized = false;
	let hidden = false; // all done, and a new turn started
	let sinceUpdate = 0; // tool results since the agent last touched the list
	let ctxRef: ExtensionContext | undefined;

	const paint = () => {
		if (!ctxRef?.hasUI) return;
		const shown = hidden ? [] : items;
		ctxRef.ui.setWidget(
			WIDGET_KEY,
			shown.length
				? (_tui: TUI, theme: Theme) => {
						const lines = renderLines(shown, minimized, style(theme)) ?? [];
						return { render: (w: number) => lines.map((l) => truncateToWidth(l, w)), invalidate() {} };
					}
				: undefined,
			{ placement: "aboveEditor" },
		);
	};

	const load = (ctx: ExtensionContext) => {
		ctxRef = ctx;
		items = replay(ctx.sessionManager.getBranch());
		hidden = false;
		sinceUpdate = 0;
		paint();
	};

	// Guidelines are fixed at load: `pi.getSettings()` is not available yet, and pi reads
	// `promptGuidelines` from the tool definition, so a change needs /reload.
	const loaded = parseTodoSettings({
		...readTodoRaw(join(getAgentDir(), "settings.json")),
		...readTodoRaw(join(process.cwd(), ".pi", "settings.json")),
	});

	pi.registerTool({
		name: "todo",
		label: "todo",
		description: TOOL_DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: resolveGuidelines(loaded.guidelines),
		parameters: Params,
		async execute(_id, params) {
			items = parseItems(params.items);
			hidden = false;
			sinceUpdate = 0;
			pi.appendEntry(ENTRY_TYPE, items);
			paint();
			return { content: [{ type: "text", text: formatSummary(items) }], details: { items } };
		},
		renderCall: (args, theme) => {
			const n = Array.isArray(args.items) ? args.items.length : 0;
			return new Text(theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", `${n} item${n === 1 ? "" : "s"}`), 0, 0);
		},
		renderResult: (result, { isPartial }, theme) => {
			const part = result.content[0];
			return new Text(theme.fg("dim", isPartial ? "updating…" : part?.type === "text" ? part.text : ""), 0, 0);
		},
	});

	const openSettings = (ctx: ExtensionContext) =>
		ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const file = join(getAgentDir(), "settings.json");
			const onOff = (on: boolean) => (on ? "on" : "off");
			const list = new SettingsList(
				[
					{ id: "defaultMinimized", label: "start minimized", currentValue: onOff(settings.defaultMinimized), values: ["off", "on"] },
					{ id: "hideCompletedOnNextTurn", label: "hide when all done", currentValue: onOff(settings.hideCompletedOnNextTurn), values: ["on", "off"] },
					{ id: "reminderInterval", label: "update reminder", currentValue: settings.reminderInterval ? String(settings.reminderInterval) : "off", values: ["off", "5", "8", "12"] },
					{
						id: "guidelines",
						label: "guidelines",
						currentValue: typeof settings.guidelines === "string" ? settings.guidelines : "custom",
						values: ["default", "always", "off"],
						description: "Prompt text for the todo tool. Applies after /reload. Replaces a custom list from settings.json.",
					},
				],
				5,
				getSettingsListTheme(),
				(id, value) => {
					const patch: Partial<TodoSettings> =
						id === "reminderInterval" ? { reminderInterval: value === "off" ? 0 : Number(value) } : id === "guidelines" ? { guidelines: value as GuidelinesSetting } : { [id]: value === "on" };
					settings = { ...settings, ...patch };
					try {
						writeTodoSettings(file, patch);
					} catch (error) {
						ctx.ui.notify(`Settings not saved: ${(error as Error).message}`, "error");
					}
				},
				() => done(),
			);
			const box = new Container();
			box.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			box.addChild(list);
			box.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (w: number) => box.render(w),
				invalidate: () => box.invalidate(),
				handleInput: (data: string) => {
					list.handleInput?.(data);
					tui.requestRender();
				},
			};
		});

	pi.registerCommand("todo", {
		description: "Todo list: minimize, clear, settings",
		getArgumentCompletions: todoCompletions,
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const sub = args.trim();
			if (sub === "minimize") {
				minimized = !minimized;
				paint();
			} else if (sub === "clear") {
				if (items.length === 0) return ctx.ui.notify("Todo list is already empty.", "info");
				items = [];
				pi.appendEntry(ENTRY_TYPE, []);
				// Sent at the tail of the conversation, so the prompt cache stays valid.
				await pi.sendMessage({ customType: ENTRY_TYPE, content: CLEAR_NOTICE, display: false }, { triggerTurn: false });
				paint();
				ctx.ui.notify("Todos cleared.", "info");
			} else if (sub === "settings") {
				await openSettings(ctx);
			} else {
				ctx.ui.notify("Usage: /todo minimize | clear | settings", "info");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		settings = parseTodoSettings((pi.getSettings() as { "pi-minimal"?: { todo?: unknown } })["pi-minimal"]?.todo);
		minimized = settings.defaultMinimized;
		load(ctx);
	});
	pi.on("session_compact", (_event, ctx) => load(ctx));
	pi.on("session_tree", (_event, ctx) => load(ctx));

	pi.on("agent_start", () => {
		if (settings.hideCompletedOnNextTurn && items.length > 0 && !unfinished(items)) {
			hidden = true;
			paint();
		}
	});

	// Stale list: every `reminderInterval` tool results without a `todo` call, append one line to a result.
	pi.on("tool_result", (event) => {
		if (event.toolName === "todo" || event.parentToolCallId || !settings.reminderInterval || !unfinished(items)) return;
		if (++sinceUpdate < settings.reminderInterval) return;
		sinceUpdate = 0;
		return { content: [...event.content, { type: "text", text: `\n\n${formatReminder(items)}` }] };
	});

	pi.on("session_shutdown", () => {
		ctxRef?.ui.setWidget(WIDGET_KEY, undefined);
		ctxRef = undefined;
	});
}
