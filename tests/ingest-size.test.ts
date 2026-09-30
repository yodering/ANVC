/**
 * A long turn must still produce a record.
 *
 * `outcome.errors` was added with no bound, in an envelope where everything
 * else is bounded. A turn with enough failing commands grew past the 64 KiB
 * cap, `validateRecord` rejected it, and the ingest loop's bare `catch` counted
 * the loss as "already present" — so the records most worth keeping, long
 * sessions full of failures, disappeared without a word.
 */
import { expect, test } from "bun:test";
import { ingest, type CaptureEvent } from "../protocol/ingest";
import { canonical, readRecord, listRecords, validateRecord, MAX_RECORD_BYTES } from "../protocol/record";
import { gitRepo } from "./helpers";

/** A turn of `n` failing shell commands, long enough to strain the cap. */
function longTurn(repo: string, n: number, ok: boolean | null): CaptureEvent[] {
  const base = { anvc_capture: 0 as const, repo, cwd: repo, session_id: "sess-long" };
  const events: unknown[] = [{
    ...base, ts: new Date().toISOString(), prompt: "x".repeat(7800),
    tool: null, path: null, command: null, bytes: null, ok: null,
  }];
  // A turn with no files and no failures records nothing now, so a succeeding
  // fixture needs a write to be a unit of work at all.
  events.push({ ...base, ts: new Date().toISOString(), tool: "Write",
    path: `${repo}/module.py`, bytes: 120, command: null, prompt: null, ok: true });
  for (let i = 0; i < n; i++) {
    events.push({
      ...base, ts: new Date(Date.now() + i * 1000).toISOString(), tool: "Bash",
      command: `pytest tests/test_module_${i}.py ${"y".repeat(480)}`,
      path: null, bytes: null, prompt: null, ok,
    });
  }
  return events as CaptureEvent[];
}

test("a turn too large for the envelope is trimmed, not dropped", async () => {
  const repo = gitRepo();

  // 94 and 96 are the window that regressed: these fit without errors and
  // did not fit with them.
  for (const n of [94, 96, 300]) {
    const result = ingest(repo, longTurn(repo, n, false));
    expect(result.failed).toEqual([]);
    expect(result.written).toBe(1);
  }

  const refs = listRecords(repo);
  expect(refs).toHaveLength(3);

  for (const { ref } of refs) {
    const record = readRecord(repo, ref);
    // Every stored record is within the cap and passes validation.
    expect(Buffer.byteLength(canonical(record), "utf8")).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(() => validateRecord(record)).not.toThrow();
    // Not necessarily truncated any more: dropping the stored prompt took
    // roughly 8 KiB off every scraped record, so a turn that used to need
    // trimming now fits. What matters is that it fits and keeps its
    // evidence, not that it was trimmed.
    // The prompt is no longer stored — the agent titles its own work, and a
    // scraped turn stands on its evidence.
    expect(record.intent.prompt).toBeUndefined();
    expect(record.delta?.files?.length).toBeGreaterThan(0);
    expect(record.outcome.errors?.length).toBeGreaterThan(0);
  }
}, 60_000);

test("a failing shell command is recorded as an error, within bounds", async () => {
  const repo = gitRepo();
  const result = ingest(repo, longTurn(repo, 40, false));
  expect(result.written).toBe(1);

  const record = readRecord(repo, listRecords(repo)[0]!.ref);
  // Bounded at 20 entries even though 40 commands failed.
  expect(record.outcome.errors!.length).toBe(20);
  expect(record.outcome.errors![0]).toContain("failed: pytest");
}, 30_000);

test("a succeeding turn records no errors", async () => {
  const repo = gitRepo();
  ingest(repo, longTurn(repo, 5, true));
  const record = readRecord(repo, listRecords(repo)[0]!.ref);
  // `ok: true` must not invent an error, and the field is omitted when empty.
  expect(record.outcome.errors).toBeUndefined();
}, 30_000);

test("re-ingesting the same capture writes nothing", async () => {
  const repo = gitRepo();
  const events = longTurn(repo, 5, false);

  expect(ingest(repo, events).written).toBe(1);

  // This used to write a duplicate: `nextSeq` always advances, so the second
  // run landed on a fresh ref instead of colliding. Record ids are derived
  // from the turn now, so the turn is recognised and skipped.
  const second = ingest(repo, events);
  expect(second.failed).toEqual([]);
  expect(second.written).toBe(0);
  expect(second.skipped).toBe(1);
  expect(listRecords(repo)).toHaveLength(1);
}, 30_000);
