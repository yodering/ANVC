/**
 * What a record relies on, changed since it was written, shown as the lines
 * themselves: the evidence an agent acts on, where a warning isn't.
 */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedLines, codeNames } from "../protocol/drift";
import type { Hit } from "../protocol/query";
import { git, gitRepo } from "./helpers";

test("code-looking names are picked out of a record's words", () => {
  expect([...codeNames("used our own regex with sizes.UNITS[unit] and money.remainder(total, n) instead")].sort())
    .toEqual(["UNITS", "remainder"]);
});

test("changes inside what a record names are shown, and unrelated ones aren't", async () => {
  const repo = gitRepo();
  const before = 'UNITS = {"KB": 1000}\n\n\ndef remainder(total, parts):\n    return total % parts\n\n\ndef unrelated():\n    return 1\n';
  writeFileSync(join(repo, "money.py"), before);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const oid = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "money.py"), before
    .replace('{"KB": 1000}', '{"KB": 1024}')
    .replace("return total % parts", "return (total % parts) // 100")
    .replace("return 1", "return 2"));
  const hit = {
    anchor: `commit:${oid.slice(0, 12)}`, files: ["money.py"], errors: [], why: null, status: "abandoned",
    intent: "Split with money.UNITS and money.remainder(total, n)",
  } as unknown as Hit;
  const lines = changedLines(repo, hit);
  expect(lines).toContain('money.py: + UNITS = {"KB": 1024}');
  // Inside remainder(), though the line itself doesn't say "remainder".
  expect(lines).toContain("money.py: + return (total % parts) // 100");
  expect(lines.some((l) => l.includes("return 2"))).toBe(false);
});

test("a comment or docstring change isn't shown as evidence", async () => {
  const repo = gitRepo();
  writeFileSync(join(repo, "sizes.py"), 'def parse_size(text):\n    """Bytes in a size."""\n    return 1024\n');
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const oid = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "sizes.py"), 'def parse_size(text):\n    """Bytes in a size, for the report."""\n    # still 1024\n    return 1024\n');
  const hit = { anchor: `commit:${oid.slice(0, 12)}`, files: ["sizes.py"], errors: [], why: null, status: "abandoned", intent: "Use sizes.parse_size" } as unknown as Hit;
  expect(changedLines(repo, hit)).toEqual([]);
});

test("a kept record is measured from the commit its own work landed in", async () => {
  const repo = gitRepo();
  writeFileSync(join(repo, "sizes.py"), "UNITS = {}\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const oid = git(repo, "rev-parse", "HEAD");
  const hit = { anchor: `commit:${oid.slice(0, 12)}`, files: ["sizes.py"], errors: [], why: null, status: "kept",
    intent: "Parse with sizes.UNITS", ts: new Date(Date.now() - 60_000).toISOString() } as unknown as Hit;
  // The record's own work, still uncommitted: nothing to show.
  writeFileSync(join(repo, "sizes.py"), 'UNITS = {"KB": 1000}\n');
  expect(changedLines(repo, hit)).toEqual([]);
  // Committed: still its own work, not a change since.
  git(repo, "commit", "-qam", "the work");
  expect(changedLines(repo, hit)).toEqual([]);
  // A later change to what it relies on is.
  writeFileSync(join(repo, "sizes.py"), 'UNITS = {"KB": 1024}\n');
  expect(changedLines(repo, hit)).toContain('sizes.py: + UNITS = {"KB": 1024}');
});

test("a full stop isn't a dotted name", () => {
  expect([...codeNames("which is what would have caught them. Also api.fetch_all.")]).toEqual(["fetch_all"]);
});
