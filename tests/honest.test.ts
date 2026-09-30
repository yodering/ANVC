/**
 * A record says what was true when it was written. Shown to an agent, it has
 * to say how old it is and whether its files changed since, or "X failed"
 * reads as "X fails".
 */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRecord } from "../protocol/record";
import { git, gitRepo, rec, runHook, tmp } from "./helpers";

test("an injected record says its age, and names files that changed since", async () => {
  const repo = gitRepo();
  const state = tmp("anvc-honest-state-");
  writeFileSync(join(repo, "a.ts"), "one\n");
  writeFileSync(join(repo, "b.ts"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const head = git(repo, "rev-parse", "HEAD");
  const dead = (goal: string, file: string, days: number) => appendRecord(repo, rec({
    anchor: { kind: "commit", oid: head }, session: { agent: "claude-code", run_id: "old" },
    intent: { goal }, delta: { files: [file] }, outcome: { status: "abandoned", recheck: null, errors: ["it broke"] },
    ts: new Date(Date.now() - days * 86_400_000).toISOString(),
  }));
  dead("Cache the parser in a module Map", "a.ts", 3);
  dead("Inline the lexer", "b.ts", 1);
  // Someone edited a.ts after the record was written; b.ts is untouched.
  writeFileSync(join(repo, "a.ts"), "two\n");

  const out = runHook("inject", "SessionStart", { session_id: "new", cwd: repo, hook_event_name: "SessionStart", source: "startup" }, { ANVC_STATE_DIR: state });
  const text = out!.hookSpecificOutput.additionalContext as string;
  expect(text).toContain("Each was true when it was written");
  expect(text).toMatch(/"Cache the parser in a module Map" — "it broke" \(3 days ago; changed since: a\.ts\)/);
  expect(text).toMatch(/"Inline the lexer" — "it broke" \(yesterday\)/);
});

test("under a record whose code changed, the changed lines are shown as evidence", async () => {
  const repo = gitRepo();
  const state = tmp("anvc-honest-drift-state-");
  writeFileSync(join(repo, "sizes.py"), 'UNITS = {"KB": 1000}\n');
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const head = git(repo, "rev-parse", "HEAD");
  appendRecord(repo, rec({
    anchor: { kind: "commit", oid: head }, session: { agent: "claude-code", run_id: "old" },
    intent: { goal: "Parse sizes with sizes.parse_size" }, delta: { files: ["sizes.py"] },
    outcome: { status: "abandoned", recheck: null, errors: ["parse_size read KB as 1024; used sizes.UNITS instead"] },
    ts: new Date(Date.now() - 35 * 86_400_000).toISOString(),
  }));
  writeFileSync(join(repo, "sizes.py"), '# Display only: KB means 1024 here.\nUNITS = {"KB": 1024}\n');

  const out = runHook("inject", "SessionStart", { session_id: "new", cwd: repo, hook_event_name: "SessionStart", source: "startup" }, { ANVC_STATE_DIR: state });
  const text = out!.hookSpecificOutput.additionalContext as string;
  expect(text).toContain("Since then, lines naming what this record relies on changed, so it may no longer be true:");
  expect(text).toContain('sizes.py: + UNITS = {"KB": 1024}');
});
