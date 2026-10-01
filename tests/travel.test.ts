/**
 * A fresh clone of a project that uses anvc fetches none of its records. The
 * agent is told, so the person hears why the team's records are missing.
 */
import { expect, test } from "bun:test";
import { configureRemote, leftBehindLine, recordsLeftBehind } from "../protocol/git";
import { git, gitRepo, runHook, tmp } from "./helpers";

test("a clone whose records do not travel says so until init", async () => {
  const repo = gitRepo();
  const state = tmp("anvc-travel-state-");
  git(repo, "remote", "add", "origin", "git@github.com:x/y.git");
  const start = (session: string) => {
    const out = runHook("inject", "SessionStart", { session_id: session, cwd: repo, source: "startup" }, { ANVC_STATE_DIR: state });
    return out ? out.hookSpecificOutput.additionalContext as string : "";
  };
  expect(start("a")).toContain("do not travel with git push and fetch yet");
  configureRemote(repo);
  expect(start("b")).not.toContain("do not travel");
});

test("records left behind by a push that named the branch are counted, and a plain push sends them", () => {
  const repo = gitRepo({ commit: true });
  git(repo, "checkout", "-q", "-B", "main");
  git(repo, "remote", "add", "origin", gitRepo({ bare: true }));
  configureRemote(repo);
  git(repo, "update-ref", "refs/anvc/s1/000001", "HEAD");
  git(repo, "update-ref", "refs/anvc/s1/000002", "HEAD");

  // Not pushed at all yet: the code isn't on origin either, so nothing is said.
  expect(recordsLeftBehind(repo)).toBeNull();
  git(repo, "push", "-q", "-u", "origin", "main");
  expect(recordsLeftBehind(repo)).toBe(2);
  expect(leftBehindLine(2)).toBe("Your code is pushed, but 2 ANVC records aren't: a push that names a branch sends only that branch. Run git push with no branch named.");
  git(repo, "push", "-q", "origin");
  expect(recordsLeftBehind(repo)).toBe(0);
  expect(leftBehindLine(0)).toBeNull();
});
