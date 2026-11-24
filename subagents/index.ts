import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type Child, piInvocation, startChild } from "./child.ts";
import { dropForkDrift, forkFileText } from "./fork.ts";
import { forkPrompt, GUIDANCE, spawnNote, TOOL_DESCRIPTION } from "./prompts.ts";
import { headline, resultView, Viewer, widgetLines } from "./ui.ts";

/** How deep this pi is: 0 for the user's, 1 for a sub-agent, 2 for its sub-agent... */
const DEPTH = Number(process.env.PI_MINIMAL_SUBAGENT_DEPTH) || 0;
/** In a sub-agent: when it was forked (ms). Its messages are newer. */
const FORKED_AT = Number(process.env.PI_MINIMAL_SUBAGENT_FORKED_AT) || 0;
/** Guard against a fork bomb: a sub-agent at this depth cannot start another. */
const MAX_DEPTH = 3;

const resultText = (child: Child) => `${headline(child)}\n\n${child.output}`.trim();
const oneLine = (text: string) => (text.length > 100 ? `${text.slice(0, 99)}…` : text).replace(/\s+/g, " ");

export default function (pi: ExtensionAPI) {
	const children: Child[] = [];
	let session: ExtensionContext | undefined; // for the widget, which changes outside handlers
	let rerenderViewer: (() => void) | undefined;
	let timer: NodeJS.Timeout | undefined; // ticks the widget's clocks
	let guidance = GUIDANCE;
	let closing = false;

	const refresh = () => {
		rerenderViewer?.();
		if (!session?.hasUI) return;
		const lines = widgetLines(children, session.ui.theme, Date.now());
		session.ui.setWidget("subagents", lines.length ? lines : undefined);
		if (lines.length && !timer) timer = setInterval(refresh, 1000);
		if (!lines.length) {
			clearInterval(timer);
			timer = undefined;
		}
	};
	const stopAll = () => children.forEach((child) => child.stop());

	/** Fork the current branch into a new session file and run a pi on it with `task`. */
	function fork(task: string, ctx: ExtensionContext): Child {
		if (DEPTH >= MAX_DEPTH) throw new Error(`Sub-agents nest at most ${MAX_DEPTH} levels deep: this one cannot start another.`);
		const model = ctx.model;
		if (!model) throw new Error("No model is selected.");
		const sessions = ctx.sessionManager;
		const parentFile = sessions.getSessionFile();
		const dir = parentFile ? join(parentFile.replace(/\.jsonl$/, ""), "subagents") : join(tmpdir(), "pi-subagents");
		const id = randomUUID();
		const file = join(dir, `${id}.jsonl`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, forkFileText(sessions.getHeader(), ctx.cwd, sessions.getBranch(), id, parentFile));
		const args = ["--mode", "json", "--session", file, "--provider", model.provider, "--model", model.id];
		args.push("--thinking", pi.getThinkingLevel(), forkPrompt(task));
		const env = { ...process.env, PI_MINIMAL_SUBAGENT_DEPTH: `${DEPTH + 1}`, PI_MINIMAL_SUBAGENT_FORKED_AT: `${Date.now()}` };
		const child = startChild(children.length + 1, task, file, piInvocation(args), ctx.cwd, env, refresh);
		children.push(child);
		refresh();
		return child;
	}

	/** Send the result of a background child when it ends. Only a child that was not stopped wakes the agent. */
	const deliverLater = (child: Child) =>
		void child.done.then(() => {
			if (closing) return;
			const content = resultText(child);
			pi.sendMessage({ customType: "subagent", content, display: true }, { triggerTurn: child.status !== "stopped" });
		});

	pi.registerTool({
		name: "subagent",
		label: "Sub-agent",
		description: TOOL_DESCRIPTION,
		parameters: Type.Object({
			task: Type.String({ description: "What the sub-agent must do, and what it must report." }),
			run_in_background: Type.Optional(Type.Boolean({ description: "Return at once; the result arrives later as a message." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const child = fork(params.task, ctx);
			// A sub-agent runs in print mode, which exits when its run ends: its own sub-agents run in the foreground.
			if (params.run_in_background && DEPTH === 0) {
				deliverLater(child);
				return { content: [{ type: "text", text: `Sub-agent #${child.id} started in the background.` }], details: {} };
			}
			signal?.addEventListener("abort", child.stop, { once: true });
			await child.done;
			signal?.removeEventListener("abort", child.stop);
			if (child.status !== "done") throw new Error(resultText(child));
			return { content: [{ type: "text", text: resultText(child) }], details: {} };
		},
		renderCall: (args, theme) =>
			new Text(
				theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", oneLine(args.task ?? "")) +
					(args.run_in_background ? theme.fg("dim", " (background)") : ""),
				0,
				0,
			),
		renderResult: (result, { expanded, isPartial }, theme) => {
			if (isPartial) return new Text(theme.fg("dim", "running…"), 0, 0);
			const part = result.content[0];
			return resultView(part?.type === "text" ? part.text : "", expanded, theme);
		},
	});

	pi.registerMessageRenderer("subagent", (message, { expanded }, theme) =>
		resultView(typeof message.content === "string" ? message.content : "", expanded, theme),
	);

	pi.registerCommand("spawn", {
		description: "Start a background sub-agent on a fork of this conversation: /spawn <task>",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) return ctx.ui.notify("Usage: /spawn <task>", "warning");
			try {
				const child = fork(task, ctx);
				deliverLater(child);
				pi.sendMessage({ customType: "subagent", content: spawnNote(child.id, task), display: true }, { triggerTurn: false });
			} catch (error) {
				ctx.ui.notify(`${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("subagents", {
		description: "View the sub-agents of this session; /subagents stop stops the running ones",
		getArgumentCompletions: (prefix) => ("stop".startsWith(prefix) ? [{ value: "stop", label: "stop" }] : null),
		handler: async (args, ctx) => {
			if (args.trim() === "stop") return stopAll();
			if (!children.length) return ctx.ui.notify("No sub-agent in this session yet.", "info");
			const labels = children.map((child) => `#${child.id} ${child.status} · ${oneLine(child.task)}`).reverse();
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
		},
	});

	// Read at session_start: settings are not available while the extension loads.
	pi.on("session_start", (_event, ctx) => {
		session = ctx;
		const settings = pi.getSettings() as { "pi-minimal"?: { subagents?: { guidance?: string } } };
		guidance = settings["pi-minimal"]?.subagents?.guidance ?? GUIDANCE;
	});

	// Same text in every fork, so it does not break the prompt cache.
	pi.on("before_agent_start", (event) => {
		if (guidance) event.systemPromptOptions.sections.subagents = guidance;
	});

	// Escape stops the agent: it stops every sub-agent too, so none wakes the agent up again.
	pi.on("agent_settled", (event) => {
		if (event.aborted) stopAll();
	});

	pi.on("session_shutdown", () => {
		closing = true;
		stopAll();
		clearInterval(timer);
	});

	if (FORKED_AT) {
		pi.on("context_with_system", (event) => {
			const messages = dropForkDrift(event.messages, FORKED_AT);
			return messages === event.messages ? undefined : { messages };
		});
	}
}
