/**
 * A failed command is caught before the agent tries it a third time.
 *
 * Payload shapes are Claude Code 2.1.283's, captured live: a failed Bash call
 * goes to PostToolUseFailure with an `error` that starts "Exit code N".
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
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
