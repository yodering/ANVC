import { expect, test } from "bun:test";
import { canonical, listRecords, nextSeq, readRecord, readRecords, refFor, ulid, validateForWrite, validateRecord, writeRecord, type CheckpointRecord } from "../protocol/record";
import { gitRepo, rec } from "./helpers";

const record = (over: Partial<CheckpointRecord> = {}) => rec({
  session: { agent: "claude-code", run_id: "sess-one" },
  intent: { goal: "make refs fast" },
  outcome: { status: "abandoned", errors: ["manifest conflict"], recheck: "bun test tests/protocol.test.ts" },
  ...over,
});

test("records round-trip through git refs and are immutable", async () => {
  const repo = gitRepo({ bare: true });
  const r = record({ delta: { files: ["refs/reftable.ts"], stats: { added: 180, removed: 12 } } });

  const { ref } = writeRecord(repo, r, 1);
  expect(ref).toBe("refs/anvc/sess-one/000001");
  expect(readRecord(repo, ref)).toEqual(r);

  // An abandoned attempt anchors to a blob, having produced no commit.
  expect(readRecord(repo, ref).anchor.kind).toBe("blob");
  expect(readRecord(repo, ref).outcome.status).toBe("abandoned");

  // Immutable: a correction is a new record, never an overwrite.
  expect(() => writeRecord(repo, r, 1)).toThrow("Refusing to overwrite");

  writeRecord(repo, record({ parent: r.id }), 2);
  expect(listRecords(repo)).toHaveLength(2);
  expect(nextSeq(repo, "sess-one")).toBe(3);
}, 30_000);

test("a ref whose object is missing costs only that record", () => {
  const repo = gitRepo({ bare: true });
  const first = writeRecord(repo, record(), 1);
  const last = writeRecord(repo, record(), 2);
  // What a fetched ref looks like after a shallow fetch or a gc took its blob:
  // cat-file answers "<oid> missing" and sends no payload.
  const gone = { ref: "refs/remotes/origin/anvc/gone/000001", oid: "1".repeat(40) };
  expect(readRecords(repo, [first, gone, last]).map(([ref]) => ref)).toEqual([first.ref, last.ref]);
});

test("validation rejects what must never reach an append-only store", () => {
  expect(() => validateRecord(record({ anvc: 1 as never }))).toThrow("Unsupported envelope version");
  expect(() => validateRecord(record({ id: "not-a-ulid" }))).toThrow("ULID");
  expect(() => validateRecord(record({ anchor: { kind: "commit", oid: "xyz" } }))).toThrow("anchor oid");
  expect(() => validateRecord(record({ outcome: { status: "maybe" as never } }))).toThrow("outcome.status");
  expect(() => validateRecord(record({ intent: { goal: "g", prompt: "x".repeat(8193) } }))).toThrow("8 KiB");
  // A captured prompt alone is not enough for a NEW record — the agent titles
  // its work, or the record stands on its evidence — but a record already
  // stored under an older rule must still read. Records are immutable and
  // outlive the code that wrote them, so raising the bar on write must never
  // make yesterday's records unreadable.
  const weak = record({ intent: { prompt: "just keep going" }, outcome: { status: "kept" } });
  expect(() => validateForWrite(weak)).toThrow("intent.goal, or evidence");
  expect(() => validateRecord(weak)).not.toThrow();
  expect(() => validateRecord(record({ ts: "yesterday" }))).toThrow("RFC 3339");
});

test("canonical form is key-order stable", () => {
  const r = record();
  const reordered = JSON.parse(JSON.stringify({ ts: r.ts, intent: r.intent, anvc: r.anvc, id: r.id, outcome: r.outcome, anchor: r.anchor, session: r.session }));
  expect(canonical(reordered)).toBe(canonical(r));
});

test("session ids are sanitised into valid ref paths", () => {
  expect(refFor("2638C6C1-E43E-4778", 7)).toBe("refs/anvc/2638c6c1-e43e-4778/000007");
  expect(() => refFor("...", 1)).toThrow("Invalid session id");
});

/**
 * The fields added to make a record checkable rather than merely readable.
 *
 * Each rule here exists because the field it guards is load-bearing in a way
 * that fails quietly. A `scope` on a kept record would let "this approach is
 * dead" be read off work that succeeded; an evidence entry with no path and no
 * commit is prose wearing a struct; and a self-referencing `serves` makes a
 * lineage walk loop forever.
 */
test("a record cannot claim more than it can show", () => {
  const base = (over: Record<string, unknown> = {}) => rec({ intent: { goal: "g" }, ...over } as Partial<CheckpointRecord>);

  // `general` means "nobody should try this again". It has to be unavailable
  // to work that was kept, or the strongest warning we have is readable off a
  // success.
  expect(() => validateRecord(base({ outcome: { status: "kept", scope: "general" } })))
    .toThrow(/abandoned/);
  expect(() => validateRecord(base({ outcome: { status: "abandoned", scope: "cosmic" } })))
    .toThrow(/local or general/);

  // Evidence is an address or it is nothing. A note with no path and no commit
  // is the prose this field exists to replace.
  expect(() => validateRecord(base({ evidence: [{ note: "trust me" }] }))).toThrow(/path or a commit/);
  expect(() => validateRecord(base({ evidence: [{ commit: "zzz" }] }))).toThrow(/git oid/);

  const selfRef = base();
  (selfRef as unknown as Record<string, unknown>).serves = selfRef.id;
  expect(() => validateRecord(selfRef)).toThrow(/its own record/);

  expect(() => validateRecord(base({ authority: "root" }))).toThrow(/agent or human/);

  // And the shape it is all for: an abandoned attempt that says how far the
  // failure reaches, how to check it, and where to look.
  expect(() => validateRecord(base({
    serves: ulid(),
    outcome: { status: "abandoned", scope: "general", recheck: "bun test tests/x.test.ts" },
    evidence: [{ path: "protocol/query.ts", line: 12, commit: "c98cecd" }],
    authority: "human",
  }))).not.toThrow();
});

test("every envelope field survives being written to a blob", () => {
  // `canonical()` copies a fixed key list, so a field missing from that list is
  // dropped silently — the record that gets stored is not the record that was
  // validated, and nothing anywhere would say so.
  const full = {
    anvc: 0, id: ulid(), anchor: { kind: "blob", oid: "a".repeat(40) },
    parent: ulid(), serves: ulid(), supersedes: ulid(),
    session: { agent: "claude-code", run_id: "s" },
    intent: { goal: "g" },
    outcome: { status: "abandoned", scope: "local", recheck: "bun test" },
    evidence: [{ path: "a.ts", commit: "c98cecd" }],
    authority: "agent",
    ts: new Date().toISOString(),
  } as unknown as CheckpointRecord;

  const round = JSON.parse(canonical(full));
  for (const key of Object.keys(full as unknown as Record<string, unknown>)) {
    expect(round[key], `canonical() dropped ${key}`).toBeDefined();
  }
});

test("an abandoned record has to say how it could be checked", () => {
  // Every case below names its own outcome.
  const base = (over: Record<string, unknown> = {}) => rec({ intent: { goal: "Try a mutex around the ref cache" }, ...over } as Partial<CheckpointRecord>);

  // `recheck` was optional and filled in 0 of 33 records — including 0 of the
  // 2 abandoned ones, by the agent that added the field while writing the
  // comments about why it mattered. An optional field carrying the whole
  // verification story is a field that does not exist.
  expect(() => validateForWrite(base({ outcome: { status: "abandoned", errors: ["deadlock"] } })))
    .toThrow(/recheck/);

  // A command is the good answer.
  expect(() => validateForWrite(base({
    outcome: { status: "abandoned", errors: ["deadlock"], recheck: "bun test tests/concurrency.test.ts" },
  }))).not.toThrow();

  // `null` is also an answer: some failures genuinely have no command that
  // settles them. It has to be stated, because leaving it out is what made the
  // field vanish in the first place.
  expect(() => validateForWrite(base({
    outcome: { status: "abandoned", errors: ["deadlock"], recheck: null },
  }))).not.toThrow();

  // Kept work is not making a claim anyone has to re-test.
  expect(() => validateForWrite(base({ outcome: { status: "kept" } }))).not.toThrow();

  // A scraped record has no agent standing by to answer, and holding it to a
  // rule it cannot satisfy would drop the turn entirely.
  expect(() => validateForWrite(base({
    intent: {}, delta: { files: ["a.ts"] }, outcome: { status: "abandoned" },
  }))).not.toThrow();
});

test("the verdict is readable before the evidence", () => {
  // Agents grep, read the first lines, and conclude. Measured before this
  // changed: `outcome` sat at a median of 93.9% and a maximum of 99.7% through
  // each record, so a partial read saw an approach and the commands that ran
  // it and never reached "…and it was abandoned" — which reads as a
  // description of how to do the thing.
  const record = {
    anvc: 0, id: ulid(), anchor: { kind: "blob", oid: "a".repeat(40) },
    session: { agent: "claude-code", run_id: "s" },
    intent: { goal: "Try a mutex around the ref cache" },
    actions: Array.from({ length: 200 }, (_, i) => ({ kind: "shell", command: `step ${i}`, ts: new Date().toISOString() })),
    outcome: { status: "abandoned", errors: ["deadlock under five writers"], recheck: "bun test" },
    ts: new Date().toISOString(),
  } as unknown as CheckpointRecord;

  const text = canonical(record);
  const verdict = text.indexOf('"outcome"');
  const bulk = text.indexOf('"actions"');
  expect(verdict).toBeGreaterThan(-1);
  // The first bytes have to be true on their own even if nothing after them is
  // read, so the verdict precedes the bulky action list.
  expect(verdict).toBeLessThan(bulk);
  expect(verdict / text.length).toBeLessThan(0.1);
});

test("a map record carries the agent's understanding and survives canonicalisation", () => {
  const record = {
    anvc: 0 as const,
    id: "01JQZX9K4M7N8P2R3S5T6V7W8X",
    anchor: { kind: "commit" as const, oid: "a".repeat(40) },
    session: { agent: "claude-code", run_id: "t" },
    intent: { goal: "Describe what protocol/ is for" },
    outcome: { status: "kept" as const },
    ts: "2026-09-22T10:00:00.000Z",
    map: {
      part: "protocol",
      does: "The record format and everything that reads it.",
      reads: [{ part: "emitters", what: "captured hook events" }],
      feeds: [{ part: "server", what: "every view" }],
      decisions: [{ what: "Records are immutable", because: "An edited record cannot be trusted." }],
    },
  };
  validateForWrite(record);
  const parsed = JSON.parse(canonical(record));
  expect(parsed.map.part).toBe("protocol");
  expect(parsed.map.decisions[0].because).toContain("cannot be trusted");
  // The verdict has to stay first; understanding is not what a reader scans for.
  expect(Object.keys(parsed).indexOf("outcome")).toBeLessThan(Object.keys(parsed).indexOf("map"));
});
