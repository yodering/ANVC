/**
 * Codex runs the same hooks as Claude Code, told which agent is calling.
 *
 * Codex's hook payloads use Claude Code's field names; its tools do not. These
 * check the translation (apply_patch is an edit of each file its patch names,
 * exec_command is a shell command), that captured work is labelled codex, that
 * the stop hook reads Codex's session file, and that a checkpoint lands in the
 * session the hooks saw even though Codex never tells the MCP server.
 *
 * The payload and transcript shapes follow Codex 0.157.1: the hook schemas
 * built into its binary, and the rollout files in ~/.codex/sessions.
 */
import { expect, test } from "bun:test";
import { git, gitRepo, rawRows, runHook, setEnv, tmp, tool } from "./helpers";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { agentArg, currentSession, eventArg, noteSession, patchPaths, toolCall } from "../protocol/agents";

const ROOT = resolve(import.meta.dir, "..");

const PATCH = `*** Begin Patch
*** Update File: src/pool.ts
@@
-a
+b
*** Add File: src/new.ts
+x
*** End Patch`;

function repo() {
  return { dir: gitRepo({ commit: true }), state: tmp("anvc-codex-state-") };
}

test("hook arguments: the event, and which agent", () => {
  expect(eventArg(["PostToolUse", "--agent", "codex"])).toBe("PostToolUse");
  expect(eventArg(["--agent", "codex", "Stop"])).toBe("Stop");
  expect(agentArg(["PostToolUse", "--agent", "codex"])).toBe("codex");
  expect(agentArg(["PostToolUse"])).toBe("claude-code");
});

test("apply_patch is an edit of every file its patch names; exec_command is a command", () => {
  expect(patchPaths(PATCH)).toEqual(["src/pool.ts", "src/new.ts"]);
  expect(toolCall("apply_patch", { input: PATCH })).toMatchObject({ tool: "Edit", paths: ["src/pool.ts", "src/new.ts"] });
  expect(toolCall("exec_command", { cmd: "bun test", workdir: "/r" })).toMatchObject({ tool: "Bash", command: "bun test" });
  expect(toolCall("exec_command", { cmd: ["bun", "test"] })).toMatchObject({ command: "bun test" });
  // Claude Code's own tools pass through as they were.
  expect(toolCall("Read", { file_path: "a.ts" })).toMatchObject({ tool: "Read", paths: ["a.ts"] });
});

test("capture labels Codex work and writes one row per patched file", async () => {
  const { dir, state } = repo();
  const run = (payload: object) => runHook("capture", ["PostToolUse", "--agent", "codex"], payload, { ANVC_CAPTURE_DIR: state });
  run({ hook_event_name: "PostToolUse", session_id: "c1", cwd: dir, tool_name: "apply_patch", tool_input: { input: PATCH }, tool_response: {} });
  run({ hook_event_name: "PostToolUse", session_id: "c1", cwd: dir, tool_name: "exec_command", tool_input: { cmd: "bun test" }, tool_response: { exit_code: 1, output: "1 fail" } });
  const rows = rawRows(state);
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.agent === "codex")).toBe(true);
  expect(rows.slice(0, 2).map((r) => r.path)).toEqual([join(dir, "src/pool.ts"), join(dir, "src/new.ts")]);
  expect(rows[2]).toMatchObject({ tool: "Bash", command: "bun test", ok: false, output: "1 fail" });
});

test("the stop hook reads a Codex session file", async () => {
  const { dir, state } = repo();
  const line = (payload: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload });
  const transcript = join(state, "rollout.jsonl");
  await writeFile(transcript, [
    JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: "c2", cwd: dir } }),
    line({ type: "custom_tool_call", name: "apply_patch", input: PATCH, call_id: "1" }),
  ].join("\n") + "\n");
  const env = { ANVC_STATE_DIR: state, ANVC_METRICS_DIR: join(state, "metrics") };
  const stop = (session: string, path: string) =>
    runHook("stop", ["Stop", "--agent", "codex"], { hook_event_name: "Stop", session_id: session, cwd: dir, transcript_path: path, stop_hook_active: false }, env);
  // Edited through apply_patch, recorded nothing: asked.
  expect(stop("c2", transcript)?.decision).toBe("block");

  // A checkpoint call under Codex's naming counts as recording.
  const other = join(state, "rollout2.jsonl");
  await writeFile(other, [
    line({ type: "custom_tool_call", name: "apply_patch", input: PATCH, call_id: "1" }),
    line({ type: "function_call", name: "mcp__anvc__anvc_checkpoint", arguments: "{}", call_id: "2" }),
  ].join("\n") + "\n");
  expect(JSON.stringify(stop("c3", other))).not.toContain('"block"');
});

test("a Codex checkpoint is filed under the session its hooks saw", async () => {
  const { dir, state } = repo();
  // What the SessionStart hook does when Codex starts.
  setEnv({ ANVC_STATE_DIR: state });
  const root = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  noteSession("codex", root.replace(/\/\.git$/, ""), "019f-codex-session");
  expect(currentSession("codex", root.replace(/\/\.git$/, ""))).toBe("019f-codex-session");

  // The server must find the session itself, so neither variable that names one is passed on.
  setEnv({ ANVC_SESSION: undefined, CLAUDE_CODE_SESSION_ID: undefined });
  tool(dir, "anvc_checkpoint", { goal: "Pool the redis connections", outcome: "kept" }, { ANVC_AGENT: "codex" });
  const refs = git(dir, "for-each-ref", "--format=%(refname)", "refs/anvc/", "refs/anvc-private/");
  expect(refs).toContain("/019f-codex-session/");
});

test("setup --agent codex writes Codex hooks that name the agent, and keeps them out of commits", async () => {
  const { dir } = repo();
  const p = Bun.spawnSync(["bun", join(ROOT, "scripts/setup.ts"), "--repo", dir, "--agent", "codex", "--no-instructions"], { stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  const file = join(dir, ".codex", "hooks.json");
  expect(existsSync(file)).toBe(true);
  const hooks = JSON.parse(readFileSync(file, "utf8")).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    expect(hooks[event]!.every((h) => h.hooks[0]!.command.endsWith("--agent codex"))).toBe(true);
  }
  expect(Bun.spawnSync(["git", "-C", dir, "check-ignore", "-q", ".codex/hooks.json"]).exitCode).toBe(0);
  // Run twice, nothing doubles.
  Bun.spawnSync(["bun", join(ROOT, "scripts/setup.ts"), "--repo", dir, "--agent", "codex", "--no-instructions"], { stdout: "pipe", stderr: "pipe" });
  const again = JSON.parse(readFileSync(file, "utf8")).hooks as Record<string, unknown[]>;
  expect(again.UserPromptSubmit).toHaveLength(2);
});

test("a kept record sent with scope is not blamed on an old server", async () => {
  const { dir, state } = repo();
  const text = tool(dir, "anvc_checkpoint", { goal: "Check Codex setup", outcome: "kept", scope: "local" }, { ANVC_STATE_DIR: state, ANVC_AGENT: "codex" });
  // Seen in a real Codex run: scope only applies to abandoned attempts, so
  // it was dropped on purpose and the server reported itself as outdated.
  expect(text).toContain("recorded kept");
  expect(text).not.toContain("did not store");
});

test("old Codex sessions are read in both formats, each step once", async () => {
  const { dir, state } = repo();
  const day = join(state, "sessions", "2026", "09", "27");
  await Bun.write(join(day, ".keep"), "");
  const at = (n: number) => new Date(Date.UTC(2026, 8, 27, 1, 0, n)).toISOString();
  const row = (n: number, type: string, payload: unknown) => JSON.stringify({ timestamp: at(n), type, payload });
  await writeFile(join(day, "rollout-2026-09-27T01-00-00-abc.jsonl"), [
    row(0, "session_meta", { id: "codex-old", cwd: dir }),
    // The same message as an event and as an item: taken once.
    row(1, "event_msg", { type: "user_message", message: "make the pool work" }),
    row(1, "event_msg", { type: "item_completed", item: { id: "u1", type: "UserMessage", content: [{ type: "text", text: "make the pool work" }] } }),
    // Older per-kind events.
    row(2, "event_msg", { type: "exec_command_end", call_id: "c1", command: ["bun", "test"], cwd: dir, exit_code: 1, stdout: "1 fail" }),
    row(3, "event_msg", { type: "patch_apply_end", call_id: "p1", success: true, changes: { [join(dir, "src/pool.ts")]: { type: "update" } } }),
    // Newer items, with a file:// directory.
    row(4, "event_msg", { type: "item_completed", item: { id: "c2", type: "CommandExecution", command: "bun test", cwd: pathToFileURL(dir).href, exit_code: 0 } }),
    row(5, "event_msg", { type: "task_complete" }),
  ].join("\n") + "\n");
  // And a session from another project, which is not this one's history.
  await writeFile(join(day, "rollout-2026-09-27T02-00-00-def.jsonl"), row(0, "session_meta", { id: "elsewhere", cwd: "/tmp/not-this-repo" }) + "\n");

  const { backfill } = await import("../protocol/backfill");
  const result = backfill(dir, { root: join(state, "none"), codexRoot: join(state, "sessions"), cursorRoot: join(state, "none") });
  const kinds = result.events.map((e) => `${e.event}:${e.tool ?? ""}:${e.ok}`);
  expect(kinds).toEqual(["UserPromptSubmit::null", "PostToolUse:Bash:false", "PostToolUse:Edit:true", "PostToolUse:Bash:true", "Stop::null"]);
  expect(result.events.every((e) => e.agent === "codex" && e.session_id === "codex-old")).toBe(true);
});

test("the stop hook counts a checkpoint and edits written as newer Codex items", async () => {
  const { dir, state } = repo();
  const item = (item: unknown) => JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "item_completed", item } });
  const run = async (lines: string[]) => {
    const t = join(state, `t-${Math.random()}.jsonl`);
    await writeFile(t, lines.join("\n") + "\n");
    return JSON.stringify(runHook("stop", ["Stop", "--agent", "codex"], { hook_event_name: "Stop", session_id: `s-${Math.random()}`, cwd: dir, transcript_path: t, stop_hook_active: false },
      { ANVC_STATE_DIR: state, ANVC_METRICS_DIR: join(state, "metrics") }));
  };
  const change = item({ id: "f1", type: "FileChange", changes: [{ path: join(dir, "src/pool.ts") }] });
  expect(await run([change])).toContain('"block"');
  expect(await run([change, item({ id: "m1", type: "McpToolCall", server: "anvc", tool: "anvc_checkpoint" })])).not.toContain('"block"');
});

test("a command result sent as text still says whether it passed", async () => {
  const { dir, state } = repo();
  const send = (response: string) => runHook("capture", ["PostToolUse", "--agent", "codex"],
    { session_id: "c9", cwd: dir, tool_name: "Bash", tool_input: { command: "bun test" }, tool_response: response }, { ANVC_CAPTURE_DIR: state });
  send("Process exited with code 1\nOutput:\n1 fail");
  send("Exit code: 0\nall good");
  const rows = rawRows(state);
  expect(rows.map((r) => r.ok)).toEqual([false, true]);
  expect(rows[0].output).toContain("1 fail");
});

test("a Codex command's exit code is read from its session file, since the hook is not given one", async () => {
  const { dir, state } = repo();
  // As Codex 0.157.1 writes it: the finished command as an item, just
  // before the hook runs, and the hook handed only the output text.
  const transcript = join(state, "rollout.jsonl");
  await writeFile(transcript, [
    JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: "c-exit", cwd: dir } }),
    JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "item_completed",
      item: { id: "exec-1", type: "CommandExecution", command: ["/bin/bash", "-lc", "bun test"], exit_code: 1 } } }),
  ].join("\n") + "\n");
  const payload = { hook_event_name: "PostToolUse", session_id: "c-exit", cwd: dir, transcript_path: transcript,
    tool_name: "Bash", tool_input: { command: "bun test" }, tool_response: "tests/math.test.ts:\nerror: expect(received).toBe(expected)\n 1 fail" };
  runHook("capture", ["PostToolUse", "--agent", "codex"], payload, { ANVC_CAPTURE_DIR: state });
  expect(rawRows(state).find((r) => r.command === "bun test")?.ok).toBe(false);
});
