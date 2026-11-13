import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Same names and order as pi's own loader, which handles cwd and its parents. */
const NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
/** Tools whose `path` input triggers the lookup. */
const TOOLS = ["read", "edit", "write"];
/** Longest part of one file that is injected, in characters. */
const MAX_CHARS = 32_000;

/** What one tool result brings to the agent. */
interface Found {
	/** Real paths of the instruction files now in the agent's context. Saved in the result's `details`. */
	files: string[];
	/** Text to append: one block per instruction file (parents first), or a line about a failed read. */
	texts: string[];
}

/** The marker this extension adds to the `details` of a tool result. The model never sees `details`. */
type Marked = { nestedContext?: string[] } | undefined;

/**
 * Resolve symlinks. `undefined` when the path does not exist.
 * `.native` also returns the letter case on disk (macOS), so two spellings give one key.
 */
const real = (path: string): string | undefined => {
	try {
		return realpathSync.native(path);
	} catch {
		return undefined;
	}
};

/** True when `path` is `dir` itself or inside it. Both must be real paths. */
const within = (dir: string, path: string): boolean => path === dir || path.startsWith(dir + sep);

/** The nearest directory from `dir` up that holds `.git` (a folder, or a file in a worktree). */
function gitRoot(dir: string): string | undefined {
	for (; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return undefined; // Reached "/".
	}
}

/** How a path is shown to the model: relative inside cwd, absolute outside. */
const show = (cwd: string, path: string): string => (within(cwd, path) ? relative(cwd, path) : path);

/** The file content in a tag that says where it applies. Long files are cut, with a note. */
function render(cwd: string, dir: string, file: string): string {
	let text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
	if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n[truncated: read the file for the rest]`;
	// JSON.stringify quotes and escapes odd characters in file names.
	const path = JSON.stringify(show(cwd, file));
	const scope = JSON.stringify(`${show(cwd, dir)}/`);
	return `<nested_instructions path=${path} scope=${scope}>\n${text}\n</nested_instructions>`;
}

/** `a` followed by `b`. */
const merge = (a: Found | undefined, b: Found | undefined): Found => ({
	files: [...(a?.files ?? []), ...(b?.files ?? [])],
	texts: [...(a?.texts ?? []), ...(b?.texts ?? [])],
});

export default function (pi: ExtensionAPI): void {
	// pi's agent dir (~/.pi/agent). Read once: it does not change during a run.
	const agentDir = real(getAgentDir());

	/** Real paths of the instruction files the agent has in its context (or that failed to read). */
	const seen = new Set<string>();
	/**
	 * What nested calls (codemode) found, by the id of the outer call. A nested result goes to
	 * the calling script, not to the model, so it waits for the outer result.
	 */
	const pending = new Map<string, Found>();

	/**
	 * Make `seen` match what the model sees now: the tool results on the current branch, after
	 * the last compaction. Runs on a new session or /resume, after compaction, and after /tree.
	 */
	const rebuild = (_event: unknown, ctx: ExtensionContext): void => {
		seen.clear();
		pending.clear();
		for (const message of ctx.sessionManager.buildSessionProjection().messages)
			if (message.role === "toolResult") for (const file of (message.details as Marked)?.nestedContext ?? []) seen.add(file);
	};
	pi.on("session_start", rebuild);
	pi.on("session_compact", rebuild);
	pi.on("session_tree", rebuild);

	/**
	 * pi loaded the instruction file of this directory at startup: pi reads cwd and every
	 * directory above it, and its agent dir (which is below cwd when pi runs in ~ or ~/.pi).
	 */
	const loadedByPi = (cwd: string, dir: string): boolean => within(dir, cwd) || dir === agentDir;

	/**
	 * The instruction file pi would pick in `dir`, as a real path. A symlink is followed only
	 * if it stays inside `top` (else it could copy any file into the context) and does not
	 * land on a file pi loaded already.
	 */
	function instructionFile(cwd: string, top: string, dir: string): string | undefined {
		for (const name of NAMES) {
			const file = real(join(dir, name));
			if (file && within(top, dirname(file)) && !loadedByPi(cwd, dirname(file)) && statSync(file).isFile()) return file;
		}
	}

	/**
	 * Find the instruction files that apply to `input` and that the agent has not seen yet, and
	 * claim them in `seen`. The walk goes from the file's directory up to a top directory:
	 * - inside cwd, up to cwd;
	 * - outside cwd, up to the root of the file's git repository (included: pi did not load
	 *   it). A file in no git repository gets nothing: there is no bound to stop the walk.
	 * Directories pi loaded at startup are skipped on the way.
	 *
	 * @param direct True when the tool output goes to the model: if `input` is itself an
	 *               instruction file, the agent is reading it now, so it needs no copy.
	 */
	function find(cwd: string, input: unknown, direct: boolean, ctx: ExtensionContext): Found | undefined {
		if (typeof input !== "string") return;
		// Spelled like pi's tools do: no leading @, and ~ is home. The call succeeded, so the file exists.
		const target = real(resolve(cwd, input.replace(/^@/, "").replace(/^~(?=\/|$)/, homedir())));
		if (!target) return;
		const top = within(cwd, target) ? cwd : gitRoot(dirname(target));
		// Skip installed packages. Their AGENTS.md is written for the people who work on that
		// package (or is even a persona prompt), not for this project, and any dependency could
		// use it to steer the agent. Checked on the real path, so a workspace package that
		// node_modules only links to (monorepo) still gets its rules.
		if (!top || relative(top, target).split(sep).includes("node_modules")) return;

		const found: Found = { files: [], texts: [] };
		// Deepest first. Inside cwd, the last step is cwd itself, which `loadedByPi` skips.
		// `prev` stops at "/", which is its own parent.
		for (let dir = dirname(target), prev = ""; dir !== prev && within(top, dir); prev = dir, dir = dirname(dir)) {
			if (loadedByPi(cwd, dir)) continue;
			const file = instructionFile(cwd, top, dir);
			if (!file || seen.has(file)) continue;
			// Claimed now, even if the read fails: a parallel result cannot add it twice,
			// and a broken file warns once, not on every access.
			seen.add(file);
			if (direct && file === target) {
				found.files.push(file); // The agent is reading it right now.
				continue;
			}

			const path = show(cwd, file);
			try {
				found.texts.unshift(render(cwd, dir, file)); // The walk goes deepest first; unshift puts parents first.
				found.files.push(file);
			} catch (error) {
				// The file was found a moment ago, so this is rare: no permission (EACCES), or deleted since.
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`nested-context: the agent did not get the rules of ${path}. Reading it failed: ${reason}. Fix the file, then /reload.`, "warning");
				// Tell the model too, so it can read the file itself or tell the user.
				found.texts.unshift(`[nested-context] ${JSON.stringify(path)} has rules for ${JSON.stringify(`${show(cwd, dir)}/`)}, but reading it failed (${(error as NodeJS.ErrnoException).code ?? reason}). Its rules are NOT applied.`);
			}
		}
		return found;
	}

	// Synchronous on purpose: parallel tool results cannot both claim the same file.
	pi.on("tool_result", (event, ctx) => {
		const cwd = real(ctx.cwd);
		if (!cwd) return;
		const nested = event.parentToolCallId !== undefined;
		// A failed call showed the agent nothing of its directories.
		const own = event.isError || !TOOLS.includes(event.toolName) ? undefined : find(cwd, event.input.path, !nested, ctx);

		if (nested) {
			// Nested ids are `<outer id>/<n>` (deeper: `<outer id>/<n>/<m>`). Keep it for the outer result.
			const outer = event.toolCallId.split("/")[0];
			if (own) pending.set(outer, merge(pending.get(outer), own));
			return;
		}

		// The outer result reaches the model even when it is an error (the script may have read
		// files before it failed), so it gets what its nested calls found.
		const found = merge(pending.get(event.toolCallId), own);
		pending.delete(event.toolCallId);
		if (found.files.length === 0 && found.texts.length === 0) return;

		// The marker lets `rebuild` know later which files this result carries.
		const details = { ...(event.details as object | undefined), nestedContext: found.files };
		if (found.texts.length === 0) return { details };
		const text = `Instructions for the directories you accessed. The deepest file wins:\n\n${found.texts.join("\n\n")}`;
		return { content: [...event.content, { type: "text", text }], details };
	});
}
