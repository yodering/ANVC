/**
 * Choices made once for every project: a project follows them until it makes
 * its own, and setting one project up can leave its git alone.
 */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { isLocalOnly, setLocalOnly } from "../protocol/localonly";
import { readPolicy, writeDefaults } from "../protocol/policy";
import { git, gitRepo, setEnv, tmp } from "./helpers";

function place() {
  const home = tmp("anvc-defaults-home-");
  const repo = gitRepo();
  setEnv({ ANVC_STATE_HOME: home });
  return { home, repo };
}

test("a project follows the preset and Local only chosen for every project, until it says otherwise", async () => {
  const p = place();
  expect(readPolicy(p.repo)).toMatchObject({ preset: "team", chosen: false });
  writeDefaults({ preset: "minimal", localOnly: true });
  expect(readPolicy(p.repo)).toMatchObject({ preset: "minimal", chosen: true });
  expect(isLocalOnly(p.repo)).toBe(true);
  setLocalOnly(p.repo, false);
  expect(isLocalOnly(p.repo)).toBe(false);
  setLocalOnly(p.repo, true);
  expect(isLocalOnly(p.repo)).toBe(true);
});

test("setup --no-remote leaves git as it is", async () => {
  const p = place();
  git(p.repo, "remote", "add", "origin", "https://example.invalid/r.git");
  const run = Bun.spawnSync(["bun", resolve(import.meta.dir, "../scripts/setup.ts"), "--repo", p.repo, "--agent", "cursor", "--no-instructions", "--no-remote"],
    { env: { ...process.env, ANVC_STATE_HOME: p.home, HOME: p.home }, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toContain("records stay here until you run anvc init");
  expect(Bun.spawnSync(["git", "-C", p.repo, "config", "--get-all", "remote.origin.push"], { stdout: "pipe" }).stdout.toString()).toBe("");
});
