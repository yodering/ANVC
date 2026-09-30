/**
 * One raw log per repository, the same from every worktree of it.
 */
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { captureFiles, lastDays, repoKey, samePath } from "../protocol/rawlog";
import { handoff } from "../protocol/handoff";
import { git, gitRepo, rawRows, runHook, tmp } from "./helpers";

test("a worktree's events land in its repository's folder", async () => {
  const repo = gitRepo({ commit: true });
  const tree = join(tmp("anvc-raw-wt-"), "wt");
  const root = tmp("anvc-raw-cap-");
  git(repo, "worktree", "add", "-q", tree);
  for (const cwd of [repo, tree]) {
    runHook("capture", "PostToolUse", { session_id: "s", cwd, tool_name: "Bash", tool_input: { command: "ls" } }, { ANVC_CAPTURE_DIR: root });
  }
  const files = captureFiles(null, root);
  expect(files).toHaveLength(1);
  expect(files[0]).toContain(`${sep}${repoKey(repo)}${sep}`);
  expect(rawRows(root).map((r) => samePath(r.repo))).toEqual([samePath(repo), samePath(repo)]);
});

test("rows written before the split, in the shared daily file, are still read", async () => {
  const repo = gitRepo();
  const root = tmp("anvc-raw-oldcap-");
  const day = new Date().toISOString().slice(0, 10);
  await writeFile(join(root, `${day}.jsonl`), JSON.stringify({
    anvc_capture: 0, event: "PostToolUse", ts: new Date().toISOString(), session_id: "old", agent: "codex",
    cwd: repo, repo, tool: "Edit", path: join(repo, "a.ts"), bytes: 1, command: null, prompt: null, ok: true,
  }) + "\n");
  expect(handoff(repo, "new", { captureDir: root })).toContain("Codex worked in this repository");
});

test("the last days are named the way the log files are, today first", () => {
  expect(lastDays(3, Date.parse("2026-03-01T12:00:00Z"))).toEqual(["2026-03-01", "2026-02-28", "2026-02-27"]);
});
