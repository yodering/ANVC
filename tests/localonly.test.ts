/**
 * Local only is a guarantee: with it on, nothing ANVC keeps can leave the
 * computer by any path ANVC controls, and turning it off sends nothing.
 */
import { expect, test } from "bun:test";
import { configureRemote } from "../protocol/git";
import { isLocalOnly, setLocalOnly } from "../protocol/localonly";
import { writePolicy, readPolicy } from "../protocol/policy";
import { prePush } from "../protocol/prepush";
import { appendRecord, defaultTier, moveRecord } from "../protocol/record";
import { sync } from "../protocol/sync";
import { cli, git, gitRepo, rec } from "./helpers";

const config = (repo: string, key: string) =>
  Bun.spawnSync(["git", "-C", repo, "config", "--get-all", key], { stdout: "pipe" }).stdout.toString();
const record = () => rec({ intent: { goal: "Try it" } });

test("local only takes ANVC off the remote and keeps every record private", async () => {
  const repo = gitRepo();
  git(repo, "remote", "add", "origin", "https://example.invalid/r.git");
  configureRemote(repo, "origin");
  expect(config(repo, "remote.origin.push")).toContain("refs/anvc/");

  expect(setLocalOnly(repo, true).unset).toBeGreaterThan(0);
  expect(isLocalOnly(repo)).toBe(true);
  expect(config(repo, "remote.origin.push")).not.toContain("refs/anvc/");
  expect(config(repo, "remote.origin.fetch")).not.toContain("refs/anvc/");

  // Asked for shared, written private.
  const { ref } = appendRecord(repo, record(), { tier: "shared" });
  expect(ref.startsWith("refs/anvc-private/")).toBe(true);
  expect(defaultTier(repo)).toBe("private");
  expect(() => moveRecord(repo, ref, "shared")).toThrow("local only");

  // Every other way out refuses.
  expect(cli(repo, "init").code).toBe(1);
  expect(config(repo, "remote.origin.push")).not.toContain("refs/anvc/");
  expect(() => sync(repo, repo, "origin")).toThrow("local only");
  const push = prePush(repo, [`refs/anvc-private/s/000001 ${"b".repeat(40)} refs/anvc/s/000001 ${"0".repeat(40)}`]);
  expect(push.ok).toBe(false);

  // A preset can't turn it off by accident.
  writePolicy(repo, { ...readPolicy(repo), preset: "private-repo" });
  expect(isLocalOnly(repo)).toBe(true);

  // Off sends nothing and changes no remote.
  setLocalOnly(repo, false);
  expect(isLocalOnly(repo)).toBe(false);
  expect(config(repo, "remote.origin.push")).not.toContain("refs/anvc/");
});
