/**
 * ANVC is on in every repository unless someone turns a folder off, and off
 * means off everywhere: nothing captured, nothing shown, no tool answers.
 */
import { expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { folderOn, folders, noteFolder, setFolder } from "../protocol/folders";
import { gitRepo, runHook, setEnv, tmp, tool } from "./helpers";

function place() {
  const home = tmp("anvc-folders-home-");
  const repo = gitRepo();
  setEnv({ ANVC_STATE_HOME: home });
  return { home, repo };
}

test("a folder is on until it is turned off, and the list remembers both", async () => {
  const p = place();
  expect(folderOn(p.repo)).toBe(true);
  expect(noteFolder(p.repo)).toBe(true);
  expect(noteFolder(p.repo)).toBe(false);
  setFolder(p.repo, false);
  expect(folderOn(p.repo)).toBe(false);
  expect(folders()).toMatchObject([{ repo: realpathSync(p.repo), on: false }]);
});

test("in a folder that is off, capture writes nothing and the tools say so", async () => {
  const p = place();
  setFolder(p.repo, false);
  const capture = join(p.home, "capture");
  runHook("capture", "PostToolUse", { session_id: "s", cwd: p.repo, tool_name: "Bash", tool_input: { command: "ls" } }, { ANVC_CAPTURE_DIR: capture });
  expect(existsSync(capture)).toBe(false);

  expect(tool(p.repo, "anvc_search", { query: "x" })).toContain("ANVC is off in this folder");
});

test("the MCP server does nothing when it can't tell which repository it serves", async () => {
  const p = place();
  const call = (repo: string) => tool(repo, "anvc_search", { query: "x" });
  // A config variable the agent never filled in, and a folder that isn't a repository.
  expect(call("${workspaceFolder}")).toContain("can't tell which git repository");
  expect(call(p.home)).toContain("can't tell which git repository");
});
