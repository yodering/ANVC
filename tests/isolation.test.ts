/**
 * Installed for every repository, ANVC keeps one raw log per machine, and an
 * agent in one project must never be shown another's prompts, commands or
 * output. Two repositories whose paths make the same folder name before the
 * hash was added, their rows mixed in the shared files from before the split:
 * each sees only its own.
 */
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autosave } from "../protocol/autosave";
import { sessionRows } from "../protocol/evidence";
import { legacyKey, repoKey } from "../protocol/rawlog";
import { listRecords } from "../protocol/record";
import { searchRaw } from "../protocol/search";
import { git, setEnv, tmp } from "./helpers";

test("folder names differ for paths the old naming merged", () => {
  expect(legacyKey("/x/a-b")).toBe(legacyKey("/x/a b"));
  expect(legacyKey("/x/a-b")).toBe(legacyKey("/x/a/b"));
  expect(repoKey("/x/a-b")).not.toBe(repoKey("/x/a b"));
  expect(repoKey("/x/a-b")).not.toBe(repoKey("/x/a/b"));
});

test("one repository's raw log never shows up in another's search, evidence or saved work", async () => {
  const base = tmp("anvc-iso-");
  const log = join(base, "log");
  const a = join(base, "my-app"), b = join(base, "my app");
  setEnv({ ANVC_CAPTURE_DIR: log, ANVC_STATE_DIR: join(base, "state") });
  for (const repo of [a, b]) {
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  }
  const day = new Date().toISOString().slice(0, 10);
  const ts = new Date(Date.now() - 3_600_000).toISOString();
  const row = (repo: string, session: string, extra: object) =>
    JSON.stringify({ anvc_capture: 0, repo, cwd: repo, agent: "codex", session_id: session, ts, ...extra });
  // A's secret, written everywhere B's reader looks: the shared folder the
  // old naming gave both, and the flat file from before the split.
  const secret = [
    row(a, "sa", { event: "UserPromptSubmit", prompt: "deploy with the staging token" }),
    row(a, "sa", { event: "PostToolUse", tool: "Bash", command: "curl staging-secret", ok: false, output: "staging-secret failed" }),
  ].join("\n");
  mkdirSync(join(log, legacyKey(b)), { recursive: true });
  writeFileSync(join(log, legacyKey(b), `${day}.jsonl`), `${secret}\n`);
  writeFileSync(join(log, `${day}.jsonl`), `${secret}\n`);
  // Even under B's session id.
  writeFileSync(join(log, legacyKey(b), `${day}.jsonl`), `${row(a, "sb", { event: "PostToolUse", tool: "Bash", command: "staging-secret again", ok: false })}\n`, { flag: "a" });

  expect(searchRaw(b, "staging-secret")).toEqual([]);
  expect(sessionRows(b, "sb", null)).toEqual([]);
  expect(sessionRows(b, "sa", null)).toEqual([]);
  autosave(b, { except: "none" });
  expect(listRecords(b)).toEqual([]);
  // A itself still finds its own.
  expect(searchRaw(a, "staging-secret").length).toBeGreaterThan(0);
});
