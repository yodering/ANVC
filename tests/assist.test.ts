/**
 * How much ANVC tells an agent on its own is the person's choice, for every
 * project or one, and a moment switched off says nothing and runs nothing.
 */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearProjectAssist, readAssist, writeAssist } from "../protocol/assist";
import { marker } from "../protocol/localonly";
import { appendRecord, ulid } from "../protocol/record";
import { setDataMode } from "../protocol/results";
import { git, gitRepo, runHook, setEnv, tmp } from "./helpers";

function place() {
  const home = tmp("anvc-assist-home-");
  const repo = gitRepo();
  const state = tmp("anvc-assist-state-");
  writeFileSync(join(repo, "Makefile"), "test:\n\t@exit 1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  setEnv({ ANVC_STATE_HOME: home });
  const inject = (event: string, extra: object) => {
    const out = runHook("inject", event, { session_id: `s-${Math.random()}`, cwd: repo, hook_event_name: event, ...extra }, { ANVC_STATE_HOME: home, ANVC_STATE_DIR: state });
    return out ? (out.hookSpecificOutput?.additionalContext as string) : null;
  };
  return { repo, inject };
}

test("a project follows the choice for every project until it makes its own", async () => {
  const p = place();
  expect(readAssist(p.repo)).toMatchObject({ level: "auto", from: "default" });
  writeAssist(null, { level: "start" });
  expect(readAssist(p.repo)).toMatchObject({ level: "start", from: "everywhere" });
  expect(readAssist(p.repo).moments.prompts).toBe(false);
  writeAssist(p.repo, { moment: "prompts", on: true });
  expect(readAssist(p.repo)).toMatchObject({ level: "start", from: "project" });
  expect(readAssist(p.repo).moments.prompts).toBe(true);
  clearProjectAssist(p.repo);
  expect(readAssist(p.repo).from).toBe("everywhere");
});

// Skipped where make isn't installed, as on many Windows machines: the check is make test.
test.skipIf(!Bun.which("make"))("with a moment off, nothing is said and no check is run", async () => {
  const p = place();
  appendRecord(p.repo, {
    anvc: 0, id: ulid(), anchor: { kind: "blob", oid: "a".repeat(40) }, session: { agent: "claude-code", run_id: "old" },
    intent: { goal: "Cache the parser in a module Map" }, outcome: { status: "abandoned", errors: ["memory grew"], recheck: "make test" },
    ts: new Date().toISOString(),
  });
  // On macOS, make is a shim whose first run took over the hook's 2 s limit
  // on GitHub's runners, so it runs once first.
  Bun.spawnSync(["make", "--version"], { stdout: "ignore", stderr: "ignore" });
  // Automatic: the briefing names the dead end and its check ran.
  expect(p.inject("SessionStart", { source: "startup" })).toContain("checked just now: still fails");
  // Checks off: still briefed, nothing run.
  writeAssist(p.repo, { moment: "checks", on: false });
  const briefed = p.inject("SessionStart", { source: "startup" });
  expect(briefed).toContain("Cache the parser");
  expect(briefed).not.toContain("checked just now");
  // When asked: nothing at session start, nothing on a prompt about it.
  writeAssist(p.repo, { level: "ask" });
  expect(p.inject("SessionStart", { source: "startup" })).toBeNull();
  expect(p.inject("UserPromptSubmit", { prompt: "cache the parser in a module map" })).toBeNull();
});

test("a level or a moment is one of the ones named, never a name every object has", () => {
  const p = place();
  expect(() => writeAssist(p.repo, { level: "constructor" as never })).toThrow("level must be one of");
  expect(() => writeAssist(p.repo, { moment: "toString" as never, on: true })).toThrow("unknown moment toString");
  writeAssist(p.repo, { level: "start" });
  writeFileSync(marker(p.repo, "assist.json")!, JSON.stringify({ level: "constructor" }));
  expect(readAssist(p.repo)).toMatchObject({ level: "auto", from: "project" });
  expect(() => setDataMode(p.repo, "constructor" as never)).toThrow("mode must be one of");
});

test("a moment that's off claims nothing, so it speaks once it's back on", async () => {
  const p = place();
  appendRecord(p.repo, {
    anvc: 0, id: ulid(), anchor: { kind: "blob", oid: "a".repeat(40) }, session: { agent: "claude-code", run_id: "old" },
    intent: { goal: "Pool the redis connections" }, delta: { files: ["pool.ts"] },
    outcome: { status: "abandoned", errors: ["ssl.SSLError: [X509] no certificate or crl found"], recheck: null },
    ts: new Date().toISOString(),
  });
  const s = { session_id: "s1" };
  const open = () => p.inject("PreToolUse", { ...s, tool_name: "Read", tool_input: { file_path: join(p.repo, "pool.ts") } });
  const failed = () => p.inject("PostToolUseFailure", {
    ...s, tool_name: "Bash", tool_input: { command: "pytest" }, error: "Exit code 1\nE   ssl.SSLError: [X509] no certificate or crl found",
  });
  const start = () => p.inject("SessionStart", { ...s, source: "startup" });

  writeAssist(p.repo, { level: "ask" });
  expect([open(), failed(), start()]).toEqual([null, null, null]);
  writeAssist(p.repo, { level: "auto" });
  expect(open()).toContain("Pool the redis connections");
  expect(failed()).toContain("this error was seen before");
  expect(start()).toContain("records in this repository");
});
