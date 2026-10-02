/**
 * The Stats page's counts (protocol/stats.ts), each from the log line ANVC
 * writes when it acts.
 */
import { expect, test } from "bun:test";
import { appendDaily } from "../protocol/activity";
import { withIndex } from "../protocol/query";
import { metricsRoot } from "../protocol/rawlog";
import { stats } from "../protocol/stats";
import { gitRepo, writeCapture } from "./helpers";

test("each count comes from its own log line, and a stopped command counts as not run again only if the session never ran it", () => {
  const repo = gitRepo({ commit: true });
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 2, 10, minutes)).toISOString();
  const activity = process.env.ANVC_ACTIVITY_DIR!;
  for (const row of [
    { ts: at(0), kind: "injected", repo, session: "s1", records: ["r1", "r2"], via: "SessionStart" },
    { ts: at(1), kind: "injected", repo, session: "s1", records: ["r3"], via: "SubagentStart", agent_id: "a1" },
    { ts: at(2), kind: "recovered", repo, session: "s1" },
    { ts: at(3), kind: "searched", repo, session: "s1", records: ["r1"] },
    { ts: at(4), kind: "opened", repo, session: "s1", records: ["r2"] },
    { ts: at(5), kind: "recorded", repo, session: "s1", records: ["r9"] },
    { ts: at(6), kind: "autosaved", repo, session: "s0" },
    { ts: at(7), kind: "absorbed", repo, session: "s1", records: ["g1"], tokens: 6_000 },
  ]) appendDaily(activity, row as never);
  for (const row of [
    { ts: at(10), event: "SessionStart", session: "s1", repo, injected: true, records: ["r1", "r2"], chars: 800 },
    { ts: at(11), event: "PreToolUse", session: "s1", repo, injected: true, records: [], chars: 300, stopped: "git apply" },
    { ts: at(12), event: "PreToolUse", session: "s1", repo, injected: true, records: [], chars: 300, stopped: "pytest" },
    { ts: at(13), event: "PreToolUse", session: "s1", repo, injected: true, records: [], chars: 1_200 },
    { ts: at(14), event: "PostToolUseFailure", session: "s1", repo, injected: true, records: ["r4"], chars: 400 },
    { ts: at(15), event: "UserPromptSubmit", session: "s1", repo, injected: false, records: [], chars: 0 },
  ]) appendDaily(metricsRoot(), row);
  // After its stop, pytest ran again; git apply never did.
  writeCapture(repo, [
    { ts: at(11), session_id: "s1", tool: "Bash", command: "git apply -p0 << 'PATCH'", ok: false, output: "anvc: `git apply` failed in an earlier session here on 2026-10-01." },
    { ts: at(20), session_id: "s1", tool: "Bash", command: "pytest -q tests", ok: true, output: "3 passed" },
  ]);

  const s = withIndex(repo, (db) => stats(db, repo, [{ authored: true }, { authored: true }, { authored: false }]));
  expect(s).toMatchObject({
    since: at(0), recovered: 1, shown: 3, stopped: 2, notRunAgain: 1, matched: 1, rules: 1,
    asked: 2, recorded: 2, saved: 1, absorbed: { updates: 1, tokens: 6_000 }, added: 3_000,
  });
});
