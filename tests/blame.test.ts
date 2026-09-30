/**
 * Why a line is there: line, commit, the attempts behind it.
 */
import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { splitLine, whyLine } from "../protocol/blame";
import { buildIndex, openIndex } from "../protocol/query";
import { appendRecord } from "../protocol/record";
import { git, gitRepo, rec } from "./helpers";

test("path:line is split, a plain path is not", () => {
  expect(splitLine("src/api.ts:42")).toEqual({ path: "src/api.ts", line: 42 });
  expect(splitLine("src/api.ts")).toBeNull();
});

test("a line leads to its commit and to the attempts behind it, abandoned ones included", async () => {
  const dir = gitRepo();
  await writeFile(join(dir, "pool.ts"), "export const size = 1;\nexport const ttl = 5;\n");
  git(dir, "add", "."); git(dir, "commit", "-q", "-m", "Start the pool");
  const base = git(dir, "rev-parse", "HEAD");

  const attempt = (goal: string, status: "kept" | "abandoned", file = "pool.ts") => rec({
    anchor: { kind: "commit", oid: base },
    intent: { goal }, outcome: { status, ...(status === "abandoned" ? { recheck: null } : {}) },
    delta: { files: [file] },
  });
  appendRecord(dir, attempt("Share one pool across workers", "abandoned"));
  appendRecord(dir, attempt("One pool per worker", "kept"));
  appendRecord(dir, attempt("Unrelated work elsewhere", "kept", "other.ts"));

  await writeFile(join(dir, "pool.ts"), "export const size = 8;\nexport const ttl = 5;\n");
  git(dir, "commit", "-q", "-am", "Size the pool per worker");

  const db = openIndex();
  buildIndex(db, dir);
  const w = whyLine(db, dir, "pool.ts", 1);
  expect(w.commit?.subject).toBe("Size the pool per worker");
  expect(w.attempts.map((a) => `${a.status} ${a.intent}`)).toEqual([
    "abandoned Share one pool across workers",
    "kept One pool per worker",
  ]);
  db.close();
});
