import { expect, test } from "bun:test";
import { writeRecord, type CheckpointRecord } from "../protocol/record";
import { abandonedTouching, buildIndex, failed, openIndex, overlap, redToGreen, session, summary, tried, why } from "../protocol/query";
import { gitRepo, rec } from "./helpers";

const record = ({ run = "sess-a", ...over }: Partial<CheckpointRecord> & { run?: string } = {}) =>
  rec({ session: { agent: "claude-code", run_id: run }, intent: { prompt: "generic work" }, ...over });

// Prompt-only records are the captured kind, which live in the private tier:
// a shared record drops `intent.prompt`, since what a person typed stays here.
test("the six queries answer what git and transcripts cannot", async () => {
  const repo = gitRepo({ bare: true });

  // An abandoned attempt on a lock: no commit, so invisible to git log.
  writeRecord(repo, record({
    run: "sess-a", intent: { prompt: "remove the mutex around the ref cache" },
    delta: { files: ["refs/cache.ts"] },
    outcome: { status: "abandoned", errors: ["data race under five writers"], recheck: "bun test tests/concurrency.test.ts" },
  }), 1, "private");
  // A kept repair that turned tests green.
  writeRecord(repo, record({
    run: "sess-a", intent: { prompt: "keep the mutex, shrink the critical section" },
    delta: { files: ["refs/cache.ts"] },
    outcome: { status: "kept", tests: { passed: 48, failed: 0 } },
  }), 2, "private");
  // A second session touching the same file: overlap.
  writeRecord(repo, record({
    run: "sess-b", intent: { prompt: "add metrics to the ref cache" },
    delta: { files: ["refs/cache.ts", "metrics.ts"] },
  }), 1, "private");

  const db = openIndex();
  expect(buildIndex(db, repo)).toBe(3);

  // Q1 why: every intent that touched the file.
  expect(why(db, "refs/cache.ts")).toHaveLength(3);

  // Q2 tried: full-text over intent.
  expect(tried(db, "mutex").map((h) => h.status).sort()).toEqual(["abandoned", "kept"]);

  // Q3 failed: carries the error that explains it.
  const bad = failed(db);
  expect(bad).toHaveLength(1);
  expect(bad[0]!.errors[0]).toContain("data race");

  // Q4 red to green: the repair record.
  expect(redToGreen(db)).toHaveLength(1);

  // Q5 abandoned touching: the query no commit-anchored scheme can answer.
  const dead = abandonedTouching(db, "refs/cache.ts");
  expect(dead).toHaveLength(1);
  // A captured prompt is context, not a goal: it stays searchable but is
  // never presented as the agent's stated intent.
  expect(dead[0]!.intent).toBe("");
  expect(dead[0]!.source).toBe("captured");
  expect(tried(db, "mutex").length).toBeGreaterThan(0);
  expect(dead[0]!.anchor.startsWith("blob:")).toBe(true);

  // Q6 session: ordered history of one run.
  expect(session(db, "sess-a")).toHaveLength(2);

  // E12: two sessions, both touched refs/cache.ts.
  const o = overlap(db);
  expect(o.pairs).toBe(1);
  expect(o.overlapping).toBe(1);
  expect(o.ratio).toBe(1);
}, 30_000);

test("the index is derived and rebuilds from refs", async () => {
  const repo = gitRepo({ bare: true });
  writeRecord(repo, record({ delta: { files: ["a.ts"] } }), 1);
  const db = openIndex();
  buildIndex(db, repo);
  writeRecord(repo, record({ delta: { files: ["b.ts"] } }), 2);
  // Refs are the source of truth; a rebuild picks up what was appended.
  expect(buildIndex(db, repo)).toBe(2);
  expect(why(db, "b.ts")).toHaveLength(1);
}, 30_000);

test("one summary replaces three drifting copies of the same counts", async () => {
  const repo = gitRepo({ bare: true });
  const add = (over: Partial<CheckpointRecord>, seq: number) => {
    const r = rec({ session: { agent: "claude-code", run_id: "s1" }, ...over });
    writeRecord(repo, r, seq);
    return r;
  };

  const goal = add({ intent: { goal: "the objective" } }, 1);
  add({ serves: goal.id, delta: { files: ["a.ts"] } }, 2);
  add({
    intent: { goal: "a whole approach that is dead" },
    outcome: { status: "abandoned", errors: ["no"], scope: "general", recheck: "bun test" },
  }, 3);
  add({ intent: { goal: "one step failed" }, outcome: { status: "abandoned", errors: ["no"], recheck: null } }, 4);

  const db = openIndex();
  try {
    buildIndex(db, repo);
    const s = summary(db);

    expect(s.records).toBe(4);
    expect(s.abandoned).toBe(2);
    // `general` is the strongest warning the log can carry, so it is counted
    // separately from an ordinary dead end — an agent should be able to see
    // at a glance whether it is being used sparingly.
    expect(s.dead_approaches).toBe(1);
    // A log of unconnected roots has kept every what and lost every why.
    expect(s.goals.serving).toBe(1);
    expect(s.goals.roots).toBe(3);
    // Staleness asks git per record, so a caller that skips the repo — the
    // polled repo view — pays nothing for it.
    expect(s.stale).toBeNull();
    // Still the same overlap the three old copies disagreed about carrying.
    expect(s.overlap).toEqual(overlap(db));
  } finally { db.close(); }
}, 30_000);
