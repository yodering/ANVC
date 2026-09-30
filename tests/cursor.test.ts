/**
 * Cursor runs the same hook scripts, recognised by what it sends.
 *
 * Cursor 3.7 sends `session_id`, `cursor_version` and `workspace_roots` with
 * every hook, reads added context from a top-level `additional_context`, and
 * cannot block a stop; it takes a `followup_message` as the next message
 * instead. Shapes taken from Cursor 3.7.19's own hook runner.
 */
import { expect, test } from "bun:test";
import { gitRepo, rawRows, runHook, tmp } from "./helpers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentOf, cwdOf } from "../protocol/agents";
import { appendRecord, ulid, type CheckpointRecord } from "../protocol/record";

const ROOT = resolve(import.meta.dir, "..");

function repo() {
  return { dir: gitRepo({ commit: true }), state: tmp("anvc-cursor-state-") };
}

test("Cursor is recognised without being told, and its workspace root stands in for a cwd", () => {
  expect(agentOf(["SessionStart"], { cursor_version: "3.7.19" })).toBe("cursor");
  expect(agentOf(["SessionStart"], {})).toBe("claude-code");
  expect(agentOf(["SessionStart", "--agent", "codex"], { cursor_version: "3.7.19" })).toBe("codex");
  expect(cwdOf({ workspace_roots: ["/w/app"] })).toBe("/w/app");
  expect(cwdOf({ cwd: "/w/app/sub", workspace_roots: ["/w/app"] })).toBe("/w/app/sub");
});

test("session start answers Cursor in its own format", async () => {
  const { dir, state } = repo();
  appendRecord(dir, {
    anvc: 0, id: ulid(), anchor: { kind: "blob", oid: "a".repeat(40) },
    session: { agent: "claude-code", run_id: "s" },
    intent: { goal: "Pool the redis connections", why: "ssl context is not copyable" },
    outcome: { status: "abandoned", recheck: null }, ts: new Date().toISOString(),
  } as CheckpointRecord);
  const out = runHook("inject", "SessionStart", {
    hook_event_name: "sessionStart", session_id: "cur-1", cursor_version: "3.7.19", workspace_roots: [dir],
  }, { ANVC_STATE_DIR: state })!;
  expect(out.hookSpecificOutput).toBeUndefined();
  expect(String(out.additional_context)).toContain("Pool the redis connections");
});

test("a Cursor session that edited and recorded nothing gets a follow-up, from the capture log alone", async () => {
  const { dir, state } = repo();
  const env = { ANVC_STATE_DIR: state, ANVC_CAPTURE_DIR: join(state, "capture"), ANVC_METRICS_DIR: join(state, "metrics") };
  // Cursor's edit, as capture records it; its session file is not read.
  runHook("capture", "PostToolUse", {
    hook_event_name: "postToolUse", session_id: "cur-2", cursor_version: "3.7.19", workspace_roots: [dir],
    tool_name: "Write", tool_input: { file_path: join(dir, "pool.ts") }, cwd: dir,
  }, env);
  const out = runHook("stop", "Stop", {
    hook_event_name: "stop", session_id: "cur-2", cursor_version: "3.7.19", workspace_roots: [dir], status: "completed", loop_count: 0,
  }, env)!;
  expect(out.decision).toBeUndefined();
  expect(String(out.followup_message)).toContain("anvc_checkpoint");

  // Already the follow-up: never asked twice in a row.
  const again = runHook("stop", "Stop", {
    hook_event_name: "stop", session_id: "cur-3", cursor_version: "3.7.19", workspace_roots: [dir], loop_count: 1,
  }, env);
  expect(again?.followup_message).toBeUndefined();
});

test("Cursor's Shell tool is captured as a command", async () => {
  const { dir, state } = repo();
  runHook("capture", "PostToolUse", {
    session_id: "cur-4", cursor_version: "3.7.19", workspace_roots: [dir], cwd: dir,
    tool_name: "Shell", tool_input: { command: "bun test" }, tool_output: "1 fail",
  }, { ANVC_CAPTURE_DIR: state });
  const [row] = rawRows(state);
  expect(row).toMatchObject({ agent: "cursor", tool: "Bash", command: "bun test", output: "1 fail" });
});

// Shapes copied from Cursor's CLI 2026.09.26: a success arrives on postToolUse
// with the result as a JSON string, a failure on postToolUseFailure.
test("a Cursor command is marked passed or failed from what Cursor sends", async () => {
  const { dir, state } = repo();
  const base = { session_id: "cur-5", cursor_version: "2026.09.26-dd393fe", workspace_roots: [dir], cwd: "", tool_name: "Shell" };
  runHook("capture", "PostToolUse", {
    ...base, hook_event_name: "postToolUse", tool_input: { command: "ls tsconfig.json" },
    tool_output: JSON.stringify({ output: "tsconfig.json\n", exitCode: 0 }),
  }, { ANVC_CAPTURE_DIR: state });
  runHook("capture", "PostToolUse", {
    ...base, hook_event_name: "postToolUseFailure", tool_input: { command: "npx tsc -p tsconfig.jso" },
    error_message: "error TS5058: The specified path does not exist", failure_type: "error",
  }, { ANVC_CAPTURE_DIR: state });
  const [passed, failed] = rawRows(state);
  expect(passed).toMatchObject({ command: "ls tsconfig.json", ok: true, output: "tsconfig.json\n" });
  expect(failed).toMatchObject({ command: "npx tsc -p tsconfig.jso", ok: false });
});

// Cursor's CLI in print mode never sends beforeSubmitPrompt; sessionEnd does
// arrive, and the transcript holds what was typed.
test("a Cursor print-mode session gets its prompt from the transcript when it ends", async () => {
  const { dir, state } = repo();
  const transcript = join(state, "transcript.txt");
  await writeFile(transcript, `${JSON.stringify({ role: "user", message: { content: [{ type: "text",
    text: "<timestamp>Sunday, Sep 27, 2026, 6:41 PM (UTC+3)</timestamp>\n<user_query>\nFix the tsconfig path\n</user_query>" }] } })}\n`);
  const base = { session_id: "cur-6", cursor_version: "2026.09.26-dd393fe", workspace_roots: [dir], cwd: "", transcript_path: transcript };
  runHook("capture", "PostToolUse", { ...base, hook_event_name: "postToolUse", tool_name: "Shell",
    tool_input: { command: "ls" }, tool_output: JSON.stringify({ output: "", exitCode: 0 }) }, { ANVC_CAPTURE_DIR: state });
  const end = () => runHook("stop", "SessionEnd", { ...base, hook_event_name: "sessionEnd", reason: "completed" }, { ANVC_CAPTURE_DIR: state });
  end();
  end();
  const rows = rawRows(state).sort((a, b) => a.ts.localeCompare(b.ts));
  expect(rows.map((r) => r.event)).toEqual(["UserPromptSubmit", "PostToolUse"]);
  expect(rows[0]).toMatchObject({ agent: "cursor", session_id: "cur-6", prompt: "Fix the tsconfig path" });
});

test("setup --agent cursor writes Cursor's hooks file, once, and keeps it out of commits", async () => {
  const { dir } = repo();
  const setup = () => Bun.spawnSync(["bun", join(ROOT, "scripts/setup.ts"), "--repo", dir, "--agent", "cursor", "--no-instructions"], { stdout: "pipe", stderr: "pipe" });
  expect(setup().exitCode).toBe(0);
  setup();
  const file = join(dir, ".cursor", "hooks.json");
  expect(existsSync(file)).toBe(true);
  const config = JSON.parse(readFileSync(file, "utf8")) as { version: number; hooks: Record<string, Array<{ command: string }>> };
  expect(config.version).toBe(1);
  expect(config.hooks.beforeSubmitPrompt).toHaveLength(2);
  expect(config.hooks.stop!.every((h) => h.command.endsWith("--agent cursor"))).toBe(true);
  expect(Bun.spawnSync(["git", "-C", dir, "check-ignore", "-q", ".cursor/hooks.json"]).exitCode).toBe(0);
});

test("setup --agent cursor adds the MCP server and keeps servers already there", async () => {
  const { dir } = repo();
  mkdirSync(join(dir, ".cursor"), { recursive: true });
  writeFileSync(join(dir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  const setup = Bun.spawnSync(["bun", join(ROOT, "scripts/setup.ts"), "--repo", dir, "--agent", "cursor", "--no-instructions"], { stdout: "pipe", stderr: "pipe" });
  expect(setup.exitCode).toBe(0);
  const config = JSON.parse(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8")) as { mcpServers: Record<string, { env?: Record<string, string> }> };
  expect(Object.keys(config.mcpServers)).toEqual(["other", "anvc"]);
  expect(config.mcpServers.anvc!.env).toEqual({ ANVC_REPO: dir, ANVC_AGENT: "cursor" });
  expect(Bun.spawnSync(["git", "-C", dir, "check-ignore", "-q", ".cursor/mcp.json"]).exitCode).toBe(0);
});

test("old Cursor sessions are imported from its project folder", async () => {
  const { dir, state } = repo();
  const root = join(state, "projects");
  const id = "5c69446f-7e8c-465a-8b77-7e5728ea757d";
  const folder = join(root, dir.replace(/^\/+/, "").replace(/[\\/:_]/g, "-"), "agent-transcripts", id);
  await Bun.write(join(folder, `${id}.jsonl`), [
    { role: "user", message: { content: [{ type: "text", text: "make the pool work" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", name: "StrReplace", input: { path: join(dir, "src/pool.ts"), old_string: "a", new_string: "b" } }] } },
    { role: "assistant", message: { content: [{ type: "tool_use", name: "Shell", input: { command: "bun test", description: "run tests" } }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const { backfill } = await import("../protocol/backfill");
  const result = backfill(dir, { root: join(state, "none"), codexRoot: join(state, "none"), cursorRoot: root, keptRoot: join(state, "none") });
  expect(result.events.map((e) => `${e.event}:${e.tool ?? ""}`)).toEqual(["UserPromptSubmit:", "PostToolUse:Edit", "PostToolUse:Bash"]);
  expect(result.events.every((e) => e.agent === "cursor" && e.session_id === id)).toBe(true);
  expect(result.events[1]!.path).toBe(join(dir, "src/pool.ts"));
});
