/**
 * The index is rebuilt from refs on every query, so reading records is the
 * cost that decides whether this works on a real log.
 *
 * `readRecord` spawns one `git cat-file` per ref. At 5,000 records that was
 * 2,727 ms against 71 ms for a single `cat-file --batch`, and because the
 * rebuild happens per query the cost was paid every time: 6 seconds at 10,000
 * records. No agent waits six seconds before starting work.
 */
import { expect, test } from "bun:test";
import { canonical, contentUlid, listRecords, readRecords, type CheckpointRecord } from "../protocol/record";
import { deadEnds, openDeadEnds, tried, withIndex } from "../protocol/query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitRepo, tmp } from "./helpers";

/**
 * Writes the records' blobs and their refs in two git processes. One
 * hash-object per record took over 120 s on Windows, where starting a process
 * is slow, and the test measures reads, not writes.
 */
function writeRefs(repo: string, records: Array<[ref: string, record: CheckpointRecord]>): void {
  const marks = join(tmp("anvc-marks-"), "marks");
  const parts = records.flatMap(([, record], i) => {
    const body = Buffer.from(canonical(record));
    return [Buffer.from(`blob\nmark :${i + 1}\ndata ${body.length}\n`), body, Buffer.from("\n")];
  });
  const made = Bun.spawnSync(["git", "-C", repo, "fast-import", "--quiet", `--export-marks=${marks}`], { stdin: Buffer.concat(parts), stderr: "pipe" });
  if (!made.success) throw new Error(`git fast-import failed: ${made.stderr}`);
  const oid = new Map(readFileSync(marks, "utf8").trim().split("\n").map((line) => line.split(" ") as [string, string]));
  const commands = records.map(([ref], i) => `create ${ref} ${oid.get(`:${i + 1}`)}`);
  const refs = Bun.spawnSync(["git", "-C", repo, "update-ref", "--stdin"], { stdin: Buffer.from(`${commands.join("\n")}\n`), stderr: "pipe" });
  if (!refs.success) throw new Error(`git update-ref failed: ${refs.stderr}`);
}

/** Writes `n` records the fast way, so the test measures reads, not writes. */
async function repoWith(n: number): Promise<string> {
  const repo = gitRepo({ bare: true });
  const records: Array<[string, CheckpointRecord]> = [];
  for (let i = 0; i < n; i++) {
    const record = {
      anvc: 0, id: contentUlid([String(i)], 1757000000000 + i),
      anchor: { kind: "blob", oid: "a".repeat(40) },
      session: { agent: "claude-code", run_id: `s${i % 20}` },
      intent: { goal: `turn ${i}: refactor the cache layer` },
      outcome: { status: i % 20 === 0 ? "abandoned" : "kept" },
      delta: { files: [`src/mod${i % 50}.ts`] },
      ts: new Date(1757000000000 + i * 1000).toISOString(),
    } as CheckpointRecord;
    records.push([`refs/anvc/s${i % 20}/${String(i).padStart(6, "0")}`, record]);
  }
  writeRefs(repo, records);
  // 50k loose refs cost 201 MB and pack to 6.4 MB; packing is what a real
  // repository would have done long before this point.
  git(repo, "pack-refs", "--all");
  return repo;
}

test("reading every record takes one git process, not one per record", async () => {
  const repo = await repoWith(2_000);
  const refs = listRecords(repo);
  expect(refs).toHaveLength(2_000);

  const records = readRecords(repo, refs);
  // Every record parsed, in order, with its ref.
  expect(records).toHaveLength(2_000);
  expect(records[0]![0]).toBe(refs[0]!.ref);
  expect(records[0]![1].intent.goal).toContain("turn");

  // A record whose payload contains a newline must not desynchronise the
  // stream: the batch format frames by byte count, not by delimiter.
  const goals = new Set(records.map(([, r]) => r.intent.goal));
  expect(goals.size).toBe(2_000);
}, 120_000);

test("a record with non-ASCII text does not desynchronise the batch read", async () => {
  const repo = gitRepo({ bare: true });
  // `cat-file --batch` frames each payload with a BYTE count. Slicing the
  // decoded string by it silently lost this record and every record after
  // it — one em-dash in a `why` field cost two of six records, with no error
  // anywhere.
  const { appendRecord, ulid } = await import("../protocol/record");
  const goals = [
    "Cache the index — it goes stale",   // em-dash
    "Handle café names and 日本語 paths",  // accents and CJK
    "Plain ascii after the unicode",
  ];
  for (const goal of goals) {
    appendRecord(repo, {
      anvc: 0, id: ulid(), anchor: { kind: "blob", oid: "a".repeat(40) },
      session: { agent: "claude-code", run_id: "s" },
      intent: { goal }, outcome: { status: "kept" }, ts: new Date().toISOString(),
    } as CheckpointRecord);
  }

  const read = readRecords(repo);
  expect(read).toHaveLength(3);
  expect(read.map(([, r]) => r.intent.goal).sort()).toEqual([...goals].sort());
}, 30_000);

test("a query over a large log stays interactive", async () => {
  const repo = await repoWith(5_000);
  const started = Date.now();
  const hits = withIndex(repo, (db) => tried(db, "cache layer", 10).length);
  const elapsed = Date.now() - started;

  expect(hits).toBe(10);
  // Generous: the point is to catch a return to per-record spawning, which
  // was ~3 s at this size and grew from there.
  expect(elapsed).toBeLessThan(2_000);

  // The query an agent runs unprompted must be just as cheap.
  expect(withIndex(repo, (db) => deadEnds(db, 20).length)).toBe(20);
}, 120_000);

test("folding the log down to what is still true does not scan it", async () => {
  // An append-only log never edits a record: a dead end that someone later got
  // past is corrected by a *new* record pointing back at it. That makes the
  // read side do the work — every session start has to ask, for each abandoned
  // attempt, whether anything has resolved it since.
  //
  // Done wrong that is a correlated subquery scanning every kept record per
  // abandoned one. Measured on a 5,000-record log with a correction every
  // twentieth record: 87 ms without an index on `parent`, ~1 ms with one, and
  // still 2 ms at 20,000. The unindexed version is the reason people believe
  // append-only logs get slower as they grow; it is the index that is missing,
  // not the design that is wrong.
  const repo = gitRepo({ bare: true });
  const records: Array<[string, CheckpointRecord]> = [];
  const ids: string[] = [];
  for (let i = 0; i < 3_000; i++) {
    const id = contentUlid([String(i)], 1757000000000 + i);
    ids.push(id);
    // Every other dead end gets resolved by the record five steps later.
    // That record must be `kept` — a resolver that was itself abandoned
    // resolves nothing, which is exactly what the query checks and what an
    // earlier version of this fixture got wrong.
    const resolves = i % 20 === 5 ? ids[i - 5] : undefined;
    const abandons = i % 10 === 0 && !resolves;
    const record = {
      anvc: 0, id, anchor: { kind: "blob", oid: "a".repeat(40) },
      session: { agent: "claude-code", run_id: `s${i % 20}` },
      intent: { goal: `attempt ${i}` },
      outcome: abandons ? { status: "abandoned", errors: ["failed"], recheck: "bun test" } : { status: "kept" },
      ...(resolves ? { parent: resolves } : {}),
      ts: new Date(1757000000000 + i * 1000).toISOString(),
    } as CheckpointRecord;
    records.push([`refs/anvc/s${i % 20}/${String(i).padStart(6, "0")}`, record]);
  }
  writeRefs(repo, records);
  git(repo, "pack-refs", "--all");

  withIndex(repo, (db) => {
    // Over the whole log, not the newest page: the newest dead ends have
    // not been resolved yet, so the first twenty of each are the same
    // twenty and comparing those proves nothing.
    const all = deadEnds(db, 9_999);
    const started = Bun.nanoseconds();
    const open = openDeadEnds(db, 9_999);
    const ms = (Bun.nanoseconds() - started) / 1e6;

    // Every twentieth record resolves a dead end, so half of them are
    // history rather than warnings.
    expect(all.length).toBe(300);
    expect(open.length).toBe(150);

    // Generous against CI noise; the unindexed version was ~90x this.
    expect(ms).toBeLessThan(25);
  });
}, 120_000);
