/**
 * Forget deletes a private record; review lists what the next push shares.
 */
import { expect, test } from "bun:test";
import { appendRecord, readRecords } from "../protocol/record";
import { cli, gitRepo, rec } from "./helpers";

const record = (goal: string) => rec({ intent: { goal } });

test("a private record is forgotten; a shared one has to be made private first", async () => {
  const dir = gitRepo();
  const mine = record("Try the in-memory cache");
  const theirs = record("Retry with backoff");
  appendRecord(dir, mine, { tier: "private" });
  appendRecord(dir, theirs, { tier: "shared" });
  expect(cli(dir, "forget", mine.id).out).toContain(`forgot ${mine.id}`);
  const refused = cli(dir, "forget", theirs.id);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain(`anvc unshare ${theirs.id}`);
  expect(readRecords(dir).map(([, r]) => r.id)).toEqual([theirs.id]);
});

test("review lists what the next push will share, and nothing private", async () => {
  const dir = gitRepo();
  appendRecord(dir, record("Retry with backoff"), { tier: "shared" });
  appendRecord(dir, record("Try the in-memory cache"), { tier: "private" });
  const { out } = cli(dir, "review");
  expect(out).toContain("1 record will be shared on your next push");
  expect(out).toContain("Retry with backoff");
  expect(out).not.toContain("in-memory cache");
});
