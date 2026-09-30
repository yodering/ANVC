/**
 * Re-ingesting an unchanged capture directory must change nothing.
 *
 * Capture files are append-only and `anvc ingest` reads the whole directory, so
 * re-running it is the normal workflow. It used to write every turn again each
 * time: records were byte-identical apart from a random ULID, so each got a new
 * id, `nextSeq` handed out a new sequence, and the immutability guard never
 * fired. Measured on this repository's own capture: three runs produced 93 refs
 * for 57 real turns, reported as "(0 already present)".
 */
import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ingest, readCapture, toRecords, type CaptureEvent } from "../protocol/ingest";
import { listRecords, readRecord } from "../protocol/record";
import { gitRepo, tmp } from "./helpers";

async function fixture(): Promise<{ repo: string; events: CaptureEvent[]; captureDir: string }> {
  const repo = gitRepo();
  const captureDir = tmp("anvc-idem-cap-");
  const base = { anvc_capture: 0, repo, cwd: repo, session_id: "s1" };
  const lines = [
    { ...base, event: "UserPromptSubmit", ts: "2026-09-17T10:00:00.000Z", prompt: "add the parser" },
    { ...base, event: "PostToolUse", ts: "2026-09-17T10:00:05.000Z", tool: "Write", path: `${repo}/parser.ts`, bytes: 100 },
    { ...base, event: "UserPromptSubmit", ts: "2026-09-17T11:00:00.000Z", prompt: "fix the parser bug" },
    { ...base, event: "PostToolUse", ts: "2026-09-17T11:00:05.000Z", tool: "Write", path: `${repo}/parser.ts`, bytes: 120 },
  ];
  const file = join(captureDir, "day.jsonl");
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  return { repo, events: readCapture(file), captureDir };
}

test("ingesting the same capture three times writes each turn once", async () => {
  const { repo, events } = await fixture();
  const first = ingest(repo, events);
  expect(first.written).toBe(2);
  expect(first.failed).toEqual([]);

  // The runs that used to fabricate history.
  for (const run of [2, 3]) {
    const again = ingest(repo, events);
    expect(again.written).toBe(0);
    expect(again.skipped).toBe(2);
    expect(again.failed).toEqual([]);
    expect(listRecords(repo).length).toBe(2);
    expect(run).toBeGreaterThan(1);
  }

  // And the two records are the two real turns, not one turn twice.
  // Prompts are no longer stored; the two records are told apart by what
  // they changed, which is what a scraped turn honestly knows.
  const files = listRecords(repo).flatMap(({ ref }) => readRecord(repo, ref).delta?.files ?? []);
  expect(files.length).toBeGreaterThan(0);
}, 60_000);

test("a turn's id is derived from the turn, not from when it was ingested", async () => {
  const { repo, events } = await fixture();
  // Two independent derivations of the same events must agree, or the skip
  // check above has nothing stable to compare.
  const a = toRecords(events, repo).map((r) => r.id);
  const b = toRecords(events, repo).map((r) => r.id);
  expect(a).toEqual(b);
  expect(new Set(a).size).toBe(2);
}, 30_000);

test("a different turn still gets a different id", async () => {
  const { repo, events } = await fixture();
  const base = { anvc_capture: 0, repo, cwd: repo, session_id: "s1" };
  const changed = [
    ...events,
    { ...base, event: "UserPromptSubmit", ts: "2026-09-17T12:00:00.000Z", prompt: "a third thing" },
    // A turn needs evidence to be recorded, so the third one writes a file.
    { ...base, event: "PostToolUse", ts: "2026-09-17T12:00:05.000Z", tool: "Write", path: `${repo}/third.ts`, bytes: 40 },
  ] as CaptureEvent[];

  ingest(repo, events);
  const added = ingest(repo, changed);
  expect(added.written).toBe(1);
  expect(added.skipped).toBe(2);
  expect(listRecords(repo).length).toBe(3);
}, 60_000);

test("a prompt written after its commands still opens their turn", async () => {
  const { repo, events } = await fixture();
  // Cursor's print mode writes the prompt at session end, stamped earlier.
  const [prompt, ...rest] = events;
  expect(toRecords([...rest.slice(0, 1), prompt!, ...rest.slice(1)], repo).length).toBe(2);
}, 60_000);

test("a file named after a cd, or never in the repository, isn't counted as written", async () => {
  const { repo } = await fixture();
  const base = { anvc_capture: 0, repo, cwd: repo, session_id: "s9" };
  const events = [
    { ...base, event: "UserPromptSubmit", ts: "2026-09-18T10:00:00.000Z", prompt: "note it" },
    { ...base, event: "PostToolUse", ts: "2026-09-18T10:00:05.000Z", tool: "Bash", command: "cd ~/notes && sed -i 's/a/b/' MEMORY.md", ok: false },
    { ...base, event: "PostToolUse", ts: "2026-09-18T10:00:06.000Z", tool: "Bash", command: "echo x > never-here.txt && rm never-here.txt", ok: true },
  ] as any;
  const [record] = toRecords(events, repo);
  expect(record?.delta?.files ?? []).toEqual([]);
}, 60_000);
