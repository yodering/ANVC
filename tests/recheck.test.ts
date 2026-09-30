/**
 * A record's check is run whenever its dead end is shown, remembered while
 * the code stays the same, and only ever one of a few test commands.
 */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cachedCheck, runnable, verifyCached } from "../protocol/recheck";
import { git, gitRepo, setEnv, tmp } from "./helpers";

test("the allowlist takes common test runners with a few plain arguments, and nothing that installs or chains", () => {
  for (const ok of ["bun test", "python3 -m unittest -q", "python -m pytest tests/test_x.py::test_y -q", "pnpm test", "make test", "go test ./..."]) {
    expect(runnable(ok), ok).toBe(true);
  }
  // A record can come from anyone who can push, so each of these must stay
  // out: a second command after a newline or tab, an option or path that
  // points the runner at code elsewhere.
  const planted = ["bun test\nsh x", "bun test\tx", "bun test\r\nx", "bun test --preload=/tmp/x", "npm test --script-shell=/x",
    "make test SHELL=/x", "make test -C /tmp", "pytest -p x", "bun test ../x", "bun test /etc/x", "bun test a/../../x",
    "bun test C:/Users/x/evil.test.ts"];
  for (const no of ["npx jest", "uv run pytest", "deno test", "bun test; rm -rf /", "pytest $(whoami)", "npm install", "pytest a b c d", ...planted]) {
    expect(runnable(no), no).toBe(false);
  }
});

// Skipped where make isn't installed, as on many Windows machines: the check is make test.
test.skipIf(!Bun.which("make"))("a check runs once while the code is the same, and again when it changes", async () => {
  const repo = gitRepo();
  setEnv({ ANVC_STATE_DIR: tmp("anvc-recheck-state-") });
  writeFileSync(join(repo, "Makefile"), "test:\n\t@exit 1\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  expect(cachedCheck(repo, "make test")).toBeUndefined();
  expect(verifyCached(repo, "make test")).toBe("checked just now: still fails, so this still holds");
  expect(cachedCheck(repo, "make test")).toBe("checked just now: still fails, so this still holds");
  // The code moved: the remembered result no longer applies.
  writeFileSync(join(repo, "Makefile"), "test:\n\t@exit 0\n");
  expect(cachedCheck(repo, "make test")).toBeUndefined();
  expect(verifyCached(repo, "make test")).toContain("passes now, so this may no longer be true");
});
