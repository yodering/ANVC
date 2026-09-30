/**
 * Running a record's check, and saying what the result means.
 *
 * A record's `recheck` is the command that failed when the attempt was
 * abandoned. Run now, it is the best evidence of whether the record still
 * holds. With the changed lines themselves, it's what stops an agent
 * following a stale record, where a warning doesn't.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitOrNull } from "./git";
import { readJson, stateRoot } from "./rawlog";

/**
 * Commands a record may have run on its behalf, and nothing else.
 *
 * This is the one place where text out of a record could become a process, so
 * it is an allowlist of whole commands rather than a sanitiser. A record is
 * written by an agent and travels through `git push`, which means a record
 * from a teammate's clone — or from a pull request — is untrusted input. A
 * denylist of shell metacharacters would be the wrong shape: the question is
 * not "does this look dangerous" but "is this one of the few things we are
 * willing to run".
 *
 * Test and build commands only. No install, no network, no writes: npx, uv run
 * and deno test are left out because each can fetch packages. Up to three
 * plain arguments, so one test file or one test name can be named.
 *
 * Parsed into words and run without a shell. The allowlist used to be a
 * regex whose separator `\s` also matched a newline, and the command went to
 * `sh -c`, so a record fetched from anyone who could push could run a second
 * command of its own. An argument is a path or a test name inside the
 * repository, or -q, -v or -x: no other option, no absolute path (C:/x is
 * one on Windows), no `..`, no `VAR=` override, each of which could point the
 * runner at code somewhere else.
 */
const COMMANDS = [
  "bun test", "bun run typecheck", "npm test", "pnpm test", "yarn test", "pytest",
  "python -m pytest", "python3 -m pytest", "python -m unittest", "python3 -m unittest",
  "cargo test", "go test", "make test",
];
const ARG = /^(?:-[qvx]|(?![-/])(?![A-Za-z]:)(?!(?:.*\/)?\.\.(?:\/|$))[\w./:-]{1,80})$/;

/** The words to run for a record's check, or null when it isn't one we run. */
export function argvOf(command: string): string[] | null {
  const text = command.trim();
  // Printable ASCII words, one space apart: no newline, tab or control character.
  if (!/^[\x21-\x7e]+( [\x21-\x7e]+)*$/.test(text)) return null;
  const head = COMMANDS.find((c) => text === c || text.startsWith(`${c} `));
  if (!head) return null;
  const args = text.slice(head.length).split(" ").filter(Boolean);
  return args.length <= 3 && args.every((a) => ARG.test(a)) ? [...head.split(" "), ...args] : null;
}

export const runnable = (command: string): boolean => argvOf(command) !== null;

/**
 * How long a check may take before it is not worth the agent's wait. A hook
 * runs inside the agent's turn, so this is latency the user feels.
 */
const RECHECK_TIMEOUT_MS = 2_000;

/**
 * Runs a record's check and says what the result means, or null when it
 * can't be run or didn't finish.
 *
 * Said as what it means, not as a status. "checked just now: passes" left the
 * agent to work out that passing overturns the record, and it mostly didn't.
 */
export function verify(repo: string, command: string): string | null {
  const argv = argvOf(command);
  if (!argv) return null;
  try {
    const proc = Bun.spawnSync(argv, { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: RECHECK_TIMEOUT_MS });
    // A timeout is not a result. Saying "still failing" because a test suite
    // was slow would be a fabricated observation, which is worse than none.
    // Nor is 9009, which Windows answers for a program that isn't there, as
    // the python3 that only offers to install Python from the Store does.
    if (proc.exitCode === null || proc.exitCode === 9009) return null;
    return proc.exitCode === 0
      ? "checked just now: the check that failed back then passes now, so this may no longer be true; read the current code before following it"
      : "checked just now: still fails, so this still holds";
  } catch {
    return null;
  }
}

/**
 * The same, remembered for as long as the code is the same.
 *
 * Checks used to run only at session start, because each can take two
 * seconds. Keyed by the commit and the uncommitted changes, a result is
 * reused until the code moves, so a check can run whenever its record is
 * shown and still cost nothing the second time.
 */
type Cache = Record<string, { result: string | null; ts: string }>;
const cacheFile = () => join(stateRoot(), "rechecks.json");
const readCache = (): Cache => readJson<Cache>(cacheFile(), {});
function keyFor(repo: string, command: string): string {
  const state = gitOrNull(repo, ["rev-parse", "HEAD"]) ?? "";
  const dirty = gitOrNull(repo, ["diff", "HEAD"]) ?? "";
  return createHash("sha256").update(`${repo}\0${command}\0${state}\0${dirty}`).digest("hex").slice(0, 24);
}

/** A remembered result for the code as it is now, or undefined if there is none. */
export function cachedCheck(repo: string, command: string): string | null | undefined {
  if (!runnable(command)) return null;
  const hit = readCache()[keyFor(repo, command)];
  return hit ? hit.result : undefined;
}

export function verifyCached(repo: string, command: string): string | null {
  if (!runnable(command)) return null;
  const key = keyFor(repo, command);
  const cache = readCache();
  if (key in cache) return cache[key]!.result;
  const result = verify(repo, command);
  cache[key] = { result, ts: new Date().toISOString() };
  // Kept small: results for code that has since moved are never read again.
  const entries = Object.entries(cache).sort((a, b) => b[1].ts.localeCompare(a[1].ts)).slice(0, 200);
  try {
    mkdirSync(join(cacheFile(), ".."), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(Object.fromEntries(entries)));
  } catch { /* checked again next time */ }
  return result;
}
