/**
 * After compaction, the agent is told what this session already did.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { gitRepo, runHook, tmp, writeCapture } from "./helpers";

function setup() {
  const repo = gitRepo();
  const state = tmp("anvc-recover-state-");
  const capture = join(state, "capture");
  const row = (n: number, over: object) => ({ ts: new Date(Date.now() - n * 60_000).toISOString(), session_id: "s-comp", ...over });
  writeCapture(repo, [
    row(9, { tool: "Edit", path: join(repo, "protocol/query.ts") }),
    row(8, { tool: "Bash", command: "bun test", ok: false, output: "1 fail: stale read after write" }),
    row(7, { tool: "Bash", command: "bun test", ok: false, output: "2 fail: stale read after write" }),
    row(6, { tool: "Bash", command: "bun run typecheck", ok: true }),
  ], capture);
  const run = (event: string, payload: object, agent?: string) =>
    runHook("inject", [event, ...(agent ? ["--agent", agent] : [])], { session_id: "s-comp", cwd: repo, ...payload },
      { ANVC_STATE_DIR: state, ANVC_CAPTURE_DIR: capture });
  return { run };
}

test("Claude Code: the session start after compaction carries the session so far", async () => {
  const { run } = setup();
  const text = run("SessionStart", { source: "compact" })?.hookSpecificOutput?.additionalContext ?? "";
  expect(text).toContain("this session before compaction");
  expect(text).toContain("failed 2×: `bun test` → 2 fail: stale read after write");
  expect(text).toContain("changed: protocol/query.ts");
  // A plain start says nothing of it.
  const { run: fresh } = setup();
  expect(fresh("SessionStart", { source: "startup" })?.hookSpecificOutput?.additionalContext ?? "").not.toContain("before compaction");
});

test("Codex: marked at compaction, said once with the next prompt", async () => {
  const { run } = setup();
  expect(run("PostCompact", { hook_event_name: "PostCompact" }, "codex")).toBeNull();
  const first = run("UserPromptSubmit", { prompt: "keep going" }, "codex")?.hookSpecificOutput?.additionalContext ?? "";
  expect(first).toContain("this session before compaction");
  const second = run("UserPromptSubmit", { prompt: "and then" }, "codex")?.hookSpecificOutput?.additionalContext ?? "";
  expect(second).not.toContain("before compaction");
});
