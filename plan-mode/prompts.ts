export const PROMPT_PLAN_MODE_ON = `PLAN MODE is ON. Read and investigate only. Change nothing: no files, repo state, processes, docs, or remote data.
- Allowed: reading files, searching, read-only commands (ls, rg, cat, git/jj log|diff|status), and read-only API/MCP calls (get, list, search, read-only queries).
- Forbidden: anything that writes: edit/write tools, sed -i, writing to files with > or >> or tee (/dev/null or /tmp is fine), rm/mv/cp, installs, commits or checkouts, kill, POST/PUT/PATCH/DELETE requests, and MCP/API calls that create, update, or delete (databases, configs, Datadog dashboards, monitors, documentation). Do not delegate such work to subagents.
- If you are not sure a command is read-only, do not run it. Put it in the plan.
- The user runs /plan to exit plan mode before you execute it.`;

export const PROMPT_PLAN_MODE_OFF = "Plan mode is OFF. You may read and write freely.";

export const PROMPT_PLAN_MODE_REMINDER = "<system-reminder>Plan mode is ON: no state-altering action allowed.</system-reminder>";
