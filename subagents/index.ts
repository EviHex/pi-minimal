import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type Child, piInvocation, snapshot, startChild } from "./child.ts";
import { dropForkDrift, forkFileText, inspectSessionFile, restoreRecords, sanitizeSessionText, type SubagentRecord } from "./fork.ts";
import {
	type ChildMode,
	childPrompt,
	compactNote,
	formatModelShortlist,
	GUIDELINE_VALUES,
	type Guidelines,
	parseGuidelines,
	parseSpawnArgs,
	resolveModel,
	resolveThinking,
	spawnNote,
	STATUS_TOOL_DESCRIPTION,
	STEER_TOOL_DESCRIPTION,
	STOP_TOOL_DESCRIPTION,
	subagentsCompletions,
	subagentsSection,
	THINKING_LEVELS,
	TOOL_DESCRIPTION,
} from "./prompts.ts";
import { DEFAULT_FIELDS, FIELD_META, parseWidgetFields, resultView, statusReport, stopReply, WIDGET_FIELDS, type WidgetField, widgetLines, writeSubagentSettings } from "./ui.ts";

/** How deep this pi is: 0 for the user's, 1 for a sub-agent, 2 for its sub-agent... */
const DEPTH = Number(process.env.PI_MINIMAL_SUBAGENT_DEPTH) || 0;
/** In a sub-agent: when it was forked (ms). Its messages are newer. */
const FORKED_AT = Number(process.env.PI_MINIMAL_SUBAGENT_FORKED_AT) || 0;
/** Guard against a fork bomb: a sub-agent at this depth cannot start another. */
const MAX_DEPTH = 3;
/** Inherited from parent so live setting toggles reach running children without breaking the prompt cache. */
const ENV_ALLOW_NESTED = process.env.PI_MINIMAL_SUBAGENT_ALLOW_NESTED !== "0";
/** Handoff slot across `/reload` in the same Node process so background sub-agents keep running. */
const HANDOFF_KEY = Symbol.for("@pi-minimal/subagents/handoff");

interface Handoff {
	sessionFile: string | undefined;
	children: Child[];
	dismissed: Set<number>;
	timer: NodeJS.Timeout;
	onExit: () => void;
}

const oneLine = (text: string) => (text.length > 100 ? `${text.slice(0, 99)}…` : text).replace(/\s+/g, " ");

export default function (pi: ExtensionAPI) {
	const children: Child[] = [];
	const dismissed = new Set<number>(); // finished children cleared from the widget on the user's next prompt
	const history = new Map<number, SubagentRecord>();
	let nextId = 1;
	let session: ExtensionContext | undefined; // for the widget, which changes outside handlers
	let currentSessionFile: string | undefined;
	let tuiRef: TUI | undefined;
	let agentRunning = false;
	let reportedWorking = false;
	let timer: NodeJS.Timeout | undefined; // ticks the widget's clocks
	let guidelines: Guidelines = "default"; // what the settings menu shows; the prompt does not follow it until /reload
	let section: string | undefined; // frozen at session_start: a mid-session change would break the prompt cache
	let compacting = false; // `/compact` aborts the run first: that abort must not stop the children
	let widgetFields: WidgetField[] = [...DEFAULT_FIELDS];
	let allowNested = ENV_ALLOW_NESTED;
	let closing = false;
	let minimized = false;

	/** Keep terminal tab indicators (OSC 7501 + OSC 9;4) active while background sub-agents run and the main agent is idle. */
	const syncTerminalStatus = () => {
		if (closing || DEPTH > 0 || !tuiRef) return;
		const running = children.filter((c) => c.status === "running").length;
		if (agentRunning) {
			reportedWorking = false;
			return;
		}
		if (running > 0) {
			reportedWorking = true;
			tuiRef.terminal.setProgramStatus({ state: "working", app: "pi", message: `Sub-agents (${running} running)` });
			tuiRef.terminal.setProgress(true);
		} else if (reportedWorking) {
			reportedWorking = false;
			tuiRef.terminal.setProgramStatus({ state: "idle", app: "pi" });
			tuiRef.terminal.setProgress(false);
		}
	};

	const refresh = () => {
		if (closing) return;
		if (DEPTH > 0) {
			process.stdout.write(`${JSON.stringify({ type: "subagent_children", children: children.map(snapshot) })}\n`);
			return;
		}
		const running = children.filter((c) => c.status === "running").length;
		pi.events.emit("subagents:status", { running, total: children.length });
		if (!session?.hasUI) return;
		const visible = children.filter((c) => !dismissed.has(c.id));
		const sessions = session.sessionManager;
		const mainCost = sessions.getBranch().reduce((sum, e) => sum + (e.type === "message" && e.message.role === "assistant" ? e.message.usage?.cost?.total || 0 : 0), 0);
		const lines = widgetLines(visible, session.ui.theme, Date.now(), widgetFields, minimized, { name: sessions.getSessionName(), cost: mainCost });
		session.ui.setWidget(
			"subagents",
			lines.length
				? (tui: TUI) => {
						tuiRef = tui;
						queueMicrotask(syncTerminalStatus);
						return { render: (w: number) => lines.map((l) => truncateToWidth(l, w)), invalidate() {} };
					}
				: undefined,
		);
		syncTerminalStatus();
		const anyRunning = lines.length > 0 && running > 0;
		if (anyRunning && !timer) timer = setInterval(refresh, 1000);
		if (!anyRunning) {
			clearInterval(timer);
			timer = undefined;
		}
	};
	const stopAll = () => children.forEach((child) => child.stop());

	const availableModels = (ctx: ExtensionContext) => {
		const avail = ctx.modelRegistry.getAvailable();
		return avail.length ? avail : ctx.modelRegistry.getAll();
	};

	/** Start or resume a sub-agent: forked from this branch, fresh empty session, or resuming a prior child. */
	function launch(
		task: string,
		ctx: ExtensionContext,
		opts: { fresh?: boolean; resume?: number; label?: string; group?: string; model?: string; thinking?: string } = {},
	): Child {
		if (DEPTH > 0 && !allowNested) throw new Error("Nested sub-agents are disabled in settings.");
		if (DEPTH >= MAX_DEPTH) throw new Error(`Sub-agents nest at most ${MAX_DEPTH} levels deep: this one cannot start another.`);
		const livePrev = opts.resume !== undefined ? children.find((c) => c.id === opts.resume) : undefined;
		const prev = livePrev ?? (opts.resume !== undefined ? history.get(opts.resume) : undefined);
		if (opts.resume !== undefined && !prev) throw new Error(`Sub-agent #${opts.resume} not found in this session.`);
		if (livePrev?.status === "running") throw new Error(`Sub-agent #${livePrev.id} is still running.`);
		if (prev && !existsSync(prev.file)) throw new Error(`Session file for sub-agent #${prev.id} no longer exists: ${prev.file}`);
		const mode: ChildMode = prev ? "resume" : opts.fresh ? "fresh" : "fork";
		const model = resolveModel(opts.model ?? (prev?.model || undefined), ctx.model, availableModels(ctx));
		const thinking = resolveThinking(opts.thinking ?? (prev?.thinking || undefined), pi.getThinkingLevel());
		let file: string;
		if (prev) {
			file = prev.file;
			writeFileSync(file, sanitizeSessionText(readFileSync(file, "utf8")));
		} else {
			const sessions = ctx.sessionManager;
			const parentFile = sessions.getSessionFile();
			const dir = parentFile ? join(parentFile.replace(/\.jsonl$/, ""), "subagents") : join(tmpdir(), "pi-subagents");
			const id = randomUUID();
			file = join(dir, `${id}.jsonl`);
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, forkFileText(sessions.getHeader(), ctx.cwd, mode === "fresh" ? [] : sessions.getBranch(), id, parentFile));
		}
		const args = ["--mode", "rpc", "--session", file, "--provider", model.provider, "--model", model.id, "--thinking", thinking];
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_MINIMAL_SUBAGENT_DEPTH: `${DEPTH + 1}`,
			PI_MINIMAL_SUBAGENT_ALLOW_NESTED: allowNested ? "1" : "0",
		};
		if (mode === "fork") env.PI_MINIMAL_SUBAGENT_FORKED_AT = `${Date.now()}`;
		else delete env.PI_MINIMAL_SUBAGENT_FORKED_AT;
		const fullModel = `${model.provider}/${model.id}`;
		const label = opts.label?.trim() || (prev && prev.label !== prev.task ? prev.label : undefined);
		const child = startChild(nextId++, task, file, piInvocation(args), ctx.cwd, env, refresh, {
			label,
			mode,
			model: fullModel,
			thinking,
			group: opts.group,
			contextWindow: model.contextWindow,
			prompt: childPrompt(task, mode, { depth: DEPTH + 1, maxDepth: MAX_DEPTH, allowNested }),
		});
		children.push(child);
		if (DEPTH === 0) {
			const rec: SubagentRecord = { id: child.id, file, task, label: child.label, model: fullModel, thinking };
			history.set(child.id, rec);
			pi.appendEntry("subagents", rec);
		}
		refresh();
		return child;
	}

	/** Send the result of a background child when it ends. Stopped children and non-final members of a running group do not wake the agent. */
	const deliverLater = (child: Child) => {
		child.background = true;
		void child.done.then(() => {
			if (closing) return;
			const waitForGroup = Boolean(child.group && children.some((c) => c.group === child.group && c.status === "running"));
			const content = statusReport(child);
			pi.sendMessage({ customType: "subagent", content, display: true }, { triggerTurn: child.status !== "stopped" && !waitForGroup });
		});
	};

	pi.registerTool({
		name: "subagent",
		label: "Sub-agent",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({
			task: Type.String({ description: "Goal, scope, whether it may edit, and expected output. Brief on fork; self-contained on fresh; follow-up only on resume." }),
			label: Type.Optional(Type.String({ description: "2–4 word lowercase focus (no model/thinking/id), e.g. \"audit auth\", \"oauth limits\"." })),
			fresh: Type.Optional(Type.Boolean({ description: "Start with an empty context instead of forking." })),
			resume: Type.Optional(Type.Number({ description: "Continue a finished, failed or stopped sub-agent by #id with its prior context." })),
			model: Type.Optional(Type.String({ description: "Model ID (provider/id or id). Default: parent's (child's on resume)." })),
			thinking: Type.Optional(
				Type.Union(
					THINKING_LEVELS.map((l) => Type.Literal(l)),
					{ description: "Thinking level. Default: parent's (child's on resume)." },
				),
			),
			wait: Type.Optional(Type.Boolean({ description: "Block until done (default: false). Only when the user asks." })),
			group: Type.Optional(Type.String({ description: "Shared name for a parallel batch (e.g. \"prompt review\"). Omit for single calls." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const child = launch(params.task, ctx, {
				fresh: params.fresh,
				resume: params.resume,
				label: params.label,
				group: params.group,
				model: params.model,
				thinking: params.thinking,
			});
			// Print mode (a sub-agent, or `pi -p`) exits when its run ends and would kill background children: run in the foreground there.
			if (!params.wait && DEPTH === 0 && ctx.hasUI) {
				deliverLater(child);
				const resumed = params.resume !== undefined ? `resumed from #${params.resume}, ` : "";
				return {
					content: [{ type: "text", text: `Sub-agent #${child.id} (${resumed}${child.model}, ${child.thinking}) started in the background.` }],
					details: {},
				};
			}
			signal?.addEventListener("abort", child.stop, { once: true });
			await child.done;
			signal?.removeEventListener("abort", child.stop);
			if (child.status !== "done") throw new Error(statusReport(child));
			return { content: [{ type: "text", text: statusReport(child) }], details: {} };
		},
		renderCall: (args, theme) => {
			const flags = [
				args.resume !== undefined && `resume:#${args.resume}`,
				args.fresh && "fresh",
				args.model,
				args.thinking && `thinking:${args.thinking}`,
				args.wait && "wait",
			]
				.filter(Boolean)
				.join(", ");
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", oneLine(args.label || args.task || "")) +
					(flags ? theme.fg("dim", ` (${flags})`) : ""),
				0,
				0,
			);
		},
		renderResult: (result, { expanded, isPartial }, theme) => {
			if (isPartial) return new Text(theme.fg("dim", "running…"), 0, 0);
			const part = result.content[0];
			return resultView(part?.type === "text" ? part.text : "", expanded, theme);
		},
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Sub-agent status",
		description: STATUS_TOOL_DESCRIPTION,
		parameters: Type.Object({
			id: Type.Number({ description: "Sub-agent #id to inspect." }),
		}),
		async execute(_id, params) {
			const child = children.find((c) => c.id === params.id);
			if (child) return { content: [{ type: "text", text: statusReport(child) }], details: {} };
			const prior = history.get(params.id);
			if (prior) {
				const spec = [prior.model, prior.thinking].filter(Boolean).join(", ");
				const info = existsSync(prior.file) ? inspectSessionFile(readFileSync(prior.file, "utf8")) : { lastText: "", tools: 0 };
				const state = info.stopReason ? `${info.stopReason} before reload` : "from before reload";
				const head = `Sub-agent #${prior.id}${prior.label && prior.label !== prior.task ? ` [${oneLine(prior.label)}]` : ""}${spec ? ` (${spec})` : ""} (${state}, ${info.tools} tools).`;
				const meta = `Session: ${prior.file} · Use resume: ${prior.id} to continue.`;
				return { content: [{ type: "text", text: [head, info.lastText, meta].filter(Boolean).join("\n\n") }], details: {} };
			}
			throw new Error(`Sub-agent #${params.id} not found in this session.`);
		},
		renderCall: (args, theme) =>
			new Text(theme.fg("toolTitle", theme.bold("subagent_status ")) + theme.fg("accent", `#${args.id ?? ""}`), 0, 0),
		renderResult: (result, { expanded, isPartial }, theme) => {
			if (isPartial) return new Text(theme.fg("dim", "checking…"), 0, 0);
			const part = result.content[0];
			return resultView(part?.type === "text" ? part.text : "", expanded, theme);
		},
	});

	pi.registerTool({
		name: "subagent_steer",
		label: "Steer sub-agent",
		description: STEER_TOOL_DESCRIPTION,
		parameters: Type.Object({
			id: Type.Number({ description: "Running sub-agent #id to steer." }),
			message: Type.String({ description: "Steering message to inject into the running sub-agent." }),
		}),
		async execute(_id, params) {
			const child = children.find((c) => c.id === params.id);
			if (!child) throw new Error(`Sub-agent #${params.id} not found in this session.`);
			child.steer(params.message);
			return { content: [{ type: "text", text: `Steered sub-agent #${child.id}.` }], details: {} };
		},
		renderCall: (args, theme) =>
			new Text(
				theme.fg("toolTitle", theme.bold("subagent_steer ")) +
					theme.fg("accent", `#${args.id ?? ""} `) +
					theme.fg("dim", oneLine(args.message ?? "")),
				0,
				0,
			),
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Stop sub-agent",
		description: STOP_TOOL_DESCRIPTION,
		parameters: Type.Object({
			id: Type.Number({ description: "Running sub-agent #id to stop." }),
		}),
		async execute(_id, params) {
			const child = children.find((c) => c.id === params.id);
			if (!child) throw new Error(`Sub-agent #${params.id} not found in this session.`);
			const text = stopReply(child);
			child.stop();
			return { content: [{ type: "text", text }], details: {} };
		},
		renderCall: (args, theme) => new Text(theme.fg("toolTitle", theme.bold("subagent_stop ")) + theme.fg("accent", `#${args.id ?? ""}`), 0, 0),
	});

	pi.registerMessageRenderer("subagent", (message, { expanded }, theme) =>
		resultView(typeof message.content === "string" ? message.content : "", expanded, theme),
	);

	const openSettings = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const settingsFile = join(getAgentDir(), "settings.json");
		const save = (patch: Record<string, unknown>) => {
			try {
				writeSubagentSettings(settingsFile, patch);
			} catch (error) {
				ctx.ui.notify(`Settings not saved: ${(error as Error).message}`, "error");
			}
		};
		const enabled = new Set<WidgetField>(widgetFields);
		const fieldsSummary = () => `${widgetFields.length}/${WIDGET_FIELDS.length}`;
		const buildFieldsSubmenu = (closeSub: (selectedValue?: string) => void) => {
			const fieldItems = WIDGET_FIELDS.map((field) => ({
				id: field,
				label: FIELD_META[field].label,
				description: FIELD_META[field].description,
				currentValue: enabled.has(field) ? "on" : "off",
				values: ["on", "off"],
			}));
			return new SettingsList(
				fieldItems,
				Math.min(fieldItems.length, 12),
				getSettingsListTheme(),
				(id, val) => {
					if (val === "on") enabled.add(id as WidgetField);
					else enabled.delete(id as WidgetField);
					widgetFields = WIDGET_FIELDS.filter((f) => enabled.has(f));
					save({ fields: widgetFields });
					refresh();
				},
				() => closeSub(fieldsSummary()),
			);
		};
		const topItems = [
			{
				id: "guidelines",
				label: "guidelines",
				description: "How much the agent uses sub-agents. Applies after /reload. A preset replaces custom text from settings.json.",
				currentValue: typeof guidelines === "string" ? guidelines : "custom",
				values: [...GUIDELINE_VALUES],
			},
			{
				id: "allowNested",
				label: "Nested sub-agents",
				description: "Allow sub-agents to spawn nested sub-agents",
				currentValue: allowNested ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "fields",
				label: "Widget fields",
				description: "Choose which columns appear in the sub-agents widget",
				currentValue: fieldsSummary(),
				submenu: (_cur: string, closeSub: (selectedValue?: string) => void) => buildFieldsSubmenu(closeSub),
			},
		];
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const box = new Container();
			box.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			box.addChild(new Text(theme.fg("accent", theme.bold(" Sub-agents Settings")), 0, 0));
			const list = new SettingsList(
				topItems,
				Math.min(topItems.length, 12),
				getSettingsListTheme(),
				(id, val) => {
					if (id === "allowNested") {
						allowNested = val === "on";
						save({ allowNested });
					} else if (id === "guidelines") {
						guidelines = val as Guidelines;
						save({ guidelines: val });
					}
				},
				() => done(),
			);
			box.addChild(list);
			box.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			return {
				render: (w) => box.render(w),
				invalidate: () => box.invalidate(),
				handleInput: (data) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	};

	const handleCommand = async (args: string, ctx: ExtensionContext) => {
		const trimmed = args.trim();
		if (trimmed === "minimize") {
			minimized = !minimized;
			refresh();
			if (!children.some((c) => !dismissed.has(c.id))) ctx.ui.notify("No sub-agent in this session yet.", "info");
			return;
		}
		if (trimmed === "settings") return openSettings(ctx);
		if (trimmed === "spawn" || trimmed.startsWith("spawn ")) {
			const { fresh, model, thinking, task } = parseSpawnArgs(trimmed.slice("spawn".length));
			if (!task) return ctx.ui.notify("Usage: /subagents spawn [--fresh] [--model <provider/id>] [--thinking <level>] <task>", "warning");
			try {
				const child = launch(task, ctx, { fresh, model, thinking });
				deliverLater(child);
				pi.sendMessage({ customType: "subagent", content: spawnNote(child.id, task, fresh), display: true }, { triggerTurn: false });
			} catch (error) {
				ctx.ui.notify(`${(error as Error).message}`, "error");
			}
			return;
		}
		ctx.ui.notify("Usage: /sa [spawn [--fresh] [--model] [--thinking] <task> | minimize | settings]", "info");
	};

	const commandSpec = {
		description: "Manage sub-agents: /subagents [spawn | minimize | settings] (alias: /sa)",
		getArgumentCompletions: (prefix: string) => subagentsCompletions(prefix, session ? availableModels(session) : []),
		handler: handleCommand,
	};
	pi.registerCommand("subagents", commandSpec);
	pi.registerCommand("sa", commandSpec);

	// Read at session_start: settings, persisted history, and any live children handed off across `/reload`.
	pi.on("session_start", (_event, ctx) => {
		closing = false;
		session = ctx;
		currentSessionFile = ctx.sessionManager.getSessionFile();
		const settings = pi.getSettings() as { "pi-minimal"?: { subagents?: { fields?: unknown; allowNested?: unknown } } };
		guidelines = parseGuidelines(settings["pi-minimal"]?.subagents);
		const modelShortlist = formatModelShortlist(availableModels(ctx), (settings as { enabledModels?: string[] }).enabledModels, ctx.model?.provider);
		section = subagentsSection(guidelines, modelShortlist);
		widgetFields = parseWidgetFields(settings["pi-minimal"]?.subagents?.fields);
		allowNested = ENV_ALLOW_NESTED && settings["pi-minimal"]?.subagents?.allowNested !== false;
		if (DEPTH === 0) {
			const store = globalThis as Record<symbol, Handoff | undefined>;
			const handoff = store[HANDOFF_KEY];
			if (handoff) {
				delete store[HANDOFF_KEY];
				clearTimeout(handoff.timer);
				process.off("exit", handoff.onExit);
				if (handoff.sessionFile === ctx.sessionManager.getSessionFile()) {
					for (const id of handoff.dismissed) dismissed.add(id);
					for (const child of handoff.children) {
						children.push(child);
						child.setOnChange(refresh);
						if (child.background && child.status === "running") deliverLater(child);
					}
				} else {
					handoff.children.forEach((c) => c.stop());
				}
			}
			history.clear();
			for (const rec of restoreRecords(ctx.sessionManager.getBranch())) history.set(rec.id, rec);
			const maxId = Math.max(0, ...children.map((c) => c.id), ...history.keys());
			nextId = maxId + 1;
			if (children.length) refresh();
		}
	});

	// Same text in every fork, so it does not break the prompt cache.
	pi.on("before_agent_start", (event) => {
		if (section) event.systemPromptOptions.sections.subagents = section;
	});

	// `/compact` aborts the run (agent_settled aborted) before it starts: keep the children, and remind the agent of them afterwards.
	pi.on("session_before_compact", () => {
		compacting = true;
	});
	pi.on("session_compact_failed", () => {
		compacting = false;
	});
	pi.on("session_compact", () => {
		compacting = false;
		const note = compactNote(children.filter((c) => c.status === "running"));
		if (note) pi.sendMessage({ customType: "subagent", content: note, display: false }, { triggerTurn: false });
	});

	pi.on("input", () => {
		let changed = false;
		for (const c of children) {
			if (c.status !== "running" && !dismissed.has(c.id)) {
				dismissed.add(c.id);
				changed = true;
			}
		}
		if (changed) refresh();
	});

	pi.on("agent_start", () => {
		agentRunning = true;
		reportedWorking = false;
	});

	// Escape stops the agent: it stops every sub-agent too, so none wakes the agent up again.
	pi.on("agent_settled", (event) => {
		agentRunning = false;
		// Escape and `/compact` both abort; `session_before_compact` comes right after the abort, so wait a tick to tell them apart.
		if (event.aborted) setTimeout(() => !compacting && stopAll(), 50);
		// Run after pi's ProgramStatusReporter finishes reporting done/idle so background sub-agents keep the tab active.
		queueMicrotask(syncTerminalStatus);
	});

	pi.on("session_shutdown", () => {
		const sessionFile = currentSessionFile;
		closing = true;
		session = undefined;
		agentRunning = false;
		clearInterval(timer);
		timer = undefined;
		if (reportedWorking && tuiRef) {
			reportedWorking = false;
			tuiRef.terminal.setProgramStatus({ state: "idle", app: "pi" });
			tuiRef.terminal.setProgress(false);
		}
		tuiRef = undefined;
		const hasLiveBg = DEPTH === 0 && children.some((c) => c.background && c.status === "running");
		if (hasLiveBg) {
			children.forEach((c) => c.setOnChange(() => {}));
			const stopLive = () => children.forEach((c) => c.stop());
			const onExit = () => stopLive();
			process.once("exit", onExit);
			// If no reloaded extension adopts these within 3 s (e.g. extension disabled), stop them.
			const cleanup = setTimeout(() => {
				const store = globalThis as Record<symbol, Handoff | undefined>;
				if (store[HANDOFF_KEY]?.timer === cleanup) delete store[HANDOFF_KEY];
				process.off("exit", onExit);
				stopLive();
			}, 3000);
			cleanup.unref();
			(globalThis as Record<symbol, Handoff | undefined>)[HANDOFF_KEY] = {
				sessionFile,
				children: [...children],
				dismissed: new Set(dismissed),
				timer: cleanup,
				onExit,
			};
			return;
		}
		stopAll();
	});

	if (FORKED_AT) {
		pi.on("context_with_system", (event) => {
			const messages = dropForkDrift(event.messages, FORKED_AT);
			return messages === event.messages ? undefined : { messages };
		});
	}
}
