/**
 * A fresh clone of a project that uses anvc fetches none of its records. The
 * agent is told, so the person hears why the team's records are missing.
 */
import { expect, test } from "bun:test";
import { configureRemote } from "../protocol/git";
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
