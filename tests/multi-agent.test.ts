/**
 * Two agents working at once must not become one record.
 *
 * `toRecords` split a single global event stream on `UserPromptSubmit`, which
 * assumes one agent. With two running, their events interleave and a prompt
 * from either closes whatever turn is open. Measured on a four-event fixture:
 * two agents collapsed into one record, attributed to one of them and claiming
 * both their files — the other agent disappeared entirely.
 *
 * That is the exact scenario this product is sold into, so it is the exact
 * scenario that has to hold.
 */
import { expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ingest, toRecords, type CaptureEvent } from "../protocol/ingest";
import { buildIndex, deadEnds, openIndex } from "../protocol/query";
import { appendRecord, readRecords, ulid, type CheckpointRecord } from "../protocol/record";
import { gitRepo, tmp } from "./helpers";

async function repo(): Promise<string> {
  const dir = gitRepo();
  return dir;
}

test("interleaved agents produce one record each, with their own files", async () => {
  const dir = await repo();
  const base = { anvc_capture: 0 as const, repo: dir, cwd: dir };
  // Interleaved the way concurrent agents actually arrive in one capture
  // directory: A prompts, B prompts, A writes, B writes.
  const events = [
    { ...base, session_id: "agent-A", event: "UserPromptSubmit", ts: "2026-09-19T10:00:00Z", prompt: "A: add the parser" },
    { ...base, session_id: "agent-B", event: "UserPromptSubmit", ts: "2026-09-19T10:00:01Z", prompt: "B: fix the cache" },
    { ...base, session_id: "agent-A", event: "PostToolUse", ts: "2026-09-19T10:00:02Z", tool: "Write", path: `${dir}/parser.ts`, bytes: 10 },
    { ...base, session_id: "agent-B", event: "PostToolUse", ts: "2026-09-19T10:00:03Z", tool: "Write", path: `${dir}/cache.ts`, bytes: 10 },
  ] as CaptureEvent[];

  const records = toRecords(events, dir);
  expect(records).toHaveLength(2);

  const byRun = new Map(records.map((r) => [r.session.run_id, r]));
  expect([...byRun.keys()].sort()).toEqual(["agent-A", "agent-B"]);
  // Each agent claims only what it wrote. Attributing one agent's edit to
  // another is a false statement in an immutable record.
  expect(byRun.get("agent-A")!.delta?.files).toEqual(["parser.ts"]);
  expect(byRun.get("agent-B")!.delta?.files).toEqual(["cache.ts"]);
}, 30_000);

test("an event with no session is dropped rather than misattributed", async () => {
  const dir = await repo();
  const base = { anvc_capture: 0 as const, repo: dir, cwd: dir };
  const events = [
    { ...base, session_id: "agent-A", event: "UserPromptSubmit", ts: "2026-09-19T10:00:00Z", prompt: "A: add the parser" },
    // No session id. Folding it into whichever turn is open is how one
    // agent's work gets recorded as another's.
    { ...base, session_id: null, event: "PostToolUse", ts: "2026-09-19T10:00:01Z", tool: "Write", path: `${dir}/mystery.ts`, bytes: 10 },
    { ...base, session_id: "agent-A", event: "PostToolUse", ts: "2026-09-19T10:00:02Z", tool: "Write", path: `${dir}/parser.ts`, bytes: 10 },
  ] as CaptureEvent[];

  const records = toRecords(events, dir);
  expect(records).toHaveLength(1);
  expect(records[0]!.session.run_id).toBe("agent-A");
  expect(records[0]!.delta?.files).toEqual(["parser.ts"]);
}, 30_000);

test("a query result says which session produced it", async () => {
  const dir = await repo();
  for (const run of ["agent-A", "agent-B"]) {
    appendRecord(dir, {
      anvc: 0, id: ulid(), anchor: { kind: "blob", oid: "a".repeat(40) },
      session: { agent: "claude-code", run_id: run },
      intent: { goal: `${run} tried a lock` },
      outcome: { status: "abandoned", errors: ["deadlock"], recheck: "bun test tests/concurrency.test.ts" },
      ts: new Date().toISOString(),
    } as CheckpointRecord);
  }

  const db = openIndex();
  try {
    buildIndex(db, dir);
    const hits = deadEnds(db);
    expect(hits).toHaveLength(2);
    // `agent` names the tool and reads "claude-code" on every record, so
    // without the run nothing tells your dead end from a teammate's.
    expect(hits.map((h) => h.run).sort()).toEqual(["agent-A", "agent-B"]);
  } finally { db.close(); }
}, 30_000);

test("a turn that only delegated still becomes a record", async () => {
  const dir = await repo();
  const base = { anvc_capture: 0 as const, repo: dir, cwd: dir, session_id: "s1",
    path: null, bytes: null, command: null, prompt: null, ok: null };
  const events: CaptureEvent[] = [
    { ...base, event: "UserPromptSubmit", ts: "2026-09-20T10:00:00.000Z", tool: null, prompt: "go find out about X" },
    { ...base, event: "PostToolUse", ts: "2026-09-20T10:00:05.000Z", tool: "Task",
      delegated: "Research agent skimming behaviour", agent_type: "general-purpose", ok: true },
  ];

  const records = toRecords(events, dir);
  // A turn with no files and no failures is normally dropped — it says
  // nothing. A delegation is the exception: real work happened, it just
  // happened somewhere this log cannot see, and the parent's description is
  // the only trace of it that exists anywhere.
  expect(records).toHaveLength(1);
  expect(records[0]!.intent.goal).toContain("Research agent skimming behaviour");
  expect(records[0]!.intent.goal).toContain("general-purpose");
  // The subagent never calls anvc_checkpoint, so nothing else would have
  // recorded this.
  expect(records[0]!.intent.prompt).toBeUndefined();

  // Claude Code called the tool Task, and now calls it Agent.
  const renamed = events.map((e) => (e.tool === "Task" ? { ...e, tool: "Agent" } : e));
  expect(toRecords(renamed, dir).map((r) => r.intent.goal)).toEqual([records[0]!.intent.goal]);
}, 30_000);

test("an abandoned turn that delegated is stored", async () => {
  const dir = gitRepo({ commit: true });
  writeFileSync(join(dir, "a.ts"), "never committed\n");
  const base = { anvc_capture: 0 as const, repo: dir, cwd: dir, session_id: "s1",
    path: null, bytes: null, command: null, prompt: null, ok: null };
  const events: CaptureEvent[] = [
    { ...base, event: "UserPromptSubmit", ts: "2026-09-20T10:00:00.000Z", tool: null, prompt: "try the other parser" },
    { ...base, event: "PostToolUse", ts: "2026-09-20T10:00:05.000Z", tool: "Task", delegated: "Port the parser", ok: true },
    { ...base, event: "PostToolUse", ts: "2026-09-20T10:00:09.000Z", tool: "Edit", path: join(dir, "a.ts"), ok: true },
  ];
  // The delegation gives it a goal, and an abandoned record with a goal has
  // to answer recheck, so this turn was refused on every ingest.
  const result = ingest(dir, events);
  expect(result.failed).toEqual([]);
  expect(result.written).toBe(1);
  const [, record] = readRecords(dir)[0]!;
  expect(record.outcome).toMatchObject({ status: "abandoned", recheck: null });
}, 30_000);

test("a scraped turn keeps the output of what failed", async () => {
  const dir = await repo();
  const base = { anvc_capture: 0 as const, repo: dir, cwd: dir, session_id: "s1",
    path: null, bytes: null, prompt: null, ok: null };
  const events: CaptureEvent[] = [
    { ...base, event: "UserPromptSubmit", ts: "2026-09-22T10:00:00.000Z", tool: null, command: null, prompt: "fix the pool" },
    { ...base, event: "PostToolUse", ts: "2026-09-22T10:00:05.000Z", tool: "Bash",
      command: "pytest tests/test_pool.py", ok: false,
      output: 'ssl.SSLError: [X509] no certificate found\n  raised in 3 of 200 requests' },
  ];

  const records = toRecords(events, dir);
  expect(records).toHaveLength(1);

  // A scraped turn cannot write a narrative — no agent is there to write one
  // — but it can keep what was observed, which is the half nobody can
  // reconstruct later. Before this the record said only that a command
  // failed, which is the one thing a reader could already guess.
  expect(records[0]!.detail?.output).toContain("ssl.SSLError");
  expect(records[0]!.detail?.output).toContain("3 of 200 requests");
  // And the command it belongs to, so the output is attributable.
  expect(records[0]!.detail?.output).toContain("pytest tests/test_pool.py");
}, 30_000);

test("a file written through a symlink to the repository is still its file", async () => {
  // As on macOS, where git says /private/var/... and the agent says /var/....
  const dir = gitRepo({ commit: true });
  const link = join(tmp("anvc-link-"), "repo");
  symlinkSync(dir, link);
  writeFileSync(join(dir, "a.ts"), "changed\n");
  const base = { anvc_capture: 0 as const, repo: link, cwd: link, session_id: "s1",
    path: null, bytes: null, command: null, prompt: null, ok: null };
  const events: CaptureEvent[] = [
    { ...base, event: "UserPromptSubmit", ts: "2026-09-20T10:00:00.000Z", tool: null, prompt: "change a" },
    { ...base, event: "PostToolUse", ts: "2026-09-20T10:00:05.000Z", tool: "Edit", path: join(link, "a.ts") },
  ];
  expect(toRecords(events, dir).map((r) => r.delta?.files)).toEqual([["a.ts"]]);
  // Named both ways, it is still one file.
  const both = [...events, { ...events[1]!, ts: "2026-09-20T10:00:06.000Z", path: join(dir, "a.ts") }];
  expect(toRecords(both, dir).map((r) => r.delta?.files)).toEqual([["a.ts"]]);
}, 30_000);

test("a file written outside the repository is not that repository's history", async () => {
  const dir = await repo();
  const event = (path: string): CaptureEvent => ({
    anvc_capture: 0, event: "PostToolUse", ts: "2026-09-01T10:00:00.000Z",
    session_id: "s1", cwd: dir, repo: dir, tool: "Write", path,
    bytes: 10, command: null, prompt: null, ok: true,
  });
  const [record] = toRecords([
    { ...event(""), event: "UserPromptSubmit", tool: null, path: null, prompt: "do the thing" },
    event(join(dir, "src/app.ts")),
    // A scratch file and the agent's own notes are not the project.
    event("/tmp/scratch.json"),
    event("/home/someone/.claude/projects/notes.md"),
    // A sibling repository whose path merely starts the same way.
    event(`${dir}-other/app.ts`),
  ], dir);
  expect(record!.delta?.files).toEqual(["src/app.ts"]);
});
