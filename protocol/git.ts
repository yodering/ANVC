/**
 * One git helper, because eight private copies had already drifted apart.
 *
 * The copies differed in ways nobody chose: only one set a large `maxBuffer`,
 * so `for-each-ref` over every record silently truncated on the default 1 MiB
 * once a repository held enough of them; error text was truncated in one place
 * and swallowed entirely in another, so the same failure read differently
 * depending on which module caught it.
 */
import { spawnSync } from "node:child_process";

/** Matches a SHA-1 or SHA-256 object id. The boundary of what may reach a ref. */
export const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * Runs git in `repo` and returns trimmed stdout.
 *
 * `maxBuffer` is 64 MiB rather than Node's 1 MiB default: `for-each-ref` over a
 * repository's checkpoint records outgrows the default, and `spawnSync` reports
 * the overflow as a non-zero status, which reads as a spurious git failure.
 *
 * `input` is written to stdin, for `hash-object --stdin` and friends.
 *
 * `windowsHide`, here and at every other spawn the work log's server can
 * reach: that server runs detached, and on Windows a console program started
 * from a process with no console of its own, without the flag, gets a window.
 */
export function git(repo: string, args: string[], options: { input?: string } = {}): string {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr ?? "").trim()}`);
  return (result.stdout ?? "").trim();
}

/** Trimmed stdout, or null when git failed. For probing rather than asserting. */
export function gitOrNull(repo: string, args: string[]): string | null {
  try { return git(repo, args); } catch { return null; }
}

/** The names of a repository's remotes; none outside a repository. */
export const remoteNames = (repo: string): string[] => (gitOrNull(repo, ["remote"]) ?? "").split("\n").filter(Boolean);

/** Absolute path to the object database, whether the repository is bare or not. */
export function gitDir(repo: string): string {
  const dir = git(repo, ["rev-parse", "--absolute-git-dir"]);
  if (!dir) throw new Error(`Not a git repository: ${repo}`);
  return dir;
}

/** Every ref as name and object id. One parser, previously copied four times. */
export function readRefs(repo: string, prefix = ""): Array<{ ref: string; oid: string }> {
  const out = git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", ...(prefix ? [prefix] : [])]);
  if (!out) return [];
  return out.split("\n").map((line) => {
    const index = line.indexOf(" ");
    return { ref: line.slice(0, index), oid: line.slice(index + 1) };
  });
}

/**
 * Whether records travel with git push and fetch here: false when the
 * repository has a remote but it was never told about refs/anvc. A clone of a
 * project that uses anvc starts that way, and its agents then see none of the
 * team's records with nothing saying why.
 */
export function recordsTravel(repo: string): boolean | null {
  if (!gitOrNull(repo, ["remote", "get-url", "origin"])) return null;
  return (gitOrNull(repo, ["config", "--get-all", "remote.origin.fetch"]) ?? "").includes("refs/anvc/");
}

/**
 * Makes an ordinary push and fetch carry records. Shared by `anvc init` and
 * `setup`, which had each kept their own copy of the list.
 *
 * Records live in a ref namespace git does not sync by default: a plain push
 * leaves them behind and a plain clone fetches none of them, so a teammate sees
 * an empty log and nothing says otherwise. That is how git notes died.
 *
 * Any `remote.*.push` replaces git's default of pushing the current branch, so
 * that has to be restated. It is restated as `HEAD`. The first version wrote
 * `refs/heads/*:refs/heads/*`, which made a plain `git push` send every local
 * branch, work in progress included — so that line is removed where we wrote it.
 */
export function configureRemote(repo: string, remote = "origin", dry = false): { added: number; removed: number; changes: string[] } {
  const fetch = `remote.${remote}.fetch`, push = `remote.${remote}.push`;
  // No such key yet is the normal case on a fresh repository.
  const values = (key: string) => (gitOrNull(repo, ["config", "--get-all", key]) ?? "").split("\n");
  // With `dry`, nothing is written and `changes` says what would be.
  const changes: string[] = [];
  let removed = 0;
  if (values(push).includes("refs/heads/*:refs/heads/*")) {
    if (!dry) git(repo, ["config", "--fixed-value", "--unset-all", push, "refs/heads/*:refs/heads/*"]);
    changes.push(`remove ${push} refs/heads/*:refs/heads/*`);
    removed++;
  }
  let added = 0;
  for (const [key, value] of [[fetch, `+refs/anvc/*:refs/remotes/${remote}/anvc/*`], [push, "HEAD"], [push, "refs/anvc/*:refs/anvc/*"]] as const) {
    if (values(key).includes(value)) continue;
    if (!dry) git(repo, ["config", "--add", key, value]);
    changes.push(`add ${key} ${value}`);
    added++;
  }
  return { added, removed, changes };
}

/**
 * Takes configureRemote's lines off one remote, and says how many went. Used
 * by `anvc init --off`, local only and uninstall. `push = HEAD` goes only where
 * the records' refspec shows configureRemote added it; without that line, git's
 * own default sends the current branch anyway.
 */
export function unconfigureRemote(repo: string, remote = "origin"): number {
  const unset = (key: string, value: string) => gitOrNull(repo, ["config", "--fixed-value", "--unset-all", `remote.${remote}.${key}`, value]) !== null;
  const pushed = unset("push", "refs/anvc/*:refs/anvc/*");
  const fetched = unset("fetch", `+refs/anvc/*:refs/remotes/${remote}/anvc/*`);
  const head = pushed && unset("push", "HEAD");
  return Number(pushed) + Number(fetched) + Number(head);
}
