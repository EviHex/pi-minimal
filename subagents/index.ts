import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type Child, piInvocation, snapshot, startChild } from "./child.ts";
import { dropForkDrift, forkFileText, lastAssistantText, restoreRecords, sanitizeSessionText, type SubagentRecord } from "./fork.ts";
import {
	type ChildMode,
	childPrompt,
	GUIDANCE,
	parseSpawnArgs,
	resolveModel,
	resolveThinking,
	spawnNote,
	STATUS_TOOL_DESCRIPTION,
	subagentsCompletions,
	THINKING_LEVELS,
	TOOL_DESCRIPTION,
} from "./prompts.ts";
import { resultView, statusReport, Viewer, widgetLines } from "./ui.ts";

/** How deep this pi is: 0 for the user's, 1 for a sub-agent, 2 for its sub-agent... */
const DEPTH = Number(process.env.PI_MINIMAL_SUBAGENT_DEPTH) || 0;
/** In a sub-agent: when it was forked (ms). Its messages are newer. */
const FORKED_AT = Number(process.env.PI_MINIMAL_SUBAGENT_FORKED_AT) || 0;
/** Guard against a fork bomb: a sub-agent at this depth cannot start another. */
const MAX_DEPTH = 3;

const oneLine = (text: string) => (text.length > 100 ? `${text.slice(0, 99)}…` : text).replace(/\s+/g, " ");

export default function (pi: ExtensionAPI) {
	const children: Child[] = [];
	const history = new Map<number, SubagentRecord>();
	let nextId = 1;
	let session: ExtensionContext | undefined; // for the widget, which changes outside handlers
	let tuiRef: TUI | undefined;
	let agentRunning = false;
	let reportedWorking = false;
	let rerenderViewer: (() => void) | undefined;
	let timer: NodeJS.Timeout | undefined; // ticks the widget's clocks
	let guidance = GUIDANCE;
	let closing = false;
	let widgetMode: "auto" | "show" | "hide" = "auto";

	/** Keep terminal tab indicators (OSC 7501 + OSC 9;4) active while background sub-agents run and the main agent is idle. */
	const syncTerminalStatus = () => {
		if (DEPTH > 0 || !tuiRef) return;
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
		rerenderViewer?.();
		if (DEPTH > 0) {
			process.stdout.write(`${JSON.stringify({ type: "subagent_children", children: children.map(snapshot) })}\n`);
			return;
		}
		const running = children.filter((c) => c.status === "running").length;
		pi.events.emit("subagents:status", { running, total: children.length });
		if (!session?.hasUI) return;
		const lines = widgetMode === "hide" ? [] : widgetLines(children, session.ui.theme, Date.now(), widgetMode === "show");
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
		const args = ["--mode", "json", "--session", file, "--provider", model.provider, "--model", model.id];
		args.push("--thinking", thinking, childPrompt(task, mode));
		const env: NodeJS.ProcessEnv = { ...process.env, PI_MINIMAL_SUBAGENT_DEPTH: `${DEPTH + 1}` };
		if (mode === "fork") env.PI_MINIMAL_SUBAGENT_FORKED_AT = `${Date.now()}`;
		else delete env.PI_MINIMAL_SUBAGENT_FORKED_AT;
		const fullModel = `${model.provider}/${model.id}`;
		const label = opts.label?.trim() || (prev && prev.label !== prev.task ? prev.label : undefined);
		const child = startChild(nextId++, task, file, piInvocation(args), ctx.cwd, env, refresh, {
			label,
			model: fullModel,
			thinking,
			group: opts.group,
			contextWindow: model.contextWindow,
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
	const deliverLater = (child: Child) =>
		void child.done.then(() => {
			if (closing) return;
			const waitForGroup = Boolean(child.group && children.some((c) => c.group === child.group && c.status === "running"));
			const content = statusReport(child);
			pi.sendMessage({ customType: "subagent", content, display: true }, { triggerTurn: child.status !== "stopped" && !waitForGroup });
		});

	pi.registerTool({
		name: "subagent",
		label: "Sub-agent",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({
			task: Type.String({ description: "What the sub-agent must do, and what it must report." }),
			label: Type.Optional(Type.String({ description: "Short label shown in the status widget and notifications." })),
			fresh: Type.Optional(Type.Boolean({ description: "Start with an empty conversation instead of forking this one." })),
			resume: Type.Optional(Type.Number({ description: "Resume a finished or stopped sub-agent by its #id, keeping its conversation." })),
			model: Type.Optional(Type.String({ description: "Model for the sub-agent (provider/id or id). Defaults to the current model." })),
			thinking: Type.Optional(
				Type.Union(
					THINKING_LEVELS.map((l) => Type.Literal(l)),
					{ description: "Thinking level for the sub-agent. Defaults to the current level." },
				),
			),
			run_in_background: Type.Optional(Type.Boolean({ description: "Return at once; the result arrives later as a message." })),
			group: Type.Optional(Type.String({ description: "Batch group name (with run_in_background): only wakes you once when the last sub-agent in the group finishes." })),
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
			// A sub-agent runs in print mode, which exits when its run ends: its own sub-agents run in the foreground.
			if (params.run_in_background && DEPTH === 0) {
				deliverLater(child);
				return {
					content: [{ type: "text", text: `Sub-agent #${child.id} (${child.model}, ${child.thinking}) started in the background.` }],
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
				args.run_in_background && "background",
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
				const head = `Sub-agent #${prior.id}${prior.label && prior.label !== prior.task ? ` [${oneLine(prior.label)}]` : ""}${spec ? ` (${spec})` : ""} (from before reload).`;
				const output = existsSync(prior.file) ? lastAssistantText(readFileSync(prior.file, "utf8")) : "";
				const meta = `Session: ${prior.file} · Use resume: ${prior.id} to continue.`;
				return { content: [{ type: "text", text: [head, output, meta].filter(Boolean).join("\n\n") }], details: {} };
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

	pi.registerMessageRenderer("subagent", (message, { expanded }, theme) =>
		resultView(typeof message.content === "string" ? message.content : "", expanded, theme),
	);

	const handleCommand = async (args: string, ctx: ExtensionContext) => {
		const trimmed = args.trim();
		if (trimmed === "stop") return stopAll();
		if (trimmed === "show" || trimmed === "hide") {
			widgetMode = trimmed;
			refresh();
			if (trimmed === "show" && !children.length) ctx.ui.notify("No sub-agent in this session yet.", "info");
			return;
		}
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
		if (!children.length) return ctx.ui.notify("No sub-agent in this session yet.", "info");
		const labels = children
			.map((c) => {
				const ctxStr = c.contextTokens ? ` · ${Math.round(c.contextTokens / 1000)}k${c.contextWindow ? `/${Math.round(c.contextWindow / 1000)}k` : ""}` : "";
				const sum = c.summary ? ` — ${oneLine(c.summary)}` : "";
				return `#${c.id} ${c.status} · ${oneLine(c.label)}${ctxStr}${sum}`;
			})
			.reverse();
		const picked = await ctx.ui.select("Sub-agents", labels);
		const child = children.find((c) => picked?.startsWith(`#${c.id} `));
		if (!child || ctx.mode !== "tui") return;
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				rerenderViewer = () => tui.requestRender();
				return new Viewer(child, tui, theme, () => {
					rerenderViewer = undefined;
					done();
				});
			},
			{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } },
		);
	};

	const commandSpec = {
		description: "View or manage sub-agents: /subagents [spawn [--fresh] [--model] [--thinking] <task> | stop | show | hide] (alias: /sa)",
		getArgumentCompletions: (prefix: string) => subagentsCompletions(prefix, session ? availableModels(session) : []),
		handler: handleCommand,
	};
	pi.registerCommand("subagents", commandSpec);
	pi.registerCommand("sa", commandSpec);

	// Read at session_start: settings and prior sub-agent history are not available while the extension loads.
	pi.on("session_start", (_event, ctx) => {
		session = ctx;
		const settings = pi.getSettings() as { "pi-minimal"?: { subagents?: { guidance?: string } } };
		guidance = settings["pi-minimal"]?.subagents?.guidance ?? GUIDANCE;
		if (DEPTH === 0) {
			history.clear();
			for (const rec of restoreRecords(ctx.sessionManager.getBranch())) history.set(rec.id, rec);
			const maxId = Math.max(0, ...children.map((c) => c.id), ...history.keys());
			nextId = maxId + 1;
		}
	});

	// Same text in every fork, so it does not break the prompt cache.
	pi.on("before_agent_start", (event) => {
		if (guidance) event.systemPromptOptions.sections.subagents = guidance;
	});

	pi.on("agent_start", () => {
		agentRunning = true;
		reportedWorking = false;
	});

	// Escape stops the agent: it stops every sub-agent too, so none wakes the agent up again.
	pi.on("agent_settled", (event) => {
		agentRunning = false;
		if (event.aborted) stopAll();
		// Run after pi's ProgramStatusReporter finishes reporting done/idle so background sub-agents keep the tab active.
		queueMicrotask(syncTerminalStatus);
	});

	pi.on("session_shutdown", () => {
		closing = true;
		agentRunning = false;
		stopAll();
		if (reportedWorking && tuiRef) {
			reportedWorking = false;
			tuiRef.terminal.setProgramStatus({ state: "idle", app: "pi" });
			tuiRef.terminal.setProgress(false);
		}
		clearInterval(timer);
	});

	if (FORKED_AT) {
		pi.on("context_with_system", (event) => {
			const messages = dropForkDrift(event.messages, FORKED_AT);
			return messages === event.messages ? undefined : { messages };
		});
	}
}
