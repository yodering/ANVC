/**
 * Records must survive concurrent writers.
 *
 * `writeRecord` used to check the ref with `rev-parse` and then write it with a
 * bare `update-ref`, which overwrites unconditionally. Between those two
 * commands another writer could take the ref, so ten agents checkpointing one
 * session were all told "recorded" while nine records were destroyed. The
 * product's one claim is that the record is trustworthy, so this is the failure
 * that matters most.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { appendRecord, listRecords, nextSeq, readRecord, writeRecord } from "../protocol/record";
import { git, gitRepo, rec, tmp } from "./helpers";

const record = (run: string, goal: string) => rec({ session: { agent: "claude-code", run_id: run }, intent: { goal } });

test("a ref that exists is never overwritten", async () => {
  const repo = gitRepo({ bare: true });
  const first = writeRecord(repo, record("s", "first"), 1);

  // The second write targets a ref that is already taken.
  expect(() => writeRecord(repo, record("s", "second"), 1)).toThrow(/Refusing to overwrite/);

  // And the original is untouched, which is the point of the guard.
  expect(readRecord(repo, first.ref).intent.goal).toBe("first");
}, 30_000);

test("concurrent writers each keep their record", async () => {
  const repo = gitRepo({ bare: true });

  // Separate processes, so this is real OS-level concurrency rather than
  // interleaved promises in one event loop.
  const writer = join(tmp("anvc-writer-"), "writer.ts");
  await Bun.write(writer, `
    import { appendRecord, ulid } from ${JSON.stringify(join(import.meta.dir, "../protocol/record.ts"))};
    appendRecord(process.argv[2]!, { anvc: 0, id: ulid(),
      anchor: { kind: "blob", oid: "a".repeat(40) },
      session: { agent: "claude-code", run_id: "shared" },
      intent: { goal: "item " + process.argv[3] }, outcome: { status: "kept" },
      ts: new Date().toISOString() });
  `);
  const procs = Array.from({ length: 12 }, (_, i) =>
    Bun.spawn(["bun", writer, repo, String(i)], { stdout: "ignore", stderr: "pipe" }));
  const codes = await Promise.all(procs.map((p) => p.exited));

  expect(codes.every((c) => c === 0)).toBe(true);
  // Every writer that reported success must be findable in the log.
  const refs = listRecords(repo);
  expect(refs).toHaveLength(12);
  // And each holds a distinct record rather than twelve copies of one.
  const goals = new Set(refs.map(({ ref }) => readRecord(repo, ref).intent.goal));
  expect(goals.size).toBe(12);
}, 120_000);

test("a stray non-numeric ref does not brick the session", async () => {
  const repo = gitRepo({ bare: true });
  const { oid } = writeRecord(repo, record("s", "first"), 1);
  // A backup or a mirror's refspec can leave a non-sequence ref here. It used
  // to make `Math.max` return NaN, and every later write for that session
  // failed with "Invalid sequence" forever after.
  git(repo, "update-ref", "refs/anvc/s/backup", oid);

  expect(nextSeq(repo, "s")).toBe(2);
  expect(() => appendRecord(repo, record("s", "second"))).not.toThrow();
}, 30_000);
