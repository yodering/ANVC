/**
 * A failed command is caught before the agent tries it a third time.
 *
 * Payload shapes are Claude Code 2.1.283's, captured live: a failed Bash call
 * goes to PostToolUseFailure with an `error` that starts "Exit code N".
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeAssist } from "../protocol/assist";
import { appendRecord, ulid } from "../protocol/record";
import { gitRepo, rawRows, rec, runHook, tmp, writeCapture } from "./helpers";

function setup() {
  const repo = gitRepo();
  const state = tmp("anvc-stuck-state-");
  const capture = join(state, "capture");
  const env = { ANVC_STATE_DIR: state, ANVC_CAPTURE_DIR: capture };
  const failure = (command: string, error: string) => ({
    hook_event_name: "PostToolUseFailure", session_id: "s-stuck", cwd: repo, tool_name: "Bash",
    tool_input: { command }, tool_use_id: ulid(), error, is_interrupt: false,
  });
  const hook = (script: "inject" | "capture", payload: object): string =>
    runHook(script, "PostToolUseFailure", payload, env)?.hookSpecificOutput?.additionalContext ?? "";
  return { repo, capture, env, failure, hook };
}

test("a Claude Code failure is captured as one, with its error", async () => {
  const { capture, failure, hook } = setup();
  hook("capture", failure("ls /missing", "Exit code 2\nls: cannot access '/missing': No such file or directory"));
  const [row] = rawRows(capture);
  expect(row).toMatchObject({ event: "PostToolUseFailure", tool: "Bash", command: "ls /missing", ok: false });
  expect(row!.output).toContain("No such file or directory");
});

test("an error anvc has seen before is named, with the record, once", async () => {
  const { repo, env, failure, hook } = setup();
  appendRecord(repo, rec({
    session: { agent: "codex", run_id: "old" },
    intent: { goal: "Pool the redis connections", why: "ssl context" },
    outcome: { status: "abandoned", recheck: null, errors: ["pytest: ssl.SSLError: [X509] no certificate or crl found"] },
    ts: new Date(Date.now() - 86_400_000).toISOString(),
  }));
  // The session start already showed this dead end; the failure is still
  // the moment it matters.
  runHook("inject", "SessionStart", { session_id: "s-stuck", cwd: repo, source: "startup" }, env);
  const payload = failure("pytest tests/test_pool.py", "Exit code 1\nE   ssl.SSLError: [X509] no certificate or crl found (_ssl.c:4012)");
  const said = hook("inject", payload);
  expect(said).toContain("this error was seen before");
  expect(said).toContain("Pool the redis connections");
  expect(hook("inject", payload)).toBe("");
  // An unrelated error names nothing.
  expect(hook("inject", failure("bun run build", "Exit code 1\nTypeError: undefined is not a function in render"))).toBe("");
});

test("the same command failing a second time in a session is pointed out", async () => {
  const { repo, capture, failure, hook } = setup();
  writeCapture(repo, [{
    event: "PostToolUseFailure", ts: new Date(Date.now() - 60_000).toISOString(), session_id: "s-stuck",
    tool: "Bash", command: "bun test", ok: false, output: "Exit code 1\n1 fail",
  }], capture);
  expect(hook("inject", failure("bun test", "Exit code 1\n2 fail"))).toContain("`bun test` has now failed 2 times in this session");
});

test("a command that failed in an earlier session is stopped once, with that session's error", () => {
  const { repo, capture, env } = setup();
  writeCapture(repo, [
    { session_id: "earlier", tool: "Bash", command: "pytest tests/validators/tests.py -q", ok: false, output: "bash: line 1: pytest: command not found" },
    { session_id: "earlier", tool: "Bash", command: "git apply -p0 << 'PATCH'\n*** Begin Patch", ok: false, output: "error: unrecognized input" },
    { session_id: "earlier", tool: "Bash", command: "python tests/runtests.py validators", ok: true, output: "OK" },
    // Failed, then worked later in the same session: not a dead end.
    { session_id: "earlier", tool: "Bash", command: "python reproduce.py", ok: false, output: "Traceback\nValueError: bad" },
    { session_id: "earlier", tool: "Bash", command: "python reproduce.py", ok: true, output: "fixed" },
  ], capture);
  const before = (command: string, session = "now") => runHook("inject", "PreToolUse", {
    hook_event_name: "PreToolUse", session_id: session, cwd: repo, tool_name: "Bash", tool_input: { command },
  }, env)?.hookSpecificOutput;
  // A missing tool matches any use of it.
  const stopped = before("cd /testbed && pytest tests/forms_tests -x");
  expect(stopped?.permissionDecision).toBe("deny");
  expect(stopped?.permissionDecisionReason).toContain('`pytest tests/validators/tests.py -q` failed in an earlier session here');
  expect(stopped?.permissionDecisionReason).toContain('"bash: line 1: pytest: command not found"');
  expect(stopped?.permissionDecisionReason).toContain("After it, that session ran `python tests/runtests.py validators` without an error.");
  // Run again, it goes through.
  expect(before("pytest tests/forms_tests -x")).toBeUndefined();
  expect(before("git apply -p0 << 'EOF'")?.permissionDecision).toBe("deny");
  expect(before("python reproduce.py")).toBeUndefined();
  expect(before("cat django/forms/fields.py")).toBeUndefined();
  // The session that failed isn't stopped by its own failure.
  expect(before("git apply -p0 << 'PATCH'", "earlier")).toBeUndefined();
});

test("with failed commands switched off, nothing is stopped", () => {
  const { repo, capture, env } = setup();
  writeCapture(repo, [{ session_id: "earlier", tool: "Bash", command: "pytest -q", ok: false, output: "pytest: command not found" }], capture);
  writeAssist(repo, { moment: "failures", on: false });
  const out = runHook("inject", "PreToolUse", { hook_event_name: "PreToolUse", session_id: "now", cwd: repo, tool_name: "Bash", tool_input: { command: "pytest -q" } }, env);
  expect(out).toBeNull();
});
