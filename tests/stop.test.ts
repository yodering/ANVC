/**
 * An agent that edited files and recorded nothing is asked once to record it.
 *
 * On the yodermon trial Sonnet 5 did the work and skipped the checkpoint that
 * the repository's instructions ask for. These tests cover when the hook asks
 * and, mostly, when it must not. Whether a model then complies is not
 * something a payload can show; that needs a live run.
 *
 * The transcripts here copy the shape of the trial's real ones: one JSON line
 * per entry, with tool calls as `tool_use` blocks in an assistant message.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendRecord, ulid, type CheckpointRecord } from "../protocol/record";
import { gitRepo, tmp } from "./helpers";

const STOP = resolve(import.meta.dir, "../emitters/claude-code/stop.ts");

type Call = { name: string; input?: Record<string, unknown> };

function fixture() {
  return { repo: gitRepo({ commit: true }), state: tmp("anvc-stop-state-") };
}

async function transcript(dir: string, calls: Call[]): Promise<string> {
  const path = join(dir, `${ulid()}.jsonl`);
  const lines = [
    { type: "user", message: { role: "user", content: "add the tool" } },
    ...calls.map((call, i) => ({
      type: "assistant", isSidechain: false,
      message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${i}`, name: call.name, input: call.input ?? {} }] },
    })),
  ];
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

/** Runs the hook the way Claude Code does and returns its decision. */
function stop(payload: Record<string, unknown>, state: string) {
  const proc = Bun.spawnSync(["bun", STOP, "Stop"], {
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, ...payload })),
    env: { ...process.env, ANVC_STATE_DIR: state, ANVC_METRICS_DIR: join(state, "metrics") },
    stdout: "pipe", stderr: "pipe",
  });
  const out = proc.stdout.toString().trim();
  return { exitCode: proc.exitCode, decision: out ? JSON.parse(out) as { decision: string; reason: string } : null };
}

const edit = (repo: string, file: string): Call => ({ name: "Edit", input: { file_path: join(repo, file), old_string: "a", new_string: "b" } });

test("edits with no checkpoint are asked about, once", async () => {
  const { repo, state } = fixture();
  const path = await transcript(state, [
    { name: "Read", input: { file_path: join(repo, "mcp_server/yodermon_readonly.py") } },
    edit(repo, "mcp_server/yodermon_readonly.py"),
    { name: "Write", input: { file_path: join(repo, "tests/test_calendar.py"), content: "x" } },
  ]);
  const payload = { session_id: "s1", cwd: repo, transcript_path: path };

  const first = stop(payload, state);
  expect(first.exitCode).toBe(0);
  expect(first.decision?.decision).toBe("block");
  expect(first.decision?.reason).toContain("anvc_checkpoint");
  expect(first.decision?.reason).toContain("2 files");

  // Claude Code marks the stop that follows a block. Blocking it too is the
  // loop the flag exists to prevent.
  expect(stop({ ...payload, stop_hook_active: true }, state).decision).toBeNull();
  // An agent that declined is not argued with on every later turn.
  expect(stop(payload, state).decision).toBeNull();
  // Another session is its own question.
  expect(stop({ ...payload, session_id: "s2" }, state).decision?.decision).toBe("block");
}, 60_000);

test("a session that checkpointed is left alone", async () => {
  const { repo, state } = fixture();
  const path = await transcript(state, [
    edit(repo, "server/api.ts"),
    { name: "mcp__anvc__anvc_checkpoint", input: { goal: "Add the tool", outcome: "kept" } },
  ]);
  expect(stop({ session_id: "s1", cwd: repo, transcript_path: path }, state).decision).toBeNull();
}, 60_000);

test("a record filed under the session counts as a checkpoint", async () => {
  const { repo, state } = fixture();
  // The MCP server files under CLAUDE_CODE_SESSION_ID, which is the hook's
  // session_id, so a record there is this session's whatever wrote it.
  appendRecord(repo, {
    anvc: 0, id: ulid(), anchor: { kind: "blob", oid: "a".repeat(40) },
    session: { agent: "claude-code", run_id: "b3ff2b14-8673-4e05-b5e7-2cf3771b7c43" },
    intent: { goal: "Add the tool" }, outcome: { status: "kept" },
    ts: new Date().toISOString(),
  } as CheckpointRecord);
  const path = await transcript(state, [edit(repo, "server/api.ts")]);
  expect(stop({ session_id: "b3ff2b14-8673-4e05-b5e7-2cf3771b7c43", cwd: repo, transcript_path: path }, state).decision).toBeNull();
  expect(stop({ session_id: "another", cwd: repo, transcript_path: path }, state).decision?.decision).toBe("block");
}, 60_000);

test("reading, and writing outside the repository, are not work to record", async () => {
  const { repo, state } = fixture();
  // Run 1's agent wrote a scratch script under /tmp. That is not an edit to
  // the project.
  const path = await transcript(state, [
    { name: "Read", input: { file_path: join(repo, "README.md") } },
    { name: "Grep", input: { pattern: "calendar" } },
    { name: "Write", input: { file_path: join(state, "scratchpad/check_tool.py"), content: "x" } },
  ]);
  expect(stop({ session_id: "s1", cwd: repo, transcript_path: path }, state).decision).toBeNull();
}, 60_000);

test("it never keeps a session from stopping", async () => {
  const { repo, state } = fixture();
  const garbage = join(state, "garbage.jsonl");
  await writeFile(garbage, "not json\n{\"type\":\"assistant\",\"message\":{\"content\":\"tool_use\"}}\n");
  for (const payload of [
    { session_id: "s1", cwd: repo, transcript_path: join(state, "missing.jsonl") },
    { session_id: "s1", cwd: repo, transcript_path: garbage },
    { session_id: "s1", cwd: repo },
    { session_id: "s1", cwd: tmpdir(), transcript_path: garbage },
  ]) {
    const { exitCode, decision } = stop(payload, state);
    expect(exitCode).toBe(0);
    expect(decision).toBeNull();
  }
}, 60_000);

test("every stop is counted, so the share of sessions that checkpointed can be read", async () => {
  const { repo, state } = fixture();
  const path = await transcript(state, [edit(repo, "server/api.ts")]);
  stop({ session_id: "s1", cwd: repo, transcript_path: path }, state);
  // The stop after the block is the one that says whether asking worked.
  // It went unrecorded on the first live run.
  await writeFile(path, readFileSync(path, "utf8") + JSON.stringify({
    type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_c", name: "mcp__anvc__anvc_checkpoint", input: {} }] },
  }) + "\n");
  stop({ session_id: "s1", cwd: repo, transcript_path: path, stop_hook_active: true }, state);

  const dir = join(state, "metrics");
  expect(existsSync(dir)).toBe(true);
  const rows = readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
  expect(rows.map((r) => [r.event, r.edited, r.checkpointed, r.asked, r.continued ?? false])).toEqual([
    ["Stop", 1, false, true, false],
    ["Stop", 1, true, false, true],
  ]);
}, 60_000);
