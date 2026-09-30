/**
 * Attempts form a tree, not a list.
 *
 * `parent` was in the envelope from the start and nothing could write it: the
 * checkpoint tool had no such argument, so all 21 records in this repository
 * were roots. A pile of attempts with no edges cannot answer the question that
 * matters — "we tried three things from here, and the third one worked" reads
 * as three unrelated turns.
 *
 * The edge points backwards, which is the wrong direction for a reader, so a
 * dead end is also resolved forward to whatever continued from it.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { appendRecord, type CheckpointRecord } from "../protocol/record";
import { buildIndex, deadEnds, maybeStale, openDeadEnds, openIndex, revisions, succeededBy, tried } from "../protocol/query";
import { git, gitRepo, rec, tool } from "./helpers";

const attempt = (goal: string, status: "kept" | "abandoned", parent?: string) => rec({
  intent: { goal }, outcome: { status, ...(status === "abandoned" ? { errors: ["deadlock"], recheck: "bun test tests/concurrency.test.ts" } : {}) },
  ...(parent ? { parent } : {}),
});

async function repoWithTree() {
  const repo = gitRepo({ bare: true });

  // Two dead ends from the same starting point, then the one that worked.
  const first = attempt("Try a mutex around the ref cache", "abandoned");
  appendRecord(repo, first);
  const second = attempt("Try a read-write lock instead", "abandoned", first.id);
  appendRecord(repo, second);
  const worked = attempt("Shrink the critical section", "kept", second.id);
  appendRecord(repo, worked);

  const db = openIndex();
  buildIndex(db, repo);
  return { repo, db, first, second, worked };
}

test("a dead end resolves forward to what replaced it", async () => {
  const { db, second, worked } = await repoWithTree();
  try {
    const after = succeededBy(db, second.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.intent).toBe("Shrink the critical section");
    expect(after[0]!.status).toBe("kept");
    expect(after[0]!.id).toBe(worked.id);
  } finally { db.close(); }
}, 30_000);

test("the chain is walkable from the newest attempt back to the first", async () => {
  const { db, first, second, worked } = await repoWithTree();
  try {
    const dead = deadEnds(db);
    expect(dead).toHaveLength(2);

    // Each abandoned attempt knows where it came from, so a reader can see
    // this was one line of attack rather than two unrelated failures.
    const byId = new Map(dead.map((h) => [h.id, h]));
    expect(byId.get(second.id)!.parent).toBe(first.id);
    expect(byId.get(first.id)!.parent).toBeNull();

    // And the kept record closes the chain.
    expect(succeededBy(db, second.id)[0]!.id).toBe(worked.id);
  } finally { db.close(); }
}, 30_000);

test("an attempt nothing continued from has no successor", async () => {
  const { db, worked } = await repoWithTree();
  try {
    // The last attempt worked, so nothing follows it. An empty answer here
    // must not be confused with a broken link.
    expect(succeededBy(db, worked.id)).toEqual([]);
  } finally { db.close(); }
}, 30_000);

test("the checkpoint tool accepts a parent and returns the id to use as one", async () => {
  const repo = gitRepo({ bare: true });
  const call = (args: Record<string, unknown>) => tool(repo, "anvc_checkpoint", args, { ANVC_SESSION: "tree" });

  const first = call({ goal: "Try a mutex", outcome: "abandoned", why: "deadlock", recheck: "bun test tests/concurrency.test.ts" });
  // Without the id in the response the agent cannot link its next attempt,
  // and every record stays a root.
  const id = /id: ([0-9A-Z]+)/.exec(first)?.[1];
  expect(id).toBeTruthy();
  // Abandoning something should prompt the agent to link what comes next.
  expect(first).toContain("parent");

  const second = call({ goal: "Shrink the critical section", outcome: "kept", parent: id });
  expect(second).toContain("recorded kept");

  const db = openIndex();
  buildIndex(db, repo);
  try {
    expect(succeededBy(db, id!)[0]!.intent).toBe("Shrink the critical section");
  } finally { db.close(); }
}, 60_000);

test("a dead end someone got past is not injected as a warning", async () => {
  const { db, first, second } = await repoWithTree();
  try {
    // Both are abandoned, and the UI and CLI should keep showing both —
    // history is the point there.
    expect(deadEnds(db)).toHaveLength(2);

    // But injection is advice, not history. Telling an agent to avoid
    // something that now works is worse than silence: it is confident,
    // on-topic and wrong, and the reader has no way to find out.
    //
    // Observed on this repository. An attempt was abandoned, a later attempt
    // fixed it and linked itself with `parent`, and the session briefing kept
    // announcing the dead end as open. The correction was already in the log;
    // the query never asked for it.
    const open = openDeadEnds(db);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(first.id);
    expect(open.map((h) => h.id)).not.toContain(second.id);
  } finally { db.close(); }
}, 30_000);

test("a record notices when the code under it has moved", async () => {
  const repo = gitRepo();
  await Bun.write(join(repo, "api.ts"), "export const x = 1;\n");
  await Bun.write(join(repo, "other.ts"), "export const y = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");

  const written = {
    ...attempt("Cache the ref index", "abandoned"),
    anchor: { kind: "commit" as const, oid: base },
    delta: { files: ["api.ts"] },
  } as CheckpointRecord;
  appendRecord(repo, written);
  const untouched = {
    ...attempt("Something about the other file", "abandoned"),
    anchor: { kind: "commit" as const, oid: base },
    delta: { files: ["other.ts"] },
  } as CheckpointRecord;
  appendRecord(repo, untouched);

  // The code moves under one record and not the other.
  await Bun.write(join(repo, "api.ts"), "export const x = 2;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change api");

  const db = openIndex();
  try {
    buildIndex(db, repo);
    const stale = maybeStale(db, repo, 10);
    // This is the claim a prose note cannot make: not "trust this less",
    // but "this exact file changed after this was written".
    expect(stale).toHaveLength(1);
    expect(stale[0]!.intent).toBe("Cache the ref index");
    expect(stale[0]!.changed).toEqual(["api.ts"]);

    // The bug this test exists for: `hit.anchor` renders as "commit:abc1234",
    // and passing that to git makes every diff fail silently, so everything
    // reads as fresh. A staleness check that can only say "nothing is stale"
    // looks exactly like a working one.
    expect(stale[0]!.changed.length).toBeGreaterThan(0);
  } finally { db.close(); }
}, 30_000);

test("a superseded record says so, and the chain resolves from any version", async () => {
  const dir = gitRepo({ bare: true });
  const v1 = attempt("the first claim", "kept");
  const v2 = { ...attempt("the second claim", "kept"), supersedes: v1.id };
  const v3 = { ...attempt("the third claim", "kept"), supersedes: v2.id };
  for (const r of [v1, v2, v3]) appendRecord(dir, r);
  const db = openIndex();
  buildIndex(db, dir);
  try {
    // The forward edge is what a stored record cannot carry, and what an
    // agent holding an old record needs before it acts on one.
    const chain = revisions(db, v1.id);
    expect(chain.current).toBe(v3.id);
    expect(chain.chain.map((h) => h.intent))
      .toEqual(["the third claim", "the second claim", "the first claim"]);
    // Naming the newest resolves to itself, still with its whole history.
    expect(revisions(db, v3.id).current).toBe(v3.id);
    expect(revisions(db, v3.id).chain).toHaveLength(3);
    // And it shows up without anyone asking for it.
    const [old] = tried(db, "first", 5);
    expect(old!.superseded_by).toBe(v2.id);
    const [newest] = tried(db, "third", 5);
    expect(newest!.superseded_by).toBeNull();
  } finally { db.close(); }
});
