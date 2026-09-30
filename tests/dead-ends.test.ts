/**
 * A miss must not read as "nothing was tried".
 *
 * Full-text search only matches the words someone else happened to use.
 * Measured on this repository, the one abandoned attempt is found by
 * "summarizer" and by nothing else: "summary model", "intent extraction" and
 * "what was tried for intent" all returned nothing, and the agent was told
 * "Nothing recorded" — a confident false statement that leads straight to
 * rebuilding the thing that was abandoned.
 */
import { expect, test } from "bun:test";
import { writeRecord } from "../protocol/record";
import { abandonedCount, buildIndex, deadEnds, openIndex, tried } from "../protocol/query";
import { gitRepo, rec } from "./helpers";

const attempt = (goal: string, status: "kept" | "abandoned", errors?: string[]) => rec({
  intent: { goal }, outcome: { status, ...(errors ? { errors } : {}), ...(status === "abandoned" ? { recheck: "bun test" } : {}) },
});

function fixture() {
  const repo = gitRepo({ bare: true });
  writeRecord(repo, attempt("Try a separate summarizer model for intent", "abandoned",
    ["It can only re-read the transcript, so it has strictly less information"]), 1);
  writeRecord(repo, attempt("Let the agent write its own records", "kept"), 2);
  writeRecord(repo, attempt("Cache the index across requests", "abandoned", ["stale after any write"]), 3);
  const db = openIndex();
  buildIndex(db, repo);
  return { repo, db };
}

test("dead ends are listed without needing the right search words", async () => {
  const { db } = fixture();
  try {
    const dead = deadEnds(db);
    expect(dead).toHaveLength(2);
    // Newest first, and the kept record is not among them.
    expect(dead.every((h) => h.status === "abandoned")).toBe(true);
    expect(dead.map((h) => h.intent).join(" ")).toContain("summarizer");
    expect(abandonedCount(db)).toBe(2);
  } finally { db.close(); }
}, 30_000);

test("the words an agent would actually use do not match, which is the point", async () => {
  const { db } = fixture();
  try {
    // The exact word works.
    expect(tried(db, "summarizer")).toHaveLength(1);
    // Everything a differently-phrased agent would try does not. This is not a
    // bug to fix in the search — it is why deadEnds() exists.
    for (const miss of ["summary model", "intent extraction", "compress records"]) {
      expect(tried(db, miss)).toHaveLength(0);
    }
    // And the log still holds the answer, reachable without any query.
    expect(deadEnds(db).some((h) => h.intent.includes("summarizer"))).toBe(true);
  } finally { db.close(); }
}, 30_000);

test("an empty search is not evidence of an empty log", async () => {
  const { db } = fixture();
  try {
    // A search that misses, in a repository that does hold abandoned work.
    expect(tried(db, "something nobody wrote")).toHaveLength(0);
    expect(abandonedCount(db)).toBeGreaterThan(0);
  } finally { db.close(); }
}, 30_000);
