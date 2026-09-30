/**
 * A private copy of every session, readable after the agent deletes its own.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backfill } from "../protocol/backfill";
import { keepSession, keptSessions, readKept } from "../protocol/keep";
import { PRESETS, writePolicy } from "../protocol/policy";
import { gitRepo, tmp } from "./helpers";

const STOP = resolve(import.meta.dir, "../emitters/claude-code/stop.ts");

async function setup() {
  const repo = gitRepo();
  const state = tmp("anvc-keep-state-");
  const transcript = join(state, "s1.jsonl");
  const line = (text: string) => JSON.stringify({
    type: "user", uuid: `u-${text}`, sessionId: "s1", cwd: repo, timestamp: new Date().toISOString(),
    message: { role: "user", content: text },
  });
  await writeFile(transcript, `${line("make the pool work")}\n`);
  return {
    repo, state, transcript, line,
    kept: join(state, "kept"),
  };
}

const stop = (repo: string, state: string, transcript: string, event = "Stop") => Bun.spawnSync(["bun", STOP, event], {
  stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: event, session_id: "s1", cwd: repo, transcript_path: transcript, stop_hook_active: false })),
  env: { ...process.env, ANVC_STATE_DIR: state, ANVC_KEPT_DIR: join(state, "kept"), ANVC_METRICS_DIR: join(state, "metrics"), ANVC_CAPTURE_DIR: join(state, "capture") },
  stdout: "pipe", stderr: "pipe",
});

test("the stop hook keeps a compressed copy that reads back the same", async () => {
  const { repo, state, transcript, kept } = await setup();
  stop(repo, state, transcript);
  const [copy] = keptSessions(repo, kept);
  expect(copy).toMatchObject({ agent: "claude-code", session: "s1" });
  expect(copy!.path.endsWith(".jsonl.gz")).toBe(true);
  expect(readKept(copy!.path)).toBe(await Bun.file(transcript).text());
});

test("a session Claude Code deleted is still imported from the copy", async () => {
  const { repo, state, transcript, kept } = await setup();
  stop(repo, state, transcript);
  await unlink(transcript);
  const result = backfill(repo, { root: join(state, "none"), codexRoot: join(state, "none"), cursorRoot: join(state, "none"), keptRoot: kept });
  expect(result.events.map((e) => e.prompt)).toEqual(["make the pool work"]);
});

test("copies are spaced out while a session runs, and made for good when it ends", async () => {
  const { repo, state, transcript, line, kept } = await setup();
  stop(repo, state, transcript);
  await Bun.sleep(20);
  await writeFile(transcript, `${line("make the pool work")}\n${line("now the retries")}\n`);
  // A turn later: within the interval, so the copy is left as it was.
  stop(repo, state, transcript);
  expect(readKept(keptSessions(repo, kept)[0]!.path)).not.toContain("now the retries");
  // The session ends: copied regardless, and nothing is asked of the agent.
  const end = stop(repo, state, transcript, "SessionEnd");
  expect(end.stdout.toString()).toBe("");
  expect(readKept(keptSessions(repo, kept)[0]!.path)).toContain("now the retries");
});

test("nothing is kept when the project turns session copies off", async () => {
  const { repo, state, transcript, kept } = await setup();
  const policy = { preset: "team", ...structuredClone(PRESETS.team!.policy) };
  policy.fields.transcripts = "off";
  writePolicy(repo, policy);
  expect(keepSession(repo, "claude-code", "s1", transcript, { root: kept })).toBeNull();
  expect(existsSync(kept)).toBe(false);
});

test("a later copy adds only what the session file gained", async () => {
  const { repo, transcript, line, kept } = await setup();
  const path = keepSession(repo, "claude-code", "s1", transcript, { root: kept, force: true })!;
  const before = Bun.file(path).size;
  const added = `${Array.from({ length: 200 }, (_, i) => line(`turn ${i}`)).join("\n")}\n`;
  await Bun.sleep(20); // so the session file is newer than the copy
  await writeFile(transcript, added, { flag: "a" });
  keepSession(repo, "claude-code", "s1", transcript, { root: kept, force: true });
  // The copy grew by the compressed addition and nothing else.
  expect(Bun.file(path).size - before).toBe(Bun.gzipSync(new TextEncoder().encode(added)).length);
  expect(readKept(path)).toBe(await Bun.file(transcript).text());
  expect(keptSessions(repo, kept).map((k) => k.session)).toEqual(["s1"]);
});

test("a session file rewritten from the start is copied whole again", async () => {
  const { repo, transcript, line, kept } = await setup();
  const path = keepSession(repo, "claude-code", "s1", transcript, { root: kept, force: true })!;
  await Bun.sleep(20); // so the session file is newer than the copy
  await writeFile(transcript, `${line("a different first prompt")}\n${line("and more")}\n`);
  keepSession(repo, "claude-code", "s1", transcript, { root: kept, force: true });
  expect(readKept(path)).toBe(await Bun.file(transcript).text());
});

test("a copy cut off partway through an append is repaired by the next one", async () => {
  const { repo, transcript, line, kept } = await setup();
  const path = keepSession(repo, "claude-code", "s1", transcript, { root: kept, force: true })!;
  // Half of a gzip stream, as a crash during appendFileSync would leave it.
  await writeFile(path, Bun.gzipSync(new TextEncoder().encode("lost\n")).subarray(0, 12), { flag: "a" });
  await Bun.sleep(20); // so the session file is newer than the copy
  await writeFile(transcript, `${line("after the crash")}\n`, { flag: "a" });
  keepSession(repo, "claude-code", "s1", transcript, { root: kept, force: true });
  expect(readKept(path)).toBe(await Bun.file(transcript).text());
});
