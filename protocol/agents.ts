/**
 * What differs between coding agents, in one place.
 *
 * Claude Code and Codex send hooks the same fields — `session_id`, `cwd`,
 * `prompt`, `tool_name`, `tool_input` — and read the same output. What differs
 * is the tools: Claude Code edits with `Edit` and runs `Bash`, Codex edits with
 * `apply_patch` and runs `exec_command`. The hooks translate each call into
 * the actions anvc records (read, write, command, delegation) here, so nothing
 * downstream needs to know which agent made them.
 */
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "./activity";
import { flag, positional } from "./args";
import { folderOn } from "./folders";
import { gitOrNull } from "./git";

export const AGENTS = ["claude-code", "codex", "cursor"] as const;
/** How each agent is named to a person. */
export const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" };

/** Which of the agents setup knows are installed here, by the command each is started with. */
export const installedAgents = () =>
  AGENTS.filter((a) => Bun.which({ "claude-code": "claude", codex: "codex", cursor: "cursor" }[a]));

/** `--agent <name>` from a hook's command line; Claude Code when absent. */
export function agentArg(argv: string[]): string {
  const name = flag(argv, "agent");
  return name && /^[a-z0-9-]+$/.test(name) ? name : "claude-code";
}

/** The first argument that is not a flag or a flag's value: the hook event. */
export const eventArg = positional;

/**
 * Files an `apply_patch` call touches, from the patch text.
 *
 * Codex's patch format names each file on its own header line:
 * `*** Add File: x`, `*** Update File: x`, `*** Delete File: x`, and
 * `*** Move to: y` for a rename.
 */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    const path = (m[1] ?? m[2])!.trim();
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

export interface ToolCall {
  /** anvc's name for the action: Read, Edit, Bash, Task, or the agent's own name when none fits. */
  tool: string | null;
  paths: string[];
  command: string | null;
  bytes: number | null;
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One tool call, in the terms the rest of anvc records. */
export function toolCall(name: unknown, input: Record<string, unknown>): ToolCall {
  const tool = typeof name === "string" ? name : null;
  const path = text(input.file_path) ?? text(input.path) ?? text(input.notebook_path);
  const bytes = text(input.content)?.length ?? text(input.new_string)?.length ?? null;
  switch (tool) {
    // Codex runs commands through exec_command; `cmd` is a string or an argv.
    case "exec_command":
    case "shell":
    case "local_shell":
    case "Shell": {
      const cmd = input.cmd ?? input.command;
      const command = Array.isArray(cmd) ? cmd.map(String).join(" ") : text(cmd);
      return { tool: "Bash", paths: [], command, bytes: null };
    }
    case "apply_patch": {
      const patch = text(input.input) ?? text(input.patch) ?? text(input.command) ?? "";
      return { tool: "Edit", paths: patchPaths(patch), command: null, bytes: patch.length || null };
    }
    case "Bash":
      return { tool, paths: [], command: text(input.command), bytes: null };
    // Cursor edits a file in place with StrReplace; it is an edit like any other.
    case "StrReplace":
    case "MultiEdit":
      return { tool: "Edit", paths: path ? [path] : [], command: null, bytes: text(input.new_string)?.length ?? null };
    default:
      return { tool, paths: path ? [path] : [], command: null, bytes };
  }
}

/**
 * The session an agent is in, for tools that are not told.
 *
 * Claude Code gives its MCP servers the session id in the environment; Codex
 * and Cursor give it only to hooks. So the hooks write it down, per agent and
 * repository, and the MCP server reads it when it files a record. Two sessions
 * of the same agent in the same repository at once will share the newest id,
 * which files a record under the wrong session but never loses it.
 */
const sessionsFile = () => join(process.env.ANVC_STATE_DIR ?? join(homedir(), ".anvc"), "sessions.json");

type Sessions = Record<string, { session: string; ts: string }>;

function readSessions(): Sessions {
  try { return JSON.parse(readFileSync(sessionsFile(), "utf8")) as Sessions; } catch { return {}; }
}

export function noteSession(agent: string, repo: string, session: string): void {
  try {
    const all = readSessions();
    const key = `${agent}\u0000${repo}`;
    if (all[key]?.session === session) return;
    all[key] = { session, ts: new Date().toISOString() };
    const file = sessionsFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(all));
  } catch { /* a missed note costs a session label, never the session */ }
}

export function currentSession(agent: string, repo: string): string | null {
  return readSessions()[`${agent}\u0000${repo}`]?.session ?? null;
}

type Payload = Record<string, unknown>;

/**
 * Whether this hook is the plugin's copy while the project runs ANVC's hooks
 * itself, as ANVC's own checkout does from its committed settings. Installed
 * for every repository, the plugin would otherwise run beside them and every
 * event there would be captured and answered twice. The project's own hooks
 * win, since they are the ones someone set up for this project.
 */
export function shadowedByProject(): boolean {
  if (!process.env.CLAUDE_PLUGIN_ROOT) return false;
  const dir = process.env.CLAUDE_PROJECT_DIR;
  if (!dir) return false;
  for (const name of ["settings.json", "settings.local.json"]) {
    try {
      if (readFileSync(join(dir, ".claude", name), "utf8").includes("emitters/claude-code/")) return true;
    } catch { /* no such file */ }
  }
  return false;
}

/**
 * What every hook starts with: the payload on stdin, the event and the agent
 * that sent it, and the folder the agent works in. Exits when the project runs
 * ANVC's own hooks; see shadowedByProject.
 */
export async function hookInput() {
  const raw = await Bun.stdin.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = raw.trim() ? JSON.parse(raw) : {};
  const argv = process.argv.slice(2);
  const event = eventArg(argv) ?? payload.hook_event_name;
  const agent = agentOf(argv, payload);
  // The project runs ANVC's own hooks: this copy steps aside (null).
  if (shadowedByProject()) return null;
  return { payload, event, agent, cwd: cwdOf(payload) };
}

/**
 * The repository a hook runs in: `repo` as git names this worktree, `root` as
 * every worktree of it agrees (see repoRoot). Exits outside a repository, and
 * in a folder ANVC is turned off for.
 */
export function hookRepo(cwd: string): { repo: string; root: string } | null {
  const repo = gitOrNull(cwd, ["rev-parse", "--show-toplevel"]);
  if (!repo) return null;
  const root = repoRoot(repo) ?? repo;
  return folderOn(root) ? { repo, root } : null;
}

/**
 * Which agent ran this hook. `--agent` when setup wrote one; otherwise Cursor
 * is recognised by the `cursor_version` it sends with every hook, since it can
 * also run the hooks written for Claude Code.
 */
export function agentOf(argv: string[], payload: Payload): string {
  if (argv.includes("--agent")) return agentArg(argv);
  if (typeof payload.cursor_version === "string") return "cursor";
  // A plugin's hooks are the same for every agent, so Codex is told apart by
  // where it keeps its session files.
  if (typeof payload.transcript_path === "string" && /[\\/]\.codex[\\/]sessions[\\/]/.test(payload.transcript_path)) return "codex";
  return "claude-code";
}

/** The directory the agent works in. Cursor sends its workspace roots instead of a cwd on most events. */
export function cwdOf(payload: Payload): string {
  if (typeof payload.cwd === "string" && payload.cwd) return payload.cwd;
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string") return roots[0];
  return process.cwd();
}

/**
 * Text added to the agent's context. Claude Code and Codex read it nested
 * under `hookSpecificOutput`; Cursor reads `additional_context` at the top.
 */
export function contextOutput(agent: string, event: string, text: string): Payload {
  if (agent === "cursor") return { additional_context: text };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

/**
 * Asks the agent to keep going instead of stopping. Cursor cannot block a
 * stop; it sends `followup_message` as the next message instead, which has
 * the same effect.
 */
export function continueOutput(agent: string, reason: string): Payload {
  if (agent === "cursor") return { followup_message: reason };
  return { decision: "block", reason };
}

/** A line for the person, not the model. Cursor's stop hook has no such field. */
export function noticeOutput(agent: string, text: string): Payload | null {
  return agent === "cursor" ? null : { systemMessage: text };
}

/** Whether this stop is already the continuation a stop hook asked for. */
export function continuing(payload: Payload): boolean {
  return Boolean(payload.stop_hook_active) || (typeof payload.loop_count === "number" && payload.loop_count > 0);
}

/** A tool call's result, with Cursor's JSON-in-a-string unpacked. */
export function responseOf(payload: Payload): unknown {
  const response = payload.tool_response ?? payload.tool_output;
  if (typeof response !== "string" || !response.startsWith("{")) return response;
  try {
    const parsed: unknown = JSON.parse(response);
    return parsed && typeof parsed === "object" ? parsed : response;
  } catch { return response; }
}

/**
 * Whether a tool call worked.
 *
 * Claude Code sends a failed call only to PostToolUseFailure, with an `error`,
 * and fires PostToolUse only on success, with no exit code in it. Measured
 * live on 2.1.283: 8,398 captured Claude Code commands, none marked as
 * passed or failed, because capture listened on PostToolUse alone. Codex
 * reports failures on PostToolUse, with an exit code or text naming one.
 * Cursor sends them to postToolUseFailure, with an `error_message`, and a
 * success's `tool_output` as a JSON string carrying `exitCode`.
 */
export function succeeded(payload: Payload, event?: string, agent?: string): boolean | null {
  if (event === "PostToolUseFailure") return false;
  if (typeof payload.error_message === "string" && payload.error_message) return false;
  if (typeof payload.error === "string" && payload.error) return false;
  const response = responseOf(payload);
  if (typeof response === "string") {
    const code = /(?:exited with code|exit code:?)\s*(\d+)/i.exec(response)?.[1];
    return code === undefined ? null : code === "0";
  }
  if (!response || typeof response !== "object") return null;
  const r = response as { success?: unknown; exit_code?: unknown; exitCode?: unknown };
  if (typeof r.success === "boolean") return r.success;
  const exit = r.exit_code ?? r.exitCode;
  if (typeof exit === "number") return exit === 0;
  return agent === "claude-code" && event === "PostToolUse" ? true : null;
}

/** What a tool call printed, whichever field the agent put it in. */
export function outputOf(payload: Payload): string | null {
  const response = responseOf(payload);
  const parts = typeof response === "string" ? [response]
    : response && typeof response === "object"
      ? ["stdout", "stderr", "output"].map((k) => (response as Record<string, unknown>)[k])
      : [];
  if (typeof payload.error_message === "string") parts.push(payload.error_message);
  if (typeof payload.error === "string") parts.push(payload.error);
  const text = parts.filter((x): x is string => typeof x === "string" && x.length > 0).join("\n");
  return text || null;
}

/**
 * Whether a Codex command worked, read from its session file.
 *
 * Codex hands the hook a shell command's output with no exit code, so a
 * failure looks exactly like a success. Measured in a live Codex 0.157.1 run:
 * every captured command had no result, and stuck detection never spoke. The
 * session file does record it, as an item with the full command line and its
 * exit code, written about 20 ms before the hook runs. So the newest item
 * whose command ends with this one answers.
 */
export function codexExit(transcript: unknown, command: string | null): boolean | null {
  if (typeof transcript !== "string" || !command) return null;
  let text = "";
  try {
    const size = statSync(transcript).size;
    const fd = openSync(transcript, "r");
    const start = Math.max(0, size - 256 * 1024);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    text = buf.toString("utf8");
  } catch { return null; }
  const want = command.trim();
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"CommandExecution"') && !line.includes('"exec_command_end"')) continue;
    try {
      const row = JSON.parse(line) as { payload?: Record<string, unknown> };
      const p = row.payload ?? {};
      const item = (p.type === "item_completed" ? p.item : p) as Record<string, unknown> | undefined;
      if (!item) continue;
      const cmd = Array.isArray(item.command) ? item.command.map(String).join(" ") : String(item.command ?? "");
      if (!cmd.trim().endsWith(want)) continue;
      return typeof item.exit_code === "number" ? item.exit_code === 0 : null;
    } catch { /* a line cut by the read window */ }
  }
  return null;
}
