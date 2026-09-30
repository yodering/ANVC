/**
 * Work an agent finished without recording is saved from the raw log, once,
 * privately, and never for turns the agent did record.
 */
import { expect, test } from "bun:test";
import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readActivity } from "../protocol/activity";
import { autosave } from "../protocol/autosave";
import { appendRecord, listRecords, readRecord, ulid } from "../protocol/record";
import { setEnv, tmp, writeCapture } from "./helpers";

function repo() {
  const dir = tmp("anvc-autosave-");
  // The base commit predates every turn below, as it would in real use.
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { env: { ...process.env, GIT_COMMITTER_DATE: hourAgo, GIT_AUTHOR_DATE: hourAgo } });
  git("init", "-q");
  writeFileSync(join(dir, "a.ts"), "one\n");
  git("add", "a.ts");
  git("commit", "-q", "-m", "base");
  setEnv({ ANVC_CAPTURE_DIR: tmp("anvc-autosave-log-"), ANVC_STATE_DIR: tmp("anvc-autosave-state-") });
  return {
    dir,
    write: (rows: object[]) => writeCapture(dir, rows.map((r) => ({ agent: "codex", ...r }))),
  };
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

test("a session that recorded nothing is saved once, privately, with what failed", async () => {
  const r = repo();
  writeFileSync(join(r.dir, "a.ts"), "two\n");
  r.write([
    { session_id: "s1", event: "UserPromptSubmit", ts: ago(5), prompt: "change a" },
    { session_id: "s1", event: "PostToolUse", ts: ago(4), tool: "Edit", path: join(r.dir, "a.ts") },
    { session_id: "s1", event: "PostToolUse", ts: ago(3), tool: "Bash", command: "bun test", ok: false, output: "1 fail" },
  ]);
  const ids = autosave(r.dir, { session: "s1" });
  expect(ids).toHaveLength(1);
  expect(autosave(r.dir, { session: "s1" })).toEqual([]);
  const [ref] = listRecords(r.dir);
  expect(ref!.ref.startsWith("refs/anvc-private/")).toBe(true);
  const record = readRecord(r.dir, ref!.ref);
  expect(record.intent.goal).toBeUndefined();
  // Uncommitted right after the session is work in progress, not abandoned.
  expect(record.outcome.status).toBe("kept");
  expect(record.outcome.errors).toEqual(["failed: bun test"]);
});

test("turns the agent recorded are left alone", async () => {
  const r = repo();
  writeFileSync(join(r.dir, "a.ts"), "two\n");
  r.write([
    { session_id: "s2", event: "UserPromptSubmit", ts: ago(5), prompt: "change a" },
    { session_id: "s2", event: "PostToolUse", ts: ago(4), tool: "Edit", path: join(r.dir, "a.ts") },
  ]);
  const head = Bun.spawnSync(["git", "-C", r.dir, "rev-parse", "HEAD"]).stdout.toString().trim();
  appendRecord(r.dir, {
    anvc: 0, id: ulid(), anchor: { kind: "commit", oid: head }, session: { agent: "codex", run_id: "s2" },
    intent: { goal: "Change a" }, outcome: { status: "kept" }, ts: ago(2),
  });
  expect(autosave(r.dir, { session: "s2" })).toEqual([]);
});

test("at session start, only sessions that have gone quiet are saved", async () => {
  const r = repo();
  writeFileSync(join(r.dir, "a.ts"), "two\n");
  for (const [session, minutes] of [["old", 90], ["busy", 5], ["me", 1]] as const) {
    r.write([
      { session_id: session, event: "UserPromptSubmit", ts: ago(minutes + 1), prompt: "change a" },
      { session_id: session, event: "PostToolUse", ts: ago(minutes), tool: "Edit", path: join(r.dir, "a.ts") },
    ]);
  }
  autosave(r.dir, { except: "me" });
  const sessions = listRecords(r.dir).map(({ ref }) => readRecord(r.dir, ref).session.run_id);
  expect(sessions).toEqual(["old"]);
});

test("an edit put back before the session ended is abandoned", async () => {
  const r = repo();
  // Written, then restored: the file is clean and no commit touched it.
  r.write([
    { session_id: "s3", event: "UserPromptSubmit", ts: ago(5), prompt: "change a" },
    { session_id: "s3", event: "PostToolUse", ts: ago(4), tool: "Edit", path: join(r.dir, "a.ts") },
  ]);
  autosave(r.dir, { session: "s3" });
  const [ref] = listRecords(r.dir);
  expect(readRecord(r.dir, ref!.ref).outcome.status).toBe("abandoned");
});

// Skipped on Windows: a read-only folder doesn't stop git writing into it there.
test.skipIf(process.platform === "win32")("a turn that couldn't be stored is logged and tried again next time", async () => {
  const r = repo();
  setEnv({ ANVC_ACTIVITY_DIR: tmp("anvc-autosave-activity-") });
  writeFileSync(join(r.dir, "a.ts"), "two\n");
  r.write([
    { session_id: "s4", event: "UserPromptSubmit", ts: ago(5), prompt: "change a" },
    { session_id: "s4", event: "PostToolUse", ts: ago(4), tool: "Edit", path: join(r.dir, "a.ts") },
  ]);
  // With the object folders read-only, git can't write the record's blob.
  const objects = join(r.dir, ".git", "objects");
  const folders = [objects, ...readdirSync(objects).map((d) => join(objects, d))];
  for (const f of folders) chmodSync(f, 0o555);
  try {
    expect(autosave(r.dir, { session: "s4" })).toEqual([]);
  } finally {
    for (const f of folders) chmodSync(f, 0o755);
  }
  expect(readActivity({ session: "s4" })).toMatchObject([{ kind: "autosaved", outcome: "failed" }]);
  expect(autosave(r.dir, { session: "s4" })).toHaveLength(1);
});
