/**
 * Two small parsers the hooks trust: a path the agent names must really be
 * inside the repository, and a hook's event is the first bare word.
 */
import { expect, test } from "bun:test";
import { cmdWord, positional, positionals } from "../protocol/args";
import { inRepo, samePath } from "../protocol/rawlog";

test("an empty path stays empty, where resolving it would name the current folder", () => {
  expect(samePath("")).toBe("");
});

test("a path is in the repository only after its .. segments are resolved", () => {
  const within = inRepo("/repo");
  expect(within("/repo/src/../README.md")).toBe("README.md");
  expect(within("/repo/a/../../etc/passwd")).toBeNull();
  expect(within("/repo/src/app.ts")).toBe("src/app.ts");
});

test("a flag written as --name=value doesn't swallow the word after it", () => {
  expect(positional(["--agent=codex", "SessionStart"])).toBe("SessionStart");
  expect(positional(["SessionStart", "--agent", "codex"])).toBe("SessionStart");
  expect(positionals(["--repo", "x", "why", "src/a.ts"])).toEqual(["why", "src/a.ts"]);
});

test("a word for cmd.exe is quoted the way a Windows program reads it back", () => {
  expect(cmdWord("C:\\x\\a.py")).toBe("C:\\x\\a.py");
  // Quoted for the program, then every character cmd.exe reads is careted,
  // so cmd passes the word through whole.
  expect(cmdWord("a b")).toBe('^"a^ b^"');
  expect(cmdWord('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
  expect(cmdWord("c:\\my dir\\")).toBe('^"c:\\my^ dir\\\\^"');
  expect(cmdWord('print("a & b")')).toBe('^"print^(\\^"a^ ^&^ b\\^"^)^"');
  expect(cmdWord("%PATH%")).toBe('^"^%PATH^%^"');
});
