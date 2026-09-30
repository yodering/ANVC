import { expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { appendDaily } from "../protocol/activity";
import { captureFiles, writeJson } from "../protocol/rawlog";
import { rawRows, runHook, tmp } from "./helpers";

const emitter = resolve(import.meta.dir, "../emitters/claude-code/capture.ts");

const emit = (dir: string, event: string, payload: object) => runHook("capture", event, payload, { ANVC_CAPTURE_DIR: dir });

test("capture records file paths and redacts secrets", async () => {
  const dir = tmp("anvc-capture-");
  emit(dir, "PostToolUse", { session_id: "s", cwd: process.cwd(), tool_name: "Read", tool_input: { file_path: "harness/run.ts" } });
  emit(dir, "UserPromptSubmit", { session_id: "s", cwd: process.cwd(), prompt: "token ghp_aaaaaaaaaaaaaaaaaaaa and sk-abcdefghijklmnopqrst" });
  emit(dir, "PostToolUse", { session_id: "s", cwd: process.cwd(), tool_name: "Bash", tool_input: { command: "KEY=AKIAIOSFODNN7EXAMPLE git push" } });

  const rows = rawRows(dir);
  expect(rows).toHaveLength(3);

  // File-read overlap needs absolute paths attributed to a repository.
  expect(rows[0]!.path).toEndWith(join("harness", "run.ts"));
  expect(isAbsolute(rows[0]!.path)).toBe(true);
  expect(rows[0]!.repo).toBeTruthy();

  // No secret of any captured class survives to disk.
  const written = JSON.stringify(rows);
  expect(written).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaa");
  expect(written).not.toContain("sk-abcdefghijklmnopqrst");
  expect(written).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(rows[1]!.prompt).toContain("[redacted:github]");
  expect(rows[2]!.command).toContain("[redacted:aws]");
}, 30_000);

// Skipped on Windows: Windows has no POSIX file modes.
test.skipIf(process.platform === "win32")("what anvc writes under ~/.anvc is readable by this user only", async () => {
  const root = join(tmp("anvc-capture-mode-"), "capture");
  emit(root, "UserPromptSubmit", { session_id: "s", cwd: process.cwd(), prompt: "what I typed" });
  const [file] = captureFiles(null, root);
  const mode = (path: string) => statSync(path).mode & 0o777;
  expect([mode(file!), mode(dirname(file!)), mode(root)]).toEqual([0o600, 0o700, 0o700]);

  const other = tmp("anvc-mode-");
  writeJson(join(other, "state", "settings.json"), {});
  appendDaily(join(other, "activity"), { kind: "test" });
  expect([mode(join(other, "state", "settings.json")), mode(join(other, "state")), mode(join(other, "activity"))])
    .toEqual([0o600, 0o700, 0o700]);
  expect(readdirSync(join(other, "activity")).map((f) => mode(join(other, "activity", f)))).toEqual([0o600]);
}, 30_000);

test("outside a repository nothing is captured", async () => {
  const dir = tmp("anvc-capture-none-");
  // The flat log this used to write held prompts and command output that no
  // repository asked for, and no folder switch could turn it off.
  const outside = tmp("anvc-not-a-repo-");
  emit(dir, "UserPromptSubmit", { session_id: "s", cwd: outside, prompt: "what I typed" });
  emit(dir, "PostToolUse", { session_id: "s", cwd: outside, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "secret.txt" } });
  expect(captureFiles(null, dir)).toEqual([]);
}, 30_000);

test("capture never fails the hook on malformed input", async () => {
  const dir = tmp("anvc-capture-bad-");
  const proc = Bun.spawn(["bun", emitter, "PostToolUse"], {
    stdin: Buffer.from("not json at all"),
    env: { ...process.env, ANVC_CAPTURE_DIR: dir },
    stdout: "pipe", stderr: "pipe",
  });
  // A capture fault must never break the user's session.
  expect(await proc.exited).toBe(0);
}, 30_000);

test("a delegation records what the subagent was sent to do", async () => {
  const dir = tmp("anvc-deleg-");
  // A subagent works in its own context, never calls anvc_checkpoint —
  // it does not know this exists — and its own tool calls arrive under the
  // parent's session id if they arrive at all. Measured here in one day:
  // 902 captured events, one session id, seven subagents. Without this the
  // whole delegation is a gap in the log.
  emit(dir, "PostToolUse", {
    session_id: "s", cwd: process.cwd(), tool_name: "Task",
    tool_input: { description: "Research agent skimming behaviour", subagent_type: "general-purpose" },
    tool_response: { success: true },
  });

  const [row] = rawRows(dir);
  expect(row.tool).toBe("Task");
  // The parent's one-line description is the only account of the work that
  // exists anywhere. Thin, and better than the silence it replaces.
  expect(row.delegated).toBe("Research agent skimming behaviour");
  expect(row.agent_type).toBe("general-purpose");
}, 30_000);

test("a delegation through the tool Claude Code now calls Agent is recorded the same", async () => {
  const dir = tmp("anvc-deleg-agent-");
  emit(dir, "PostToolUse", {
    session_id: "s", cwd: process.cwd(), tool_name: "Agent",
    tool_input: { description: "Fix the export", subagent_type: "Explore", prompt: "..." },
    tool_response: { success: true },
  });
  const [row] = rawRows(dir);
  expect([row.delegated, row.agent_type]).toEqual(["Fix the export", "Explore"]);
}, 30_000);

test("a failing command keeps what it printed, trimmed by shape", async () => {
  const dir = tmp("anvc-output-");
  // The three shapes real output actually has: a progress bar redrawn over
  // one line, a wall of identical warnings, and the error at the end.
  const bar = Array.from({ length: 41 }, (_, i) => `Downloading [${"=".repeat(i)}] ${i * 2}%`).join("\r");
  const warnings = Array.from({ length: 300 }, () => "  warning: unused import").join("\n");
  const error = 'Traceback (most recent call last):\n  File "pool.py", line 88\nssl.SSLError: [X509] no certificate found';

  emit(dir, "PostToolUse", {
    session_id: "s", cwd: process.cwd(), tool_name: "Bash",
    tool_input: { command: "pytest tests/" },
    tool_response: { success: false, stdout: `${bar}\n${warnings}\n${error}`, stderr: "exit 1" },
  });

  const [row] = rawRows(dir);
  const out = String(row.output);

  // The whole point: what was observed survives, because a verdict can only
  // be believed and output can be re-read. Until this existed the hook took
  // `success: false` off this payload and discarded the rest.
  expect(out).toContain("ssl.SSLError");
  expect(out).toContain('File "pool.py", line 88');

  // Dropped by shape, never by judgement. A progress bar is forty near-copies
  // of one line that was meant to be overwritten; only its final state and
  // the fact that it moved carry anything.
  expect(out).toContain("[after 40 redraws of this line]");
  expect(out).not.toContain("Downloading [=] 2%");
  expect(out).toMatch(/repeated \d+ more times/);

  // Three hundred warnings and a forty-frame bar reduce to a fraction of
  // their size while the error is untouched.
  expect(out.length).toBeLessThan(1_000);
}, 30_000);

test("a command that succeeds quietly stores no output", async () => {
  const dir = tmp("anvc-quiet-");
  emit(dir, "PostToolUse", {
    session_id: "s", cwd: process.cwd(), tool_name: "Bash",
    tool_input: { command: "true" },
    tool_response: { success: true, stdout: "", stderr: "" },
  });
  const [row] = rawRows(dir);
  expect(row.output).toBeNull();
}, 30_000);

test("a secret in command output is redacted before it is written", async () => {
  const dir = tmp("anvc-outsecret-");
  // Output is scrubbed at a higher ceiling than a prompt, so the raise must
  // not have skipped the scrub itself.
  emit(dir, "PostToolUse", {
    session_id: "s", cwd: process.cwd(), tool_name: "Bash",
    tool_input: { command: "deploy" },
    tool_response: { success: false, stdout: "", stderr: "auth failed for ghp_aaaaaaaaaaaaaaaaaaaa" },
  });
  const [row] = rawRows(dir);
  expect(String(row.output)).toContain("[redacted:github]");
  expect(String(row.output)).not.toContain("ghp_aaaa");
}, 30_000);
