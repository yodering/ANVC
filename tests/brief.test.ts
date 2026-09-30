/**
 * What happened since you last looked, for a person and, after a gap, for
 * the agent.
 */
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brief, briefText } from "../protocol/brief";
import { buildIndex, openIndex } from "../protocol/query";
import { appendRecord, ulid } from "../protocol/record";
import { git, gitRepo, rec, runHook, tmp } from "./helpers";

const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
const record = (goal: string, status: "kept" | "abandoned", when: Date) => rec({
  id: ulid(when.getTime()),
  intent: { goal, why: status === "abandoned" ? "goes stale after any write" : undefined },
  outcome: { status, ...(status === "abandoned" ? { recheck: null } : {}) }, ts: when.toISOString(),
});

function repo() {
  const dir = gitRepo();
  appendRecord(dir, record("Old work from last month", "kept", at(40)));
  appendRecord(dir, record("Cache the ref index in memory", "abandoned", at(10)));
  appendRecord(dir, record("Rebuild the index per request", "kept", at(9)));
  return dir;
}

test("the brief counts what happened since, and names the open dead end", async () => {
  const dir = repo();
  const db = openIndex();
  buildIndex(db, dir);
  const b = brief(db, dir, at(14).toISOString());
  expect(b).toMatchObject({ attempts: 2, abandoned: 1 });
  const text = briefText(b);
  expect(text).toContain("(14 days): 2 attempts, 1 abandoned");
  expect(text).toContain('open:   "Cache the ref index in memory"');
  expect(text).toContain("new:    Rebuild the index per request");
  expect(text).not.toContain("Old work from last month");
  db.close();
});

test("after a gap of days, the agent's session starts with what happened meanwhile", async () => {
  const dir = repo();
  const activity = tmp("anvc-brief-act-");
  const state = tmp("anvc-brief-state-");
  const root = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir").replace(/\/\.git$/, "");
  // The last session here was twelve days ago.
  mkdirSync(activity, { recursive: true });
  writeFileSync(join(activity, `${at(12).toISOString().slice(0, 10)}.jsonl`),
    JSON.stringify({ ts: at(12).toISOString(), kind: "injected", repo: root, session: "earlier", records: [] }) + "\n");
  const out = runHook("inject", "SessionStart", { session_id: "now", cwd: dir, source: "startup" }, { ANVC_ACTIVITY_DIR: activity, ANVC_STATE_DIR: state });
  const text = out!.hookSpecificOutput.additionalContext as string;
  expect(text).toContain("since this repository was last worked on, 12 days ago: 2 attempts recorded, 1 abandoned");
});
